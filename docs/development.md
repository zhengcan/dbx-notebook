[English](development.md) | [简体中文](development.zh-CN.md)

# Development

## Environment

- Node.js 22+ (also required by the dev host of `@dbx-app/plugin-cli`).
- Rust toolchain (stable), used to compile the backend process.
- A working Chrome or Edge (needed only for the browser smoke tests).

Install dependencies in the repository root (npm workspaces, with the lockfile in the root):

```bash
npm install
```

## Layout

| Path | Contents |
| --- | --- |
| `plugin/manifest.json`, `plugin/dbx-plugin.toml` | Plugin manifest and packaging configuration |
| `plugin/backend/` | Rust backend (main crate, exports the `dbx-plugin-plugin` executable) |
| `plugin/backend/notebook-files/` | Reading and writing notebook and result files, system file dialogs, recent files; for Markdown images, `notebook/readImage` (reads and validates, returns embedded data), `notebook/saveImage` (saves a pasted image) and `notebook/copyAssets` (copies referenced images on save as); paths are confined to the notebook's folder |
| `plugin/backend/result-engine/` | Local SQLite result engine (computation for local SQL, charts and big numbers) |
| `plugin/backend/pdf-export/` | PDF generation through the local Chrome/Edge/Chromium |
| `plugin/ui-src/` | Vue frontend source, built into `plugin/ui/` |
| `packages/sqlnb-format/` | The `.sqlnb` format library (`@sqlnb/format`) |
| `spec/` | Format specification, JSON Schema and examples |

The three backend sub-crates are not in the same Cargo workspace; each has its own `Cargo.toml` and `Cargo.lock`.

## Build, typecheck and test

```bash
# Build the frontend into plugin/ui/
npm run build -w plugin/ui-src

# Typecheck
npm run typecheck -w plugin/ui-src

# Unit tests
npm test -w packages/sqlnb-format
npm test -w plugin/ui-src

# Validate all Vega-Lite specs generated from configurations
npm run validate:vega -w packages/sqlnb-format

# Regenerate the JSON Schema validator (after changing spec/sqlnb-v1.schema.json)
npm run gen:validator -w packages/sqlnb-format
```

The tests of `packages/sqlnb-format` include a check that the generated validator matches the schema (`validatorUpToDate`), and they validate the examples under `spec/examples/`.

## Cargo tests

```bash
cargo test --manifest-path plugin/backend/notebook-files/Cargo.toml
cargo test --manifest-path plugin/backend/result-engine/Cargo.toml
cargo test --manifest-path plugin/backend/pdf-export/Cargo.toml
cargo test --manifest-path plugin/backend/Cargo.toml
```

Cases in `pdf-export` that need a real browser are ignored by default (`#[ignore]`); with a local Chrome/Edge/Chromium you can run them with `cargo test --manifest-path plugin/backend/pdf-export/Cargo.toml -- --ignored`.

## Smoke tests

Smoke tests check, in a real Chrome/Edge, what jsdom cannot cover (CSP, layout, colors, PDF output). Commands run in the `plugin/ui-src` workspace: `npm run <script> -w plugin/ui-src`. Exit codes: 0 passed, 1 failed, 2 skipped because there is no browser; with the environment variable `SMOKE_REQUIRE_BROWSER=1` a missing browser counts as a failure (use it before a release).

