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

export type DiffReviewAction = { type: "close" };

interface Gutter {
  position: number;
  show: boolean;
}

interface TurnRow {
  id: string;
  kind: "turn";
  selectable: true;
  turn: ReviewTurn;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  gutters: Gutter[];
  isVirtualRootChild: boolean;
}

interface FileRow {
  id: string;
  kind: "file";
  selectable: true;
  turn: ReviewTurn;
  prefix: string;
  file: ReviewFile;
}

interface HunkRow {
  id: string;
  kind: "hunk";
  selectable: true;
  turn: ReviewTurn;
  prefix: string;
  file: ReviewFile;
  hunk: ReviewHunk;
}

interface DiffLineRow {
  id: string;
  kind: "diff";
  selectable: true;
  turn: ReviewTurn;
  prefix: string;
  file: ReviewFile;
  hunk: ReviewHunk;
  text: string;
}

type RenderRow = TurnRow | FileRow | HunkRow | DiffLineRow;
type DetailRow = FileRow | HunkRow | DiffLineRow;
type FoldableDetailRow = FileRow | HunkRow;

export class DiffReviewComponent implements Component {
  private readonly turnsById = new Map<string, ReviewTurn>();
  private readonly parentById = new Map<string, string | undefined>();
  private readonly childrenById = new Map<string, string[]>();
  private readonly activeTurnIds = new Set<string>();
  private readonly activeDescendantMemo = new Map<string, boolean>();
  private readonly foldedBranchIds = new Set<string>();
  private readonly foldedDetailIds = new Set<string>();
  private visibleParentById = new Map<string, string | undefined>();
  private visibleChildrenById = new Map<string | undefined, string[]>();
  private multipleVisibleRoots = false;
  private cachedRows: RenderRow[] | undefined;
  private selectedId: string | undefined;
  private detailTurnId: string | undefined;
  private lastPageSize = 5;
  private pendingG = false;
  private pendingBracket: "[" | "]" | undefined;
  private pendingBracketTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.foldDetailHunksByDefault();
    this.detailTurnId = this.preferredHeadTurnId();
    this.selectedId = this.detailTurnId;
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
          `  ↑/↓: move. ←/→: page. h/l: fold/branch/dive. tab: turn/files. [/]: hunk. [f/]f: file. enter/${keyText("app.editor.external")}: open hunk. q/esc: close`,
        ),
        width,
      ),
    );
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
            "  No edit/write changes found in this session tree.",
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

    let rows = this.getRows();
    this.ensureSelectionVisible(rows);
    rows = this.getRows();
    const maxBodyLines = this.getBodyBudgetLines();
    this.lastPageSize = Math.max(1, maxBodyLines - 1);
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

    lines.push(
      truncateToWidth(this.theme.fg("muted", this.statusText()), width),
    );
    lines.push("");
    lines.push(...border.render(width));
    return lines;
  }

  private getBodyBudgetLines(): number {
    const reservedLines = this.notice ? 10 : 9;
    return Math.max(5, this.tui.terminal.rows - reservedLines);
  }

  private ensureSelectionVisible(rows: readonly RenderRow[]): void {
    if (rows.some((row) => row.selectable && row.id === this.selectedId)) {
      return;
    }

    const preferredHeadId = this.preferredHeadTurnId();
    const preferredRow = rows.find((row) => row.id === preferredHeadId);
    this.selectRow(preferredRow?.id ?? rows[rows.length - 1]?.id);
  }

  private setPendingBracket(bracket: "[" | "]"): void {
    this.clearPendingBracket();
    this.pendingBracket = bracket;
    this.pendingBracketTimer = setTimeout(() => {
      const pendingBracket = this.consumePendingBracket();
      if (!pendingBracket) return;
      this.moveToHunk(pendingBracket === "]" ? 1 : -1);
      this.tui.requestRender();
    }, 160);
  }

  private consumePendingBracket(): "[" | "]" | undefined {
    const pendingBracket = this.pendingBracket;
    this.clearPendingBracket();
    return pendingBracket;
  }

  private clearPendingBracket(): void {
    if (this.pendingBracketTimer) {
      clearTimeout(this.pendingBracketTimer);
      this.pendingBracketTimer = undefined;
    }
    this.pendingBracket = undefined;
  }

  handleInput(data: string): void {
    this.notice = undefined;

    if (
      this.pendingBracket &&
      (this.keybindings.matches(data, "tui.select.cancel") ||
        data === "q" ||
        data === "Q")
    ) {
      this.clearPendingBracket();
    }

    const pendingBracket = this.consumePendingBracket();
    if (pendingBracket && (data === "f" || data === "F")) {
      this.moveToFile(pendingBracket === "]" ? 1 : -1);
      this.pendingG = false;
      this.tui.requestRender();
      return;
    }
    if (pendingBracket) {
      this.moveToHunk(pendingBracket === "]" ? 1 : -1);
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done({ type: "close" });
      return;
    }

    if (data === "q" || data === "Q") {
      this.done({ type: "close" });
      return;
    }

    if (data === "\t") {
      this.toggleTurnFileJump();
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "app.editor.external")) {
      this.openSelectedHunk();
      this.tui.requestRender(true);
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
      this.moveSelection(-Math.max(1, this.lastPageSize));
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(Math.max(1, this.lastPageSize));
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.openSelectedHunk();
    } else if (
      data === "h" ||
      this.keybindings.matches(data, "app.tree.foldOrUp")
    ) {
      this.moveParentOrCollapse();
    } else if (
      data === "l" ||
      this.keybindings.matches(data, "app.tree.unfoldOrDown")
    ) {
      this.moveChildOrExpand();
    } else if (data === "c" || data === "C") {
      this.collapseSelectedScope();
    } else if (data === "e" || data === "E") {
      this.expandSelectedScope();
    } else if (data === "]" || data === "[") {
      this.setPendingBracket(data);
      this.pendingG = false;
      this.tui.requestRender();
      return;
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
      this.moveSelection(-Math.max(1, this.lastPageSize));
    } else if (matchesKey(data, "right")) {
      this.moveSelection(Math.max(1, this.lastPageSize));
    } else {
      this.pendingG = false;
      return;
    }

    this.pendingG = false;
    this.tui.requestRender();
  }

  private indexModel(): void {
    for (const turnId of this.model.activeTurnIds) {
      this.activeTurnIds.add(turnId);
    }
    for (const root of this.model.roots) {
      this.addTurnAndChildren(root, undefined);
    }
    for (const turn of this.model.turns) {
      if (!this.turnsById.has(turn.id)) {
        this.addTurnAndChildren(turn, undefined);
      }
    }
  }

  private foldDetailHunksByDefault(): void {
    for (const turn of this.model.turns) {
      for (const file of turn.files) {
        for (const hunk of file.hunks) {
          this.foldedDetailIds.add(hunk.id);
        }
      }
    }
  }

  private addTurnAndChildren(
    turn: ReviewTurn,
    parentId: string | undefined,
  ): void {
    if (this.turnsById.has(turn.id)) return;
    this.turnsById.set(turn.id, turn);
    this.parentById.set(turn.id, parentId);
    this.childrenById.set(
      turn.id,
      turn.children.map((child) => child.id),
    );
    for (const child of turn.children) {
      this.addTurnAndChildren(child, turn.id);
    }
  }

  private preferredHeadTurnId(): string | undefined {
    return (
      this.model.activeTurnIds[this.model.activeTurnIds.length - 1] ??
      this.model.turns[this.model.turns.length - 1]?.id
    );
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
    const rootIds = this.model.roots.map((root) => root.id);
    const orderedRootIds = this.sortActiveFirst(rootIds);
    this.visibleParentById = new Map<string, string | undefined>();
    this.visibleChildrenById = new Map<string | undefined, string[]>();
    this.visibleChildrenById.set(undefined, orderedRootIds);
    this.multipleVisibleRoots = orderedRootIds.length > 1;

    for (let index = 0; index < orderedRootIds.length; index++) {
      const rootId = orderedRootIds[index];
      if (!rootId) continue;
      this.addTurnRows(
        rows,
        rootId,
        this.multipleVisibleRoots ? 1 : 0,
        this.multipleVisibleRoots,
        this.multipleVisibleRoots,
        index === orderedRootIds.length - 1,
        [],
        this.multipleVisibleRoots,
        undefined,
      );
    }
    return rows;
  }

  private addTurnRows(
    rows: RenderRow[],
    turnId: string,
    indent: number,
    justBranched: boolean,
    showConnector: boolean,
    isLast: boolean,
    gutters: readonly Gutter[],
    isVirtualRootChild: boolean,
    visibleParentId: string | undefined,
  ): void {
    const turn = this.turnsById.get(turnId);
    if (!turn) return;

    this.visibleParentById.set(turnId, visibleParentId);
    const turnRow: TurnRow = {
      id: turn.id,
      kind: "turn",
      selectable: true,
      turn,
      indent,
      showConnector,
      isLast,
      gutters: [...gutters],
      isVirtualRootChild,
    };
    rows.push(turnRow);

    if (this.detailTurnId === turn.id) {
      this.addDetailRows(rows, turn, turnRow);
    }

    const childIds = this.sortActiveFirst(this.childrenById.get(turn.id) ?? []);
    this.visibleChildrenById.set(turnId, childIds);
    if (this.foldedBranchIds.has(turn.id)) return;

    const multipleChildren = childIds.length > 1;
    const childIndent = multipleChildren
      ? indent + 1
      : justBranched && indent > 0
        ? indent + 1
        : indent;
    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const currentDisplayIndent = this.multipleVisibleRoots
      ? Math.max(0, indent - 1)
      : indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed
      ? [...gutters, { position: connectorPosition, show: !isLast }]
      : gutters;

    for (let index = 0; index < childIds.length; index++) {
      const childId = childIds[index];
      if (!childId) continue;
      this.addTurnRows(
        rows,
        childId,
        childIndent,
        multipleChildren,
        multipleChildren,
        index === childIds.length - 1,
        childGutters,
        false,
        turn.id,
      );
    }
  }

  private addDetailRows(
    rows: RenderRow[],
    turn: ReviewTurn,
    turnRow: TurnRow,
  ): void {
    const basePrefix = this.prefixForTurnChildRows(turnRow);
    for (let fileIndex = 0; fileIndex < turn.files.length; fileIndex++) {
      const file = turn.files[fileIndex];
      if (!file) continue;
      const fileIsLast = fileIndex === turn.files.length - 1;
      const filePrefix = `${basePrefix}${fileIsLast ? "└─ " : "├─ "}`;
      const fileChildPrefix = `${basePrefix}${fileIsLast ? "   " : "│  "}`;
      rows.push({
        id: file.id,
        kind: "file",
        selectable: true,
        turn,
        prefix: filePrefix,
        file,
      });
      if (this.foldedDetailIds.has(file.id)) continue;

      for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex++) {
        const hunk = file.hunks[hunkIndex];
        if (!hunk) continue;
        const hunkIsLast = hunkIndex === file.hunks.length - 1;
        const hunkPrefix = `${fileChildPrefix}${hunkIsLast ? "└─ " : "├─ "}`;
        const diffPrefix = `${fileChildPrefix}${hunkIsLast ? "   " : "│  "}`;
        rows.push({
          id: hunk.id,
          kind: "hunk",
          selectable: true,
          turn,
          prefix: hunkPrefix,
          file,
          hunk,
        });
        if (this.foldedDetailIds.has(hunk.id)) continue;

        for (let index = 0; index < hunk.bodyLines.length; index++) {
          rows.push({
            id: `${hunk.id}:line:${index}`,
            kind: "diff",
            selectable: true,
            turn,
            prefix: diffPrefix,
            file,
            hunk,
            text: hunk.bodyLines[index] ?? "",
          });
        }
      }
    }
  }

  private sortActiveFirst(ids: readonly string[]): string[] {
    return [...ids].sort((left, right) => {
      const leftActive = this.subtreeContainsActiveTurn(left);
      const rightActive = this.subtreeContainsActiveTurn(right);
      return Number(rightActive) - Number(leftActive);
    });
  }

  private subtreeContainsActiveTurn(turnId: string): boolean {
    const cached = this.activeDescendantMemo.get(turnId);
    if (cached !== undefined) return cached;

    const contains =
      this.activeTurnIds.has(turnId) ||
      (this.childrenById.get(turnId) ?? []).some((childId) =>
        this.subtreeContainsActiveTurn(childId),
      );
    this.activeDescendantMemo.set(turnId, contains);
    return contains;
  }

  private renderRow(row: RenderRow, width: number): string {
    if (row.kind === "turn") return this.renderTurnRow(row, width);
    return this.renderDetailRow(row, width);
  }

  private renderTurnRow(row: TurnRow, width: number): string {
    const selected = row.id === this.selectedId;
    const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
    const prefix = this.theme.fg("dim", this.prefixForTurnRow(row));
    const foldMarker = this.rootFoldMarker(row);
    const pathMarker = this.activeTurnIds.has(row.id)
      ? this.theme.fg("accent", "• ")
      : "";
    const prompt = row.turn.prompt || "(empty prompt)";
    const text = `${foldMarker}${pathMarker}${this.theme.fg("accent", "user: ")}${this.theme.fg("text", prompt)} ${this.statText(row.turn)} ${this.fileHunkText(row.turn)}`;
    let line = cursor + prefix + (selected ? this.theme.bold(text) : text);
    if (selected) line = this.theme.bg("selectedBg", line);
    return truncateToWidth(line, width);
  }

  private prefixForTurnRow(row: TurnRow): string {
    const displayIndent = this.displayIndentForTurn(row);
    const connector = row.showConnector && !row.isVirtualRootChild;
    const connectorPosition = connector ? displayIndent - 1 : -1;
    const totalChars = displayIndent * 3;
    const prefixChars: string[] = [];
    const isFolded = this.foldedBranchIds.has(row.id);

    for (let index = 0; index < totalChars; index++) {
      const level = Math.floor(index / 3);
      const posInLevel = index % 3;
      const gutter = row.gutters.find(
        (candidate) => candidate.position === level,
      );

      if (gutter) {
        prefixChars.push(posInLevel === 0 && gutter.show ? "│" : " ");
      } else if (connector && level === connectorPosition) {
        if (posInLevel === 0) {
          prefixChars.push(row.isLast ? "└" : "├");
        } else if (posInLevel === 1) {
          prefixChars.push(
            isFolded ? "⊞" : this.isBranchFoldable(row.id) ? "⊟" : "─",
          );
        } else {
          prefixChars.push(" ");
        }
      } else {
        prefixChars.push(" ");
      }
    }

    return prefixChars.join("");
  }

  private prefixForTurnChildRows(row: TurnRow): string {
    const displayIndent = this.displayIndentForTurn(row);
    const connector = row.showConnector && !row.isVirtualRootChild;
    const connectorPosition = connector ? displayIndent - 1 : -1;
    const segments: string[] = [];

    for (let level = 0; level < displayIndent; level++) {
      const gutter = row.gutters.find(
        (candidate) => candidate.position === level,
      );
      if (gutter) {
        segments.push(gutter.show ? "│  " : "   ");
      } else if (connector && level === connectorPosition) {
        segments.push(row.isLast ? "   " : "│  ");
      } else {
        segments.push("   ");
      }
    }

    return segments.join("");
  }

  private displayIndentForTurn(row: TurnRow): number {
    return this.multipleVisibleRoots ? Math.max(0, row.indent - 1) : row.indent;
  }

  private rootFoldMarker(row: TurnRow): string {
    const showsFoldInConnector = row.showConnector && !row.isVirtualRootChild;
    if (!this.foldedBranchIds.has(row.id) || showsFoldInConnector) return "";
    return this.theme.fg("accent", "⊞ ");
  }

  private renderDetailRow(row: DetailRow, width: number): string {
    const selected = row.id === this.selectedId;
    const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
    const prefix = this.theme.fg("dim", row.prefix);
    let content: string;
    if (row.kind === "file") {
      content = `${this.detailFoldMarker(row)}${this.theme.fg("toolTitle", row.file.path)} ${this.statText(row.file)} ${this.theme.fg("muted", `${row.file.hunks.length} hunk${row.file.hunks.length === 1 ? "" : "s"}`)}`;
    } else if (row.kind === "hunk") {
      content = `${this.detailFoldMarker(row)}${this.theme.fg("borderAccent", row.hunk.header)} ${this.theme.fg("dim", row.hunk.path)}`;
    } else {
      content = `  ${this.renderDiffLine(row.text, row.hunk.path)}`;
    }

    let line = cursor + prefix + content;
    if (selected) line = this.theme.bg("selectedBg", line);
    return truncateToWidth(line, width);
  }

  private detailFoldMarker(row: FoldableDetailRow): string {
    if (!this.isDetailFoldable(row)) return "  ";
    return this.foldedDetailIds.has(row.id)
      ? this.theme.fg("accent", "⊞ ")
      : this.theme.fg("accent", "⊟ ");
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

  private moveSelection(delta: number): void {
    const rows = this.getRows();
    if (rows.length === 0) return;
    const currentIndex = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selectedId),
    );
    const nextIndex = clamp(currentIndex + delta, 0, rows.length - 1);
    this.selectRow(rows[nextIndex]?.id);
  }

  private moveToHunk(delta: number): void {
    const turn = this.getSelectedTurn();
    if (!turn) return;
    const hunks = this.getAllHunks(turn);
    if (hunks.length === 0) return;
    const selectedHunkId = this.findHunkForRow(this.getSelectedRow())?.id;
    const currentIndex = hunks.findIndex((hunk) => hunk.id === selectedHunkId);
    const nextIndex =
      currentIndex === -1
        ? delta > 0
          ? 0
          : hunks.length - 1
        : clamp(currentIndex + delta, 0, hunks.length - 1);
    const hunk = hunks[nextIndex];
    if (!hunk) return;
    this.detailTurnId = turn.id;
    this.foldedDetailIds.delete(hunk.fileId);
    this.selectedId = hunk.id;
    this.invalidateRows();
  }

  private moveToFile(delta: number): void {
    const turn = this.getSelectedTurn();
    if (!turn || turn.files.length === 0) return;

    const selectedRow = this.getSelectedRow();
    const selectedFileId =
      selectedRow && selectedRow.kind !== "turn"
        ? selectedRow.file.id
        : undefined;
    const currentIndex = turn.files.findIndex(
      (file) => file.id === selectedFileId,
    );
    const nextIndex =
      currentIndex === -1
        ? delta > 0
          ? 0
          : turn.files.length - 1
        : clamp(currentIndex + delta, 0, turn.files.length - 1);
    const file = turn.files[nextIndex];
    if (!file) return;
    this.detailTurnId = turn.id;
    this.selectedId = file.id;
    this.invalidateRows();
  }

  private moveParentOrCollapse(): void {
    const row = this.getSelectedRow();
    if (!row) return;

    if (row.kind === "diff") {
      this.selectRow(row.hunk.id);
      return;
    }

    if (row.kind === "hunk") {
      if (this.isDetailExpanded(row)) {
        this.foldedDetailIds.add(row.id);
        this.invalidateRows();
      } else {
        this.selectRow(row.file.id);
      }
      return;
    }

    if (row.kind === "file") {
      if (this.isDetailExpanded(row)) {
        this.foldedDetailIds.add(row.id);
        this.invalidateRows();
      } else {
        this.selectRow(row.turn.id);
      }
      return;
    }

    if (this.isBranchFoldable(row.id) && !this.foldedBranchIds.has(row.id)) {
      this.foldedBranchIds.add(row.id);
      this.invalidateRows();
      return;
    }

    const parentId = this.parentById.get(row.id);
    if (parentId) this.selectRow(parentId);
  }

  private moveChildOrExpand(): void {
    const row = this.getSelectedRow();
    if (!row) return;

    if (row.kind === "turn") {
      const firstFile = row.turn.files[0];
      if (firstFile) {
        this.detailTurnId = row.turn.id;
        this.selectedId = firstFile.id;
        this.invalidateRows();
        return;
      }

      if (this.foldedBranchIds.has(row.id)) {
        this.foldedBranchIds.delete(row.id);
        this.invalidateRows();
        return;
      }
      const childId = this.firstVisibleChildId(row.id);
      if (childId) this.selectRow(childId);
      return;
    }

    if (row.kind === "file") {
      if (this.foldedDetailIds.has(row.id)) {
        this.foldedDetailIds.delete(row.id);
        this.invalidateRows();
        return;
      }
      this.selectRow(row.file.hunks[0]?.id ?? row.id);
      return;
    }

    if (row.kind === "hunk") {
      if (this.foldedDetailIds.has(row.id)) {
        this.foldedDetailIds.delete(row.id);
        this.invalidateRows();
        return;
      }
      this.selectRow(
        row.hunk.bodyLines.length > 0 ? `${row.hunk.id}:line:0` : row.id,
      );
    }
  }

  private collapseSelectedScope(): void {
    const row = this.getSelectedRow();
    if (!row) return;
    if (row.kind === "turn") {
      this.collapseAllBranches();
    } else {
      this.collapseAllDetails(row.turn);
    }
  }

  private expandSelectedScope(): void {
    const row = this.getSelectedRow();
    if (!row) return;
    if (row.kind === "turn") {
      this.expandAllBranches();
    } else {
      this.expandAllDetails(row.turn);
    }
  }

  private collapseAllBranches(): void {
    this.foldedBranchIds.clear();
    this.invalidateRows();
    for (const row of this.getRows()) {
      if (row.kind === "turn" && this.isBranchFoldable(row.id)) {
        this.foldedBranchIds.add(row.id);
      }
    }
    this.invalidateRows();
  }

  private expandAllBranches(): void {
    this.foldedBranchIds.clear();
    this.invalidateRows();
  }

  private collapseAllDetails(turn: ReviewTurn): void {
    for (const file of turn.files) {
      this.foldedDetailIds.add(file.id);
      for (const hunk of file.hunks) {
        this.foldedDetailIds.add(hunk.id);
      }
    }
    this.invalidateRows();
  }

  private expandAllDetails(turn: ReviewTurn): void {
    for (const file of turn.files) {
      this.foldedDetailIds.delete(file.id);
      for (const hunk of file.hunks) {
        this.foldedDetailIds.delete(hunk.id);
      }
    }
    this.invalidateRows();
  }

  private toggleTurnFileJump(): void {
    const row = this.getSelectedRow();
    if (!row) return;
    if (row.kind === "turn") {
      const firstFile = row.turn.files[0];
      if (!firstFile) return;
      this.detailTurnId = row.turn.id;
      this.selectedId = firstFile.id;
      this.invalidateRows();
      return;
    }
    this.selectRow(row.turn.id);
  }

  private selectFirst(): void {
    this.selectRow(this.getRows()[0]?.id);
  }

  private selectLast(): void {
    const rows = this.getRows();
    this.selectRow(rows[rows.length - 1]?.id);
  }

  private selectRow(id: string | undefined): void {
    if (!id) return;
    const row = this.getRows().find((candidate) => candidate.id === id);
    this.selectedId = id;
    if (row) {
      const nextDetailTurnId = row.turn.id;
      if (this.detailTurnId !== nextDetailTurnId) {
        this.detailTurnId = nextDetailTurnId;
        this.invalidateRows();
      }
    }
  }

  private getSelectedRow(): RenderRow | undefined {
    if (!this.selectedId) return undefined;
    return this.getRows().find((row) => row.id === this.selectedId);
  }

  private getSelectedTurn(): ReviewTurn | undefined {
    const selectedRow = this.getSelectedRow();
    if (selectedRow) return selectedRow.turn;
    if (this.detailTurnId) return this.turnsById.get(this.detailTurnId);
    const preferredHeadId = this.preferredHeadTurnId();
    return preferredHeadId ? this.turnsById.get(preferredHeadId) : undefined;
  }

  private isBranchFoldable(turnId: string): boolean {
    const children = this.visibleChildrenById.get(turnId);
    if (!children || children.length === 0) return false;

    const parentId = this.visibleParentById.get(turnId);
    if (parentId === undefined) return true;

    const siblings = this.visibleChildrenById.get(parentId);
    return siblings !== undefined && siblings.length > 1;
  }

  private firstVisibleChildId(turnId: string): string | undefined {
    return this.visibleChildrenById.get(turnId)?.[0];
  }

  private isDetailExpanded(row: FoldableDetailRow): boolean {
    return this.isDetailFoldable(row) && !this.foldedDetailIds.has(row.id);
  }

  private isDetailFoldable(row: FoldableDetailRow): boolean {
    return row.kind === "file"
      ? row.file.hunks.length > 0
      : row.hunk.bodyLines.length > 0;
  }

  private getAllHunks(turn: ReviewTurn): ReviewHunk[] {
    return turn.files.flatMap((file) => file.hunks);
  }

  private findHunkForRow(row: RenderRow | undefined): ReviewHunk | undefined {
    if (!row) return undefined;
    if (row.kind === "turn") return this.firstHunk(row.turn);
    if (row.kind === "file") return row.file.hunks[0];
    return row.hunk;
  }

  private firstHunk(turn: ReviewTurn | undefined): ReviewHunk | undefined {
    if (!turn) return undefined;
    for (const file of turn.files) {
      const hunk = file.hunks[0];
      if (hunk) return hunk;
    }
    return undefined;
  }

  private openSelectedHunk(): void {
    const hunk = this.findHunkForRow(this.getSelectedRow());
    if (!hunk) {
      this.notice = "Select a changed file, hunk, or diff line to open it.";
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

  private statusText(): string {
    const rows = this.getRows();
    const position = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selectedId) + 1,
    );
    const selectedRow = this.getSelectedRow();
    if (!selectedRow) return "  (0/0)";
    return `  (${position}/${rows.length}) ${this.describeRow(selectedRow)}`;
  }

  private statText(stats: { additions: number; removals: number }): string {
    return `${this.theme.fg("toolDiffAdded", `+${stats.additions}`)} ${this.theme.fg("toolDiffRemoved", `-${stats.removals}`)}`;
  }

  private fileHunkText(turn: ReviewTurn): string {
    const hunkCount = turn.files.reduce(
      (total, file) => total + file.hunks.length,
      0,
    );
    return this.theme.fg(
      "muted",
      `${turn.files.length} file${turn.files.length === 1 ? "" : "s"} ${hunkCount} hunk${hunkCount === 1 ? "" : "s"}`,
    );
  }

  private turnLabel(turn: ReviewTurn): string {
    return `user: ${turn.prompt || "(empty prompt)"}`;
  }

  private describeRow(row: RenderRow): string {
    if (row.kind === "turn") return this.turnLabel(row.turn);
    if (row.kind === "file") {
      return `${row.file.path} • ${row.file.hunks.length} hunk${row.file.hunks.length === 1 ? "" : "s"}`;
    }
    if (row.kind === "hunk") {
      return `${row.hunk.path}:${row.hunk.jumpLine} • ${keyText("app.editor.external")} opens here`;
    }
    return `${row.hunk.path}:${row.hunk.jumpLine} • diff line`;
  }
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
