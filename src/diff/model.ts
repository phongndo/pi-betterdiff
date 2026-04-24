import type {
  SessionEntry,
  SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";

export interface DiffStats {
  additions: number;
  removals: number;
}

export interface ReviewHunk extends DiffStats {
  id: string;
  turnId: string;
  fileId: string;
  path: string;
  entryId: string;
  toolCallId: string;
  toolName: "edit" | "write";
  oldStart: number | undefined;
  oldLines: number | undefined;
  newStart: number | undefined;
  newLines: number | undefined;
  jumpLine: number;
  header: string;
  bodyLines: string[];
}

export interface ReviewFile extends DiffStats {
  id: string;
  turnId: string;
  path: string;
  hunks: ReviewHunk[];
}

export interface ReviewTurn extends DiffStats {
  id: string;
  ordinal: number;
  userEntryId: string;
  parentEntryId: string | null;
  timestamp: string;
  prompt: string;
  files: ReviewFile[];
  children: ReviewTurn[];
}

export interface ReviewModel extends DiffStats {
  /** All diff-producing user turns in traversal order. */
  turns: ReviewTurn[];
  /** Diff-producing user turns arranged by compressed pi session-tree ancestry. */
  roots: ReviewTurn[];
  totalFiles: number;
  totalHunks: number;
}

export interface ReviewSessionTreeNode {
  entry: SessionEntry;
  children: ReviewSessionTreeNode[];
}

interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface MutableReviewTurn extends DiffStats {
  id: string;
  ordinal: number;
  userEntryId: string;
  parentEntryId: string | null;
  timestamp: string;
  prompt: string;
  files: ReviewFile[];
  children: MutableReviewTurn[];
  fileByPath: Map<string, ReviewFile>;
}

interface EditDetails {
  diff: string;
  firstChangedLine?: number;
}

const MAX_WRITE_PREVIEW_LINES = 80;

export function buildReviewModel(
  entries: readonly SessionEntry[],
): ReviewModel {
  return buildReviewModelFromEntries(entries);
}

export function buildReviewModelFromTree(
  tree: readonly ReviewSessionTreeNode[],
): ReviewModel {
  return buildReviewModelFromEntries(flattenSessionTree(tree));
}

function buildReviewModelFromEntries(
  entries: readonly SessionEntry[],
): ReviewModel {
  const byId = new Map<string, SessionEntry>();
  const toolCalls = new Map<string, ToolCallInfo>();
  const turnByUserEntryId = new Map<string, MutableReviewTurn>();
  let userMessageCount = 0;

  for (const entry of entries) {
    byId.set(entry.id, entry);
    if (entry.type !== "message") continue;

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
    if (!isMutationToolResultEntry(entry)) continue;

    const turn = findNearestUserTurn(entry, byId, turnByUserEntryId);
    if (!turn) continue;

    const toolCall = toolCalls.get(entry.message.toolCallId);
    const args = toolCall?.name === entry.message.toolName ? toolCall.args : {};
    const path = getString(args.path) ?? getString(args.file_path);
    if (!path) continue;

    const hunks =
      entry.message.toolName === "edit"
        ? hunksFromEdit(entry, turn.id, path)
        : hunksFromWrite(entry, turn.id, path, args);

    if (hunks.length === 0) continue;

    const file = getOrCreateFile(turn, path);
    for (const hunk of hunks) {
      const finalizedHunk: ReviewHunk = {
        ...hunk,
        fileId: file.id,
      };
      file.hunks.push(finalizedHunk);
      addStats(file, finalizedHunk);
      addStats(turn, finalizedHunk);
    }
  }

  const visibleTurns = [...turnByUserEntryId.values()].filter(
    (turn) => turn.files.length > 0,
  );
  const roots = connectDiffTurnTree(visibleTurns, byId);
  const { turns, roots: immutableRoots } = stripMutableTurns(
    visibleTurns,
    roots,
  );

  return {
    turns,
    roots: immutableRoots,
    totalFiles: countUniqueFiles(visibleTurns),
    totalHunks: countHunks(visibleTurns),
    additions: visibleTurns.reduce((total, turn) => total + turn.additions, 0),
    removals: visibleTurns.reduce((total, turn) => total + turn.removals, 0),
  };
}

function flattenSessionTree(
  tree: readonly ReviewSessionTreeNode[],
): SessionEntry[] {
  const entries: SessionEntry[] = [];
  const stack = [...tree].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    entries.push(node.entry);
    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = node.children[index];
      if (child) stack.push(child);
    }
  }
  return entries;
}

