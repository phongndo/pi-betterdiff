import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { GIT_CHANGES_REVIEW_MODE } from "../src/diff/git.js";
import { SESSION_TURNS_REVIEW_MODE } from "../src/diff/model.js";
import type {
  ReviewFile,
  ReviewHunk,
  ReviewModel,
  ReviewTurn,
} from "../src/diff/model.js";
import {
  DiffReviewComponent,
  type DiffReviewAction,
  type DiffReviewBranchRefsLoader,
  type DiffReviewModelLoader,
} from "../src/render/diff-review-ui.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
} as unknown as Theme;

const colorTracingTheme = {
  fg: (color: string, text: string) => `<fg:${color}>${text}</fg:${color}>`,
  bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
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

describe("DiffReviewComponent", () => {
  it("renders hunk labels from structured fields", () => {
    const model = buildReviewModel({
      files: [
        {
          path: "src/a.ts",
          hunks: [
            {
              jumpLine: 10,
              newLines: 3,
              additions: 2,
              removals: 1,
              toolName: "edit",
            },
          ],
        },
      ],
    });

    const rendered = renderModel(model);

    expect(rendered).toContain("@@ lines 10-12 · edit · +2 -1");
  });

  it("renders a singular hunk region from structured fields", () => {
    const model = buildReviewModel({
      files: [
        {
          path: "src/a.ts",
          hunks: [
            {
              jumpLine: 7,
              newLines: 1,
              additions: 1,
              removals: 0,
              toolName: "write",
            },
          ],
        },
      ],
    });

    const rendered = renderModel(model);

    expect(rendered).toContain("@@ line 7 · write · +1 -0");
  });

  it("renders summary, turn, file, and hunk behavior text", () => {
    const model = buildReviewModel({
      prompt: "change file",
      files: [
        {
          path: "src/a.ts",
          hunks: [
            {
              jumpLine: 10,
              newLines: 3,
              additions: 2,
              removals: 1,
              toolName: "edit",
            },
          ],
        },
      ],
    });

    const rendered = renderModel(model);

    expect(rendered).toContain(
      "Better Diff — Session turns 1 turn • 1 file • 1 hunk • +2 -1",
    );
    expect(rendered).toContain(
      "<selectedBg>› • user: change file +2 -1 1 file 1 hunk</selectedBg>",
    );
    expect(rendered).toContain("src/a.ts +2 -1 1 hunk");
    expect(rendered).toContain("@@ lines 10-12 · edit · +2 -1");
  });

  it("renders pluralized summary, turn, and file counts", () => {
    const model = buildPluralModel();

    const rendered = renderModel(model);

    expect(rendered).toContain(
      "Better Diff — Session turns 1 turn • 2 files • 3 hunks • +6 -3",
    );
    expect(rendered).toContain("user: change many files +6 -3 2 files 3 hunks");
    expect(rendered).toContain("src/a.ts +3 -1 2 hunks");
    expect(rendered).toContain("src/b.ts +3 -2 1 hunk");
    expect(rendered).toContain("@@ lines 7-9 · edit · +2 -1");
  });

  it("fully expands the most recent turn when opened", () => {
    const rendered = renderModel(buildPluralModel());

    expect(rendered).toContain(
      "<selectedBg>› • user: change many files +6 -3 2 files 3 hunks</selectedBg>",
    );
    expect(rendered).toContain("▾ src/a.ts +3 -1 2 hunks");
    expect(rendered).toContain("@@ lines 7-9 · edit · +2 -1");
    expect(rendered).not.toContain("▾ @@ lines 7-9 · edit · +2 -1");
    expect(rendered).toContain("+7 changed");
    expect(rendered).toContain("+20 changed");
    expect(rendered).toContain("+30 changed");
  });

  it("renders summary additions and removals as separate color segments", () => {
    const rendered = renderModel(buildPluralModel(), colorTracingTheme);

    expect(rendered).toContain(
      "<fg:muted>1 turn • 2 files • 3 hunks •</fg:muted> <fg:toolDiffAdded>+6</fg:toolDiffAdded> <fg:toolDiffRemoved>-3</fg:toolDiffRemoved>",
    );
  });

  it("switches diff modes from the in-UI mode menu", async () => {
    const loadedModes: string[] = [];
    const component = createComponent(
      buildReviewModel({
        files: [
          {
            path: "src/a.ts",
            hunks: [
              {
                jumpLine: 7,
                newLines: 1,
                additions: 1,
                removals: 0,
                toolName: "edit",
              },
            ],
          },
        ],
      }),
      theme,
      () => {},
      keybindings,
      process.cwd(),
      (request) => {
        loadedModes.push(request.kind);
        return Promise.resolve(buildGitChangesModel());
      },
    );

    component.handleInput("m");
    let rendered = renderComponent(component);
    expect(rendered).toContain("Actions · diff mode");
    expect(rendered).toContain(
      "✓ Session turns — agent edit/write history by user turn",
    );
    expect(rendered).toContain("Git changes — staged above unstaged");

    component.handleInput("j");
    component.handleInput("\r");
    await flushPromises();

    rendered = renderComponent(component);
    expect(loadedModes).toEqual(["git-changes"]);
    expect(rendered).toContain(
      "Better Diff — Git changes 2 files • 2 hunks • +3 -1",
    );
    expect(rendered).toContain(
      "Staged changes — HEAD → index +1 -0 1 file 1 hunk",
    );
    expect(rendered).toContain("src/staged.ts +1 -0 1 hunk");
    expect(rendered).toContain(
      "Unstaged/untracked changes — index → working tree +2 -1 1 file 1 hunk",
    );
    expect(rendered).toContain("src/unstaged.ts +2 -1 1 hunk");
    expect(rendered.indexOf("Staged changes")).toBeLessThan(
      rendered.indexOf("Unstaged/untracked changes"),
    );
    expect(rendered).not.toContain("user: Staged changes");
  });

  it("opens a branch picker for current branch vs selected branch", async () => {
    const loadedRequests: string[] = [];
    const component = createComponent(
      buildReviewModel({
        files: [
          {
            path: "src/a.ts",
            hunks: [
              {
                jumpLine: 7,
                newLines: 1,
                additions: 1,
                removals: 0,
                toolName: "edit",
              },
            ],
          },
        ],
      }),
      theme,
      () => {},
      keybindings,
      process.cwd(),
      (request) => {
        if (request.kind === "git-branch-selected") {
          loadedRequests.push(`${request.kind}:${request.baseRef}`);
          return Promise.resolve(buildGitBranchModel(request.baseRef));
        }
        loadedRequests.push(request.kind);
        return Promise.resolve(buildGitChangesModel());
      },
      () => Promise.resolve(["main", "release/1.0"]),
    );

    component.handleInput("m");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    await flushPromises();

    let rendered = renderComponent(component);
    expect(rendered).toContain("Actions · base branch/ref");
    expect(rendered).toContain("main — current branch vs main");
    expect(rendered).toContain("release/1.0 — current branch vs release/1.0");

    component.handleInput("j");
    component.handleInput("\r");
    await flushPromises();

    rendered = renderComponent(component);
    expect(loadedRequests).toEqual(["git-branch-selected:release/1.0"]);
    expect(rendered).toContain(
      "Better Diff — Current branch vs release/1.0 1 file • 1 hunk • +4 -2",
    );
    expect(rendered).toContain(
      "merge-base(release/1.0, feature/foo) → feature/foo",
    );
    expect(rendered).toContain(
      "Current branch vs release/1.0 — release/1.0...feature/foo +4 -2 1 file 1 hunk",
    );
  });

  it("marks only the selected row using theme background styling", () => {
    const component = createComponent(
      buildReviewModel({
        files: [
          {
            path: "src/a.ts",
            hunks: [
              {
                jumpLine: 7,
                newLines: 1,
                additions: 1,
                removals: 0,
                toolName: "edit",
              },
            ],
          },
        ],
      }),
    );

    let rendered = renderComponent(component);
    expect(countOccurrences(rendered, "<selectedBg>")).toBe(1);
    expect(rendered).toContain(
      "<selectedBg>› • user: change file +1 -0 1 file 1 hunk</selectedBg>",
    );

    component.handleInput("\t");
    rendered = renderComponent(component);
    expect(countOccurrences(rendered, "<selectedBg>")).toBe(1);
    expect(rendered).toContain(
      "<selectedBg>› └─ ▾ src/a.ts +1 -0 1 hunk</selectedBg>",
    );
    expect(rendered).toContain("  • user: change file +1 -0 1 file 1 hunk");
  });

  it("opens a scoped action menu on enter instead of opening a file", () => {
    const enterAlsoMatchesExternalEditor = {
      matches: (data: string, id: string) =>
        data === "\r" && id === "app.editor.external",
    } as unknown as KeybindingsManager;
    const component = createComponent(
      buildReviewModel({
        files: [
          {
            path: "src/a.ts",
            hunks: [
              {
                jumpLine: 7,
                newLines: 1,
                additions: 1,
                removals: 0,
                toolName: "edit",
              },
            ],
          },
        ],
      }),
      theme,
      () => {},
      enterAlsoMatchesExternalEditor,
    );

    component.handleInput("\r");
    const rendered = renderComponent(component);

    expect(rendered).toContain("Actions · turn 1");
    expect(rendered).toContain("Prompt:");
    expect(rendered).toContain("change file");
    expect(rendered).toContain(
      "Generate summary — Ask the agent to summarize this selected diff scope",
    );
    expect(rendered).toContain(
      "Custom summary… — Add focus instructions before generating the summary",
    );
    expect(rendered).not.toContain("Jump to native /tree");
    expect(rendered).toContain(
      "Undo this turn — user: change file · 1 edit hunk / 1 file",
    );
    expect(rendered).not.toContain("Undo path to root");
    expect(rendered).not.toContain("File no longer exists");
  });

  it("wraps the full selected prompt in the action menu", () => {
    const prompt =
      "start of a very long BetterDiff prompt " +
      "with enough words to wrap across several narrow terminal lines " +
      "while preserving the final important instruction";
    const component = createComponent(
      buildReviewModel({
        prompt,
        files: [
          {
            path: "src/a.ts",
            hunks: [
              {
                jumpLine: 7,
                newLines: 1,
                additions: 1,
                removals: 0,
                toolName: "edit",
              },
            ],
          },
        ],
      }),
    );

    component.handleInput("\r");
    const rendered = renderComponent(component, 72);

    expect(rendered).toContain("Actions · turn 1");
    expect(rendered).toContain("Prompt:");
    expect(rendered).toContain("start of a very long BetterDiff prompt");
    expect(rendered).toContain("important instruction");
    expect(rendered).not.toContain("Actions · turn 1: start of a very long");
  });

  it("returns a generate-summary action from the scoped action menu", () => {
    let action: DiffReviewAction | undefined;
    const component = createComponent(buildPluralModel(), theme, (result) => {
      action = result;
    });

    component.handleInput("\r");
    component.handleInput("\r");

    expect(action?.type).toBe("summarize");
    if (action?.type !== "summarize") return;
    expect(action.custom).toBe(false);
    expect(action.summary.title).toBe("turn 1: change many files");
    expect(action.summary.body).toContain("Prompt: change many files");
    expect(action.summary.body).toContain("File: src/a.ts");
    expect(action.summary.body).toContain("+7 changed");
  });

  it("cancels the scoped action menu without closing the diff review", () => {
    let closeCount = 0;
    const component = createComponent(buildPluralModel(), theme, (action) => {
      if (action.type === "close") closeCount += 1;
    });

    component.handleInput("\r");
    component.handleInput("\x1b");
    const rendered = renderComponent(component);

    expect(closeCount).toBe(0);
    expect(rendered).not.toContain("Actions ·");
    expect(rendered).toContain(
      "<selectedBg>› • user: change many files +6 -3 2 files 3 hunks</selectedBg>",
    );
  });

  it("offers undo-scoped file actions from the enter menu", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("\t");
    component.handleInput("\r");
    const rendered = renderComponent(component);

    expect(rendered).toContain("Actions · file src/a.ts");
    expect(rendered).toContain(
      "Undo this file in this turn — src/a.ts · 2 edit hunks / 1 file",
    );
    expect(rendered).toContain(
      "Undo this turn — user: change many files · 2 edit hunks / 1 file",
    );
  });

  it("confirms undo-scoped hunk actions from the enter menu", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("l");
    component.handleInput("\r");
    let rendered = renderComponent(component);
    expect(rendered).toContain("Actions · hunk src/a.ts:7");
    expect(rendered).toContain(
      "Undo this hunk — src/a.ts · 1 edit hunk / 1 file",
    );

    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    rendered = renderComponent(component);
    expect(rendered).toContain("Actions · confirm undo this hunk");
    expect(rendered).toContain(
      "Confirm undo this hunk — Reverse 1 edit hunk / 1 file in the working tree",
    );
  });

  it("undoes selected edit hunks after confirmation", () => {
    const cwd = mkdtempSync(join(tmpdir(), "betterdiff-undo-"));
    try {
      writeFileSync(join(cwd, "a.ts"), "before\nnew\nafter\n", "utf8");
      const component = createComponent(
        buildReviewModel({
          files: [
            {
              path: "a.ts",
              hunks: [
                {
                  jumpLine: 2,
                  newLines: 1,
                  additions: 1,
                  removals: 1,
                  toolName: "edit",
                  bodyLines: [" 1 before", "-2 old", "+2 new", " 3 after"],
                },
              ],
            },
          ],
        }),
        theme,
        () => {},
        keybindings,
        cwd,
      );

      component.handleInput("\r");
      component.handleInput("j");
      component.handleInput("j");
      component.handleInput("j");
      component.handleInput("\r");
      component.handleInput("\r");

      expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe(
        "before\nold\nafter\n",
      );
      expect(renderComponent(component)).toContain(
        "Undo this turn: reversed 1 edit hunk in 1 file.",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("moves linearly through visible detail rows and l enters hunk headers", () => {
    const component = createComponent(buildTwoTurnModel());

    let rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› • user: first change +1 -0 1 file 1 hunk</selectedBg>",
    );
    expect(rendered).toContain("src/first.ts +1 -0 1 hunk");

    component.handleInput("j");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› └─ ▾ src/first.ts +1 -0 1 hunk</selectedBg>",
    );
    expect(rendered).not.toContain("src/second.ts +2 -1 1 hunk");

    component.handleInput("l");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>›    @@ line 1 · edit · +1 -0</selectedBg>",
    );
  });

  it("uses scoped item offsets for turn page movement without opening details", () => {
    const component = createComponent(buildTwoTurnModel());

    component.handleInput("\u001b[C");
    let rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› user: second change +2 -1 1 file 1 hunk</selectedBg>",
    );
    expect(rendered).not.toContain("src/second.ts +2 -1 1 hunk");

    component.handleInput("\u001b[D");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› • user: first change +1 -0 1 file 1 hunk</selectedBg>",
    );
    expect(rendered).not.toContain("src/first.ts +1 -0 1 hunk");
  });

  it("collapses selected turn details with h and re-enters them with l", () => {
    const component = createComponent(
      buildReviewModel({
        files: [
          {
            path: "src/a.ts",
            hunks: [
              {
                jumpLine: 7,
                newLines: 1,
                additions: 1,
                removals: 0,
                toolName: "edit",
              },
            ],
          },
        ],
      }),
    );

    let rendered = renderComponent(component);
    expect(rendered).toContain("src/a.ts +1 -0 1 hunk");

    component.handleInput("h");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› • user: change file +1 -0 1 file 1 hunk</selectedBg>",
    );
    expect(rendered).not.toContain("src/a.ts +1 -0 1 hunk");

    component.handleInput("l");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>›    @@ line 7 · edit · +1 -0</selectedBg>",
    );

    component.handleInput("h");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› • user: change file +1 -0 1 file 1 hunk</selectedBg>",
    );
  });

  it("scopes c/e to selected turn details", () => {
    const component = createComponent(
      buildReviewModel({
        files: [
          {
            path: "src/a.ts",
            hunks: [
              {
                jumpLine: 7,
                newLines: 1,
                additions: 1,
                removals: 0,
                toolName: "edit",
              },
            ],
          },
        ],
      }),
    );

    let rendered = renderComponent(component);
    expect(rendered).toContain("src/a.ts +1 -0 1 hunk");

    component.handleInput("c");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› • user: change file +1 -0 1 file 1 hunk</selectedBg>",
    );
    expect(rendered).not.toContain("src/a.ts +1 -0 1 hunk");

    component.handleInput("e");
    rendered = renderComponent(component);
    expect(rendered).toContain("src/a.ts +1 -0 1 hunk");
  });

  it("scopes c/e to file rows when selected on a file", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("\t");
    let rendered = renderComponent(component);
    expect(rendered).toContain("@@ lines 7-9 · edit · +2 -1");
    expect(rendered).toContain("@@ lines 30-31 · write · +3 -2");

    component.handleInput("c");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› ├─ ▸ src/a.ts +3 -1 2 hunks</selectedBg>",
    );
    expect(rendered).not.toContain("@@ lines 7-9 · edit · +2 -1");
    expect(rendered).not.toContain("@@ lines 30-31 · write · +3 -2");

    component.handleInput("e");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› ├─ ▾ src/a.ts +3 -1 2 hunks</selectedBg>",
    );
    expect(rendered).toContain("@@ lines 7-9 · edit · +2 -1");
    expect(rendered).toContain("@@ lines 30-31 · write · +3 -2");
  });

  it("expands all files and hunks when pressing e on a turn", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("\t");
    component.handleInput("c");
    let rendered = renderComponent(component);
    expect(rendered).not.toContain("@@ lines 7-9 · edit · +2 -1");
    expect(rendered).not.toContain("@@ lines 30-31 · write · +3 -2");

    component.handleInput("\t");
    component.handleInput("e");
    rendered = renderComponent(component);

    expect(rendered).toContain(
      "<selectedBg>› • user: change many files +6 -3 2 files 3 hunks</selectedBg>",
    );
    expect(rendered).toContain("@@ lines 7-9 · edit · +2 -1");
    expect(rendered).toContain("@@ lines 30-31 · write · +3 -2");
  });

  it("keeps hunk rows non-collapsible", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("j");
    component.handleInput("j");
    let rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› │  @@ lines 7-9 · edit · +2 -1</selectedBg>",
    );
    expect(rendered).toContain("+7 changed");
    expect(rendered).toContain("+20 changed");
    expect(rendered).toContain("+30 changed");

    component.handleInput("c");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› │  @@ lines 7-9 · edit · +2 -1</selectedBg>",
    );
    expect(rendered).toContain("+7 changed");
    expect(rendered).toContain("+20 changed");
    expect(rendered).toContain("+30 changed");
    expect(rendered).not.toContain("▸ @@ lines 7-9");
    expect(rendered).not.toContain("▾ @@ lines 7-9");
  });

  it("jumps between files while hunks stay visible until l enters diff lines", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("\t");
    let rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› ├─ ▾ src/a.ts +3 -1 2 hunks</selectedBg>",
    );
    expect(rendered).toContain("@@ lines 7-9 · edit · +2 -1");

    component.handleInput("]");
    component.handleInput("f");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› └─ ▾ src/b.ts +3 -2 1 hunk</selectedBg>",
    );
    expect(rendered).toContain("@@ lines 30-31 · write · +3 -2");
    expect(rendered).not.toContain("<selectedBg>› ▸ @@ lines 7-9");
    expect(rendered).not.toContain("<selectedBg>› ▾ @@ lines 7-9");

    const hunkComponent = createComponent(buildPluralModel());
    hunkComponent.handleInput("l");
    rendered = renderComponent(hunkComponent);
    expect(rendered).toContain(
      "<selectedBg>› │  @@ lines 7-9 · edit · +2 -1</selectedBg>",
    );
  });

  it("supports ]h and [h hunk jumps", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("l");
    component.handleInput("]");
    component.handleInput("h");
    let rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› │  @@ line 20 · edit · +1 -0</selectedBg>",
    );

    component.handleInput("[h");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› │  @@ lines 7-9 · edit · +2 -1</selectedBg>",
    );
  });

  it("does not bind bare ] or [", () => {
    vi.useFakeTimers();
    try {
      const component = createComponent(buildPluralModel());

      component.handleInput("l");
      component.handleInput("]");
      vi.advanceTimersByTime(650);
      let rendered = renderComponent(component);
      expect(rendered).toContain(
        "<selectedBg>› │  @@ lines 7-9 · edit · +2 -1</selectedBg>",
      );

      component.handleInput("[");
      vi.advanceTimersByTime(650);
      rendered = renderComponent(component);
      expect(rendered).toContain(
        "<selectedBg>› │  @@ lines 7-9 · edit · +2 -1</selectedBg>",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses page movement across visible rows", () => {
    const component = createComponent(buildThreeFileModel());

    component.handleInput("l");
    component.handleInput("\u001b[C");
    let rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› └─ ▾ src/c.ts +3 -0 1 hunk</selectedBg>",
    );

    component.handleInput("\u001b[D");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› • user: change three files +6 -0 3 files 3 hunks</selectedBg>",
    );
  });

  it("moves linearly between hunk headers and diff lines", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("l");
    let rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› │  @@ lines 7-9 · edit · +2 -1</selectedBg>",
    );

    component.handleInput("l");
    rendered = renderComponent(component);
    expect(rendered).toContain("<selectedBg>› │    +7 changed</selectedBg>");

    component.handleInput("j");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› │  @@ line 20 · edit · +1 -0</selectedBg>",
    );

    const hunkComponent = createComponent(buildPluralModel());
    hunkComponent.handleInput("j");
    hunkComponent.handleInput("j");
    rendered = renderComponent(hunkComponent);
    expect(rendered).toContain(
      "<selectedBg>› │  @@ lines 7-9 · edit · +2 -1</selectedBg>",
    );
  });

  it("uses page movement while reviewing diff lines", () => {
    const component = createComponent(buildThreeHunkModel());

    component.handleInput("l");
    component.handleInput("\u001b[C");
    let rendered = renderComponent(component);
    expect(rendered).toContain(" +30 changed</selectedBg>");

    component.handleInput("\u001b[D");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› • user: change three hunks +6 -0 1 file 3 hunks</selectedBg>",
    );
  });

  it("searches visible BetterDiff rows and cycles matches", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("/");
    for (const char of "src/b.ts") component.handleInput(char);
    let rendered = renderComponent(component);

    expect(rendered).toContain("Search: src/b.ts▌  1/2");
    expect(rendered).toContain(
      "<selectedBg>› └─ ▾ src/b.ts +3 -2 1 hunk</selectedBg>",
    );

    component.handleInput("\r");
    component.handleInput("n");
    rendered = renderComponent(component);
    expect(rendered).toContain("Search: src/b.ts  2/2");
    expect(rendered).toContain(
      "<selectedBg>›    @@ lines 30-31 · write · +3 -2</selectedBg>",
    );

    component.handleInput("N");
    rendered = renderComponent(component);
    expect(rendered).toContain("Search: src/b.ts  1/2");
    expect(rendered).toContain(
      "<selectedBg>› └─ ▾ src/b.ts +3 -2 1 hunk</selectedBg>",
    );
  });

  it("searches semantic turn, file, and hunk text", () => {
    const turnComponent = createComponent(buildPluralModel());
    turnComponent.handleInput("/");
    for (const char of "user +6 -3 2 files 3 hunks") {
      turnComponent.handleInput(char);
    }
    let rendered = renderComponent(turnComponent);
    expect(rendered).toContain("Search: user +6 -3 2 files 3 hunks▌  1/1");
    expect(rendered).toContain(
      "<selectedBg>› • user: change many files +6 -3 2 files 3 hunks</selectedBg>",
    );

    const fileComponent = createComponent(buildPluralModel());
    fileComponent.handleInput("/");
    for (const char of "src/a.ts +3 -1 2 hunks") {
      fileComponent.handleInput(char);
    }
    rendered = renderComponent(fileComponent);
    expect(rendered).toContain("Search: src/a.ts +3 -1 2 hunks▌  1/1");
    expect(rendered).toContain(
      "<selectedBg>› ├─ ▾ src/a.ts +3 -1 2 hunks</selectedBg>",
    );

    const hunkComponent = createComponent(buildPluralModel());
    hunkComponent.handleInput("/");
    for (const char of "lines 7-9 edit +2 -1 src/a.ts") {
      hunkComponent.handleInput(char);
    }
    rendered = renderComponent(hunkComponent);
    expect(rendered).toContain("Search: lines 7-9 edit +2 -1 src/a.ts▌  1/1");
    expect(rendered).toContain(
      "<selectedBg>› │  @@ lines 7-9 · edit · +2 -1</selectedBg>",
    );
  });

  it("clears an in-progress search with escape without closing review", () => {
    let closeCount = 0;
    const component = createComponent(buildPluralModel(), theme, (action) => {
      if (action.type === "close") closeCount += 1;
    });

    component.handleInput("/");
    for (const char of "src/b.ts") component.handleInput(char);
    expect(renderComponent(component)).toContain("Search: src/b.ts▌  1/2");

    component.handleInput("\x1b");
    const rendered = renderComponent(component);

    expect(closeCount).toBe(0);
    expect(rendered).not.toContain("Search:");
    expect(rendered).not.toContain("src/b.ts▌");
  });

  it("clears a kept search with escape before closing review", () => {
    let closeCount = 0;
    const component = createComponent(buildPluralModel(), theme, (action) => {
      if (action.type === "close") closeCount += 1;
    });

    component.handleInput("/");
    for (const char of "src/b.ts") component.handleInput(char);
    component.handleInput("\r");
    expect(renderComponent(component)).toContain("Search: src/b.ts  1/2");

    component.handleInput("\x1b");
    let rendered = renderComponent(component);
    expect(closeCount).toBe(0);
    expect(rendered).not.toContain("Search:");

    component.handleInput("\x1b");
    rendered = renderComponent(component);
    expect(closeCount).toBe(1);
    expect(rendered).not.toContain("Search:");
  });

  it("hides search after backspacing to an empty query and confirming", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("/");
    for (const char of "zz") component.handleInput(char);
    component.handleInput("\x7f");
    component.handleInput("\x7f");
    let rendered = renderComponent(component);

    expect(rendered).toContain("Search: (type query)▌");
    expect(rendered).toContain(
      "<selectedBg>› • user: change many files +6 -3 2 files 3 hunks</selectedBg>",
    );

    component.handleInput("\r");
    rendered = renderComponent(component);
    expect(rendered).not.toContain("Search:");
  });

  it("starts a fresh query when reopening search", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("/");
    for (const char of "src/b.ts") component.handleInput(char);
    component.handleInput("\r");
    expect(renderComponent(component)).toContain("Search: src/b.ts  1/2");

    component.handleInput("/");
    let rendered = renderComponent(component);
    expect(rendered).toContain("Search: (type query)▌");
    expect(rendered).not.toContain("Search: src/b.ts");

    for (const char of "src/a.ts") component.handleInput(char);
    rendered = renderComponent(component);
    expect(rendered).toContain("Search: src/a.ts▌  1/3");
    expect(rendered).toContain(
      "<selectedBg>› ├─ ▾ src/a.ts +3 -1 2 hunks</selectedBg>",
    );
  });

  it("clears search when switching diff modes", async () => {
    const component = createComponent(
      buildPluralModel(),
      theme,
      () => {},
      keybindings,
      process.cwd(),
      () => Promise.resolve(buildGitChangesModel()),
    );

    component.handleInput("/");
    for (const char of "src/a.ts") component.handleInput(char);
    component.handleInput("\r");
    expect(renderComponent(component)).toContain("Search: src/a.ts  1/3");

    component.handleInput("m");
    component.handleInput("j");
    component.handleInput("\r");
    await flushPromises();

    const rendered = renderComponent(component);
    expect(rendered).toContain("Better Diff — Git changes");
    expect(rendered).not.toContain("Search:");
  });

  it("does not search rows hidden by collapsed file details", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("\t");
    component.handleInput("c");
    component.handleInput("/");
    for (const char of "line 7") component.handleInput(char);
    const rendered = renderComponent(component);

    expect(rendered).toContain("Search: line 7▌  no matches");
    expect(rendered).toContain(
      "<selectedBg>› • user: change many files +6 -3 2 files 3 hunks</selectedBg>",
    );
    expect(rendered).toContain("▸ src/a.ts +3 -1 2 hunks");
    expect(rendered).not.toContain("@@ lines 7-9 · edit · +2 -1");
  });

  it("greps hidden BetterDiff content and reveals the matched row", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("\t");
    component.handleInput("c");
    component.handleInput("?");
    for (const char of "line 7") component.handleInput(char);
    const rendered = renderComponent(component);

    expect(rendered).toContain("Grep all: line 7▌  1/1");
    expect(rendered).toContain("▾ src/a.ts +3 -1 2 hunks");
    expect(rendered).toContain(
      "<selectedBg>› │  @@ lines 7-9 · edit · +2 -1</selectedBg>",
    );
  });

  it("greps diff body content and reveals the matched diff line", () => {
    const component = createComponent(
      buildReviewModel({
        files: [
          {
            path: "src/a.ts",
            hunks: [
              {
                jumpLine: 5,
                newLines: 1,
                additions: 1,
                removals: 0,
                toolName: "edit",
                bodyLines: ["+5 uniqueDiffNeedle"],
              },
            ],
          },
        ],
      }),
    );

    component.handleInput("?");
    for (const char of "uniqueDiffNeedle") component.handleInput(char);
    const rendered = renderComponent(component);

    expect(rendered).toContain("Grep all: uniqueDiffNeedle▌  1/1");
    expect(rendered).toMatch(
      /<selectedBg>›\s+\+5 uniqueDiffNeedle<\/selectedBg>/u,
    );
  });

  it("cycles grep matches across collapsed file details", () => {
    const component = createComponent(
      buildReviewModel({
        files: [
          {
            path: "src/a.ts",
            hunks: [
              {
                jumpLine: 7,
                newLines: 1,
                additions: 1,
                removals: 0,
                toolName: "edit",
                bodyLines: ["+7 sharedNeedle first"],
              },
            ],
          },
          {
            path: "src/b.ts",
            hunks: [
              {
                jumpLine: 30,
                newLines: 1,
                additions: 1,
                removals: 0,
                toolName: "edit",
                bodyLines: ["+30 sharedNeedle second"],
              },
            ],
          },
        ],
      }),
    );

    component.handleInput("l");
    component.handleInput("c");
    component.handleInput("?");
    for (const char of "sharedNeedle") component.handleInput(char);
    let rendered = renderComponent(component);
    expect(rendered).toContain("Grep all: sharedNeedle▌  1/2");
    expect(rendered).toContain("+7 sharedNeedle first</selectedBg>");

    component.handleInput("\r");
    component.handleInput("n");
    rendered = renderComponent(component);
    expect(rendered).toContain("Grep all: sharedNeedle  2/2");
    expect(rendered).toContain("+30 sharedNeedle second</selectedBg>");

    component.handleInput("N");
    rendered = renderComponent(component);
    expect(rendered).toContain("Grep all: sharedNeedle  1/2");
    expect(rendered).toContain("+7 sharedNeedle first</selectedBg>");
  });

  it("does not fold a linear root turn with h", () => {
    const component = createComponent(buildLinearBranchModel());

    component.handleInput("h");
    let rendered = renderComponent(component);
    expect(rendered).toContain("user: child change");
    expect(rendered).not.toContain("⊞ • user: root change");

    component.handleInput("h");
    rendered = renderComponent(component);
    expect(rendered).toContain("user: child change");
    expect(rendered).not.toContain("⊞ • user: root change");
  });

  it("greps through folded branch ancestors and reveals the matched diff line", () => {
    const component = createComponent(buildBranchModel());

    component.handleInput("c");
    let rendered = renderComponent(component);
    expect(rendered).toContain("⊞ • user: root change");
    expect(rendered).not.toContain("child change");

    component.handleInput("?");
    for (const char of "foldedNeedle") component.handleInput(char);
    rendered = renderComponent(component);

    expect(rendered).toContain("Grep all: foldedNeedle▌  1/1");
    expect(rendered).toContain("user: child change");
    expect(rendered).toContain("+2 foldedNeedle</selectedBg>");
  });

  it("greps across turns whose details are not currently rendered", () => {
    const component = createComponent(buildTwoTurnModel());

    component.handleInput("?");
    for (const char of "second.ts") component.handleInput(char);
    const rendered = renderComponent(component);

    expect(rendered).toContain("Grep all: second.ts▌  1/2");
    expect(rendered).toContain(
      "<selectedBg>› └─ ▾ src/second.ts +2 -1 1 hunk</selectedBg>",
    );
    expect(rendered).toContain("@@ lines 2-3 · write · +2 -1");
  });
});

