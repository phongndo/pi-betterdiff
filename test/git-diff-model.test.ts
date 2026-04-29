import { describe, expect, it } from "vitest";

import {
  gitBranchDiffArgs,
  gitDiffArgs,
  gitUntrackedDiffArgs,
  gitUntrackedFilesArgs,
  joinGitPatches,
  parseGitBranchReviewModel,
  parseGitChangesReviewModel,
  parseGitNulPathList,
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
  it("renders staged changes above unstaged/untracked changes in one model", () => {
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
      "Unstaged/untracked changes — index → working tree",
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

  it("keeps an empty staged section above non-empty unstaged/untracked changes", () => {
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
      "Unstaged/untracked changes — index → working tree",
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

  it("decodes git-quoted UTF-8 path escapes", () => {
    const patch = [
      'diff --git "a/\\303\\251.txt" "b/\\303\\251.txt"',
      "index 1111111..2222222 100644",
      '--- "a/\\303\\251.txt"',
      '+++ "b/\\303\\251.txt"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const model = parseGitChangesReviewModel(patch, "");

    expect(model.turns[0]?.files[0]?.path).toBe("é.txt");
  });

  it("preserves meaningful trailing spaces in git paths", () => {
    const patch = [
      "diff --git a/trail.txt  b/trail.txt ",
      "index 1111111..2222222 100644",
      "--- a/trail.txt \t",
      "+++ b/trail.txt \t",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const model = parseGitChangesReviewModel(patch, "");

    expect(model.turns[0]?.files[0]?.path).toBe("trail.txt ");
  });

  it("keeps binary paths containing repeated b/ segments", () => {
    const patch = [
      "diff --git a/foo b/bar b/baz.bin b/foo b/bar b/baz.bin",
      "index e7be1ea..f9e371f 100644",
      "Binary files a/foo b/bar b/baz.bin and b/foo b/bar b/baz.bin differ",
    ].join("\n");

    const model = parseGitChangesReviewModel(patch, "");

    expect(model.turns[0]?.files[0]?.path).toBe("foo b/bar b/baz.bin");
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

  it("places untracked file patches in the unstaged/untracked section", () => {
    const untrackedPatch = [
      "diff --git a/plan.md b/plan.md",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/plan.md",
      "@@ -0,0 +1 @@",
      "+does unstaged and staged git work?",
    ].join("\n");

    const model = parseGitChangesReviewModel("", untrackedPatch);

    expect(model.turns[0]?.files).toEqual([]);
    expect(model.turns[1]?.prompt).toBe(
      "Unstaged/untracked changes — index → working tree",
    );
    expect(model.turns[1]?.files[0]?.path).toBe("plan.md");
    expect(model.turns[1]?.files[0]?.hunks[0]?.additions).toBe(1);
    expect(model.totalFiles).toBe(1);
  });

  it("returns mode-specific empty models when staged, unstaged, and untracked are empty", () => {
    const model = parseGitChangesReviewModel("", "");

    expect(model.mode.emptyTitle).toBe(
      "No staged, unstaged, or untracked changes found.",
    );
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

  it("builds args for listing and diffing untracked files", () => {
    expect(gitUntrackedFilesArgs()).toEqual([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    expect(gitUntrackedDiffArgs("docs/hello world.md")).toEqual([
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--patch",
      "--find-renames",
      "--no-index",
      "--",
      "/dev/null",
      "docs/hello world.md",
    ]);
  });

  it("parses nul-delimited git path lists without trimming path text", () => {
    expect(parseGitNulPathList("plan.md\0 docs/space.md \0")).toEqual([
      "plan.md",
      " docs/space.md ",
    ]);
  });

  it("joins non-empty git patches with a diff boundary newline", () => {
    expect(
      joinGitPatches(["", "diff --git a/a b/a", "diff --git a/b b/b"]),
    ).toBe("diff --git a/a b/a\ndiff --git a/b b/b");
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
