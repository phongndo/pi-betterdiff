import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

    const pi: ExtensionAPI = {
      on() {},
      registerTool() {},
      registerCommand(name, options) {
        commandName = name;
        commandDescription = options.description;
      },
      registerShortcut() {
        shortcutCount += 1;
      },
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
        return Promise.resolve({
          stdout: "",
          stderr: "",
          code: 0,
          killed: false,
        });
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

    expect(() => {
      betterDiffExtension(pi);
    }).not.toThrow();

    expect(commandName).toBe("diff");
    expect(commandDescription).toContain("Review");
    expect(shortcutCount).toBe(0);
  });
});
