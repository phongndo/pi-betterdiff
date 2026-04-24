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
}

export interface ReviewModel extends DiffStats {
  turns: ReviewTurn[];
  totalFiles: number;
  totalHunks: number;
}

interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface MutableReviewTurn extends ReviewTurn {
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
  const toolCalls = new Map<string, ToolCallInfo>();
  const turns: MutableReviewTurn[] = [];
  let currentTurn: MutableReviewTurn | undefined;
  let userMessageCount = 0;
  let syntheticTurnCount = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;

    if (entry.message.role === "user") {
      userMessageCount += 1;
      currentTurn = createTurn(entry, userMessageCount);
      turns.push(currentTurn);
      continue;
    }

    if (entry.message.role === "assistant") {
      for (const toolCall of extractToolCalls(entry.message.content)) {
        toolCalls.set(toolCall.id, toolCall);
      }
      continue;
    }

    if (entry.message.role !== "toolResult") continue;
    if (entry.message.isError) continue;
    if (entry.message.toolName !== "edit" && entry.message.toolName !== "write")
      continue;

    if (!currentTurn) {
      syntheticTurnCount += 1;
      currentTurn = createSyntheticTurn(entry, syntheticTurnCount);
      turns.push(currentTurn);
    }

    const toolCall = toolCalls.get(entry.message.toolCallId);
    const args = toolCall?.name === entry.message.toolName ? toolCall.args : {};
    const path = getString(args.path) ?? getString(args.file_path);
    if (!path) continue;

    const hunks =
      entry.message.toolName === "edit"
        ? hunksFromEdit(entry, currentTurn.id, path)
        : hunksFromWrite(entry, currentTurn.id, path, args);

    if (hunks.length === 0) continue;

    const file = getOrCreateFile(currentTurn, path);
    for (const hunk of hunks) {
      const finalizedHunk: ReviewHunk = {
        ...hunk,
        fileId: file.id,
      };
      file.hunks.push(finalizedHunk);
      addStats(file, finalizedHunk);
      addStats(currentTurn, finalizedHunk);
    }
  }

  const visibleTurns = turns.filter((turn) => turn.files.length > 0);
  const allPaths = new Set<string>();
  let totalHunks = 0;
  let additions = 0;
  let removals = 0;

  for (const turn of visibleTurns) {
    for (const file of turn.files) {
      allPaths.add(file.path);
      totalHunks += file.hunks.length;
    }
    additions += turn.additions;
    removals += turn.removals;
  }

  return {
    turns: visibleTurns.map(stripMutableTurn),
    totalFiles: allPaths.size,
    totalHunks,
    additions,
    removals,
  };
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
      120,
    ),
    files: [],
    fileByPath: new Map<string, ReviewFile>(),
    additions: 0,
    removals: 0,
  };
}

function createSyntheticTurn(
  entry: SessionMessageEntry,
  ordinal: number,
): MutableReviewTurn {
  return {
    id: `turn:synthetic:${entry.id}`,
    ordinal,
    userEntryId: entry.id,
    parentEntryId: entry.parentId,
    timestamp: entry.timestamp,
    prompt: "Session mutations before a user turn could be identified",
    files: [],
    fileByPath: new Map<string, ReviewFile>(),
    additions: 0,
    removals: 0,
  };
}

function stripMutableTurn(turn: MutableReviewTurn): ReviewTurn {
  return {
    id: turn.id,
    ordinal: turn.ordinal,
    userEntryId: turn.userEntryId,
    parentEntryId: turn.parentEntryId,
    timestamp: turn.timestamp,
    prompt: turn.prompt,
    files: turn.files,
    additions: turn.additions,
    removals: turn.removals,
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