function renderModel(model: ReviewModel, renderTheme: Theme = theme): string {
  return renderComponent(createComponent(model, renderTheme));
}

function createComponent(
  model: ReviewModel,
  renderTheme: Theme = theme,
  done: (action: DiffReviewAction) => void = () => {},
  componentKeybindings: KeybindingsManager = keybindings,
  cwd: string = process.cwd(),
  modelLoader?: DiffReviewModelLoader,
  branchRefsLoader?: DiffReviewBranchRefsLoader,
): DiffReviewComponent {
  return new DiffReviewComponent(
    model,
    cwd,
    tui,
    renderTheme,
    componentKeybindings,
    done,
    modelLoader,
    branchRefsLoader,
  );
}

function renderComponent(component: DiffReviewComponent, width = 200): string {
  return component.render(width).join("\n");
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
}

interface TestHunk {
  jumpLine: number;
  newLines: number;
  additions: number;
  removals: number;
  toolName: "edit" | "write" | "git";
  bodyLines?: string[];
}

interface TestFile {
  path: string;
  hunks: TestHunk[];
}

function buildPluralModel(): ReviewModel {
  return buildReviewModel({
    prompt: "change many files",
    files: [
      {
        path: "src/a.ts",
        hunks: [
          {
            jumpLine: 7,
            newLines: 3,
            additions: 2,
            removals: 1,
            toolName: "edit",
          },
          {
            jumpLine: 20,
            newLines: 1,
            additions: 1,
            removals: 0,
            toolName: "edit",
          },
        ],
      },
      {
        path: "src/b.ts",
        hunks: [
          {
            jumpLine: 30,
            newLines: 2,
            additions: 3,
            removals: 2,
            toolName: "write",
          },
        ],
      },
    ],
  });
}

