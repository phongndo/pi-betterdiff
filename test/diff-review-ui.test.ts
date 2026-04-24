import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";

import type { ReviewHunk, ReviewModel } from "../src/diff/model.js";
import { DiffReviewComponent } from "../src/render/diff-review-ui.js";

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

describe("DiffReviewComponent", () => {
  it("renders hunk labels from structured fields instead of parsing hunk.header", () => {
    const model = buildSingleHunkModel({
      header: "lines 99-100  staged metadata that must not drive rendering",
      jumpLine: 10,
      newLines: 3,
      additions: 2,
      removals: 1,
      toolName: "edit",
    });

    const rendered = renderModel(model);

    expect(rendered).toContain("lines 10-12  edit  +2 -1 src/a.ts");
    expect(rendered).not.toContain("99-100");
    expect(rendered).not.toContain("staged metadata");
  });

  it("renders a singular hunk region from structured fields", () => {
    const model = buildSingleHunkModel({
      header: "garbage header that should be ignored",
      jumpLine: 7,
      newLines: 1,
      additions: 1,
      removals: 0,
      toolName: "write",
    });

    const rendered = renderModel(model);

    expect(rendered).toContain("line 7  write  +1 -0 src/a.ts");
    expect(rendered).not.toContain("garbage header");
  });
});

function renderModel(model: ReviewModel): string {
  const component = new DiffReviewComponent(
    model,
    process.cwd(),
    tui,
    theme,
    keybindings,
    () => {},
  );
  return component.render(200).join("\n");
}

function buildSingleHunkModel(hunkOverrides: Partial<ReviewHunk>): ReviewModel {
  const hunk: ReviewHunk = {
    id: "hunk-1",
    turnId: "turn-1",
    fileId: "file-1",
    path: "src/a.ts",
    entryId: "entry-1",
    toolCallId: "tool-call-1",
    toolName: "edit",
    oldStart: 10,
    oldLines: 1,
    newStart: 10,
    newLines: 1,
    jumpLine: 10,
    header: "line 10  edit  (+1 -0)",
    bodyLines: ["+10 changed"],
    additions: 1,
    removals: 0,
    ...hunkOverrides,
  };
  const file = {
    id: "file-1",
    turnId: "turn-1",
    path: "src/a.ts",
    hunks: [hunk],
    additions: hunk.additions,
    removals: hunk.removals,
  };
  const turn = {
    id: "turn-1",
    ordinal: 1,
    userEntryId: "user-1",
    parentEntryId: null,
    timestamp: "2026-04-24T00:00:00.000Z",
    prompt: "change file",
    files: [file],
    children: [],
    additions: hunk.additions,
    removals: hunk.removals,
  };

  return {
    turns: [turn],
    roots: [turn],
    activeTurnIds: [turn.id],
    totalFiles: 1,
    totalHunks: 1,
    additions: hunk.additions,
    removals: hunk.removals,
  };
}
