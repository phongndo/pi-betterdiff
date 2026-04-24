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

type FocusMode = "tree" | "details";

interface Gutter {
  position: number;
  show: boolean;
}

interface TurnRow {
  id: string;
  turn: ReviewTurn;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  gutters: Gutter[];
  isVirtualRootChild: boolean;
}

interface FileDetailRow {
  id: string;
  kind: "file";
  selectable: true;
  file: ReviewFile;
}

interface HunkDetailRow {
  id: string;
  kind: "hunk";
  selectable: true;
  file: ReviewFile;
  hunk: ReviewHunk;
}

interface DiffDetailRow {
  id: string;
  kind: "diff";
  selectable: true;
  file: ReviewFile;
  hunk: ReviewHunk;
  text: string;
}

type DetailRow = FileDetailRow | HunkDetailRow | DiffDetailRow;
type SelectableDetailRow = FileDetailRow | HunkDetailRow | DiffDetailRow;

export class DiffReviewComponent implements Component {
  private readonly turnsById = new Map<string, ReviewTurn>();
  private readonly parentById = new Map<string, string | undefined>();
  private readonly childrenById = new Map<string, string[]>();
  private readonly activeTurnIds = new Set<string>();
  private readonly activeDescendantMemo = new Map<string, boolean>();
  private readonly foldedIds = new Set<string>();
  private visibleParentById = new Map<string, string | undefined>();
  private visibleChildrenById = new Map<string | undefined, string[]>();
  private multipleVisibleRoots = false;
  private cachedTreeRows: TurnRow[] | undefined;
  private selectedTurnId: string | undefined;
  private selectedDetailId: string | undefined;
  private focus: FocusMode = "tree";
  private detailScrollOffset = 0;
  private lastTreePageSize = 5;
  private lastDetailsPageSize = 5;
  private searchQuery = "";
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
    this.selectedTurnId = this.firstSelectableTurnId();
  }

  invalidate(): void {
    this.invalidateTreeRows();
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
          `  ↑/↓: move. ←/→: page. enter/tab: ${this.focus === "tree" ? "diff details" : "tree"}. [/]: hunk. [f/]f: file. ${keyText("app.tree.foldOrUp")}/${keyText("app.tree.unfoldOrDown")} or h/l: fold/branch. ${keyText("app.editor.external")}: open hunk. q/esc: close`,
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

    const bodyBudget = this.getBodyBudgetLines();
    const treeRows = this.getTreeRows();
    this.ensureSelectedTurnVisible(treeRows);
    const treeHeight = this.calculateTreeHeight(treeRows.length, bodyBudget);
    this.lastTreePageSize = Math.max(1, treeHeight - 1);
    const treeStart = this.calculateSelectedWindowStart(
      treeRows,
      this.selectedTurnId,
      treeHeight,
    );
    const treeEnd = Math.min(treeRows.length, treeStart + treeHeight);

    for (let index = treeStart; index < treeEnd; index++) {
      const row = treeRows[index];
      if (!row) continue;
      lines.push(this.renderTurnRow(row, width));
    }

    if (treeRows.length === 0) {
      lines.push(
        truncateToWidth(
          this.theme.fg("muted", "  No diff turns match the search."),
          width,
        ),
      );
    }

    const detailsHeaderLines = 1;
    const detailsHeight = Math.max(
      0,
      bodyBudget -
        Math.max(treeHeight, treeRows.length === 0 ? 1 : 0) -
        detailsHeaderLines,
    );
    if (detailsHeight > 0) {
      lines.push(this.renderDetailsHeader(width));
      this.lastDetailsPageSize = Math.max(1, detailsHeight - 1);
      const detailRows = this.getDetailRows();
      this.ensureDetailSelection(detailRows);
      this.ensureDetailScroll(detailRows, detailsHeight);
      const detailEnd = Math.min(
        detailRows.length,
        this.detailScrollOffset + detailsHeight,
      );
      for (let index = this.detailScrollOffset; index < detailEnd; index++) {
        const row = detailRows[index];
        if (!row) continue;
        lines.push(this.renderDetailRow(row, width));
      }

      if (detailRows.length === 0) {
        lines.push(
          truncateToWidth(
            this.theme.fg("muted", "  No changed files on selected turn."),
            width,
          ),
        );
      }
    }

    lines.push(
      truncateToWidth(this.theme.fg("muted", this.statusText()), width),
    );
    lines.push("");
    lines.push(...border.render(width));
    return lines;
  }

  private getBodyBudgetLines(): number {
    const reservedLines = this.notice ? 11 : 10;
    return Math.max(5, this.tui.terminal.rows - reservedLines);
  }

  private calculateTreeHeight(rowCount: number, bodyBudget: number): number {
    if (rowCount === 0) return 0;
    if (bodyBudget <= 7) return Math.min(rowCount, bodyBudget);
    const maxTreeHeight = Math.max(3, Math.min(10, Math.floor(bodyBudget / 3)));
    return Math.min(rowCount, maxTreeHeight);
  }

  private renderSearchLine(width: number): string {
    const label = this.theme.fg("muted", "  Type to search:");
    const query = this.searchQuery
      ? ` ${this.theme.fg("accent", this.searchQuery)}`
      : "";
    return truncateToWidth(`${label}${query}`, width);
  }

  private renderDetailsHeader(width: number): string {
    const turn = this.getSelectedTurn();
    const prompt = turn?.prompt || "(no selected prompt)";
    const focusText =
      this.focus === "details"
        ? this.theme.fg("accent", "diff focus")
        : this.theme.fg("muted", "tree focus");
    return truncateToWidth(
      `  ${this.theme.fg("border", "─")} ${this.theme.bold("Changes for selected prompt")} ${this.theme.fg("muted", "—")} ${focusText} ${this.theme.fg("dim", prompt)}`,
      width,
    );
  }

  private ensureSelectedTurnVisible(rows: readonly TurnRow[]): void {
    if (rows.some((row) => row.id === this.selectedTurnId)) return;
    this.selectTurn(rows[0]?.id);
  }

  private clearSearch(): void {
    this.searchQuery = "";
    this.foldedIds.clear();
    this.invalidateTreeRows();
  }

  private setPendingBracket(bracket: "[" | "]"): void {
    this.clearPendingBracket();
    this.pendingBracket = bracket;
    this.pendingBracketTimer = setTimeout(() => {
      const pendingBracket = this.consumePendingBracket();
      if (!pendingBracket) return;
      this.focus = "details";
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
      this.focus = "details";
      this.moveToHunk(pendingBracket === "]" ? 1 : -1);
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.searchQuery) {
        this.clearSearch();
        this.tui.requestRender();
      } else if (this.focus === "details") {
        this.focus = "tree";
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

    if (data === "\t") {
      this.toggleFocus();
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      if (this.searchQuery) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.foldedIds.clear();
        this.invalidateTreeRows();
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
      const turn = this.getSelectedTurn();
      if (!turn) return;
      this.done({
        type: "undo",
        targetEntryId: turn.userEntryId,
        label: this.turnLabel(turn),
      });
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.moveFocusedSelection(-1);
    } else if (
      this.keybindings.matches(data, "tui.select.down") ||
      data === "j"
    ) {
      this.moveFocusedSelection(1);
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.pageFocusedSelection(-1);
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.pageFocusedSelection(1);
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.focus === "tree") {
        this.focusDetails();
      } else {
        this.openSelectedHunk();
      }
    } else if (
      data === "h" ||
      this.keybindings.matches(data, "app.tree.foldOrUp")
    ) {
      if (this.focus === "details") {
        this.moveDetailParentOrTree();
      } else {
        this.collapseOrMoveParent();
      }
    } else if (
      data === "l" ||
      this.keybindings.matches(data, "app.tree.unfoldOrDown")
    ) {
      if (this.focus === "details") {
        this.moveDetailChild();
      } else if (!this.expandOrMoveChild()) {
        this.focusDetails();
      }
    } else if (data === "c" || data === "C") {
      this.collapseAllBranches();
    } else if (data === "e" || data === "E") {
      this.expandAllBranches();
    } else if (data === "]" || data === "[") {
      this.setPendingBracket(data);
      this.pendingG = false;
      this.tui.requestRender();
      return;
    } else if (data === "G") {
      this.selectFocusedLast();
    } else if (data === "g") {
      if (this.pendingG) {
        this.selectFocusedFirst();
        this.pendingG = false;
      } else {
        this.pendingG = true;
      }
      this.tui.requestRender();
      return;
    } else if (matchesKey(data, "left")) {
      this.pageFocusedSelection(-1);
    } else if (matchesKey(data, "right")) {
      this.pageFocusedSelection(1);
    } else if (isPrintableInput(data)) {
      this.searchQuery += data;
      this.foldedIds.clear();
      this.invalidateTreeRows();
      this.focus = "tree";
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

  private firstSelectableTurnId(): string | undefined {
    return (
      this.model.activeTurnIds[this.model.activeTurnIds.length - 1] ??
      this.model.roots[0]?.id ??
      this.model.turns[0]?.id
    );
  }

  private getTreeRows(): TurnRow[] {
    this.cachedTreeRows ??= this.buildTreeRows();
    return this.cachedTreeRows;
  }

  private invalidateTreeRows(): void {
    this.cachedTreeRows = undefined;
  }

  private buildTreeRows(): TurnRow[] {
    const rows: TurnRow[] = [];
    const visibleTurnIds = this.getSearchVisibleTurnIds();
    const rootIds = this.model.roots
      .map((root) => root.id)
      .filter((rootId) => !visibleTurnIds || visibleTurnIds.has(rootId));
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
        visibleTurnIds,
        undefined,
      );
    }
    return rows;
  }

  private addTurnRows(
    rows: TurnRow[],
    turnId: string,
    indent: number,
    justBranched: boolean,
    showConnector: boolean,
    isLast: boolean,
    gutters: readonly Gutter[],
    isVirtualRootChild: boolean,
    visibleTurnIds: ReadonlySet<string> | undefined,
    visibleParentId: string | undefined,
  ): void {
    if (visibleTurnIds && !visibleTurnIds.has(turnId)) return;

    const turn = this.turnsById.get(turnId);
    if (!turn) return;

    this.visibleParentById.set(turnId, visibleParentId);
    rows.push({
      id: turn.id,
      turn,
      indent,
      showConnector,
      isLast,
      gutters: [...gutters],
      isVirtualRootChild,
    });

    const childIds = this.sortActiveFirst(
      (this.childrenById.get(turn.id) ?? []).filter(
        (childId) => !visibleTurnIds || visibleTurnIds.has(childId),
      ),
    );
    this.visibleChildrenById.set(turnId, childIds);
    if (this.foldedIds.has(turn.id)) return;

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
        visibleTurnIds,
        turn.id,
      );
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

  private getDetailRows(): DetailRow[] {
    const turn = this.getSelectedTurn();
    if (!turn) return [];

    const rows: DetailRow[] = [];
    for (const file of turn.files) {
      rows.push({
        id: file.id,
        kind: "file",
        selectable: true,
        file,
      });
      for (const hunk of file.hunks) {
        rows.push({
          id: hunk.id,
          kind: "hunk",
          selectable: true,
          file,
          hunk,
        });
        for (let index = 0; index < hunk.bodyLines.length; index++) {
          rows.push({
            id: `${hunk.id}:line:${index}`,
            kind: "diff",
            selectable: true,
            file,
            hunk,
            text: hunk.bodyLines[index] ?? "",
          });
        }
      }
    }
    return rows;
  }

  private getSearchVisibleTurnIds(): ReadonlySet<string> | undefined {
    const tokens = this.searchQuery.toLowerCase().split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) return undefined;

    const visible = new Set<string>();
    for (const turn of this.turnsById.values()) {
      const searchableText = this.getSearchableText(turn).toLowerCase();
      if (!tokens.every((token) => searchableText.includes(token))) continue;
      this.addTurnAndAncestors(visible, turn.id);
    }
    return visible;
  }

  private addTurnAndAncestors(target: Set<string>, turnId: string): void {
    let currentId: string | undefined = turnId;
    while (currentId) {
      target.add(currentId);
      currentId = this.parentById.get(currentId);
    }
  }

  private getSearchableText(turn: ReviewTurn): string {
    const fileText = turn.files
      .map((file) =>
        [
          file.path,
          `+${file.additions}`,
          `-${file.removals}`,
          file.hunks
            .map((hunk) =>
              [
                hunk.path,
                hunk.header,
                String(hunk.jumpLine),
                hunk.bodyLines.join("\n"),
              ].join(" "),
            )
            .join(" "),
        ].join(" "),
      )
      .join(" ");
    return `${this.turnLabel(turn)} ${turn.prompt} ${fileText}`;
  }

  private renderTurnRow(row: TurnRow, width: number): string {
    const selected = row.id === this.selectedTurnId;
    const focused = selected && this.focus === "tree";
    const cursor = focused ? this.theme.fg("accent", "› ") : "  ";
    const prefix = this.theme.fg("dim", this.prefixForTurnRow(row));
    const foldMarker = this.rootFoldMarker(row);
    const pathMarker = this.activeTurnIds.has(row.id)
      ? this.theme.fg("accent", "• ")
      : "";
    const prompt = row.turn.prompt || "(empty prompt)";
    const text = `${foldMarker}${pathMarker}${this.theme.fg("accent", "user: ")}${this.theme.fg("text", prompt)} ${this.statText(row.turn)} ${this.fileHunkText(row.turn)}`;
    let line = cursor + prefix + (selected ? this.theme.bold(text) : text);
    if (focused) line = this.theme.bg("selectedBg", line);
    return truncateToWidth(line, width);
  }

  private prefixForTurnRow(row: TurnRow): string {
    const displayIndent = this.multipleVisibleRoots
      ? Math.max(0, row.indent - 1)
      : row.indent;
    const connector = row.showConnector && !row.isVirtualRootChild;
    const connectorPosition = connector ? displayIndent - 1 : -1;
    const totalChars = displayIndent * 3;
    const prefixChars: string[] = [];
    const isFolded = this.foldedIds.has(row.id);

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
            isFolded ? "⊞" : this.isFoldable(row.id) ? "⊟" : "─",
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

  private rootFoldMarker(row: TurnRow): string {
    const showsFoldInConnector = row.showConnector && !row.isVirtualRootChild;
    if (!this.foldedIds.has(row.id) || showsFoldInConnector) return "";
    return this.theme.fg("accent", "⊞ ");
  }

  private renderDetailRow(row: DetailRow, width: number): string {
    const selected = row.selectable && row.id === this.selectedDetailId;
    const focused = selected && this.focus === "details";
    const cursor = focused ? this.theme.fg("accent", "› ") : "  ";
    let content: string;
    if (row.kind === "file") {
      content = `  ${this.theme.fg("toolTitle", row.file.path)} ${this.statText(row.file)} ${this.theme.fg("muted", `${row.file.hunks.length} hunk${row.file.hunks.length === 1 ? "" : "s"}`)}`;
    } else if (row.kind === "hunk") {
      content = `    ${this.theme.fg("borderAccent", row.hunk.header)} ${this.theme.fg("dim", row.hunk.path)}`;
    } else {
      content = `      ${this.renderDiffLine(row.text, row.hunk.path)}`;
    }

    let line = cursor + content;
    if (focused) line = this.theme.bg("selectedBg", line);
    return truncateToWidth(line, width);
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

  private moveFocusedSelection(delta: number): void {
    if (this.focus === "details") {
      this.moveDetailSelection(delta);
    } else {
      this.moveTurnSelection(delta);
    }
  }

  private pageFocusedSelection(direction: -1 | 1): void {
    if (this.focus === "details") {
      this.moveDetailSelection(
        direction * Math.max(1, this.lastDetailsPageSize),
      );
    } else {
      this.moveTurnSelection(direction * Math.max(1, this.lastTreePageSize));
    }
  }

  private moveTurnSelection(delta: number): void {
    const rows = this.getTreeRows();
    if (rows.length === 0) return;
    const currentIndex = Math.max(
      0,
      rows.findIndex((row) => row.id === this.selectedTurnId),
    );
    const nextIndex = clamp(currentIndex + delta, 0, rows.length - 1);
    this.selectTurn(rows[nextIndex]?.id);
  }

  private moveDetailSelection(delta: number): void {
    const selectable = this.getDetailRows().filter(isSelectableDetailRow);
    if (selectable.length === 0) return;
    const currentIndex = Math.max(
      0,
      selectable.findIndex((row) => row.id === this.selectedDetailId),
    );
    const nextIndex = clamp(currentIndex + delta, 0, selectable.length - 1);
    this.selectedDetailId = selectable[nextIndex]?.id;
  }

  private moveToHunk(delta: number): void {
    const hunks = this.getDetailRows().filter(isHunkDetailRow);
    if (hunks.length === 0) return;
    const selectedHunkId = this.findHunkForDetailRow(
      this.getSelectedDetailRow(),
    )?.id;
    const currentIndex = hunks.findIndex(
      (row) => row.hunk.id === selectedHunkId,
    );
    const nextIndex =
      currentIndex === -1
        ? delta > 0
          ? 0
          : hunks.length - 1
        : clamp(currentIndex + delta, 0, hunks.length - 1);
    this.focus = "details";
    this.selectedDetailId = hunks[nextIndex]?.id;
  }

  private moveToFile(delta: number): void {
    const files = this.getDetailRows().filter(isFileDetailRow);
    if (files.length === 0) return;

    const selectedFileId = this.getSelectedDetailRow()?.file.id;
    const currentIndex = files.findIndex(
      (row) => row.file.id === selectedFileId,
    );
    const nextIndex =
      currentIndex === -1
        ? delta > 0
          ? 0
          : files.length - 1
        : clamp(currentIndex + delta, 0, files.length - 1);
    this.focus = "details";
    this.selectedDetailId = files[nextIndex]?.id;
  }

  private moveDetailParentOrTree(): void {
    const selectedRow = this.getSelectedDetailRow();
    if (!selectedRow || selectedRow.kind === "file") {
      this.focus = "tree";
      return;
    }

    this.selectedDetailId =
      selectedRow.kind === "hunk" ? selectedRow.file.id : selectedRow.hunk.id;
  }

  private moveDetailChild(): void {
    const selectedRow = this.getSelectedDetailRow();
    if (!selectedRow) return;

    if (selectedRow.kind === "file") {
      this.selectedDetailId = selectedRow.file.hunks[0]?.id ?? selectedRow.id;
      return;
    }

    if (selectedRow.kind === "hunk") {
      this.selectedDetailId =
        selectedRow.hunk.bodyLines.length > 0
          ? `${selectedRow.hunk.id}:line:0`
          : selectedRow.id;
    }
  }

  private selectFocusedFirst(): void {
    if (this.focus === "details") {
      const first = this.getDetailRows().find(isSelectableDetailRow);
      this.selectedDetailId = first?.id;
    } else {
      this.selectTurn(this.getTreeRows()[0]?.id);
    }
  }

  private selectFocusedLast(): void {
    if (this.focus === "details") {
      const selectable = this.getDetailRows().filter(isSelectableDetailRow);
      this.selectedDetailId = selectable[selectable.length - 1]?.id;
    } else {
      const rows = this.getTreeRows();
      this.selectTurn(rows[rows.length - 1]?.id);
    }
  }

  private isFoldable(turnId: string): boolean {
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

  private collapseOrMoveParent(): void {
    const turn = this.getSelectedTurn();
    if (!turn) return;

    if (this.isFoldable(turn.id) && !this.foldedIds.has(turn.id)) {
      this.foldedIds.add(turn.id);
      this.invalidateTreeRows();
      return;
    }
    const parentId = this.parentById.get(turn.id);
    if (parentId) this.selectTurn(parentId);
  }

  private expandOrMoveChild(): boolean {
    const turn = this.getSelectedTurn();
    if (!turn) return false;
    if (this.foldedIds.has(turn.id)) {
      this.foldedIds.delete(turn.id);
      this.invalidateTreeRows();
      return true;
    }
    const childId = this.firstVisibleChildId(turn.id);
    if (!childId) return false;
    this.selectTurn(childId);
    return true;
  }

  private collapseAllBranches(): void {
    this.foldedIds.clear();
    this.invalidateTreeRows();
    for (const row of this.getTreeRows()) {
      if (this.isFoldable(row.id)) this.foldedIds.add(row.id);
    }
    this.invalidateTreeRows();
  }

  private expandAllBranches(): void {
    this.foldedIds.clear();
    this.invalidateTreeRows();
  }

  private toggleFocus(): void {
    if (this.focus === "tree") {
      this.focusDetails();
    } else {
      this.focus = "tree";
    }
  }

  private focusDetails(): void {
    const rows = this.getDetailRows();
    this.ensureDetailSelection(rows);
    if (rows.some(isSelectableDetailRow)) {
      this.focus = "details";
    } else {
      this.notice = "Selected turn has no diff details.";
    }
  }

  private selectTurn(id: string | undefined): void {
    if (id === this.selectedTurnId) return;
    this.selectedTurnId = id;
    this.selectedDetailId = undefined;
    this.detailScrollOffset = 0;
  }

  private ensureDetailSelection(rows: readonly DetailRow[]): void {
    if (
      rows.some((row) => row.selectable && row.id === this.selectedDetailId)
    ) {
      return;
    }
    this.selectedDetailId = rows.find(isSelectableDetailRow)?.id;
    this.detailScrollOffset = 0;
  }

  private ensureDetailScroll(
    rows: readonly DetailRow[],
    viewportHeight: number,
  ): void {
    this.detailScrollOffset = clamp(
      this.detailScrollOffset,
      0,
      Math.max(0, rows.length - viewportHeight),
    );
    const selectedIndex = rows.findIndex(
      (row) => row.id === this.selectedDetailId,
    );
    if (selectedIndex < 0) return;
    if (selectedIndex < this.detailScrollOffset) {
      this.detailScrollOffset = selectedIndex;
    } else if (selectedIndex >= this.detailScrollOffset + viewportHeight) {
      this.detailScrollOffset = selectedIndex - viewportHeight + 1;
    }
  }

  private calculateSelectedWindowStart(
    rows: readonly TurnRow[],
    selectedId: string | undefined,
    viewportHeight: number,
  ): number {
    if (viewportHeight <= 0) return 0;
    const selectedIndex = Math.max(
      0,
      rows.findIndex((row) => row.id === selectedId),
    );
    return Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(viewportHeight / 2),
        rows.length - viewportHeight,
      ),
    );
  }

  private getSelectedTurn(): ReviewTurn | undefined {
    if (!this.selectedTurnId) return undefined;
    return this.turnsById.get(this.selectedTurnId);
  }

  private getSelectedDetailRow(): SelectableDetailRow | undefined {
    if (!this.selectedDetailId) return undefined;
    return this.getDetailRows().find(
      (row): row is SelectableDetailRow =>
        row.selectable && row.id === this.selectedDetailId,
    );
  }

  private findHunkForDetailRow(
    row: SelectableDetailRow | undefined,
  ): ReviewHunk | undefined {
    if (!row) return undefined;
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
    const turn = this.getSelectedTurn();
    const hunk =
      this.findHunkForDetailRow(this.getSelectedDetailRow()) ??
      this.firstHunk(turn);
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

  private statusText(): string {
    const treeRows = this.getTreeRows();
    const treePosition = Math.max(
      0,
      treeRows.findIndex((row) => row.id === this.selectedTurnId) + 1,
    );
    const detailRows = this.getDetailRows().filter(isSelectableDetailRow);
    const detailPosition = Math.max(
      0,
      detailRows.findIndex((row) => row.id === this.selectedDetailId) + 1,
    );
    const turn = this.getSelectedTurn();
    if (!turn) return "  (0/0)";
    return `  tree ${treePosition}/${treeRows.length} • diff ${detailPosition}/${detailRows.length} • ${this.describeTurn(turn)}`;
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

  private describeTurn(turn: ReviewTurn): string {
    return `${this.turnLabel(turn)} • u to undo to this turn`;
  }
}

function isSelectableDetailRow(row: DetailRow): row is SelectableDetailRow {
  return row.selectable;
}

function isFileDetailRow(row: DetailRow): row is FileDetailRow {
  return row.kind === "file";
}

function isHunkDetailRow(row: DetailRow): row is HunkDetailRow {
  return row.kind === "hunk";
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