function buildGitChangesModel(): ReviewModel {
  const stagedTurn = buildReviewTurn({
    turnId: "git-changes-staged-turn",
    ordinal: 1,
    prompt: "Staged changes — HEAD → index",
    files: [
      {
        path: "src/staged.ts",
        hunks: [
          {
            jumpLine: 3,
            newLines: 1,
            additions: 1,
            removals: 0,
            toolName: "git",
            bodyLines: ["+staged change"],
          },
        ],
      },
    ],
  });
  const unstagedTurn = buildReviewTurn({
    turnId: "git-changes-unstaged-turn",
    ordinal: 2,
    prompt: "Unstaged/untracked changes — index → working tree",
    files: [
      {
        path: "src/unstaged.ts",
        hunks: [
          {
            jumpLine: 9,
            newLines: 2,
            additions: 2,
            removals: 1,
            toolName: "git",
            bodyLines: ["-old unstaged", "+new unstaged", "+extra unstaged"],
          },
        ],
      },
    ],
  });
  return {
    ...buildReviewModelFromTurns([stagedTurn, unstagedTurn], [stagedTurn.id]),
    mode: GIT_CHANGES_REVIEW_MODE,
  };
}

function buildGitBranchModel(baseRef: string): ReviewModel {
  const turn = buildReviewTurn({
    turnId: "git-branch-turn",
    ordinal: 1,
    prompt: `Current branch vs ${baseRef} — ${baseRef}...feature/foo`,
    files: [
      {
        path: "src/branch.ts",
        hunks: [
          {
            jumpLine: 11,
            newLines: 4,
            additions: 4,
            removals: 2,
            toolName: "git",
            bodyLines: ["-old branch", "+new branch"],
          },
        ],
      },
    ],
  });
  return {
    ...buildReviewModelFromTurns([turn], [turn.id]),
    mode: {
      kind: "git-branch-selected",
      label: `Current branch vs ${baseRef}`,
      description: `merge-base(${baseRef}, feature/foo) → feature/foo`,
      baseRef,
      emptyTitle: `No branch changes found for ${baseRef}...feature/foo.`,
    },
  };
}

