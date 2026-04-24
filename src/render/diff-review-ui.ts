import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import {
  DynamicBorder,
  getLanguageFromPath,
  highlightCode,
  keyText,
} from "@mariozechner/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
} from "@mariozechner/pi-tui";

import type {
  ReviewFile,
  ReviewHunk,
  ReviewModel,
  ReviewTurn,
} from "../diff/model.js";

export type DiffReviewAction =
  | { type: "close" }
  | { type: "undo"; targetEntryId: string; label: string };

type ReviewNode = TurnNode | FileNode | HunkNode;

interface TurnNode {
  type: "turn";
  id: string;
  turn: ReviewTurn;
  parentId: undefined;
}

interface FileNode {
  type: "file";
  id: string;
  turn: ReviewTurn;
  file: ReviewFile;
  parentId: string;
}

interface HunkNode {
  type: "hunk";
  id: string;
  turn: ReviewTurn;
  file: ReviewFile;
  hunk: ReviewHunk;
  parentId: string;
}

type SelectableRow = {
  id: string;
  kind: "turn" | "file" | "hunk";
  depth: number;
  prefix: string;
  selectable: true;
  node: ReviewNode;
};

type DiffLineRow = {
  id: string;
  kind: "diff";
  depth: number;
  prefix: string;
  selectable: true;
  node: HunkNode;
  text: string;
};

type RenderRow = SelectableRow | DiffLineRow;

export class DiffReviewComponent implements Component {
  private readonly nodesById = new Map<string, ReviewNode>();
  private readonly parentById = new Map<string, string | undefined>();
  private readonly childrenById = new Map<string, string[]>();
  private readonly foldableIds = new Set<string>();
  private readonly foldedIds = new Set<string>();
  private cachedRows: RenderRow[] | undefined;
  private selectedId: string | undefined;
  private searchQuery = "";
  private pendingG = false;
  private notice: string | undefined;

