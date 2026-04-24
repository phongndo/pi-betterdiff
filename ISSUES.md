# Issues

Track bug fixes, review findings, suspicious implementation patterns, and missing behavior tests. Product feature goals belong in `TODOS.md`. Resolved items stay in their own section so open issues do not get buried under finished work.

## Open review findings from `70b17e7` (`feat: add BetterDiff search and grep`)

- [ ] **Make search cancel actually close or clear the active search.**
  - **Location:** `src/render/diff-review-ui.ts:343-363`, `src/render/diff-review-ui.ts:623-662`
  - **Context:** The rendered search hint says `esc: close.`, but `handleSearchInput()` only sets `searchEditing = false`. The query remains active, the search line remains visible, and `n` / `N` still operate on that stale query. After the user presses enter to keep a search, pressing escape goes through the normal cancel path and closes the entire diff review instead of clearing search first.
  - **Why this is an issue:** The UI text and behavior disagree. Users have no obvious way to dismiss an active search except manually backspacing the whole query, and the stale search state makes accidental review close easy.
  - **How to verify:** Start `/`, type a matching query, press escape, and render. The query is still shown. Start `/`, type a query, press enter, then press escape; the component closes instead of clearing the active search.
  - **Smallest acceptable fix:** Add one explicit search-close path. Escape while editing search should clear the search query and leave the diff review open. Escape while a non-editing search query is active should clear the query before falling through to closing the review. If the intended behavior is only “stop editing,” then the hint must stop saying `close`, but that would still leave search dismissal under-designed.
  - **Required test:** Input tests proving escape clears an in-progress search without closing the review, and clears a kept search before the normal review-close behavior can run.

- [ ] **Stop duplicating rendered row label logic for search.**
  - **Location:** `src/render/diff-review-ui.ts:1438-1476`, `src/render/diff-review-ui.ts:1696-1770`
  - **Context:** Tree search claims to search rendered BetterDiff tree labels, but searchable text is rebuilt separately in `searchableTextForTurn()`, `searchableTextForFile()`, and `searchableTextForHunk()`. That duplicates the semantic label parts already assembled by `renderTurnRow()`, `renderDetailRow()`, `formatHunkLabel()`, `fileHunkText()`, `hunkCountText()`, and `statText()`.
  - **Why this is an issue:** The UI now has two sources of truth for what a row “means.” A future rendering change can silently drift away from search behavior. This is hidden coupling dressed up as a helper.
  - **How to verify:** Change the hunk/file/turn label composition in rendering and observe that search still uses the old independent label recipe unless the search helpers are manually updated too.
  - **Smallest acceptable fix:** Introduce shared plain-label helpers for turn/file/hunk rows and have both rendering and search consume those semantic parts. Rendering can add color/style around shared text; search should not own a second label model.
  - **Required test:** Behavior tests proving search matches the actual displayed turn/file/hunk label components: prompt, stats, file count, hunk count, hunk region, tool name, path, and visible diff body lines.

- [ ] **Put diff-line row ids behind one helper instead of string-splicing them in multiple places.**
  - **Location:** `src/render/diff-review-ui.ts:1310-1318`, `src/render/diff-review-ui.ts:1666-1674`
  - **Context:** Rendered diff rows and grep targets both manufacture ids with `${hunk.id}:line:${index}`. Grep reveal works only because both sites remember the exact same string convention.
  - **Why this is an issue:** This is hidden coupling. A harmless-looking row id change in one place breaks grep selection/reveal in another place with no type boundary protecting it.
  - **How to verify:** Change the diff row id format in `addDetailRows()` only, then grep for a diff-body match. The grep match can no longer select the rendered row.
  - **Smallest acceptable fix:** Add a `diffLineRowId(hunk, index)` helper and use it everywhere row ids or search match ids are built.
  - **Required test:** Grep a diff-body match and assert the selected rendered diff line is revealed, with row ids generated through the shared helper.

- [ ] **Do not let global grep masquerade as scoped grep.**
  - **Location:** `src/render/diff-review-ui.ts:1631-1693`, `TODOS.md`
  - **Context:** The implemented `?` grep traverses the whole review model. That is valid for the completed “all-review grep bootstrap,” but the remaining product goal is scoped grep based on the currently selected turn/file/hunk/diff line.
  - **Why this is an issue:** If this global traversal becomes the only grep path, the later scoped grep feature will either break existing behavior or pile scope hacks on top of it. That is how keybindings become semantic junk drawers.
  - **How to verify:** Select a file or hunk, press `?`, and search for text that only exists elsewhere in the model. Current grep will leave the selected scope and jump globally.
  - **Smallest acceptable fix:** Keep global grep explicitly labeled as global/all-review, and implement scoped grep as a separate mode or derive its target set from the selected row. Do not pretend the current global traversal satisfies scoped grep.
  - **Required test:** Tests for invoking grep from selected turn, file, hunk, and diff-line rows proving matches stay inside the expected scope; separate tests for intentional global/all-review grep.

