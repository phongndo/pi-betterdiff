# Diff review UX spec

This document captures the intended product shape for `pi-betterdiff`.
It is a planning/spec artifact only. No runtime behavior is implemented yet.

## Primary goal

Provide a dedicated, navigable diff-review experience for **agent-produced file mutations in the current pi session**.

This should feel spiritually similar to pi's `/tree` navigator, but focused only on file changes and diff hunks.

## Entry points

### Slash command

- `/diff`

This is the primary entrypoint for opening the diff review UI.

### Keyboard shortcut

- default shortcut: `ctrl+space`

This should open the same diff review UI as `/diff`.

> Note: `ctrl+space` is the desired default, but some terminals do not emit it reliably. `/diff` remains the guaranteed fallback entrypoint.

## Core interaction model

The UI should take strong inspiration from pi's `/tree` experience:

- vertically navigable
- foldable / unfoldable sections
- keyboard-first
- optimized for fast scanning and review
- lightweight enough to reopen frequently during a coding session

Unlike `/tree`, the content model is based on **diffs**, not conversation entries.

## Information hierarchy

The default hierarchy should be:

1. **file**
2. **diff region / hunk**
3. optional inline changed lines / patch body when expanded

### File node

A file node represents one changed file across the current session review scope.

Suggested header content:

- relative path
- change summary
- hunk count
- optional cumulative line stats (`+N -M`)

Example:

```text
⊞ src/render/diff-view.ts  (+24 -8)  3 hunks
```

### Hunk node

A hunk node represents a concrete changed region.

Suggested header content:

- file-relative region label
- new-file line anchor
- optional old/new line range
- small change stats or preview

Example:

```text
  ⊟ lines 120-148  @@ -118,9 +120,28 @@  (+18 -3)
```

When expanded, the hunk should reveal the diff body inline.

## Rendering behavior

### Folding

Users should be able to keep both levels either collapsed or expanded:

- files can be collapsed or expanded
- hunks can be collapsed or expanded

The initial default should favor scanability:

- files visible
- hunks visible under selected file, or all hunks collapsed by default

This can be finalized during implementation.

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

- `j` / `k` — move selection down / up
- `h` — collapse current item or move to parent
- `l` — expand current item or move into child
- `gg` — jump to top
- `G` — jump to bottom
- `enter` — toggle or focus selected item
- `q` / `esc` — close the diff UI

### Nice-to-have motions

- `[` / `]` — previous / next hunk
- `/` — search by file path or diff text
- `n` / `N` — next / previous search result
- `zc` / `zo` / `za` style fold helpers if they fit naturally

### Non-vim fallback

Arrow keys should also work so the UI stays usable without vim muscle memory.

## External editor integration

### Keybinding inside the diff UI

- `ctrl+g`

When the cursor is on a diff hunk, `ctrl+g` should:

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

The review browser is based on **pi session mutation history**, not the git working tree.

Primary mutation sources:

- `edit`
- `write`

The extension should normalize these into a single internal review model.

## Suggested internal review model

A future implementation should likely normalize data into something like:

- review file
  - path
  - cumulative stats
  - hunks[]
- review hunk
  - stable id
  - originating session entry id
  - tool name
  - timestamp / turn index
  - old range
  - new range
  - display header
  - patch text
  - primary jump line / column

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

## Explicit non-goal for scaffold stage

This document does **not** imply that any of the above is implemented yet.
It only captures the intended design so the repo scaffolding can grow toward it deliberately.