  constructor(
    private readonly model: ReviewModel,
    private readonly cwd: string,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: DiffReviewAction) => void,
  ) {
    this.indexModel();
    this.foldHunksByDefault();
    this.selectedId = this.firstSelectableId();
  }

  invalidate(): void {
    this.invalidateRows();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const border = new DynamicBorder((text: string) =>
      this.theme.fg("border", text),
    );
    lines.push("");
    lines.push(...border.render(width));
    lines.push(
      truncateToWidth(
        `  ${this.theme.bold("Better Diff")} ${this.summaryText()}`,
        width,
      ),
    );
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "muted",
          `  ↑/↓: move. ←/→ or h/l: fold/branch. enter: toggle. c/e: collapse/expand. u: undo turn. ${keyText("app.editor.external")}: open hunk. q/esc: close`,
        ),
        width,
      ),
    );
    lines.push(this.renderSearchLine(width));
    if (this.notice) {
      lines.push(
        truncateToWidth(`  ${this.theme.fg("warning", this.notice)}`, width),
      );
    }
    lines.push(...border.render(width));
    lines.push("");

    if (this.model.turns.length === 0) {
      lines.push(
        truncateToWidth(
          this.theme.fg(
            "muted",
            "  No edit/write changes found in the current branch.",
          ),
          width,
        ),
      );
      lines.push(
        truncateToWidth(
          this.theme.fg(
            "muted",
            "  Make a file change with edit/write, then reopen /diff.",
          ),
          width,
        ),
      );
      lines.push("");
      lines.push(...border.render(width));
      return lines;
    }

    const rows = this.getRows();
    this.ensureSelectionVisible(rows);
    const maxBodyLines = Math.max(5, Math.floor(this.tui.terminal.rows / 2));
    const selectedRowIndex = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selectedId),
    );
    const startIndex = Math.max(
      0,
      Math.min(
        selectedRowIndex - Math.floor(maxBodyLines / 2),
        rows.length - maxBodyLines,
      ),
    );
    const endIndex = Math.min(rows.length, startIndex + maxBodyLines);

    for (let index = startIndex; index < endIndex; index++) {
      const row = rows[index];
      if (!row) continue;
      lines.push(this.renderRow(row, width));
    }

    if (rows.length === 0) {
      lines.push(
        truncateToWidth(
          this.theme.fg("muted", "  No diff entries found"),
          width,
        ),
      );
    }

    const selectableRows = rows.filter(isSelectableRow);
    const selectedSelectableIndex = selectableRows.findIndex(
      (row) => row.id === this.selectedId,
    );
    const selectedNode = this.getSelectedNode();
    const position =
      selectedSelectableIndex >= 0 ? selectedSelectableIndex + 1 : 0;
    const status = selectedNode
      ? `  (${position}/${selectableRows.length}) ${this.describeNode(selectedNode)}`
      : `  (0/0)`;
    lines.push(truncateToWidth(this.theme.fg("muted", status), width));
    lines.push("");
    lines.push(...border.render(width));
    return lines;
  }

  private renderSearchLine(width: number): string {
    const label = this.theme.fg("muted", "  Type to search:");
    const query = this.searchQuery
      ? ` ${this.theme.fg("accent", this.searchQuery)}`
      : "";
    return truncateToWidth(`${label}${query}`, width);
  }

  private ensureSelectionVisible(rows: readonly RenderRow[]): void {
    if (rows.some((row) => row.selectable && row.id === this.selectedId)) {
      return;
    }
    this.selectedId = rows.find(isSelectableRow)?.id;
  }

  private clearSearch(): void {
    this.searchQuery = "";
    this.foldedIds.clear();
    this.invalidateRows();
  }

  handleInput(data: string): void {
    this.notice = undefined;

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.searchQuery) {
        this.clearSearch();
        this.tui.requestRender();
      } else {
        this.done({ type: "close" });
      }
      return;
    }

    if (data === "q" || data === "Q") {
      this.done({ type: "close" });
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      if (this.searchQuery) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.foldedIds.clear();
        this.invalidateRows();
        this.tui.requestRender();
      }
      return;
    }

    if (this.keybindings.matches(data, "app.editor.external")) {
      this.openSelectedHunk();
      this.tui.requestRender(true);
      return;
    }

    if (data === "u" || data === "U") {
      const node = this.getSelectedNode();
      if (!node) return;
      this.done({
        type: "undo",
        targetEntryId: node.turn.userEntryId,
        label: this.turnLabel(node.turn),
      });
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.moveSelection(-1);
    } else if (
      this.keybindings.matches(data, "tui.select.down") ||
      data === "j"
    ) {
      this.moveSelection(1);
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-Math.max(5, Math.floor(this.tui.terminal.rows / 2)));
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(Math.max(5, Math.floor(this.tui.terminal.rows / 2)));
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.toggleSelected();
    } else if (
      data === "h" ||
      this.keybindings.matches(data, "app.tree.foldOrUp")
    ) {
      this.collapseOrMoveParent();
    } else if (
      data === "l" ||
      this.keybindings.matches(data, "app.tree.unfoldOrDown")
    ) {
      this.expandOrMoveChild();
    } else if (data === "c" || data === "C") {
      this.collapseAllDiffs();
    } else if (data === "e" || data === "E") {
      this.expandAll();
    } else if (data === "]") {
      this.moveToHunk(1);
    } else if (data === "[") {
      this.moveToHunk(-1);
    } else if (data === "G") {
      this.selectLast();
    } else if (data === "g") {
      if (this.pendingG) {
        this.selectFirst();
        this.pendingG = false;
      } else {
        this.pendingG = true;
      }
      this.tui.requestRender();
      return;
    } else if (matchesKey(data, "left")) {
      this.collapseOrMoveParent();
    } else if (matchesKey(data, "right")) {
      this.expandOrMoveChild();
    } else if (isPrintableInput(data)) {
      this.searchQuery += data;
      this.foldedIds.clear();
      this.invalidateRows();
    } else {
      this.pendingG = false;
      return;
    }

    this.pendingG = false;
    this.tui.requestRender();
  }

  private indexModel(): void {
    for (const turn of this.model.turns) {
      const turnNode: TurnNode = {
        type: "turn",
        id: turn.id,
        turn,
        parentId: undefined,
      };
      this.addNode(turnNode);
      for (const file of turn.files) {
        const fileNode: FileNode = {
          type: "file",
          id: file.id,
          turn,
          file,
          parentId: turn.id,
        };
        this.addNode(fileNode);
        for (const hunk of file.hunks) {
          const hunkNode: HunkNode = {
            type: "hunk",
            id: hunk.id,
            turn,
            file,
            hunk,
            parentId: file.id,
          };
          this.addNode(hunkNode);
        }
      }
    }
    for (const [id, node] of this.nodesById) {
      const children = this.childrenById.get(id) ?? [];
      if (
        children.length > 0 ||
        (node.type === "hunk" && node.hunk.bodyLines.length > 0)
      ) {
        this.foldableIds.add(id);
      }
    }
  }

  private addNode(node: ReviewNode): void {
    this.nodesById.set(node.id, node);
    this.parentById.set(node.id, node.parentId);
    if (node.parentId) {
      const siblings = this.childrenById.get(node.parentId) ?? [];
      siblings.push(node.id);
      this.childrenById.set(node.parentId, siblings);
    }
    this.childrenById.set(node.id, []);
  }

  private foldHunksByDefault(): void {
    for (const [id, node] of this.nodesById) {
      if (node.type === "hunk") this.foldedIds.add(id);
    }
  }

  private firstSelectableId(): string | undefined {
    return this.model.turns[0]?.id;
  }

  private getRows(): RenderRow[] {
    this.cachedRows ??= this.buildRows();
    return this.cachedRows;
  }

  private invalidateRows(): void {
    this.cachedRows = undefined;
  }

  private buildRows(): RenderRow[] {
    const rows: RenderRow[] = [];
    const visibleNodeIds = this.getSearchVisibleNodeIds();
    for (let index = 0; index < this.model.turns.length; index++) {
      const turn = this.model.turns[index];
      if (!turn) continue;
      this.addNodeRows(
        rows,
        turn.id,
        0,
        "",
        index === this.model.turns.length - 1,
        visibleNodeIds,
      );
    }
    return rows;
  }

  private addNodeRows(
    rows: RenderRow[],
    nodeId: string,
    depth: number,
    prefix: string,
    isLast: boolean,
    visibleNodeIds: ReadonlySet<string> | undefined,
  ): void {
    if (visibleNodeIds && !visibleNodeIds.has(nodeId)) return;

    const node = this.nodesById.get(nodeId);
    if (!node) return;

    const rowPrefix = depth === 0 ? "" : `${prefix}${isLast ? "└─ " : "├─ "}`;
    rows.push({
      id: node.id,
      kind: node.type,
      depth,
      prefix: rowPrefix,
      selectable: true,
      node,
    });

    if (this.foldedIds.has(node.id)) return;

    const childPrefix = depth === 0 ? "" : `${prefix}${isLast ? "   " : "│  "}`;
    const childIds = (this.childrenById.get(node.id) ?? []).filter(
      (childId) => !visibleNodeIds || visibleNodeIds.has(childId),
    );
    for (let index = 0; index < childIds.length; index++) {
      const childId = childIds[index];
      if (!childId) continue;
      this.addNodeRows(
        rows,
        childId,
        depth + 1,
        childPrefix,
        index === childIds.length - 1,
        visibleNodeIds,
      );
    }

    if (node.type === "hunk") {
      const diffPrefix = `${childPrefix}   `;
      for (let index = 0; index < node.hunk.bodyLines.length; index++) {
        rows.push({
          id: `${node.id}:line:${index}`,
          kind: "diff",
          depth: depth + 1,
          prefix: diffPrefix,
          selectable: true,
          node,
          text: node.hunk.bodyLines[index] ?? "",
        });
      }
    }
  }

  private getSearchVisibleNodeIds(): ReadonlySet<string> | undefined {
    const tokens = this.searchQuery.toLowerCase().split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) return undefined;

    const visible = new Set<string>();
    for (const node of this.nodesById.values()) {
      const searchableText = this.getSearchableText(node).toLowerCase();
      if (!tokens.every((token) => searchableText.includes(token))) continue;
      this.addNodeAndAncestors(visible, node.id);
    }
    return visible;
  }

  private addNodeAndAncestors(target: Set<string>, nodeId: string): void {
    let currentId: string | undefined = nodeId;
    while (currentId) {
      target.add(currentId);
      currentId = this.parentById.get(currentId);
    }
  }

  private getSearchableText(node: ReviewNode): string {
    if (node.type === "turn") {
      return `${this.turnLabel(node.turn)} ${node.turn.prompt}`;
    }
    if (node.type === "file") {
      return `${node.file.path} +${node.file.additions} -${node.file.removals}`;
    }
    return [
      node.hunk.path,
      node.hunk.header,
      node.hunk.bodyLines.join("\n"),
      String(node.hunk.jumpLine),
    ].join(" ");
  }

  private renderRow(row: RenderRow, width: number): string {
    const selected = row.id === this.selectedId;
    const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
    const prefix = this.theme.fg("dim", this.prefixForRow(row));
    const content =
      row.kind === "diff"
        ? this.renderDiffLine(row.text, row.node.hunk.path)
        : this.renderNode(row.node, selected);
    let line = cursor + prefix + content;
    if (selected) line = this.theme.bg("selectedBg", line);
    return truncateToWidth(line, width);
  }

  private prefixForRow(row: RenderRow): string {
    return row.prefix;
  }

  private renderNode(node: ReviewNode, selected: boolean): string {
    const marker = this.foldMarker(node.id);
    let text: string;
    if (node.type === "turn") {
      const prompt = node.turn.prompt || "(empty prompt)";
      text = `${this.theme.fg("accent", "user: ")}${this.theme.fg("text", prompt)} ${this.statText(node.turn)}`;
    } else if (node.type === "file") {
      text = `${this.theme.fg("toolTitle", node.file.path)} ${this.statText(node.file)} ${this.theme.fg("muted", `${node.file.hunks.length} hunk${node.file.hunks.length === 1 ? "" : "s"}`)}`;
    } else {
      text = `${this.theme.fg("borderAccent", node.hunk.header)} ${this.theme.fg("dim", node.hunk.path)}`;
    }
    return `${marker}${selected ? this.theme.bold(text) : text}`;
  }

  private renderDiffLine(line: string, filePath: string): string {
    const parsed = parseDiffLine(line);
    if (!parsed) return this.theme.fg("toolDiffContext", line);

    const prefixColor =
      parsed.marker === "+"
        ? "toolDiffAdded"
        : parsed.marker === "-"
          ? "toolDiffRemoved"
          : "toolDiffContext";
    const prefix = this.theme.fg(prefixColor, parsed.prefix);
    const highlightedContent = this.highlightDiffContent(
      parsed.content,
      filePath,
    );

    if (!highlightedContent) return prefix;
    return `${prefix}${highlightedContent}`;
  }

  private highlightDiffContent(content: string, filePath: string): string {
    if (!content) return "";

    const language = getLanguageFromPath(filePath);
    if (!language) return this.theme.fg("toolOutput", content);

    return (
      highlightCode(content, language)[0] ??
      this.theme.fg("toolOutput", content)
    );
  }

  private foldMarker(id: string): string {
    if (!this.foldableIds.has(id)) return "  ";
    return this.foldedIds.has(id)
      ? this.theme.fg("accent", "⊞ ")
      : this.theme.fg("accent", "⊟ ");
  }

  private moveSelection(delta: number): void {
    const selectable = this.getRows().filter(isSelectableRow);
    if (selectable.length === 0) return;
    const currentIndex = Math.max(
      0,
      selectable.findIndex((row) => row.id === this.selectedId),
    );
    const nextIndex = clamp(currentIndex + delta, 0, selectable.length - 1);
    this.selectedId = selectable[nextIndex]?.id;
  }

  private moveToHunk(delta: number): void {
    const hunks = this.getRows().filter(isHunkRow);
    if (hunks.length === 0) return;
    const selectedNode = this.getSelectedNode();
    const selectedHunkId =
      selectedNode?.type === "hunk" ? selectedNode.id : this.selectedId;
    const currentIndex = hunks.findIndex((row) => row.id === selectedHunkId);
    const nextIndex =
      currentIndex === -1
        ? delta > 0
          ? 0
          : hunks.length - 1
        : clamp(currentIndex + delta, 0, hunks.length - 1);
    this.selectedId = hunks[nextIndex]?.id;
  }

  private selectFirst(): void {
    const first = this.getRows().find(isSelectableRow);
    this.selectedId = first?.id;
  }

  private selectLast(): void {
    const selectable = this.getRows().filter(isSelectableRow);
    this.selectedId = selectable[selectable.length - 1]?.id;
  }

  private toggleSelected(): void {
    const node = this.getSelectedNode();
    if (!node || !this.foldableIds.has(node.id)) return;
    this.selectedId = node.id;
    if (this.foldedIds.has(node.id)) {
      this.foldedIds.delete(node.id);
    } else {
      this.foldedIds.add(node.id);
    }
    this.invalidateRows();
  }

  private collapseOrMoveParent(): void {
    const node = this.getSelectedNode();
    if (!node) return;

    if (this.selectedId !== node.id) {
      this.selectedId = node.id;
      return;
    }

    if (this.foldableIds.has(node.id) && !this.foldedIds.has(node.id)) {
      this.foldedIds.add(node.id);
      this.invalidateRows();
      return;
    }
    const parentId = this.parentById.get(node.id);
    if (parentId) this.selectedId = parentId;
  }

  private expandOrMoveChild(): void {
    const node = this.getSelectedNode();
    if (!node) return;
    this.selectedId = node.id;
    if (this.foldableIds.has(node.id) && this.foldedIds.has(node.id)) {
      this.foldedIds.delete(node.id);
      this.invalidateRows();
      return;
    }
    const childId = this.childrenById.get(node.id)?.[0];
    if (childId) this.selectedId = childId;
  }

  private collapseAllDiffs(): void {
    this.foldedIds.clear();
    for (const [id, node] of this.nodesById) {
      if (node.type !== "turn") this.foldedIds.add(id);
    }
    this.invalidateRows();
  }

  private expandAll(): void {
    this.foldedIds.clear();
    this.invalidateRows();
  }

  private getSelectedNode(): ReviewNode | undefined {
    return this.getSelectedRow()?.node;
  }

  private getSelectedRow(): RenderRow | undefined {
    if (!this.selectedId) return undefined;
    return this.getRows().find((row) => row.id === this.selectedId);
  }

  private findHunkForNode(
    node: ReviewNode | undefined,
  ): ReviewHunk | undefined {
    return node?.type === "hunk" ? node.hunk : undefined;
  }

  private openSelectedHunk(): void {
    const hunk = this.findHunkForNode(this.getSelectedNode());
    if (!hunk) {
      this.notice = "Select a diff hunk to open an exact region.";
      return;
    }
    this.notice = openExternalEditor(
      this.tui,
      this.cwd,
      hunk.path,
      hunk.jumpLine,
    );
  }

  private summaryText(): string {
    return this.theme.fg(
      "muted",
      `${this.model.turns.length} turn${this.model.turns.length === 1 ? "" : "s"} • ${this.model.totalFiles} file${this.model.totalFiles === 1 ? "" : "s"} • ${this.model.totalHunks} hunk${this.model.totalHunks === 1 ? "" : "s"} • +${this.model.additions} -${this.model.removals}`,
    );
  }

  private statText(stats: { additions: number; removals: number }): string {
    return `${this.theme.fg("toolDiffAdded", `+${stats.additions}`)} ${this.theme.fg("toolDiffRemoved", `-${stats.removals}`)}`;
  }

  private turnLabel(turn: ReviewTurn): string {
    return `Turn ${turn.ordinal}`;
  }

  private describeNode(node: ReviewNode): string {
    if (node.type === "turn")
      return `${this.turnLabel(node.turn)} • u to undo to this turn`;
    if (node.type === "file")
      return `${node.file.path} • ${node.file.hunks.length} hunk${node.file.hunks.length === 1 ? "" : "s"}`;
    return `${node.hunk.path}:${node.hunk.jumpLine} • ${keyText("app.editor.external")} opens here`;
  }
}

