export const GIT_CHANGES_REVIEW_MODE = {
    kind: "git-changes",
    label: "Git changes",
    description: "staged (HEAD → index) above unstaged (index → working tree)",
    emptyTitle: "No staged or unstaged changes found.",
    emptyHint: "Stage changes with git add or edit tracked files, then reopen /diff.",
};
const GIT_DIFF_BASE_ARGS = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--patch",
    "--find-renames",
];
export function gitDiffArgs(section) {
    return section === "staged"
        ? [...GIT_DIFF_BASE_ARGS, "--cached"]
        : [...GIT_DIFF_BASE_ARGS];
}
export function gitBranchDiffArgs(baseRef, targetRef = "HEAD") {
    return [...GIT_DIFF_BASE_ARGS, `${baseRef}...${targetRef}`, "--"];
}
export function parseGitChangesReviewModel(stagedPatch, unstagedPatch) {
    const stagedFiles = parseGitPatchFiles(stagedPatch, gitSectionTurnId("staged"));
    const unstagedFiles = parseGitPatchFiles(unstagedPatch, gitSectionTurnId("unstaged"));
    if (stagedFiles.length === 0 && unstagedFiles.length === 0) {
        return emptyGitChangesReviewModel();
    }
    const stagedTurn = createGitSectionTurn("staged", stagedFiles);
    const unstagedTurn = createGitSectionTurn("unstaged", unstagedFiles);
    const turns = [stagedTurn, unstagedTurn];
    const activeTurn = turns.find((turn) => turn.files.length > 0);
    return modelFromTurns(GIT_CHANGES_REVIEW_MODE, turns, activeTurn?.id);
}
export function parseGitBranchReviewModel(patch, options) {
    const mode = {
        kind: options.kind,
        label: `Current branch vs ${options.baseRef}`,
        description: `merge-base(${options.baseRef}, ${options.currentRef}) → ${options.currentRef}`,
        baseRef: options.baseRef,
        emptyTitle: `No branch changes found for ${options.range}.`,
        emptyHint: `The current branch has no changes relative to ${options.baseRef}.`,
    };
    const turnId = `git:branch:${options.kind}:${slugId(options.baseRef)}`;
    const files = parseGitPatchFiles(patch, turnId);
    if (files.length === 0) {
        return emptyReviewModel(mode);
    }
    const turn = createGitBranchTurn(turnId, mode.label, options.range, files);
    return modelFromTurns(mode, [turn], turn.id);
}
function parseGitPatchFiles(patch, turnId) {
    const mutableFiles = [];
    let currentFile;
    let currentHunk;
    for (const line of splitPatchLines(patch)) {
        if (line.startsWith("diff --git ")) {
            currentFile = createMutableFile(turnId, mutableFiles.length, line);
            mutableFiles.push(currentFile);
            currentHunk = undefined;
            continue;
        }
        if (!currentFile)
            continue;
        const oldPath = parseOldPathLine(line);
        if (oldPath !== undefined) {
            currentFile.oldPath = oldPath;
            currentFile.path = chooseDisplayPath(currentFile);
            currentHunk = undefined;
            continue;
        }
        const newPath = parseNewPathLine(line);
        if (newPath !== undefined) {
            currentFile.newPath = newPath;
            currentFile.path = chooseDisplayPath(currentFile);
            currentHunk = undefined;
            continue;
        }
        const renameFrom = parseRenamePathLine(line, "rename from ");
        if (renameFrom !== undefined) {
            currentFile.oldPath = renameFrom;
            currentFile.path = chooseDisplayPath(currentFile);
            currentFile.metadataLines.push(line);
            currentHunk = undefined;
            continue;
        }
        const renameTo = parseRenamePathLine(line, "rename to ");
        if (renameTo !== undefined) {
            currentFile.newPath = renameTo;
            currentFile.path = chooseDisplayPath(currentFile);
            currentFile.metadataLines.push(line);
            currentHunk = undefined;
            continue;
        }
        const hunkRange = parseHunkHeader(line);
        if (hunkRange) {
            currentHunk = createGitHunk(currentFile, hunkRange);
            currentFile.hunks.push(currentHunk);
            continue;
        }
        if (currentHunk && isGitDiffBodyLine(line)) {
            addGitDiffBodyLine(currentHunk, line);
            continue;
        }
        if (isDisplayMetadataLine(line)) {
            currentFile.metadataLines.push(line);
        }
        currentHunk = undefined;
    }
    return mutableFiles.flatMap((file) => finalizeGitFile(file));
}
function createMutableFile(turnId, index, diffHeaderLine) {
    const parsed = parseDiffGitHeader(diffHeaderLine);
    const id = `${turnId}:file:${index}`;
    return {
        id,
        turnId,
        path: parsed?.newPath ?? parsed?.oldPath,
        oldPath: parsed?.oldPath,
        newPath: parsed?.newPath,
        metadataLines: [],
        hunks: [],
    };
}
function finalizeGitFile(file) {
    const path = chooseDisplayPath(file);
    if (!path)
        return [];
    if (file.hunks.length === 0 && file.metadataLines.length > 0) {
        file.hunks.push(createMetadataHunk(file, path));
    }
    if (file.hunks.length === 0 && file.metadataLines.length === 0) {
        return [];
    }
    for (const hunk of file.hunks) {
        hunk.path = path;
    }
    const reviewFile = {
        id: file.id,
        turnId: file.turnId,
        path,
        hunks: file.hunks,
        additions: file.hunks.reduce((total, hunk) => total + hunk.additions, 0),
        removals: file.hunks.reduce((total, hunk) => total + hunk.removals, 0),
    };
    return [reviewFile];
}
function createGitSectionTurn(section, files) {
    return createGitTurn({
        id: gitSectionTurnId(section),
        ordinal: section === "staged" ? 1 : 2,
        userEntryId: `git:changes:${section}`,
        prompt: gitSectionPrompt(section),
        files,
    });
}
function createGitBranchTurn(turnId, label, range, files) {
    return createGitTurn({
        id: turnId,
        ordinal: 1,
        userEntryId: turnId,
        prompt: `${label} — ${range}`,
        files,
    });
}
function createGitTurn({ id, ordinal, userEntryId, prompt, files, }) {
    return {
        id,
        ordinal,
        userEntryId,
        parentEntryId: null,
        timestamp: "1970-01-01T00:00:00.000Z",
        prompt,
        files: [...files],
        children: [],
        additions: files.reduce((total, file) => total + file.additions, 0),
        removals: files.reduce((total, file) => total + file.removals, 0),
    };
}
function gitSectionTurnId(section) {
    return `git:changes:${section}`;
}
function gitSectionPrompt(section) {
    return section === "staged"
        ? "Staged changes — HEAD → index"
        : "Unstaged changes — index → working tree";
}
function emptyGitChangesReviewModel() {
    return emptyReviewModel(GIT_CHANGES_REVIEW_MODE);
}
function emptyReviewModel(mode) {
    return {
        mode,
        turns: [],
        roots: [],
        activeTurnIds: [],
        totalFiles: 0,
        totalHunks: 0,
        additions: 0,
        removals: 0,
    };
}
function modelFromTurns(mode, turns, activeTurnId) {
    return {
        mode,
        turns: [...turns],
        roots: [...turns],
        activeTurnIds: activeTurnId ? [activeTurnId] : [],
        totalFiles: turns.reduce((total, turn) => total + turn.files.length, 0),
        totalHunks: turns.reduce((total, turn) => total +
            turn.files.reduce((fileTotal, file) => fileTotal + file.hunks.length, 0), 0),
        additions: turns.reduce((total, turn) => total + turn.additions, 0),
        removals: turns.reduce((total, turn) => total + turn.removals, 0),
    };
}
function slugId(value) {
    return value.replace(/[^A-Za-z0-9._-]+/gu, "-");
}
function createGitHunk(file, range) {
    return {
        id: `${file.id}:hunk:${file.hunks.length}`,
        turnId: file.turnId,
        fileId: file.id,
        path: chooseDisplayPath(file) ?? "(unknown)",
        entryId: `${file.id}:hunk:${file.hunks.length}`,
        toolCallId: "git diff",
        toolName: "git",
        oldStart: range.oldStart,
        oldLines: range.oldLines,
        newStart: range.newStart,
        newLines: range.newLines,
        jumpLine: range.newLines > 0
            ? Math.max(1, range.newStart)
            : Math.max(1, range.oldStart),
        bodyLines: [],
        additions: 0,
        removals: 0,
    };
}
function createMetadataHunk(file, path) {
    return {
        id: `${file.id}:metadata`,
        turnId: file.turnId,
        fileId: file.id,
        path,
        entryId: `${file.id}:metadata`,
        toolCallId: "git diff",
        toolName: "git",
        oldStart: undefined,
        oldLines: undefined,
        newStart: undefined,
        newLines: undefined,
        jumpLine: 1,
        bodyLines: file.metadataLines.map((line) => ` ${line}`),
        additions: 0,
        removals: 0,
    };
}
function addGitDiffBodyLine(hunk, line) {
    hunk.bodyLines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) {
        hunk.additions += 1;
    }
    else if (line.startsWith("-") && !line.startsWith("---")) {
        hunk.removals += 1;
    }
}
function parseHunkHeader(line) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!match?.[1] || !match[3])
        return undefined;
    return {
        oldStart: Number.parseInt(match[1], 10),
        oldLines: match[2] ? Number.parseInt(match[2], 10) : 1,
        newStart: Number.parseInt(match[3], 10),
        newLines: match[4] ? Number.parseInt(match[4], 10) : 1,
    };
}
function parseDiffGitHeader(line) {
    const rest = line.slice("diff --git ".length);
    const tokens = parseDiffGitPathTokens(rest);
    if (!tokens)
        return undefined;
    return {
        oldPath: normalizeGitPath(tokens.oldToken),
        newPath: normalizeGitPath(tokens.newToken),
    };
}
function parseDiffGitPathTokens(text) {
    if (text.startsWith('"')) {
        const oldParsed = parseQuotedToken(text, 0);
        if (!oldParsed)
            return undefined;
        const nextStart = skipWhitespace(text, oldParsed.nextIndex);
        const newParsed = parseQuotedToken(text, nextStart);
        if (!newParsed)
            return undefined;
        return { oldToken: oldParsed.value, newToken: newParsed.value };
    }
    const separator = text.lastIndexOf(" b/");
    if (separator === -1)
        return undefined;
    return {
        oldToken: text.slice(0, separator),
        newToken: text.slice(separator + 1),
    };
}
function parseOldPathLine(line) {
    if (!line.startsWith("--- "))
        return undefined;
    return normalizeGitPath(line.slice(4));
}
function parseNewPathLine(line) {
    if (!line.startsWith("+++ "))
        return undefined;
    return normalizeGitPath(line.slice(4));
}
function parseRenamePathLine(line, prefix) {
    if (!line.startsWith(prefix))
        return undefined;
    return unquoteGitPath(line.slice(prefix.length).trim());
}
function normalizeGitPath(rawPath) {
    const path = unquoteGitPath(rawPath.trim());
    if (path === "/dev/null")
        return undefined;
    if (path.startsWith("a/") || path.startsWith("b/"))
        return path.slice(2);
    return path;
}
function chooseDisplayPath(file) {
    return file.newPath ?? file.oldPath ?? file.path;
}
function unquoteGitPath(path) {
    if (!path.startsWith('"'))
        return stripTrailingTimestamp(path);
    return parseQuotedToken(path, 0)?.value ?? path;
}
function stripTrailingTimestamp(path) {
    const match = /^(.*)\t\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? [+-]\d{4}$/u.exec(path);
    return match?.[1] ?? path;
}
function parseQuotedToken(text, startIndex) {
    if (text[startIndex] !== '"')
        return undefined;
    let value = "";
    for (let index = startIndex + 1; index < text.length; index++) {
        const char = text[index];
        if (char === undefined)
            break;
        if (char === '"')
            return { value, nextIndex: index + 1 };
        if (char !== "\\") {
            value += char;
            continue;
        }
        const next = text[index + 1];
        if (next === undefined) {
            value += "\\";
            break;
        }
        const decoded = decodeGitEscape(text, index + 1);
        value += decoded.value;
        index = decoded.nextIndex - 1;
    }
    return undefined;
}
function decodeGitEscape(text, escapeStart) {
    const char = text[escapeStart];
    if (char === undefined)
        return { value: "", nextIndex: escapeStart };
    const simpleEscapes = new Map([
        ["\\", "\\"],
        ['"', '"'],
        ["n", "\n"],
        ["r", "\r"],
        ["t", "\t"],
        ["b", "\b"],
        ["f", "\f"],
    ]);
    const simple = simpleEscapes.get(char);
    if (simple !== undefined)
        return { value: simple, nextIndex: escapeStart + 1 };
    if (/[0-7]/u.test(char)) {
        const octal = text
            .slice(escapeStart, escapeStart + 3)
            .match(/^[0-7]{1,3}/u)?.[0];
        if (octal) {
            return {
                value: String.fromCharCode(Number.parseInt(octal, 8)),
                nextIndex: escapeStart + octal.length,
            };
        }
    }
    return { value: char, nextIndex: escapeStart + 1 };
}
function skipWhitespace(text, startIndex) {
    let index = startIndex;
    while (index < text.length && /\s/u.test(text[index] ?? ""))
        index += 1;
    return index;
}
function isGitDiffBodyLine(line) {
    return (line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ") ||
        line.startsWith("\\"));
}
function isDisplayMetadataLine(line) {
    return /^(?:old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files |GIT binary patch|literal |delta )/u.test(line);
}
function splitPatchLines(patch) {
    return patch.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
}
