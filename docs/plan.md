# pi-betterdiff scaffold plan

## Status

This repository has moved from **scaffold-only** to an initial **UI prototype** stage.
The original scaffold still provides the package structure, checks, and release pipeline, while the current extension now exposes a first-pass `/diff` review UI.

## Goals for this scaffold

- Establish a clean TypeScript pi extension package layout.
- Keep the runtime entrypoint small and focused on wiring `/diff` to the review UI.
- Add fast local quality gates:
  - formatting
  - linting
  - TypeScript/LSP-friendly type checks
  - **Vitest** unit tests
- Add GitHub Actions for CI and release packaging.
- Avoid shipping product behavior before the better-diff design is settled.

## Product direction

The intended UX is documented in [docs/diff-review-spec.md](diff-review-spec.md).

Highlights from the current direction:

- primary command: `/diff`
- tree-inspired diff navigator with foldable files and hunks
- vim-style keyboard navigation
- `ctrl+g` opens the selected diff region in `nvim` / `$VISUAL` / `$EDITOR`
- returning from the editor should restore the diff UI state

## Current scaffold shape

### Current files

- `src/index.ts` — pi extension entrypoint registering `/diff`.
- `src/diff/model.ts` — current-branch session mutation normalizer for `edit` and `write` tool results.
- `src/render/diff-review-ui.ts` — custom TUI component for turn/file/hunk navigation.
- `src/config/` — empty placeholder for future configuration modules.
- `src/runtime/` — placeholder for future runtime orchestration as behavior grows.
- `test/` — Vitest coverage for extension registration and diff model normalization.
- `test/fixtures/` — empty placeholder for future golden/regression fixtures.
- `docs/plan.md` — implementation notes and next milestones.

### Planned future modules

When implementation starts, the next likely split is:

- `src/config/` — extension flags and configuration defaults.
- `src/diff/` — pure diff formatting and patch shaping logic.
- `src/render/` — pi tool/message rendering integration.
- `src/runtime/` — event hooks, command handlers, and orchestration.
- `test/fixtures/` — golden diff samples and regression fixtures.

## Quality strategy

### Formatting

- Tool: Prettier
- Commands:
  - `npm run format`
  - `npm run format:check`

### Linting

- Tool: ESLint with type-aware `typescript-eslint` rules
- Command:
  - `npm run lint`

### LSP / type safety

- Tool: `tsc --noEmit`
- Command:
  - `npm run typecheck`

This mirrors the same TypeScript project configuration editors and language servers use.

### Testing

- Tool: Vitest
- Commands:
  - `npm run test`
  - `npm run test:coverage`

## CI/CD plan

### CI

Run on pushes to `main` and on pull requests:

- `npm ci`
- `npm run check`
- `npm run pack:check`

### CD

On version tags (`v*`):

- re-run the full verification pipeline
- create an npm tarball with `npm pack`
- upload the tarball as a workflow artifact
- attach the tarball to a GitHub Release

## Intentional safety choice

`package.json` is marked `private: true` for now so the early prototype is not accidentally published to npm.
Once the extension has mature functionality and package metadata is finalized, the release workflow can be extended to publish to npm.

## Next implementation milestones

1. Improve write/overwrite handling by reconstructing before/after content where possible.
2. Add golden tests for representative renderer output and hunk parsing.
3. Add fuller session-tree support beyond the current active branch.
4. Harden external-editor adapter handling and add more editor-specific targeting.
5. Add integration-style tests around representative `edit`/`write` output and navigation state restoration.
6. Add user-facing configuration for keymap, verbosity, and fallback editor behavior.
7. Remove `private: true` and enable npm publishing when the package is ready.
