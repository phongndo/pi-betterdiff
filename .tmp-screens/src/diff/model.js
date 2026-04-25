export const SESSION_TURNS_REVIEW_MODE = {
    kind: "session-turns",
    label: "Session turns",
    description: "pi session edit/write history by user turn",
    emptyTitle: "No edit/write changes found in this session tree.",
    emptyHint: "Make a file change with edit/write, then reopen /diff.",
};
const MAX_WRITE_PREVIEW_LINES = 80;
export function buildReviewModel(entries, activeLeafId) {
    return buildReviewModelFromEntries(entries, activeLeafId);
}
export function buildReviewModelFromTree(tree, activeLeafId) {
    return buildReviewModelFromEntries(flattenSessionTree(tree), activeLeafId);
}
function buildReviewModelFromEntries(entries, activeLeafId) {
    const byId = new Map();
    const toolCalls = new Map();
    const turnByUserEntryId = new Map();
    let userMessageCount = 0;
    for (const entry of entries) {
        byId.set(entry.id, entry);
        if (entry.type !== "message")
            continue;
        if (entry.message.role === "user") {
            userMessageCount += 1;
            turnByUserEntryId.set(entry.id, createTurn(entry, userMessageCount));
            continue;
        }
        if (entry.message.role === "assistant") {
            for (const toolCall of extractToolCalls(entry.message.content)) {
                toolCalls.set(toolCall.id, toolCall);
            }
        }
    }
    for (const entry of entries) {
        if (!isMutationToolResultEntry(entry))
            continue;
        const turn = findNearestUserTurn(entry, byId, turnByUserEntryId);
        if (!turn)
            continue;
        const toolCall = toolCalls.get(entry.message.toolCallId);
        const args = toolCall?.name === entry.message.toolName ? toolCall.args : {};
        const path = getString(args.path) ?? getString(args.file_path);
        if (!path)
            continue;
        const hunks = entry.message.toolName === "edit"
            ? hunksFromEdit(entry, turn.id, path)
            : hunksFromWrite(entry, turn.id, path, args);
        if (hunks.length === 0)
            continue;
        const file = getOrCreateFile(turn, path);
        for (const hunk of hunks) {
            const finalizedHunk = {
                ...hunk,
                fileId: file.id,
            };
            file.hunks.push(finalizedHunk);
            addStats(file, finalizedHunk);
            addStats(turn, finalizedHunk);
        }
    }
    const visibleTurns = [...turnByUserEntryId.values()].filter((turn) => turn.files.length > 0);
    const roots = connectDiffTurnTree(visibleTurns, byId);
    const activeTurnIds = findActiveTurnIds(activeLeafId, byId, visibleTurns);
    const { turns, roots: immutableRoots } = stripMutableTurns(visibleTurns, roots);
    return {
        mode: SESSION_TURNS_REVIEW_MODE,
        turns,
        roots: immutableRoots,
        activeTurnIds,
        totalFiles: countUniqueFiles(visibleTurns),
        totalHunks: countHunks(visibleTurns),
        additions: visibleTurns.reduce((total, turn) => total + turn.additions, 0),
        removals: visibleTurns.reduce((total, turn) => total + turn.removals, 0),
    };
}
function flattenSessionTree(tree) {
    const entries = [];
    const stack = [...tree].reverse();
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node)
            continue;
        entries.push(node.entry);
        for (let index = node.children.length - 1; index >= 0; index--) {
            const child = node.children[index];
            if (child)
                stack.push(child);
        }
    }
    return entries;
}
function isMutationToolResultEntry(entry) {
    return (entry.type === "message" &&
        entry.message.role === "toolResult" &&
        !entry.message.isError &&
        (entry.message.toolName === "edit" || entry.message.toolName === "write"));
}
function findNearestUserTurn(entry, byId, turnByUserEntryId) {
    let currentId = entry.parentId;
    while (currentId) {
        const current = byId.get(currentId);
        if (!current)
            return undefined;
        if (current.type === "message" && current.message.role === "user") {
            const turn = turnByUserEntryId.get(current.id);
            if (turn)
                return turn;
        }
        currentId = current.parentId;
    }
    return undefined;
}
function connectDiffTurnTree(visibleTurns, byId) {
    const visibleByUserEntryId = new Map(visibleTurns.map((turn) => [turn.userEntryId, turn]));
    const roots = [];
    for (const turn of visibleTurns) {
        turn.children = [];
    }
    for (const turn of visibleTurns) {
        const parent = findNearestDiffAncestor(turn, visibleByUserEntryId, byId);
        if (parent) {
            parent.children.push(turn);
        }
        else {
            roots.push(turn);
        }
    }
    return roots;
}
function findNearestDiffAncestor(turn, visibleByUserEntryId, byId) {
    let currentId = turn.parentEntryId;
    while (currentId) {
        const current = byId.get(currentId);
        if (!current)
            return undefined;
        if (current.type === "message" && current.message.role === "user") {
            const ancestor = visibleByUserEntryId.get(current.id);
            if (ancestor)
                return ancestor;
        }
        currentId = current.parentId;
    }
    return undefined;
}
function findActiveTurnIds(activeLeafId, byId, visibleTurns) {
    if (!activeLeafId)
        return [];
    const visibleByUserEntryId = new Map(visibleTurns.map((turn) => [turn.userEntryId, turn]));
    const activeTurnIds = [];
    let currentId = activeLeafId;
    while (currentId) {
        const current = byId.get(currentId);
        if (!current)
            break;
        if (current.type === "message" && current.message.role === "user") {
            const turn = visibleByUserEntryId.get(current.id);
            if (turn)
                activeTurnIds.push(turn.id);
        }
        currentId = current.parentId;
    }
    return activeTurnIds.reverse();
}
function stripMutableTurns(visibleTurns, roots) {
    const cache = new Map();
    const strip = (turn) => {
        const cached = cache.get(turn.id);
        if (cached)
            return cached;
        const stripped = {
            id: turn.id,
            ordinal: turn.ordinal,
            userEntryId: turn.userEntryId,
            parentEntryId: turn.parentEntryId,
            timestamp: turn.timestamp,
            prompt: turn.prompt,
            files: turn.files,
            children: [],
            additions: turn.additions,
            removals: turn.removals,
        };
        cache.set(turn.id, stripped);
        stripped.children = turn.children.map(strip);
        return stripped;
    };
    return {
        turns: visibleTurns.map(strip),
        roots: roots.map(strip),
    };
}
function countUniqueFiles(turns) {
    const paths = new Set();
    for (const turn of turns) {
        for (const file of turn.files) {
            paths.add(file.path);
        }
    }
    return paths.size;
}
function countHunks(turns) {
    let count = 0;
    for (const turn of turns) {
        for (const file of turn.files) {
            count += file.hunks.length;
        }
    }
    return count;
}
function createTurn(entry, ordinal) {
    return {
        id: `turn:${entry.id}`,
        ordinal,
        userEntryId: entry.id,
        parentEntryId: entry.parentId,
        timestamp: entry.timestamp,
        prompt: normalizePromptText(entry.message.role === "user" ? extractText(entry.message.content) : ""),
        files: [],
        children: [],
        fileByPath: new Map(),
        additions: 0,
        removals: 0,
    };
}
function getOrCreateFile(turn, path) {
    const existing = turn.fileByPath.get(path);
    if (existing)
        return existing;
    const file = {
        id: `${turn.id}:file:${turn.files.length}:${path}`,
        turnId: turn.id,
        path,
        hunks: [],
        additions: 0,
        removals: 0,
    };
    turn.fileByPath.set(path, file);
    turn.files.push(file);
    return file;
}
function hunksFromEdit(entry, turnId, path) {
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== "edit")
        return [];
    const details = isEditDetails(message.details) ? message.details : undefined;
    if (!details?.diff.trim())
        return [];
    return parsePiEditDiff(details.diff, {
        turnId,
        path,
        entryId: entry.id,
        toolCallId: message.toolCallId,
        toolName: "edit",
        fallbackJumpLine: details.firstChangedLine ?? 1,
    });
}
function hunksFromWrite(entry, turnId, path, args) {
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== "write")
        return [];
    const content = getString(args.content);
    if (content === undefined)
        return [];
    const allLines = splitDisplayLines(content);
    const previewLines = allLines.slice(0, MAX_WRITE_PREVIEW_LINES);
    const omitted = allLines.length - previewLines.length;
    const lineNumberWidth = String(Math.max(1, allLines.length)).length;
    const bodyLines = previewLines.map((line, index) => `+${String(index + 1).padStart(lineNumberWidth, " ")} ${line}`);
    if (omitted > 0) {
        bodyLines.push(` ${"".padStart(lineNumberWidth, " ")} ... (${omitted} more lines)`);
    }
    const additions = allLines.length;
    return [
        {
            id: `${entry.id}:write:0`,
            turnId,
            path,
            entryId: entry.id,
            toolCallId: message.toolCallId,
            toolName: "write",
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: allLines.length,
            jumpLine: 1,
            bodyLines,
            additions,
            removals: 0,
        },
    ];
}
function parsePiEditDiff(diff, context) {
    const lines = diff.split("\n");
    const segments = [];
    let current = [];
    for (const line of lines) {
        if (isElisionLine(line)) {
            if (segmentHasChange(current)) {
                segments.push(current);
            }
            current = [];
            continue;
        }
        current.push(line);
    }
    if (segmentHasChange(current)) {
        segments.push(current);
    }
    return segments.map((segment, index) => segmentToHunk(segment, index, context));
}
function segmentToHunk(segment, index, context) {
    let additions = 0;
    let removals = 0;
    let firstNew;
    let lastNew;
    let firstAdded;
    let lastAdded;
    let firstOld;
    let lastOld;
    let firstRemoved;
    let lastRemoved;
    for (const line of segment) {
        const marker = line[0];
        const lineNumber = parseDiffLineNumber(line);
        if (marker === "+") {
            additions += 1;
            if (lineNumber !== undefined) {
                firstNew ??= lineNumber;
                lastNew = lineNumber;
                firstAdded ??= lineNumber;
                lastAdded = lineNumber;
            }
        }
        else if (marker === "-") {
            removals += 1;
            if (lineNumber !== undefined) {
                firstOld ??= lineNumber;
                lastOld = lineNumber;
                firstRemoved ??= lineNumber;
                lastRemoved = lineNumber;
            }
        }
        else if (marker === " ") {
            if (lineNumber !== undefined) {
                firstNew ??= lineNumber;
                lastNew = lineNumber;
                firstOld ??= lineNumber;
                lastOld = lineNumber;
            }
        }
    }
    const jumpLine = firstAdded ?? firstNew ?? context.fallbackJumpLine;
    const newStart = firstAdded ?? firstNew;
    const oldStart = firstRemoved ?? firstOld;
    const newLines = rangeLength(newStart, lastAdded ?? lastNew);
    const oldLines = rangeLength(oldStart, lastRemoved ?? lastOld);
    return {
        id: `${context.entryId}:edit:${index}`,
        turnId: context.turnId,
        path: context.path,
        entryId: context.entryId,
        toolCallId: context.toolCallId,
        toolName: context.toolName,
        oldStart,
        oldLines,
        newStart,
        newLines,
        jumpLine,
        bodyLines: segment,
        additions,
        removals,
    };
}
function rangeLength(start, end) {
    if (start === undefined || end === undefined)
        return undefined;
    return Math.max(1, end - start + 1);
}
function segmentHasChange(segment) {
    return segment.some((line) => line.startsWith("+") || line.startsWith("-"));
}
function isElisionLine(line) {
    return /^\s*\.\.\.(?:\s|$)/u.test(line.slice(1));
}
function parseDiffLineNumber(line) {
    const match = /^[-+ ]\s*(\d+)/u.exec(line);
    if (!match?.[1])
        return undefined;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function extractToolCalls(content) {
    if (!Array.isArray(content))
        return [];
    const calls = [];
    for (const block of content) {
        if (!isRecord(block))
            continue;
        if (block.type !== "toolCall")
            continue;
        const id = getString(block.id);
        const name = getString(block.name);
        if (!id || !name)
            continue;
        calls.push({
            id,
            name,
            args: isRecord(block.arguments) ? block.arguments : {},
        });
    }
    return calls;
}
function extractText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((block) => {
        if (!isRecord(block))
            return "";
        if (block.type !== "text")
            return "";
        return getString(block.text) ?? "";
    })
        .join("\n");
}
function normalizePromptText(text) {
    return text.replace(/\s+/gu, " ").trim();
}
function splitDisplayLines(content) {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") {
        return lines.slice(0, -1);
    }
    return lines;
}
function addStats(target, stats) {
    target.additions += stats.additions;
    target.removals += stats.removals;
}
function isEditDetails(value) {
    return isRecord(value) && typeof value.diff === "string";
}
function getString(value) {
    return typeof value === "string" ? value : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