function isSelectableRow(row: RenderRow): row is SelectableRow {
  return row.selectable;
}

function isHunkRow(row: RenderRow): row is SelectableRow & { node: HunkNode } {
  return row.selectable && row.node.type === "hunk";
}

function isPrintableInput(data: string): boolean {
  if (data.length === 0) return false;
  return ![...data].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
  });
}

interface ParsedDiffLine {
  marker: "+" | "-" | " ";
  prefix: string;
  content: string;
}

function parseDiffLine(line: string): ParsedDiffLine | undefined {
  const match = /^([+\- ])(\s*\d*)\s?(.*)$/u.exec(line);
  if (!match?.[1]) return undefined;

  const marker = match[1];
  if (marker !== "+" && marker !== "-" && marker !== " ") return undefined;

  const lineNumber = match[2] ?? "";
  const content = match[3] ?? "";
  return {
    marker,
    prefix: `${marker}${lineNumber}${content ? " " : ""}`,
    content,
  };
}

function openExternalEditor(
  tui: TUI,
  cwd: string,
  filePath: string,
  line: number,
): string {
  const absolutePath = resolve(cwd, filePath);
  if (!existsSync(absolutePath)) {
    return `File no longer exists: ${filePath}`;
  }

  const editorCommand =
    process.env.VISUAL || process.env.EDITOR || firstAvailableEditor() || "vi";
  const [editor, ...editorArgs] = splitCommandLine(editorCommand);
  if (!editor) return "No external editor configured.";

  const args = buildEditorArgs(editor, editorArgs, absolutePath, line);
  try {
    tui.stop();
    const result = spawnSync(editor, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.error) {
      return `Editor failed: ${result.error.message}`;
    }
    if (result.status && result.status !== 0) {
      return `Editor exited with status ${result.status}`;
    }
    return `Returned from ${editor} at ${filePath}:${line}`;
  } finally {
    tui.start();
    tui.requestRender(true);
  }
}

function firstAvailableEditor(): string | undefined {
  for (const candidate of ["nvim", "vim", "vi"] as const) {
    if (commandExists(candidate)) return candidate;
  }
  return undefined;
}

function commandExists(command: string): boolean {
  const result =
    process.platform === "win32"
      ? spawnSync("where", [command], { stdio: "ignore" })
      : spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
          stdio: "ignore",
        });
  return result.status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of commandLine.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += "\\";
  if (current) parts.push(current);
  return parts;
}

function buildEditorArgs(
  editor: string,
  editorArgs: string[],
  filePath: string,
  line: number,
): string[] {
  const editorName = (editor.split(/[\\/]/u).pop() ?? editor).toLowerCase();
  if (
    editorName === "code" ||
    editorName === "code-insiders" ||
    editorName === "cursor"
  ) {
    return [...editorArgs, "--goto", `${filePath}:${line}:1`];
  }
  if (editorName === "hx" || editorName === "helix") {
    return [...editorArgs, `${filePath}:${line}:1`];
  }
  return [...editorArgs, `+${line}`, filePath];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
