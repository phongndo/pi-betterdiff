import { describe, expect, it } from "vitest";

import {
  gitBranchDiffArgs,
  gitDiffArgs,
  parseGitBranchReviewModel,
  parseGitChangesReviewModel,
} from "../src/diff/git.js";

const modifiedPatch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " import { a } from './a';",
  "-const oldValue = 1;",
  "+const newValue = 2;",
  "+const added = true;",
  " export { newValue };",
].join("\n");

describe("parseGitChangesReviewModel", () => {
  it("renders staged changes above unstaged changes in one model", () => {
    const unstagedPatch = [
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -5 +5 @@",
      "-old",
      "+new",
    ].join("\n");

    const model = parseGitChangesReviewModel(modifiedPatch, unstagedPatch);

    expect(model.mode.label).toBe("Git changes");
    expect(model.totalFiles).toBe(2);
    expect(model.totalHunks).toBe(2);
    expect(model.additions).toBe(3);
    expect(model.removals).toBe(2);
    expect(model.turns.map((turn) => turn.prompt)).toEqual([
      "Staged changes — HEAD → index",
      "Unstaged changes — index → working tree",
    ]);
    expect(model.roots.map((turn) => turn.id)).toEqual([
      "git:changes:staged",
      "git:changes:unstaged",
    ]);
    expect(model.turns[0]?.files[0]?.path).toBe("src/a.ts");
    expect(model.turns[1]?.files[0]?.path).toBe("src/b.ts");
  });

  it("parses modified-file patches into review files and hunks", () => {
    const model = parseGitChangesReviewModel(modifiedPatch, "");

    expect(model.totalFiles).toBe(1);
    expect(model.totalHunks).toBe(1);
    expect(model.additions).toBe(2);
    expect(model.removals).toBe(1);
    expect(model.turns[0]?.files[0]?.path).toBe("src/a.ts");
    expect(model.turns[0]?.files[0]?.hunks[0]).toMatchObject({
      toolName: "git",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      jumpLine: 1,
      additions: 2,
      removals: 1,
    });
    expect(model.turns[0]?.files[0]?.hunks[0]?.bodyLines).toEqual([
      " import { a } from './a';",
      "-const oldValue = 1;",
      "+const newValue = 2;",
      "+const added = true;",
      " export { newValue };",
    ]);
  });

  it("keeps an empty staged section above non-empty unstaged changes", () => {
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+export const created = true;",
      "+export const value = 1;",
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "index 2222222..0000000",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-export const removed = true;",
      "-export const value = 0;",
    ].join("\n");

    const model = parseGitChangesReviewModel("", patch);

    expect(model.turns).toHaveLength(2);
    expect(model.turns[0]?.prompt).toBe("Staged changes — HEAD → index");
    expect(model.turns[0]?.files).toEqual([]);
    expect(model.turns[1]?.prompt).toBe(
      "Unstaged changes — index → working tree",
    );
    expect(model.turns[1]?.files.map((file) => file.path)).toEqual([
      "src/new.ts",
      "src/old.ts",
    ]);
    expect(model.totalFiles).toBe(2);
    expect(model.totalHunks).toBe(2);
    expect(model.additions).toBe(2);
    expect(model.removals).toBe(2);
  });

  it("keeps paths with spaces from git path headers", () => {
    const patch = [
      "diff --git a/docs/hello world.md b/docs/hello world.md",
      "index 1111111..2222222 100644",
      "--- a/docs/hello world.md",
      "+++ b/docs/hello world.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const model = parseGitChangesReviewModel(patch, "");

    expect(model.turns[0]?.files[0]?.path).toBe("docs/hello world.md");
  });

  it("creates metadata hunks for binary or mode-only diffs", () => {
    const patch = [
      "diff --git a/image.png b/image.png",
      "new file mode 100644",
      "index 0000000..1111111",
      "Binary files /dev/null and b/image.png differ",
    ].join("\n");

    const model = parseGitChangesReviewModel(patch, "");
    const hunk = model.turns[0]?.files[0]?.hunks[0];

    expect(model.totalFiles).toBe(1);
    expect(model.totalHunks).toBe(1);
    expect(hunk?.toolName).toBe("git");
    expect(hunk?.additions).toBe(0);
    expect(hunk?.removals).toBe(0);
    expect(hunk?.bodyLines).toContain(
      " Binary files /dev/null and b/image.png differ",
    );
  });

  it("returns mode-specific empty models when staged and unstaged are empty", () => {
    const model = parseGitChangesReviewModel("", "");

    expect(model.mode.emptyTitle).toBe("No staged or unstaged changes found.");
    expect(model.turns).toEqual([]);
    expect(model.totalFiles).toBe(0);
    expect(model.totalHunks).toBe(0);
  });
});

describe("parseGitBranchReviewModel", () => {
  it("parses current-branch-vs-base branch diffs", () => {
    const model = parseGitBranchReviewModel(modifiedPatch, {
      kind: "git-branch-main",
      baseRef: "main",
      currentRef: "feature/foo",
      range: "main...feature/foo",
    });

    expect(model.mode.label).toBe("Current branch vs main");
    expect(model.mode.description).toBe(
      "merge-base(main, feature/foo) → feature/foo",
    );
    expect(model.turns[0]?.prompt).toBe(
      "Current branch vs main — main...feature/foo",
    );
    expect(model.totalFiles).toBe(1);
    expect(model.totalHunks).toBe(1);
    expect(model.additions).toBe(2);
    expect(model.removals).toBe(1);
  });
});

describe("gitDiffArgs", () => {
  it("uses cached diff args only for the staged section", () => {
    expect(gitDiffArgs("staged")).toContain("--cached");
    expect(gitDiffArgs("unstaged")).not.toContain("--cached");
  });

  it("builds merge-base branch diff args", () => {
    expect(gitBranchDiffArgs("main")).toEqual([
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--patch",
      "--find-renames",
      "main...HEAD",
      "--",
    ]);
  });
});