function buildThreeFileModel(): ReviewModel {
  return buildReviewModel({
    prompt: "change three files",
    files: [
      {
        path: "src/a.ts",
        hunks: [
          {
            jumpLine: 10,
            newLines: 1,
            additions: 1,
            removals: 0,
            toolName: "edit",
          },
        ],
      },
      {
        path: "src/b.ts",
        hunks: [
          {
            jumpLine: 20,
            newLines: 1,
            additions: 2,
            removals: 0,
            toolName: "edit",
          },
        ],
      },
      {
        path: "src/c.ts",
        hunks: [
          {
            jumpLine: 30,
            newLines: 1,
            additions: 3,
            removals: 0,
            toolName: "edit",
          },
        ],
      },
    ],
  });
}

function buildThreeHunkModel(): ReviewModel {
  return buildReviewModel({
    prompt: "change three hunks",
    files: [
      {
        path: "src/a.ts",
        hunks: [
          {
            jumpLine: 10,
            newLines: 1,
            additions: 1,
            removals: 0,
            toolName: "edit",
          },
          {
            jumpLine: 20,
            newLines: 1,
            additions: 2,
            removals: 0,
            toolName: "edit",
          },
          {
            jumpLine: 30,
            newLines: 1,
            additions: 3,
            removals: 0,
            toolName: "edit",
          },
        ],
      },
    ],
  });
}

