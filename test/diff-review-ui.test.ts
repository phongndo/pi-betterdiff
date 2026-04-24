import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";

import type {
  ReviewFile,
  ReviewHunk,
  ReviewModel,
  ReviewTurn,
} from "../src/diff/model.js";
import { DiffReviewComponent } from "../src/render/diff-review-ui.js";

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

    expect(rendered).toContain("lines 10-12  edit  +2 -1 src/a.ts");
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

    expect(rendered).toContain("line 7  write  +1 -0 src/a.ts");
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

    expect(rendered).toContain("Better Diff 1 turn • 1 file • 1 hunk • +2 -1");
    expect(rendered).toContain(
      "<selectedBg>› • user: change file +2 -1 1 file 1 hunk</selectedBg>",
    );
    expect(rendered).toContain("src/a.ts +2 -1 1 hunk");
    expect(rendered).toContain("lines 10-12  edit  +2 -1 src/a.ts");
  });

  it("renders pluralized summary, turn, and file counts", () => {
    const model = buildPluralModel();

    const rendered = renderModel(model);

    expect(rendered).toContain(
      "Better Diff 1 turn • 2 files • 3 hunks • +6 -3",
    );
    expect(rendered).toContain("user: change many files +6 -3 2 files 3 hunks");
    expect(rendered).toContain("src/a.ts +3 -1 2 hunks");
    expect(rendered).toContain("src/b.ts +3 -2 1 hunk");
    expect(rendered).toContain("lines 7-9  edit  +2 -1 src/a.ts");
  });

  it("renders summary additions and removals as separate color segments", () => {
    const rendered = renderModel(buildPluralModel(), colorTracingTheme);

    expect(rendered).toContain(
      "<fg:muted>1 turn • 2 files • 3 hunks •</fg:muted> <fg:toolDiffAdded>+6</fg:toolDiffAdded> <fg:toolDiffRemoved>-3</fg:toolDiffRemoved>",
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
      "<selectedBg>› └─ ⊟ src/a.ts +1 -0 1 hunk</selectedBg>",
    );
    expect(rendered).toContain("  • user: change file +1 -0 1 file 1 hunk");
  });

  it("keeps turn navigation on turns while details stay visible until l enters them", () => {
    const component = createComponent(buildTwoTurnModel());

    let rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› • user: first change +1 -0 1 file 1 hunk</selectedBg>",
    );
    expect(rendered).toContain("src/first.ts +1 -0 1 hunk");

    component.handleInput("j");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› user: second change +2 -1 1 file 1 hunk</selectedBg>",
    );
    expect(rendered).toContain("src/second.ts +2 -1 1 hunk");
    expect(rendered).not.toContain("<selectedBg>› └─ ⊟ src/first.ts");

    const detailComponent = createComponent(buildTwoTurnModel());
    detailComponent.handleInput("l");
    rendered = renderComponent(detailComponent);
    expect(rendered).toContain(
      "<selectedBg>› └─ ⊟ src/first.ts +1 -0 1 hunk</selectedBg>",
    );
  });

  it("keeps file navigation on files while hunks stay visible until l enters them", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("l");
    let rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› ├─ ⊟ src/a.ts +3 -1 2 hunks</selectedBg>",
    );
    expect(rendered).toContain("lines 7-9  edit  +2 -1 src/a.ts");

    component.handleInput("j");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› └─ ⊟ src/b.ts +3 -2 1 hunk</selectedBg>",
    );
    expect(rendered).toContain("lines 30-31  write  +3 -2 src/b.ts");
    expect(rendered).not.toContain("<selectedBg>› ├─ ⊞ lines 7-9");

    const hunkComponent = createComponent(buildPluralModel());
    hunkComponent.handleInput("l");
    hunkComponent.handleInput("l");
    rendered = renderComponent(hunkComponent);
    expect(rendered).toContain(
      "<selectedBg>› │  ├─ ⊞ lines 7-9  edit  +2 -1 src/a.ts</selectedBg>",
    );
  });

  it("keeps hunk navigation on hunks while diff lines stay visible until l enters them", () => {
    const component = createComponent(buildPluralModel());

    component.handleInput("l");
    component.handleInput("l");
    component.handleInput("l");
    let rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› │  ├─ ⊟ lines 7-9  edit  +2 -1 src/a.ts</selectedBg>",
    );
    expect(rendered).toContain("+7 changed");

    component.handleInput("j");
    rendered = renderComponent(component);
    expect(rendered).toContain(
      "<selectedBg>› │  └─ ⊞ line 20  edit  +1 -0 src/a.ts</selectedBg>",
    );
    expect(rendered).not.toContain("<selectedBg>› │     +7 changed");

    const diffLineComponent = createComponent(buildPluralModel());
    diffLineComponent.handleInput("l");
    diffLineComponent.handleInput("l");
    diffLineComponent.handleInput("l");
    diffLineComponent.handleInput("l");
    rendered = renderComponent(diffLineComponent);
    expect(rendered).toContain("<selectedBg>› │  │    +7 changed</selectedBg>");
  });
});

function renderModel(model: ReviewModel, renderTheme: Theme = theme): string {
  return renderComponent(createComponent(model, renderTheme));
}

function createComponent(
  model: ReviewModel,
  renderTheme: Theme = theme,
): DiffReviewComponent {
  return new DiffReviewComponent(
    model,
    process.cwd(),
    tui,
    renderTheme,
    keybindings,
    () => {},
  );
}

function renderComponent(component: DiffReviewComponent): string {
  return component.render(200).join("\n");
}

function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
}

interface TestHunk {
  jumpLine: number;
  newLines: number;
  additions: number;
  removals: number;
  toolName: "edit" | "write";
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
      bodyLines: [`+${hunk.jumpLine} changed`],
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
  return {
    turns,
    roots: turns,
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
