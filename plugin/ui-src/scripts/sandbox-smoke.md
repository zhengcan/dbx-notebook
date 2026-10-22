# Sandbox CSP smoke test

Loads the packaged UI (`plugin/ui`) in the `dbx-plugin dev` host (sandboxed `about:srcdoc` iframe with the DBX CSP) and checks it renders: `#app` has children, no page errors / CSP / `unsafe-eval` / `EvalError`, New notebook → toolbar, `+ SQL` → `.cm-editor`, `+ Markdown` → editable preview. jsdom tests cannot catch CSP violations.

Run: `npm run smoke:sandbox -w plugin/ui-src` (or `npm run smoke:sandbox` at the root). Builds `plugin/ui` if missing; rebuild after UI changes.

Prerequisites: local Chrome or Edge (no browser download); `npx` able to fetch `@dbx-app/plugin-cli`.

Exit codes: `0` pass, `1` fail, `2` skipped (no Chrome/Edge). With `SMOKE_REQUIRE_BROWSER=1` a missing browser is a failure (`1`).

The dev host copy of the manifest drops `entrypoints.backend` and sets `engines` to `{host_api:"1"}`; the "read-only query unsupported" banner and 400/404 bridge answers are expected.

Plan 4: an extra step checks the AI entry (`[data-test=ask-ai]`) is absent in a block mounted while `aiCompletion` is false and present in one mounted while it is true. The dev host (CLI 0.1.9) reports no capabilities, so the step substitutes `window.dbxPlugin` with a Proxy that supplies them.

## Environment variables
- `SMOKE_REQUIRE_BROWSER=1`: no Chrome/Edge -> exit 1 instead of 2.
- `SMOKE_SKIP_BUILD=1`: do not rebuild `plugin/ui` (default: always run `npm run build -w plugin/ui-src` first; build failure -> exit 1).
- `SMOKE_BROWSER_CHANNELS`: comma list of Playwright channels (default `chrome,msedge`); e.g. `nonexistent` exercises the exit-2 path.
- `DBX_PLUGIN_CLI_VERSION`: dev-host CLI version (default `0.1.9`); prefetched (up to 180 s) before the 60 s host start-up wait.

A missing `playwright-core` (repo devDependency; run `npm install`) is a failure (exit 1), not a skip.
The iframe check requires exactly one `about:srcdoc` frame with `document.title` equal to the manifest `name` and the start page / toolbar present.

## Plan 3: chart runtime CSP check (`npm run smoke:chart -w plugin/ui-src`)
Builds a smoke-only bundle (`vite build --mode smoke`, temp dir, not part of the package; exposes `window.__sqlnbRenderChartForSmoke` only in that mode), serves it with the sandbox CSP (`default-src 'self'; script-src 'self'; ...`, no `unsafe-eval`) and renders bar (stacked/grouped), line (temporal), area, scatter, pie, donut, histogram and label layers via `vegaRuntime.render`. Fails on pageerror, CSP/EvalError console messages, or missing marks. Same exit codes (0/1/2) and env vars (`SMOKE_REQUIRE_BROWSER`, `SMOKE_BROWSER_CHANNELS`).
`smoke:chart` also renders `buildPortableSpec` specs (raw rows under data name `src`): combined x label, all five time-unit grains, bin histogram, multi-value layers, count/median/distinct. Errors are attributed per chart after a rAF+100ms settle, and a final sweep fails on any unattributed CSP/pageerror message.
