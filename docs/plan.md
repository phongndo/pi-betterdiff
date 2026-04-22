# pi-betterdiff scaffold plan

## Status

This repository is intentionally at the **scaffold-only** stage.
The goal of this pass is to make future implementation work easy to grow, test, lint, type-check, and release.

## Goals for this scaffold

- Establish a clean TypeScript pi extension package layout.
- Keep the runtime entrypoint valid but behavior-free for now.
- Add fast local quality gates:
  - formatting
  - linting
  - TypeScript/LSP-friendly type checks
  - **Vitest** unit tests
- Add GitHub Actions for CI and release packaging.
- Avoid shipping product behavior before the better-diff design is settled.

## Product direction

The current planned UX is documented in [docs/diff-review-spec.md](diff-review-spec.md).

Highlights from the current direction:

- primary command: `/diff`
- default shortcut: `ctrl+space`
- tree-inspired diff navigator with foldable files and hunks
- vim-style keyboard navigation
- `ctrl+g` opens the selected diff region in `nvim` / `$VISUAL` / `$EDITOR`
- returning from the editor should restore the diff UI state

## Current scaffold shape

### Current files

- `src/index.ts` — placeholder pi extension entrypoint with no runtime behavior.
- `src/config/` — empty placeholder for future configuration modules.
- `src/diff/` — empty placeholder for future diff logic.
- `src/render/` — empty placeholder for future renderer integration.
- `src/runtime/` — empty placeholder for future runtime orchestration.
- `test/` — Vitest coverage for scaffold markers and package shape.
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

`package.json` is marked `private: true` for now so the placeholder scaffold is not accidentally published to npm.
Once the extension has real functionality and package metadata is finalized, the release workflow can be extended to publish to npm.

## Next implementation milestones

1. Build the normalized review data model for session-based `edit` and `write` mutations.
2. Add pure diff-formatting helpers with golden tests.
3. Prototype the tree-inspired `/diff` navigator component with foldable files and hunks.
4. Add external-editor adapter handling for `ctrl+g` line-targeted jumps and return-to-review flow.
5. Add integration-style tests around representative `edit`/`write` output and navigation state restoration.
6. Add user-facing configuration for keymap, verbosity, and fallback editor behavior.
7. Remove `private: true` and enable npm publishing when the package is ready.
