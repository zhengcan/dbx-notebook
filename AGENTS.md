# AGENTS.md

Guide for coding agents working in this repository.

## What this is

SQL Notebook is a plugin for DBX (a database client). It is a Jupyter-style SQL notebook whose files are plain-text YAML with the extension `.sqlnb`. Blocks: Markdown, input variable, SQL, local SQL, chart (pivot) and big number.

Docs (Chinese): `README.zh-CN.md`, `docs/*.zh-CN.md` (blocks, sqlnb-format, ai, development, release, known-limits). The file format spec is `spec/sqlnb-v1.md` (+ `spec/sqlnb-v1.schema.json`, `spec/examples/`).

## Layout

- `plugin/` — the DBX plugin: `manifest.json`, `dbx-plugin.toml`, `assets/`, Rust backend `backend/` (crates `notebook-files`, `result-engine`, `pdf-export`; these three are excluded from the root backend workspace), Vue UI source in `ui-src/` (build output `plugin/ui/` is gitignored).
- `packages/sqlnb-format/` — TypeScript library: parse/serialize/validate `.sqlnb`, parameter rendering, analysis config.
- `spec/` — format spec, JSON Schema, examples.
- `docs/` — user and developer docs, `docs/images/` screenshots.
- `spikes/` — early experiments, unrelated to plugin features.

## Commands

Run from the repo root after `npm install` (Node 22+, Rust toolchain).

- Tests: `npm test --workspaces` (runs `packages/sqlnb-format` and `plugin/ui-src`).
- Typecheck: `npm run typecheck --prefix plugin/ui-src`.
- Rust tests (only in these crates; add `-- --ignored` for the browser-dependent `pdf-export` cases):
  `cargo test --manifest-path plugin/backend/{notebook-files,result-engine,pdf-export}/Cargo.toml`
  (the root `plugin/backend/Cargo.toml` is also testable).
- Vega specs: `npm run validate:vega -w packages/sqlnb-format`.
- Validator: after editing `spec/sqlnb-v1.schema.json` run `npm run gen:validator -w packages/sqlnb-format`; it must leave no diff when nothing changed (`packages/sqlnb-format/test/validatorUpToDate.test.ts`, "precompiled validator", checks it).
- Package: `npx @dbx-app/plugin-cli package plugin`. Dev host: `npx @dbx-app/plugin-cli dev --path plugin --port 5190`.
- Smoke tests (real Chrome/Edge): `SMOKE_REQUIRE_BROWSER=1 npm run smoke:<name> -w plugin/ui-src` with `<name>` in `sandbox sql chart markdown mdimage mdtoolbar table connpicker export polish pdf bnlabel badges chartaxis charthover highlight inputblock undo exportdone`. Without the variable a missing browser exits 2 (skipped). `smoke:sandbox` downloads `@dbx-app/plugin-cli` and builds the UI; `smoke:export`, `smoke:pdf` and `smoke:sandbox` are slow, so give them long timeouts. `smoke:pdf` needs `pdftoppm`.
- Screenshots: `npm run docs:screenshots -w plugin/ui-src`.

## Rules the code relies on

File format (see `spec/sqlnb-v1.md`):
- The `.sqlnb` file holds configuration only: no credentials, no connection IDs, no per-execution data. Chart and big-number blocks never carry outputs. Results live only in the optional `.sqlnb.out` (or inline outputs, by user setting). The plugin never writes AI content, chats, prompts, catalog or host-connection data into the file.
- Connections are referenced by name only; the name-to-connection mapping is never stored.
- Client-private data goes only under `clients.<name>` (this plugin uses `clients.dbx`).
- Unknown fields and block types are preserved on save.
- Format changes are additive only. Touch `packages/` and `spec/` only for deliberate format work.

Plugin contract:
- `plugin/manifest.json` requests exactly six permissions: `host.data:read`, `host.schema:read`, `host.ai`, `host.storage`, `host.workbench`, `host.connections:read`, and `engines.dbx` is `>=0.6.48`. Changing either is a deliberate decision (the install dialog shows it; `plugin/ui-src/test/manifest.test.ts` covers the manifest).
- Host calls go through `window.dbxPlugin.request` (the `bridge`), never `invoke` (see header of `plugin/ui-src/src/ai/aiClient.ts`).

AI (`plugin/ui-src/src/ai/`):
- Every AI call reads the user's send options via `aiSettings.sendOptions()` and stays all-off (fail-closed) until it resolves; never read `aiSettings.send` directly.
- Notebook data (SQL, schemas, cell values) sits inside the `<<<DATA … DATA>>>` fence in `prompt.ts` and is declared untrusted; the user's request sits outside it, capped by `MAX_USER_CHARS` (2000). Whole requests are capped by `MAX_REQUEST_CHARS`.

Markdown images:
- Images are files next to the notebook, referenced by relative path (`![](<notebook file name>.assets/image-….png)`). The `.sqlnb` holds only that text, never image data.
- `fileTransfer` (desktop OS drop and `pick`) is accessed only via `files/fileTransferClient.ts`, requires `capabilities.fileTransfer.drop`, handles must always be released, and it needs no new permission.
- Never fetch images from the network (remote `http(s)` shows alt text). Every image path goes through the confined `notebook/readImage|saveImage|copyAssets` backend RPCs; `classifySrc` in `markdown/imagePolicy.ts` is the single allow-list (PNG/JPEG/GIF/WebP only).

UI:
- Use DBX theme tokens (`var(--color-*)`) only; no hard-coded colours except as `var()` fallbacks. `plugin/ui-src/test/themeTokens.test.ts` restricts the allowed token names.
- Every user-facing string exists in both `zh-CN` and `en` (`plugin/ui-src/src/i18n.ts`). Parity is enforced by per-feature tests (e.g. `exportLabels.test.ts`, `labelCategories.test.ts`, `BigNumberMetrics.test.ts`); add a parity check for new key groups.
- Keep keyboard operation, visible focus and `aria-*` attributes working on new controls, as existing components do.

## Release and housekeeping

- Version bump places: `version` in `plugin/manifest.json`, `version` in `plugin/backend/Cargo.toml`, and the `dbx-plugin-plugin` entry in `plugin/backend/Cargo.lock` (hand-edit; then run `cargo check --manifest-path plugin/backend/Cargo.toml` and confirm with `git diff` that only that line changed; auto-update is unverified). Only bump when asked. See `docs/release.zh-CN.md`.
- The package is unsigned; DBX Store signs releases.
- The manifest `$schema` URL (`.../plugin-sdk-v1/plugins/manifest.schema.json`) returns 404. Validate the manifest with `ajv` against the freshly fetched `https://raw.githubusercontent.com/t8y2/dbx/main/plugins/manifest.schema.json`.
- `docs/superpowers/`, `docs/upstream/`, `docs/verification/` and `.superpowers/` are local-only and gitignored. Do not commit them.
- Commits: stage explicit paths only (no `git add -A`, `git stash` or `git checkout` of others' work); do not push or tag unless asked.