- [ ] **Cover search edge cases instead of only the happy path.**
  - **Location:** `test/diff-review-ui.test.ts`
  - **Context:** Existing tests cover basic tree search, hidden-row exclusion, hidden-content grep reveal, and grep across unrendered turns. They do not cover clearing, reopening, stale queries, backspace-to-empty, or mode switching.
  - **Why this is an issue:** The search state machine is now another modal input path. Without edge-case tests, it will regress the first time someone touches cancel handling, action menus, mode switching, or branch folding.
  - **How to verify:** Manually exercise escape, backspace, reopening `/` or `?`, switching modes after a search, and searching folded branch ancestors. Current tests do not pin those behaviors.
  - **Smallest acceptable fix:** Add behavior-level input tests for the missing state transitions rather than snapshotting implementation trivia.
  - **Required test:** Cover at least: escape clear, backspace deleting the last character and hiding the search line, reopening search after a previous query, `n` / `N` grep cycling through multiple hidden matches, search/grep after mode switching or refresh, and search through folded branch ancestors.

## Suspicious open cleanup

- [ ] **Decide whether reopening search edits the previous query or starts fresh.**
  - **Location:** `src/render/diff-review-ui.ts:657-662`
  - **Context:** `openSearch()` preserves `searchQuery` when `/` or `?` is pressed again. With no cursor movement and no clear command, “edit” currently means append more characters to the old query.
  - **Why this smells:** This is not a real input editor; it is a string append box with backspace. That may be acceptable for a prototype, but the behavior must be intentional and tested.
  - **Smallest acceptable fix:** Either clear the query when opening a different search mode, or deliberately preserve it and provide tested editing/clearing behavior.

- [ ] **Watch search target rebuilding on large diffs.**
  - **Location:** `src/render/diff-review-ui.ts:1607-1693`
  - **Context:** `renderSearchLine()` calls `searchStatus()`, which rebuilds/filter matches. Search input also rebuilds/filter matches on every character. Grep target construction walks every turn/file/hunk/diff line each time.
  - **Why this smells:** This is probably fine for small review models, but it is a plausible performance problem for very large git diffs or long session histories.
  - **Smallest acceptable fix:** Do not optimize blindly. If large diffs become sluggish, cache target lists per row/model version and only recompute filtered matches when query/mode/tree visibility changes.

## Resolved review findings from `9164cdc` (`style: improve diff metadata coloring`)

- [x] **Stop parsing `ReviewHunk.header` as if it were an API.**
  - **Location:** `src/render/diff-review-ui.ts:688-707`
  - **Context:** `formatHunkLabel()` previously built a hunk label from three separate pieces: `formatHunkRegion(hunk.header)`, `hunk.toolName`, and `statText(hunk)`. `formatHunkRegion()` extracted the first segment of `hunk.header` using `/^(.*?)(?:\s{2,}|$)/u`, then assumed it matched `/^(lines?)\s+(\d+)(?:-(\d+))?$/u`.
  - **Why this was an issue:** `hunk.header` was a display string generated by `formatHunkHeader()` in `src/diff/model.ts`, not a stable structured API. This duplicated formatting knowledge across model and renderer. If the header format changed, the renderer could silently drop metadata or combine region text from `header` with `toolName`/stats from structured fields.
  - **How to verify:** Run `rg -n "\.header|header:|formatHunkHeader|header\?" src test`. There should be no source/test usage of hunk header fields or header formatting helpers.
  - **Smallest acceptable fix:** Render `hunk.header` verbatim, or build all hunk label parts from structured `ReviewHunk` fields (`jumpLine`, `newLines`, `toolName`, `additions`, `removals`, etc.) without parsing the human-facing header string.
  - **Required test:** Renderer behavior test proving hunk label rendering does not lose custom/extra header metadata and does not mix inconsistent header/tool/stat sources.
  - **Fixed in working tree:** `DiffReviewComponent` now formats hunk regions from structured `ReviewHunk` fields instead of parsing `hunk.header`; follow-up cleanup removed `ReviewHunk.header` entirely so there is no display-header field to parse.