function isMutationToolResultEntry(
  entry: SessionEntry,
): entry is SessionMessageEntry & {
  message: Extract<SessionMessageEntry["message"], { role: "toolResult" }> & {
    toolName: "edit" | "write";
  };
} {
  return (
    entry.type === "message" &&
    entry.message.role === "toolResult" &&
    !entry.message.isError &&
    (entry.message.toolName === "edit" || entry.message.toolName === "write")
  );
}

function findNearestUserTurn(
  entry: SessionEntry,
  byId: ReadonlyMap<string, SessionEntry>,
  turnByUserEntryId: ReadonlyMap<string, MutableReviewTurn>,
): MutableReviewTurn | undefined {
  let currentId = entry.parentId;
  while (currentId) {
    const current = byId.get(currentId);
    if (!current) return undefined;
    if (current.type === "message" && current.message.role === "user") {
      const turn = turnByUserEntryId.get(current.id);
      if (turn) return turn;
    }
    currentId = current.parentId;
  }
  return undefined;
}

function connectDiffTurnTree(
  visibleTurns: readonly MutableReviewTurn[],
  byId: ReadonlyMap<string, SessionEntry>,
): MutableReviewTurn[] {
  const visibleByUserEntryId = new Map(
    visibleTurns.map((turn) => [turn.userEntryId, turn] as const),
  );
  const roots: MutableReviewTurn[] = [];

  for (const turn of visibleTurns) {
    turn.children = [];
  }

  for (const turn of visibleTurns) {
    const parent = findNearestDiffAncestor(turn, visibleByUserEntryId, byId);
    if (parent) {
      parent.children.push(turn);
    } else {
      roots.push(turn);
    }
  }

  return roots;
}

function findNearestDiffAncestor(
  turn: MutableReviewTurn,
  visibleByUserEntryId: ReadonlyMap<string, MutableReviewTurn>,
  byId: ReadonlyMap<string, SessionEntry>,
): MutableReviewTurn | undefined {
  let currentId = turn.parentEntryId;
  while (currentId) {
    const current = byId.get(currentId);
    if (!current) return undefined;
    if (current.type === "message" && current.message.role === "user") {
      const ancestor = visibleByUserEntryId.get(current.id);
      if (ancestor) return ancestor;
    }
    currentId = current.parentId;
  }
  return undefined;
}