function buildTwoTurnModel(): ReviewModel {
  const turns = [
    buildReviewTurn({
      turnId: "turn-1",
      ordinal: 1,
      prompt: "first change",
      files: [
        {
          path: "src/first.ts",
          hunks: [
            {
              jumpLine: 1,
              newLines: 1,
              additions: 1,
              removals: 0,
              toolName: "edit",
            },
          ],
        },
      ],
    }),
    buildReviewTurn({
      turnId: "turn-2",
      ordinal: 2,
      prompt: "second change",
      files: [
        {
          path: "src/second.ts",
          hunks: [
            {
              jumpLine: 2,
              newLines: 2,
              additions: 2,
              removals: 1,
              toolName: "write",
            },
          ],
        },
      ],
    }),
  ];
  return buildReviewModelFromTurns(turns, ["turn-1"]);
}

function buildLinearBranchModel(): ReviewModel {
  const root = buildReviewTurn({
    turnId: "turn-root",
    ordinal: 1,
    prompt: "root change",
    files: [
      {
        path: "src/root.ts",
        hunks: [
          {
            jumpLine: 1,
            newLines: 1,
            additions: 1,
            removals: 0,
            toolName: "edit",
          },
        ],
      },
    ],
  });
  const child = buildReviewTurn({
    turnId: "turn-child",
    ordinal: 2,
    prompt: "child change",
    files: [
      {
        path: "src/child.ts",
        hunks: [
          {
            jumpLine: 2,
            newLines: 1,
            additions: 1,
            removals: 0,
            toolName: "edit",
            bodyLines: ["+2 foldedNeedle"],
          },
        ],
      },
    ],
  });
  root.children = [child];
  return buildReviewModelFromRoots([root], [root, child], [root.id]);
}