- [x] **Remove obsolete `ReviewHunk.header` display state.**
  - **Location:** `src/diff/model.ts`, `test/diff-review-ui.test.ts`
  - **Context:** After the renderer stopped reading `hunk.header`, the model still exposed and populated `ReviewHunk.header` via `formatHunkHeader()`. That left a duplicate display string next to the structured fields that actually drive hunk labels.
  - **Why this was an issue:** Keeping stale display state invited future code to start parsing or trusting `hunk.header` again. It also kept model/render ownership confused: the model was still formatting UI labels even though the renderer owns the colored label.
  - **How to verify:** Run `rg -n "\.header|header:|formatHunkHeader|header\?" src test`. There should be no source/test usage of hunk header fields or header formatting helpers.
  - **Smallest acceptable fix:** Delete `ReviewHunk.header`, remove `header:` assignments from edit/write hunk construction, remove `formatHunkHeader()`, and update tests to construct hunks only from structured fields.
  - **Required test:** Existing renderer tests must still pass and verify hunk labels render correctly from `jumpLine`, `newLines`, `toolName`, `additions`, and `removals`.
  - **Fixed in working tree:** `ReviewHunk.header` and `formatHunkHeader()` were removed; renderer tests now build hunks without any header string.

- [x] **Scope `c`/`e` collapse-expand actions to the selected tree level.**
  - **Location:** `src/render/diff-review-ui.ts:933-1010`, `test/diff-review-ui.test.ts`
  - **Context:** `c`/`e` previously used broad helpers: turn rows collapsed/expanded all branches globally, and any detail row collapsed/expanded all details for the entire turn. That no longer matched the level-scoped navigation model.
  - **Why this was an issue:** A user on a file row expects file-level folding, not a whole-turn detail blast. A user on a hunk row expects hunk body folding, not unrelated files. This created spooky action at a distance.
  - **How to verify:** On a turn, `c/e` hide/show that turn's details. On a file row, `c/e` collapse/expand file rows for that turn without opening hunk bodies. On a hunk row, `c/e` collapse/expand hunk bodies for that file only.
  - **Smallest acceptable fix:** Dispatch `c`/`e` by selected row kind: turn scope, file level, hunk level, and containing hunk for diff lines.
  - **Required test:** Input tests for `c`/`e` on turn, file, and hunk rows proving changes stay inside the selected level/scope.
  - **Fixed in working tree:** `collapseSelectedScope()` and `expandSelectedScope()` now dispatch by row kind; tests cover turn, file, and hunk scoping.

- [x] **Do not auto-open details when moving between prompts.**
  - **Location:** `src/render/diff-review-ui.ts:1006-1025`, `test/diff-review-ui.test.ts`
  - **Context:** Turn-level navigation now keeps file details visible until the user enters them, but moving from prompt to prompt still automatically opened the new prompt's file/hunk details because `selectRow()` switched `detailTurnId` whenever the selected row's turn changed.
  - **Why this was an issue:** Prompt navigation became noisy in larger branch trees. Every `j/k` or page movement expanded another prompt's file list, making the tree harder to scan. This made prompt-level browsing fight the user.
  - **How to verify:** Select a prompt with details visible, press `j` or page-right to another prompt, and confirm no file rows are shown for the new prompt. Press `l` and confirm the selected prompt's first file row opens.
  - **Smallest acceptable fix:** When `selectRow()` selects a turn row from a different turn, clear `detailTurnId` instead of switching it to the new turn. Keep explicit detail entry (`l`, tab, hunk/file jumps) responsible for opening details.
  - **Required test:** Input tests for `j` and page movement between turn rows proving details stay closed until `l` enters them.
  - **Fixed in working tree:** `selectRow()` now clears stale details when selecting a different turn row and does not open details for prompt navigation; tests cover `j`, page movement, and explicit `l` entry.

- [x] **Let `h` collapse selected turn detail rows.**
  - **Location:** `src/render/diff-review-ui.ts:843-885`, `test/diff-review-ui.test.ts`
  - **Context:** BetterDiff now keeps changed files visible under the selected turn while turn-level navigation stays on turns. That makes details easy to inspect, but it also clutters the tree when the user wants to read branch structure.
  - **Why this was an issue:** Users had no quick way to hide the inline file/hunk rows for the selected prompt without moving into detail rows or changing selection. This made the happy path easy and tree readability someone else's problem.
  - **How to verify:** Select a turn with visible changed files, press `h`, and confirm the file/hunk rows under that turn disappear while the turn remains selected. Press `l` and confirm the first file row is selected again.
  - **Smallest acceptable fix:** In turn-level `h` handling, if the selected turn is currently showing detail rows, clear `detailTurnId`, invalidate rows, and return before branch folding/up-navigation.
  - **Required test:** Input test that renders visible turn details, presses `h`, asserts details are hidden and the turn remains selected, then presses `l` and asserts file details are re-entered.
  - **Fixed in working tree:** `moveParentOrCollapse()` now collapses selected turn details before branch folding; renderer/input tests cover `h` collapse and `l` re-entry.

