# Spike 03 — DuckDB size & Vega in sandbox

## DuckDB (`spikes/local-engines/duckdb/`（原 spikes/duckdb-size 已并入，见 docs/spikes/05-local-engines.md）, macOS arm64, rustc 1.101 nightly)
`duckdb = { version = "1", features = ["bundled"] }` (resolved 1.10506.1). Creates table, inserts 5000 rows via `range()`, `GROUP BY` aggregate: works (5 groups × 1000 rows).

| Profile | Binary (stripped) | Clean build |
|---|---|---|
| `release` + `strip` | **33.3 MB** (33,339,504 B) | 16m41s wall (CPU user ~10s only: includes crates download over a flaky network with retries; real compile is dominated by the C++ libduckdb-sys build) |
| `small`: opt-level=z, lto, codegen-units=1, panic=abort, strip | **20.4 MB** (20,381,664 B) | 3m41s (deps already downloaded; libduckdb + duckdb rebuilt) |

- `duckdb` default features are empty; json/parquet/icu/etc. are opt-in, so there is nothing further to trim via `--features`. The `bundled` build already excludes them.
- opt-level=z + LTO cut ~39% (cc crate honours the profile opt-level for the C++ build). Verified output identical.
- Takeaway: plan for a ~20–35 MB sidecar per platform; use opt-level=z/LTO for release. Only macOS arm64 measured.

## Vega in sandbox (`spikes/vega-sandbox/`)
Created with `dbx-plugin create --template frontend`; the UI (`ui/`) was replaced by a Vite project (`base: "./"`) bundling `vega`, `vega-lite`, `vega-embed`, `vega-interpreter`. Bar chart rendered with `embed(el, spec, { ast: true, expr: expressionInterpreter, renderer: "svg" })` then `await view.toSVG()` (6570 chars of SVG).

- `vite build` succeeds (single chunk >500 kB warning only; needs async IIFE since target has no top-level await).
- Headless system Chrome via playwright (`ui/check.mjs`, page served with CSP `script-src 'self'` — no `unsafe-eval`): console logged `SVG_OK 6570`, no pageerror, no CSP violations (only a favicon 404).
- Playwright's own browser download timed out; used `channel: "chrome"`.

### HUMAN CHECKLIST (real DBX)
1. `cd spikes/vega-sandbox/ui && npm i && npx vite build`, copy `dist` into the plugin's ui location per `dbx-plugin.toml`, then `dbx-plugin package .` and install in DBX.
2. Open the plugin; confirm bar chart shows and `SVG_OK` text appears.
3. Open devtools: confirm no CSP / `unsafe-eval` errors.

### PENDING HUMAN
Real-DBX CSP confirmation: **PENDING HUMAN** (not run; GUI unavailable). Note: scaffold's `index.html` was replaced; plugin wiring to `dist` is untested.
