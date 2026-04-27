import type {
  ExtensionAPI,
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";

import betterDiffExtension, {
  BETTERDIFF_EXTENSION_STAGE,
  BETTERDIFF_NEXT_STEPS,
} from "../src/index.js";

describe("extension entrypoint", () => {
  it("marks the extension as a UI prototype", () => {
    expect(BETTERDIFF_EXTENSION_STAGE).toBe("ui-prototype");
  });

  it("keeps the next planned steps documented in code", () => {
    expect(BETTERDIFF_NEXT_STEPS.length).toBeGreaterThan(0);
    expect(BETTERDIFF_NEXT_STEPS[0]).toContain("mutation history");
  });

  it("registers the /diff command only", () => {
    let commandName: string | undefined;
    let commandDescription: string | undefined;
    let shortcutCount = 0;

    const pi = createExtensionApiMock({
      registerCommand(name, options) {
        commandName = name;
        commandDescription = options.description;
      },
      registerShortcut() {
        shortcutCount += 1;
      },
    });

    expect(() => {
      betterDiffExtension(pi);
    }).not.toThrow();

    expect(commandName).toBe("diff");
    expect(commandDescription).toContain("Review");
    expect(shortcutCount).toBe(0);
  });

  it("loads untracked files into the git changes review", async () => {
    type CommandHandler = Parameters<
      ExtensionAPI["registerCommand"]
    >[1]["handler"];
    let handler: CommandHandler | undefined;
    let rendered = "";
    const notifications: string[] = [];

    const untrackedPatch = [
      "diff --git a/plan.md b/plan.md",
      "new file mode 100644",
      "index 0000000..f2ae289",
      "--- /dev/null",
      "+++ b/plan.md",
      "@@ -0,0 +1 @@",
      "+ does unstaged and staged git works?",
    ].join("\n");

    const pi = createExtensionApiMock({
      registerCommand(_name, options) {
        handler = options.handler;
      },
      exec(_command, args) {
        if (args.includes("--cached")) return gitResult("");
        if (args[0] === "ls-files") return gitResult("plan.md\0");
        if (args.includes("--no-index")) return gitResult(untrackedPatch, 1);
        if (args[0] === "diff") return gitResult("");
        return gitResult("", 2, `unexpected git args: ${args.join(" ")}`);
      },
    });
    betterDiffExtension(pi);
    if (!handler) throw new Error("/diff handler was not registered");

    const ctx = createCommandContextMock({
      customRender(output) {
        rendered = output;
      },
      notify(message, level) {
        notifications.push(`${level}:${message}`);
      },
    });

    await handler("git", ctx);

    expect(notifications).toEqual([]);
    expect(rendered).toContain("Better Diff — Git changes");
    expect(rendered).toContain("Unstaged/untracked changes");
    expect(rendered).toContain("plan.md +1 -0 1 hunk");
    expect(rendered).toContain("does unstaged and staged git works?");
  });
});

function createExtensionApiMock(
  overrides: Partial<ExtensionAPI> = {},
): ExtensionAPI {
  const api: ExtensionAPI = {
    on() {},
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName() {
      return undefined;
    },
    setLabel() {},
    exec() {
      return gitResult("");
    },
    getActiveTools() {
      return [];
    },
    getAllTools() {
      return [];
    },
    setActiveTools() {},
    getCommands() {
      return [];
    },
    setModel() {
      return Promise.resolve(false);
    },
    getThinkingLevel() {
      return "off";
    },
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
  };

  return { ...api, ...overrides };
}

function gitResult(stdout: string, code = 0, stderr = "") {
  return Promise.resolve({
    stdout,
    stderr,
    code,
    killed: false,
  });
}

function createCommandContextMock({
  customRender,
  notify,
}: {
  customRender: (output: string) => void;
  notify: (message: string, level: string) => void;
}): ExtensionCommandContext {
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const tui = {
    terminal: { rows: 40 },
    requestRender() {},
    stop() {},
    start() {},
  } as unknown as TUI;
  const keybindings = {
    matches: () => false,
  } as unknown as KeybindingsManager;

  return {
    hasUI: true,
    cwd: process.cwd(),
    waitForIdle() {
      return Promise.resolve();
    },
    ui: {
      notify,
      custom<T>(
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (result: T) => void,
        ) => { render(width: number): string[] },
      ) {
        const component = factory(tui, theme, keybindings, () => {});
        customRender(component.render(160).join("\n"));
        return Promise.resolve({ type: "close" } as T);
      },
    },
  } as unknown as ExtensionCommandContext;
}