function stripMutableTurns(
  visibleTurns: readonly MutableReviewTurn[],
  roots: readonly MutableReviewTurn[],
): { turns: ReviewTurn[]; roots: ReviewTurn[] } {
  const cache = new Map<string, ReviewTurn>();
  const strip = (turn: MutableReviewTurn): ReviewTurn => {
    const cached = cache.get(turn.id);
    if (cached) return cached;

    const stripped: ReviewTurn = {
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

function countUniqueFiles(turns: readonly MutableReviewTurn[]): number {
  const paths = new Set<string>();
  for (const turn of turns) {
    for (const file of turn.files) {
      paths.add(file.path);
    }
  }
  return paths.size;
}

function countHunks(turns: readonly MutableReviewTurn[]): number {
  let count = 0;
  for (const turn of turns) {
    for (const file of turn.files) {
      count += file.hunks.length;
    }
  }
  return count;
}

function createTurn(
  entry: SessionMessageEntry,
  ordinal: number,
): MutableReviewTurn {
  return {
    id: `turn:${entry.id}`,
    ordinal,
    userEntryId: entry.id,
    parentEntryId: entry.parentId,
    timestamp: entry.timestamp,
    prompt: summarizeText(
      entry.message.role === "user" ? extractText(entry.message.content) : "",
      200,
    ),
    files: [],
    children: [],
    fileByPath: new Map<string, ReviewFile>(),
    additions: 0,
    removals: 0,
  };
}

function getOrCreateFile(turn: MutableReviewTurn, path: string): ReviewFile {
  const existing = turn.fileByPath.get(path);
  if (existing) return existing;

  const file: ReviewFile = {
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

function hunksFromEdit(
  entry: SessionMessageEntry,
  turnId: string,
  path: string,
): Array<Omit<ReviewHunk, "fileId">> {
  const message = entry.message;
  if (message.role !== "toolResult" || message.toolName !== "edit") return [];

  const details = isEditDetails(message.details) ? message.details : undefined;
  if (!details?.diff.trim()) return [];

  return parsePiEditDiff(details.diff, {
    turnId,
    path,
    entryId: entry.id,
    toolCallId: message.toolCallId,
    toolName: "edit",
    fallbackJumpLine: details.firstChangedLine ?? 1,
  });
}

function hunksFromWrite(
  entry: SessionMessageEntry,
  turnId: string,
  path: string,
  args: Record<string, unknown>,
): Array<Omit<ReviewHunk, "fileId">> {
  const message = entry.message;
  if (message.role !== "toolResult" || message.toolName !== "write") return [];

  const content = getString(args.content);
  if (content === undefined) return [];

  const allLines = splitDisplayLines(content);
  const previewLines = allLines.slice(0, MAX_WRITE_PREVIEW_LINES);
  const omitted = allLines.length - previewLines.length;
  const lineNumberWidth = String(Math.max(1, allLines.length)).length;
  const bodyLines = previewLines.map(
    (line, index) =>
      `+${String(index + 1).padStart(lineNumberWidth, " ")} ${line}`,
  );
  if (omitted > 0) {
    bodyLines.push(
      ` ${"".padStart(lineNumberWidth, " ")} ... (${omitted} more lines)`,
    );
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
      header: formatHunkHeader(1, allLines.length, additions, 0, "write"),
      bodyLines,
      additions,
      removals: 0,
    },
  ];
}

interface ParseDiffContext {
  turnId: string;
  path: string;
  entryId: string;
  toolCallId: string;
  toolName: "edit";
  fallbackJumpLine: number;
}

function parsePiEditDiff(
  diff: string,
  context: ParseDiffContext,
): Array<Omit<ReviewHunk, "fileId">> {
  const lines = diff.split("\n");
  const segments: string[][] = [];
  let current: string[] = [];

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

  return segments.map((segment, index) =>
    segmentToHunk(segment, index, context),
  );
}

function segmentToHunk(
  segment: string[],
  index: number,
  context: ParseDiffContext,
): Omit<ReviewHunk, "fileId"> {
  let additions = 0;
  let removals = 0;
  let firstNew: number | undefined;
  let lastNew: number | undefined;
  let firstAdded: number | undefined;
  let lastAdded: number | undefined;
  let firstOld: number | undefined;
  let lastOld: number | undefined;
  let firstRemoved: number | undefined;
  let lastRemoved: number | undefined;

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
    } else if (marker === "-") {
      removals += 1;
      if (lineNumber !== undefined) {
        firstOld ??= lineNumber;
        lastOld = lineNumber;
        firstRemoved ??= lineNumber;
        lastRemoved = lineNumber;
      }
    } else if (marker === " ") {
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
    header: formatHunkHeader(jumpLine, newLines, additions, removals, "edit"),
    bodyLines: segment,
    additions,
    removals,
  };
}

function formatHunkHeader(
  jumpLine: number,
  newLineCount: number | undefined,
  additions: number,
  removals: number,
  toolName: "edit" | "write",
): string {
  const end =
    newLineCount && newLineCount > 1 ? jumpLine + newLineCount - 1 : jumpLine;
  const lineLabel =
    end === jumpLine ? `line ${jumpLine}` : `lines ${jumpLine}-${end}`;
  return `${lineLabel}  ${toolName}  (+${additions} -${removals})`;
}

function rangeLength(
  start: number | undefined,
  end: number | undefined,
): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  return Math.max(1, end - start + 1);
}

function segmentHasChange(segment: readonly string[]): boolean {
  return segment.some((line) => line.startsWith("+") || line.startsWith("-"));
}

function isElisionLine(line: string): boolean {
  return /^\s*\.\.\.(?:\s|$)/u.test(line.slice(1));
}

function parseDiffLineNumber(line: string): number | undefined {
  const match = /^[-+ ]\s*(\d+)/u.exec(line);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractToolCalls(content: unknown): ToolCallInfo[] {
  if (!Array.isArray(content)) return [];

  const calls: ToolCallInfo[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== "toolCall") continue;
    const id = getString(block.id);
    const name = getString(block.name);
    if (!id || !name) continue;
    calls.push({
      id,
      name,
      args: isRecord(block.arguments) ? block.arguments : {},
    });
  }
  return calls;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type !== "text") return "";
      return getString(block.text) ?? "";
    })
    .join("\n");
}

function summarizeText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function splitDisplayLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

function addStats(target: DiffStats, stats: DiffStats): void {
  target.additions += stats.additions;
  target.removals += stats.removals;
}

function isEditDetails(value: unknown): value is EditDetails {
  return isRecord(value) && typeof value.diff === "string";
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
