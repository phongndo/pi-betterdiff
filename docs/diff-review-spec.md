# Diff review UX spec

This document captures the intended product shape for `pi-betterdiff`.
An initial `/diff` UI prototype now exists; this spec still describes the broader desired behavior and marks several areas that need hardening.

## Primary goal

Provide a dedicated, navigable diff-review experience for **agent-produced file mutations across the current pi session tree**.

This should feel spiritually similar to pi's `/tree` navigator, but focused only on file changes and diff hunks.

## Entry points

### Slash command

- `/diff`

This is the primary entrypoint for opening the diff review UI.

### Keyboard shortcut

No default shortcut is currently registered. Keyboard shortcuts can be revisited later; `/diff` remains the guaranteed entrypoint.

## Core interaction model

The UI should take strong inspiration from pi's `/tree` experience:

- vertically navigable
- foldable / unfoldable sections
- keyboard-first
- optimized for fast scanning and review
- lightweight enough to reopen frequently during a coding session

Like `/tree`, child/sibling relationships should represent the pi session tree. BetterDiff extends the same navigable tree with inline review-only children for the selected diff-producing turn's files, hunks, and diff lines.

## Information hierarchy

The default hierarchy should be one unified tree:

1. **diff-producing user turn tree**
2. inline changed files under the selected/open turn
3. inline diff regions / hunks under each file
4. syntax-highlighted changed lines under expanded hunks

A BetterDiff tree child is created by pi session ancestry: a later diff-producing user turn descends from an earlier diff-producing user turn, with non-diff turns compressed out. For display, linear continuation stays visually flat; indentation/connectors are introduced only at actual fork points where a diff-producing turn has multiple visible continuations. If the user rewinds/forks a previous turn, the alternate continuations appear as sibling branches. Branches follow native `/tree` conventions where the active branch is shown first, active-path turns get a `•` marker, and the initial selection lands on the latest diff-producing turn on the active session head.

Files, hunks, and diff body lines are review-only children attached inline under the selected diff-producing user turn. They do not represent pi session branches and never affect `/tree` navigation semantics.

### Turn node

A turn node represents one user prompt whose assistant response produced one or more `edit`/`write` mutations.

Suggested header content:

- prompt preview
- changed file count
- hunk count
- cumulative line stats (`+N -M`)

Example:

```text
⊟ user: Refactor calculator parsing...  +24 -8  3 files  4 hunks
```

### Inline review children

The selected turn expands inline to show changed files and concrete hunks. Hunk rows and diff body lines can be selected/scrolled in the same tree for review and for `ctrl+g` editor jumping.

Example:

```text
src/render/diff-view.ts  (+24 -8)  3 hunks
  lines 120-148  edit  (+18 -3)
    +121 const next = parse(input);
```

## Rendering behavior

### Folding

Users should be able to collapse or expand both branch nodes and inline review nodes. Files are shown inline under the selected turn; hunks start collapsed for scanability and can be expanded with `l`.

### Headers and line indicators

The header should clearly show:

- file path
- diff region
- line number indicators

This is especially important because the selected hunk will be used as the jump target for external editor opening.

### Preview body

Expanded hunks should show:

- unified diff body
- syntax-colored additions / removals where practical
- enough context to understand the change without overwhelming the screen

## Navigation model

The navigator should support vim-like motions by default.

### Core motions

- `j` / `k` — move selection down / up in the unified tree
- `tab` — jump between the selected turn and its first changed file
- `h` — collapse current item or move to parent
- `l` — expand current item or dive into child rows
- `gg` — jump to top
- `G` — jump to bottom
- `enter` — open the selected changed file / hunk / diff line in the external editor
- `q` / `esc` — close the diff UI from anywhere

### Nice-to-have motions

- `[` / `]` — previous / next hunk
- `[f` / `]f` — previous / next changed file in the selected turn
- `zc` / `zo` / `za` style fold helpers if they fit naturally

### Non-vim fallback

Arrow keys should also work so the UI stays usable without vim muscle memory.

## External editor integration

### Keybinding inside the diff UI

- `ctrl+g`

When the cursor is on a changed file, diff hunk, or diff line, `ctrl+g` should:

1. open the relevant file in the external editor
2. jump to the exact changed region or best-available line anchor
3. wait for the editor session to end
4. restore the diff review UI in the same state

### Expected editor behavior

The first-class experience should be optimized for `nvim`, while still allowing `$VISUAL` / `$EDITOR` usage.

Preferred behavior:

- use `$VISUAL` if set
- otherwise use `$EDITOR` if set
- otherwise fall back to `nvim`, then `vim`, then `vi`

### Jump targeting

For `nvim` / `vim`, the initial target can be:

```bash
nvim +{line} {file}
```

Longer-term, the extension may support richer adapters for editors like:

- `code --goto file:line:column`
- `cursor --goto file:line:column`
- `hx file:line:column`
- `subl file:line:column`

### Return flow

After the editor exits, the user should land back in the diff review UI with:

- the same selection
- the same fold state
- the same scroll position if practical

That return flow is a core part of the UX, not an optional enhancement.

## Data source

The review browser is based on **pi session mutation history**, not the git working tree. Its default scope is the current session tree, including branch/fork siblings that are present in pi's session data.

Primary mutation sources:

- `edit`
- `write`

The extension should normalize these into a single internal review model.

## Suggested internal review model

The current implementation normalizes data into:

- review model
  - flat diff-producing turns for traversal/status
  - root diff-producing turns for tree rendering
- review turn
  - originating user entry id
  - prompt preview
  - branch children based on compressed pi session ancestry
  - changed files[]
- review file
  - path
  - cumulative stats
  - hunks[]
- review hunk
  - stable id
  - originating session entry id
  - tool name
  - old/new range where available
  - display header
  - patch body
  - primary jump line

## Scope preference

The initial product shape should emphasize **session diff review**, not git diff review.

The default mental model is:

- "show me what the agent changed"
- not "show me everything git thinks changed"

## UX priorities

1. Fast keyboard navigation
2. Immediate readability of changed files and regions
3. Reliable `ctrl+g` handoff into the external editor
4. Smooth return back into the review UI after editing
5. A layout that feels native to pi's tree-oriented workflows

## Prototype status

Implemented in the first UI pass:

- `/diff` command
- branch-aware diff-producing turn tree
- unified tree with inline files, hunks, and diff body lines for the selected turn
- fold/expand navigation for tree branches
- review-only behavior; branch navigation/rewind stays in pi's native `/tree`
- `ctrl+g` external-editor jump to the selected hunk line

Still to harden:

- richer before/after reconstruction for `write` overwrites
- more exact hunk metadata and editor targeting
- renderer golden tests and broader integration coverage
