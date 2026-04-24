# pi-betterdiff

A [pi](https://pi.dev) extension package focused on better session-diff ergonomics.

The extension now includes an initial `/diff` UI prototype for reviewing agent-produced `edit` and `write` mutations across the current pi session tree.

## What is included

- TypeScript-based pi extension package layout
- strict TypeScript config for editor/LSP-friendly checks
- ESLint + Prettier setup
- **Vitest** test suite with coverage support
- GitHub Actions for CI and release packaging
- `/diff` command that opens a tree-inspired session diff navigator
- branch-aware tree of diff-producing user turns that opens on the active session head, stays flat for linear history, indents only at forks, and marks the active branch
- selected-turn detail pane for changed files, hunks, and syntax-highlighted diff lines, focusable with `tab` and file jumps via `[f` / `]f`
- `ctrl+g` external-editor handoff for the selected diff hunk

## Repo layout

```text
.
├── .github/workflows/   # CI + release automation
├── docs/plan.md         # scaffold and implementation plan
├── src/
│   ├── config/          # placeholder for future config modules
│   ├── diff/            # placeholder for future diff logic
│   ├── render/          # custom TUI diff-review component
│   ├── runtime/         # placeholder for future runtime orchestration
│   └── index.ts         # pi extension entrypoint and /diff command
└── test/
    └── fixtures/        # placeholder golden/regression fixtures
```

## Local development

```bash
npm install
npm run check
```

### Load it in pi

```bash
pi -e .
```

Then use `/diff` inside pi to open the diff review UI.

## Scripts

- `npm run format` — format the repo
- `npm run format:check` — verify formatting
- `npm run lint` — run type-aware linting
- `npm run typecheck` — run TypeScript no-emit checks
- `npm run test` — run the Vitest suite
- `npm run test:coverage` — run Vitest with coverage
- `npm run check` — run formatting, lint, type, and test checks
- `npm run pack:check` — verify the package can be packed cleanly
- `npm run ci` — local CI-equivalent pipeline
- `npm run dev:pi` — load the package directly into pi

## CI/CD

### CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`.
It installs dependencies, runs the full quality pipeline, and verifies that `npm pack` succeeds.

### CD

`.github/workflows/release.yml` runs on `v*` tags and on manual dispatch.
It re-validates the package, creates a tarball with `npm pack`, uploads it as a workflow artifact, and attaches it to a GitHub release when triggered by a tag.

> The package is currently marked `private: true` to prevent accidental npm publication while the extension is still an early prototype.

## Planning docs

- [docs/plan.md](docs/plan.md) — scaffold and implementation plan
- [docs/diff-review-spec.md](docs/diff-review-spec.md) — planned `/diff` UX and navigation model

## Next steps

Next work should deepen the prototype: richer write/overwrite diffs, better tests for renderer output, and more editor adapters.