- [x] **Fix scoped navigation page movement using flat row offsets.**
  - **Location:** `src/render/diff-review-ui.ts:740-800`, `test/diff-review-ui.test.ts`
  - **Context:** Scoped navigation made `j/k` stay at the current tree level for turns/files/hunks, but the same code used the flat rendered-row `delta` for page movement (`ctrl+u/d`, left/right). A large page delta could skip past all valid same-level siblings before searching, so paging from a file or hunk could silently do nothing.
  - **Why this was an issue:** The UI advertises page movement. Once inline detail rows are visible, flat row offsets and same-level navigation offsets are different concepts. Mixing them made scoped movement brittle and unpredictable.
  - **How to verify:** Open a model with three files or three hunks, select the first file/hunk, then press right / page-down. It should land on the last same-level file/hunk, not stay stuck on the first row.
  - **Smallest acceptable fix:** Build the list of visible same-scope siblings first, find the selected sibling index, then clamp `index + delta` within that sibling list.
  - **Required test:** Renderer/input tests for turn, file, and hunk page movement using right/left key input, proving page movement clamps within same-level siblings.
  - **Fixed in working tree:** `scopedRowForMovement()` now applies deltas to same-scope sibling lists; tests cover turn, file, and hunk page movement.

- [x] **Add behavior-level renderer coverage for the changed UI output.**
  - **Location:** `test/diff-review-ui.test.ts`
  - **Context:** The change altered visible output for summary rows, turn rows, file rows, and hunk rows in `src/render/diff-review-ui.ts`, so renderer behavior needed direct coverage beyond model construction and extension registration.
  - **Why this was an issue:** The patch was almost entirely presentation behavior. Without render tests, `npm test` could pass while the rendered summary, hunk label, path, stats, or pluralization was wrong.
  - **How to verify:** Run `npm run test -- test/diff-review-ui.test.ts` or `npm run check`. The renderer tests exercise `DiffReviewComponent.render()` with fake `Theme`, `TUI`, and `KeybindingsManager` instances.
  - **Smallest acceptable fix:** Add a focused render test using a minimal `ReviewModel`, fake `Theme`, fake `TUI`, and fake `KeybindingsManager`. Assert behavior-visible text, not ANSI implementation trivia.
  - **Required test:** Render a model with one turn, one file, and one hunk; verify the output includes the turn summary, file hunk count, hunk line range, tool name, stats, and path.
  - **Fixed in working tree:** `test/diff-review-ui.test.ts` now verifies summary text, selected turn text, file rows, hunk rows, pluralization, and selected-row styling using deterministic fake theme output.

## Resolved suspicious patterns from `9164cdc`

- [x] **Remove or contain the regex parser for project-owned display text.**
  - **Location:** `src/render/diff-review-ui.ts:696-707`
  - **Context:** `formatHunkRegion()` parsed the exact string shape emitted by `formatHunkHeader()` in `src/diff/model.ts:563-574`.
  - **Why this smelled:** This was hidden coupling between renderer and model display formatting. It would rot quickly when hunk metadata got richer.
  - **How to verify:** Compare the old regex in `formatHunkRegion()` with the string emitted by `formatHunkHeader()`. They were coupled by convention only; TypeScript could not protect this.
  - **Fixed in working tree:** `formatHunkRegion()` no longer accepts a header string or uses regex; it accepts `ReviewHunk` and derives `line` / `lines` from `jumpLine` and `newLines`. Follow-up cleanup removed `ReviewHunk.header` and `formatHunkHeader()` from the model.

## Resolved missing tests from `9164cdc`

- [x] Renderer test for hunk rows with `line 7` and `lines 7-9`; malformed/custom header coverage became obsolete after `ReviewHunk.header` was removed.
- [x] Renderer test for pluralization: `1 hunk` vs `2 hunks`, `1 file` vs `2 files`.
- [x] Renderer test for summary totals with additions/removals split across color segments.
- [x] Renderer test for selected and unselected detail rows without asserting raw ANSI escape implementation details.