function buildBranchModel(): ReviewModel {
  const model = buildLinearBranchModel();
  const root = model.roots[0];
  if (!root) return model;

  const sibling = buildReviewTurn({
    turnId: "turn-sibling",
    ordinal: 3,
    prompt: "sibling change",
    files: [
      {
        path: "src/sibling.ts",
        hunks: [
          {
            jumpLine: 3,
            newLines: 1,
            additions: 1,
            removals: 0,
            toolName: "edit",
          },
        ],
      },
    ],
  });
  root.children = [...root.children, sibling];
  return buildReviewModelFromRoots(
    [root],
    [...model.turns, sibling],
    [root.id],
  );
}

function buildReviewModel({
  prompt = "change file",
  files,
}: {
  prompt?: string;
  files: TestFile[];
}): ReviewModel {
  const turn = buildReviewTurn({
    turnId: "turn-1",
    ordinal: 1,
    prompt,
    files,
  });
  return buildReviewModelFromTurns([turn], [turn.id]);
}

function buildReviewTurn({
  turnId,
  ordinal,
  prompt,
  files,
}: {
  turnId: string;
  ordinal: number;
  prompt: string;
  files: TestFile[];
}): ReviewTurn {
  const reviewFiles: ReviewFile[] = files.map((file, fileIndex) => {
    const fileId = `${turnId}:file-${fileIndex + 1}`;
    const hunks: ReviewHunk[] = file.hunks.map((hunk, hunkIndex) => ({
      id: `${turnId}:hunk-${fileIndex + 1}-${hunkIndex + 1}`,
      turnId,
      fileId,
      path: file.path,
      entryId: `${turnId}:entry-${fileIndex + 1}-${hunkIndex + 1}`,
      toolCallId: `${turnId}:tool-call-${fileIndex + 1}-${hunkIndex + 1}`,
      toolName: hunk.toolName,
      oldStart: hunk.jumpLine,
      oldLines: hunk.newLines,
      newStart: hunk.jumpLine,
      newLines: hunk.newLines,
      jumpLine: hunk.jumpLine,
      bodyLines: hunk.bodyLines ?? [`+${hunk.jumpLine} changed`],
      additions: hunk.additions,
      removals: hunk.removals,
    }));

    return {
      id: fileId,
      turnId,
      path: file.path,
      hunks,
      additions: hunks.reduce((total, hunk) => total + hunk.additions, 0),
      removals: hunks.reduce((total, hunk) => total + hunk.removals, 0),
    };
  });

  return {
    id: turnId,
    ordinal,
    userEntryId: `${turnId}:user`,
    parentEntryId: null,
    timestamp: "2026-04-24T00:00:00.000Z",
    prompt,
    files: reviewFiles,
    children: [],
    additions: reviewFiles.reduce((total, file) => total + file.additions, 0),
    removals: reviewFiles.reduce((total, file) => total + file.removals, 0),
  };
}

function buildReviewModelFromTurns(
  turns: ReviewTurn[],
  activeTurnIds: string[],
): ReviewModel {
  return buildReviewModelFromRoots(turns, turns, activeTurnIds);
}

function buildReviewModelFromRoots(
  roots: ReviewTurn[],
  turns: ReviewTurn[],
  activeTurnIds: string[],
): ReviewModel {
  return {
    mode: SESSION_TURNS_REVIEW_MODE,
    turns,
    roots,
    activeTurnIds,
    totalFiles: turns.reduce((total, turn) => total + turn.files.length, 0),
    totalHunks: turns.reduce(
      (total, turn) =>
        total +
        turn.files.reduce(
          (fileTotal, file) => fileTotal + file.hunks.length,
          0,
        ),
      0,
    ),
    additions: turns.reduce((total, turn) => total + turn.additions, 0),
    removals: turns.reduce((total, turn) => total + turn.removals, 0),
  };
}