| Script | What it checks |
| --- | --- |
| `smoke:sandbox` | Loads the bundled UI into the dev host (an `about:srcdoc` iframe plus DBX's CSP): rendering, no CSP/`eval` errors, creating a notebook, adding blocks, AI entry points shown according to capabilities. Needs to be able to download `@dbx-app/plugin-cli` |
| `smoke:sql` | Syntax-highlighting colors of the SQL editor and read-only snippets in light/dark |
| `smoke:chart` | Rendering of all chart types and the portable spec under a CSP that does not allow `unsafe-eval` |
| `smoke:markdown` | Height and position of adjacent blocks stay unchanged when a Markdown block switches between preview and edit |
| `smoke:mdimage` | Markdown images: PNG/JPEG/GIF/WebP shown at original size with a fake host client; error placeholders carry alt text and a notice (no broken icon, no `src`); re-rendering causes no height jump; placeholder contrast is at least 4.5:1 in light/dark; malicious paths never reach the host; exported HTML embeds data URIs and makes no external requests; paste and drop in real Chrome (saving, inserting the link, one undo step, unsupported files, unsaved notice). A headless browser cannot cover the real clipboard or DBX's file drop; see the local checklist |
| `smoke:mdtoolbar` | Markdown editing toolbar (real Chrome, 960/560/320 px): buttons do not steal focus from the editing box, the result and one undo step of every action, keyboard roving, `Ctrl/⌘+B/I/K`, light/dark contrast, toolbar height does not jitter while typing; desktop drop (with an injected fake `fileTransfer`): drop target, de-duplication, handle release; the "Insert image" button's `pick` and file-chooser fallback. A headless browser cannot cover real DBX drops, the `Mod+B` conflict or real input methods; see the local checklist |
| `smoke:table` | CSS of the result table: name column width after transposing, no content showing through fixed columns while scrolling |
| `smoke:connpicker` | Grouping and disabled-item styles of the connection dropdown are readable in light/dark |
| `smoke:export` | Exported HTML/PDF: no scripts or external requests, every column page has the sequence-number column, page orientation, wide tables and charts fit the page width; when `SMOKE_SIDECAR=<backend executable>` is set, the real backend is also driven to generate the PDF |
| `smoke:exportdone` | Export-complete box: the "OK" and "Open" buttons are visible and have accessible names, initial focus and Enter are on "OK", Tab order, "Open" closes the box on success and shows a `role=alert` error without closing on failure, contrast is at least 4.5:1 in light/dark (with a fake export client) |
| `smoke:highlight` | Syntax highlighting of SQL blocks and Markdown code fences in exported HTML/PDF; unknown languages are not colored |
| `smoke:inputblock` | The "Variable name" label of the input variable block, the `{{ name }}` marker readable in light/dark, and the hint when the variable name is empty |
| `smoke:undo` | Undo/redo: the SQL editor has a single notebook history, native undo in Markdown and inputs, undo and focus for adding/deleting/moving blocks, an IME composition counts as one step, the screen-reader announcement region |
| `smoke:chartaxis` | Chart text uses the document font, and axis titles do not overlap tick labels |
| `smoke:charthover` | Chart hover tooltip (real mouse): line/area charts show all series at the nearest X at a vertex, at a segment midpoint, between two points and at the plot-area edge (sorted by value descending, truncated beyond 10, null points do not trigger), scatter hit radius is about 8 px, bar/pie charts are unchanged, tooltip text matches what the chart displays, the exported SVG contains no interaction layer; set `SMOKE_SHOT_DIR=<directory>` to output light/dark × 960/320 screenshots |
| `smoke:polish` | A set of UI detail checks (using real components) |
| `smoke:pdf` | Whether the right border of a bordered 100%-wide element is complete when Chrome prints a PDF (needs `pdftoppm`) |
| `smoke:bnlabel` | Big-number card labels are limited to 2 lines, cards in the same row have equal height, visible text is kept in the PDF |
| `smoke:badges` | Position of the numbered badges in the "Advanced settings" preview |

Documentation screenshots (including `block-markdown-image.png` and `block-markdown-toolbar.png`, which render the real Markdown component with a generated PNG and a fake image client): the PNGs under `docs/images/` are regenerated with `npm run docs:screenshots` (run in `plugin/ui-src`; needs a system Chrome/Edge). The script mounts the real components with a smoke build, uses fictional "monthly sales" sample data and the light theme, and produces the same output every time; after a UI change, rerun it and commit the updated images, and each image should be smaller than 150 KB.

Example:

```bash
SMOKE_REQUIRE_BROWSER=1 npm run smoke:export -w plugin/ui-src
```

## Dev host

DBX is not needed; you can run the plugin in a browser:

```bash
npx @dbx-app/plugin-cli dev --path plugin --port 5190
```

The CLI compiles the backend and runs `ui_build` (builds the frontend) from `[dev]` in `dbx-plugin.toml`. Dev credentials are stored in plain text in `plugin/.dbx-dev/`; that directory is ignored and must not be committed or packaged. The dev host does not provide every DBX capability (for example read-only queries and AI), and final integration testing needs a real DBX.

## Packaging

```bash
npm run build -w plugin/ui-src
npx @dbx-app/plugin-cli package plugin
```

The command compiles the backend for the current platform, packages `manifest.json`, `assets/` and `ui/`, and produces an unsigned `.dbxp` for the target platform and the matching `.artifact.json` in `plugin/dist/`. Note that `package` itself does not build the frontend, so run the build above first. For the release process, see [Release](release.md).

## Conventions

- For any change to the file format, first change [spec/sqlnb-v1.md](../spec/sqlnb-v1.md) and the schema, and keep it additively compatible (add optional fields, do not change the meaning of old fields).
- Behavior described in the docs should match the code and tests.
- Before committing, run the typecheck and the relevant unit tests; when changing export, layout or CSP-related code, run the corresponding smoke tests.
