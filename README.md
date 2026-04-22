# pi-betterdiff

Scaffold for a clean, robust [pi](https://pi.dev) extension package focused on better diff ergonomics.

This repo is intentionally **repo-first / scaffold-only** right now. It sets up the package, tooling, checks, and CI/CD, but it does **not** implement any real extension behavior yet.

## What is included

- TypeScript-based pi extension package layout
- strict TypeScript config for editor/LSP-friendly checks
- ESLint + Prettier setup
- **Vitest** test suite with coverage support
- GitHub Actions for CI and release packaging
- a no-op pi extension entrypoint so the package shape is valid without shipping behavior
- placeholder source and fixture directories for future implementation work

## Repo layout

```text
.
├── .github/workflows/   # CI + release automation
├── docs/plan.md         # scaffold and implementation plan
├── src/
│   ├── config/          # placeholder for future config modules
│   ├── diff/            # placeholder for future diff logic
│   ├── render/          # placeholder for future renderer integration
│   ├── runtime/         # placeholder for future runtime orchestration
│   └── index.ts         # placeholder pi extension entrypoint
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

That currently loads a placeholder extension with no runtime behavior.

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

> The package is currently marked `private: true` to prevent accidental npm publication while the repository is still scaffold-only.

## Planning docs

- [docs/plan.md](docs/plan.md) — scaffold and implementation plan
- [docs/diff-review-spec.md](docs/diff-review-spec.md) — planned `/diff` UX and navigation model

## Next steps

The current plan is to grow this into a tree-inspired diff review UI for pi session mutations, opened via `/diff` and a default `ctrl+space` shortcut, with `ctrl+g` opening the selected hunk in an external editor and then returning to the diff UI.
