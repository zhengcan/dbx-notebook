# Spike 05 — local in-memory SQL engine for chaining notebook blocks

Goal: a later block queries results of earlier blocks (`SELECT * FROM refunds WHERE total > 10`, joins, aggregates, windows). Results (≤5000 rows × ~50 cols, mixed types) are registered as tables. Spike 03 showed DuckDB is 20–33 MB; evaluate alternatives.

Code: `spikes/local-engines/{sqlite,apexbase,duckdb,datafusion,stoolap,sqljs}/` (standalone crates, not a workspace) plus `common/data.rs` (synthetic data + the 14-query suite, shared by all). Environment: macOS arm64, rustc 1.101 nightly, 10 cores. **Only macOS arm64 was run — Windows/Linux are untested for everything below.**

## Method
- Table `t`: 5000 rows × 50 cols: int64, double, text, bool, date, timestamp, nullable text, nullable int, "decimal-like" (DECIMAL(12,2) where the engine has one; else float). Table `dim` (10 rows) for joins.
- 14 Postgres-flavoured queries (`common/data.rs`). "Strict" = the Postgres-style text ran unmodified; "w/ rewrite" = passes after rewriting to the engine's dialect (rewrites listed below). A pass only means "executed without error" plus I eyeballed row counts against other engines — see the silent-wrong-result notes, which matter more than the counts.
- Build times: **clean `cargo build`, deps already downloaded, sccache disabled** (`~/.cargo/config.toml` sets `rustc-wrapper=sccache`; with it enabled, a "clean" build of the sqlite spike took 1.7 s, so any earlier timing taken that way, possibly including spike 03's, may be optimistic). Wall clock, 10 cores. "small" = `opt-level="z"`, fat LTO, `codegen-units=1`, `panic="abort"`, strip.

## Comparison

| Candidate | Binary release (stripped) | Binary "small" | Clean build (release / small) | Crates | C/C++ toolchain | Suite strict / w/ rewrite | Typed results | Maintenance risk | Dialect fit (vs Postgres/MySQL/CH-ish) |
|---|---|---|---|---|---|---|---|---|---|
| a. SQLite (`rusqlite` 0.37 `bundled`, SQLite 3.50.2) | 2.1 MB | **1.2 MB** (1.2 MB with trimmed `LIBSQLITE3_FLAGS`, only −19 KB) | 15 s / 11 s | 15 | C compiler only (cc), no cmake/C++ | 10/14 · 14/14 | Weak: no date/timestamp/bool/decimal storage types; values are int/real/text/blob/NULL; `decl_type` only for bare columns, `NULL` per value | Very low (rusqlite 4.4k★, SQLite itself) | Poor-medium: no `date_trunc`, `percentile_cont`/`median`, `::`, regex `~`; dates are text |
| b. ApexBase 1.37.0 (Rust embedded API) | 26.8 MB | 8.2 MB | ~1m37 / 2m53 (+~14 min CPU) | 199 | C compiler only (mimalloc, zstd-sys) | 7/14 · 12/14 (and silent wrong results, see below) | Good (Arrow RecordBatch: Int64/Float64/Utf8/Bool/Date/Timestamp; no decimal column type) | **High**: 3★, one author, 0 open issues, first release Mar 2026, V5 format "preview" | Poor: custom parser |
| c. DuckDB (`duckdb` 1.10506.1 `bundled`) | 33.3 MB (spike 03) | 20.4 MB (re-measured, same) | ≈17 min with download (spike 03) / 1m44 | 146 | **C++ compiler** (libduckdb-sys builds amalgamation); no cmake needed by the crate | **14/14** · 14/14 | Excellent (DATE, TIMESTAMP, DECIMAL, BOOL, etc. natively) | Low (duckdb-rs 981★, active) | Best, but note `~` is a *full-match* regex (≠ Postgres partial match: 953 vs 1305 rows) |
| d1. DataFusion 55 (`default-features=false`, features sql + unicode/datetime/regex/string/math; no parquet) | 96.8 MB | **14.2 MB** | 3m01 (incl. download) / 3m35 | 281 | C compiler only (zstd-sys) | **14/14** · 14/14 | Excellent (Arrow: Int64, Decimal128(12,2), Date32, Timestamp, Boolean; NULLs in arrays) | Low (Apache project, 9.5k★, very active) | Very good: Postgres-ish (`date_trunc`, `percentile_cont … WITHIN GROUP`, `::`, `~`, `concat`) |
| d2. stoolap 0.4.2 (pure Rust, `default-features=false`) | 10.3 MB | 3.7 MB | 1m04 / 1m19 | 110 | **None** | 11/14 · 14/14 (+ silent wrong result in LIKE) | Medium: Integer/Float/Text/Boolean/Timestamp (no DATE, no DECIMAL; `d` came back as Timestamp) | Medium-high: 1.2k★ but created Dec 2025, 0.x, one dominant author (507 of ~520 commits) | Medium-poor: no `WITHIN GROUP`, no `::`, no `~` |
| e1. sql.js 1.15 (SQLite→WASM, in iframe) | n/a (0 sidecar) | wasm 685 KB raw / **335 KB gzip** (+17 KB js gz); inline variant 960 KB / 439 KB gz | npm install | – | none | same SQLite engine as (a): 10/14 · 14/14 (not re-run in browser; engine is SQLite 3.4x, same gaps) | as SQLite | Low (13.7k★) | as SQLite |
| e2. DuckDB-WASM (size only) | n/a | `duckdb-eh.wasm` 35.9 MB raw / **8.06 MB gzip**; mvp 41.3 MB / 9.18 MB gz; + ~0.8 MB worker js | – | – | – | – | – | Low | best |

Latency (median of 3, 5000×50, all engines): every query ≤ ~9 ms. SQLite slowest on the 5000-row window query (8.6 ms vs 1–3 ms elsewhere); the rest are sub-2 ms. Load of 5000×50: DataFusion 2 ms (columnar build, the fast path since results are already columnar), DuckDB 25 ms (Appender), stoolap 11 ms, SQLite 17 ms, ApexBase 47 ms (it writes `.apex` files into a temp dir). Performance is a non-issue for the use case; do not choose on it.

## ApexBase specifics
- **No pure in-memory mode in the Rust API.** `ApexDB::open(dir)` / builder only; I used a temp dir (`drop_if_exists`). Docs call it "disk-based directory"; in-memory is only discussed for Python-side memory measurements. Temp tables are also materialised into `.apex_tmp/` on disk. Needs a writable data dir per notebook (the host provides `DBX_PLUGIN_DATA_DIR`, so workable, but it is not "in-memory").
- Builds fine as a plain crates.io dependency on macOS arm64 with `default-features=false` (drops pyo3). Docs also say it must be `default-features=false`; the default `python` feature is on. `crate-type = ["cdylib","rlib"]`. MSRV not declared in Cargo.toml; compiled on the current nightly. Cranelift JIT in the tree. Arrow version coupling: I had to pin `arrow = "59"` to match.
- Pulling in Arrow means ~14 min CPU for a clean build; wall 1m37 on 10 cores is fine locally, slower on CI runners.
- **Silent wrong results (worst finding):** `SELECT count(DISTINCT grp) AS cg, (SELECT count(*) FROM t) AS c FROM t` returns only column `cg` (scalar subquery in SELECT list dropped, no error); `SELECT amount::int FROM t` returns OK with 0 columns/0 rows; `SELECT coalesce(note,'n/a') AS n, nullif(qty,1) AS q, count(note) AS cn FROM t …` returned one column (`cn`). Result of query 13 in the suite "passes" with 1 column rather than 2 — counted as strict pass but it is wrong. A notebook cannot ship an engine that drops columns silently.
- Failures: `WHERE flag` (bare bool) → "Unsupported expression type in predicate"; `GROUP BY 1` / CASE expression group-by → parse error; no `date_trunc`, `median`, `percentile_cont`, `strftime`, `extract`, `||`, `::`; `year(d)` requires a string argument.

## Per-query failure details (strict pass = ✔)

| Query | SQLite | ApexBase | DuckDB | DataFusion | stoolap |
|---|---|---|---|---|---|
| 01 filter/order/limit (`AND flag`) | ✔ | ✘ bare bool predicate; ok with `flag = true` | ✔ | ✔ | ✔ |
| 02 group by/having | ✔ | ✔ | ✔ | ✔ | ✔ |
| 03 join | ✔ | ✔ | ✔ | ✔ | ✔ |
| 04 CTE | ✔ | ✔ | ✔ | ✔ | ✔ |
| 05 window (row_number, running sum, lag) | ✔ | ✔ | ✔ | ✔ | ✔ |
| 06 `percentile_cont(0.5) WITHIN GROUP` | ✘ syntax error near "("; rewrite via `row_number()/count()` window averaging works | ✘ parse error; `median` unsupported | ✔ | ✔ (also `median()`) | ✘ parse error; `median(amount)` works |
| 07 `date_trunc('month'/'week')` | ✘ no such function; `strftime`/`date(…,'weekday 0','-6 days')` rewrite works | ✘ unsupported function (no working rewrite found) | ✔ | ✔ (month returns Timestamp(ns), week Timestamp(µs)) | ✔ |
| 08 `lower/substr/\|\|/concat`, regex `~`, LIKE | ✘ `~` syntax error (concat() exists in 3.50); LIKE rewrite ok | ✘ `\|\|` unsupported; `concat()`+LIKE ok | ✔ but `~` is full-match: 953 rows vs 1305 for Postgres semantics | ✔ (1305) | ✘ `~` → misleading "Column 'note' not found"; LIKE rewrite **returns wrong rows**: `LIKE '%Alpha-1_'` → 0 (expected 449; `_` after `%…` fails) |
| 09 cast incl. `::int` | ✘ `::` unrecognised; CAST ok | ✘ `::` parse error (and silently empty when `amount::int` is the only item); CAST ok | ✔ | ✔ (CAST→VARCHAR yields Utf8View) | ✘ `::`; CAST ok |
| 10 CASE + `GROUP BY 1` | ✔ | ✘ ordinal/expr group by; subquery rewrite ok | ✔ | ✔ | ✔ |
| 11 coalesce/nullif/count(col)/IS NULL | ✔ | ✘ + silent column drop with rewrite | ✔ | ✔ | ✔ |
| 12 IN-list | ✔ | ✔ | ✔ | ✔ | ✔ |
| 13 count distinct / DISTINCT in subquery | ✔ | ✘(silent) returns 1 of 2 columns | ✔ | ✔ | ✔ |
| 14 subquery (scalar + IN) | ✔ | ✔ | ✔ | ✔ | ✔ |
| **Strict** | 10 | 7 (really 6) | 14 | 14 | 11 (but 08 rewrite is wrong) |

## Typed results / NULLs for display
- SQLite: per-value storage class only. Result columns of expressions have no declared type; bool/date/timestamp/decimal cannot be recovered from the engine (the frontend would have to remember the original block's column types and re-apply them, which breaks across derived columns). NULL is reliable.
- DuckDB / DataFusion / ApexBase: Arrow-style typed schema per result column plus null masks; DataFusion and DuckDB keep DATE/TIMESTAMP/DECIMAL through projections. DataFusion's result is already Arrow RecordBatches: cheap to serialise (Arrow IPC) to the frontend.
- stoolap: Integer/Float/Text/Boolean/Timestamp only; typed NULL per value works; dates degrade to Timestamp.
- Real DB results will arrive via the host as JSON/rows with DB type names; an engine with DATE/DECIMAL/TIMESTAMP lets us register them faithfully. With SQLite, dates/decimals become text/real and date arithmetic needs `strftime`.

## Frontend alternative (sql.js in the sandboxed iframe)
- Plugin docs (`plugins/README.md`, workbench section): iframe `sandbox="allow-scripts"`, "a restrictive CSP", no network; `host.network:<origin>` adds origins to `connect-src`. **The docs say nothing about WASM or `wasm-unsafe-eval`/`unsafe-eval`**; I did not find the real CSP string (host source not inspected). My Vega spike (03) ran under `script-src 'self'` without `unsafe-eval`.
- Headless Chrome (playwright `channel:"chrome"`), meta CSP `default-src 'none'; script-src 'self' …`:
  - A: `'wasm-unsafe-eval'` + `connect-src 'self'`, normal `sql-wasm.js` (fetches .wasm) → **init OK** (19 ms).
  - B: no eval flags + `connect-src 'self'` → **fails** (WebAssembly.instantiateStreaming CSP violation).
  - Normal build under `default-src 'none'` with no `connect-src` → fails (wasm fetch blocked), regardless of eval flags (first run).
  - C: inline-wasm build (`sql-wasm-inline.js`, wasm base64 in JS, no fetch), `'wasm-unsafe-eval'`, no `connect-src` → **init OK**.
  - D: inline build, neither flag → **fails** (CompileError, `unsafe-eval` not allowed).
  - E: inline build with `'unsafe-eval'` only → OK (that flag also permits wasm).
  - Conclusion: sql.js needs the host CSP to include `wasm-unsafe-eval` (or `unsafe-eval`). If DBX's iframe CSP omits both, WASM engines cannot run in the iframe at all. **Unverified in real DBX** (needs a human check, same as spike 03's pending item).
- Size: sql.js wasm 335 KB gzip. DuckDB-WASM 8.06 MB gzip (35.9 MB raw), needs workers + (likely) `worker-src blob:`; not run.
- Costs of frontend engine even if allowed: results from the host cross the bridge as JSON (bounded payloads) into the iframe, are inserted via JS, memory is in the webview; SQLite dialect gaps as above; blocks executed by an agent/headless path would not have the engine.

## Non-technical risks
- **ApexBase**: 3 GitHub stars, one contributor (169/169 commits), 0 open issues (nobody using it), created Jan 2025, crates.io since Mar 2026 (1.9k downloads); Apache-2.0; V5 on-disk format "preview"; Python-first, Rust embedded API a secondary surface; silent-wrong-result bugs above. Reject.
- **stoolap**: Apache-2.0; 1.2k★, 30 open issues, repo created Dec 2025, one author makes >95% of commits, pre-1.0 (0.4.2), 7.7k downloads. Correctness bug found in LIKE. Claims pure Rust, WASM feature exists (not tested). Interesting for size (3.7 MB, no C) but too young and dialect gaps remain.
- **DataFusion**: Apache-2.0, ASF governance, 9.5k★, very active, 29M downloads; breaking API changes every ~month or so (major 55 already) → pin version. MSRV 1.94 (we have 1.101).
- **DuckDB**: MIT; duckdb-rs is community-maintained (not DuckDB Labs core) but active (981★); DuckDB itself rock solid.
- **SQLite**: public domain, zero risk. rusqlite active.
- Windows/Linux support: all are claimed cross-platform; none tested here. DuckDB bundled and C-only crates need MSVC/clang on Windows; DataFusion/stoolap/ApexBase are Rust + (zstd-sys/mimalloc C only for DF/Apex). ApexBase advertises SIMD paths for NEON/AVX2 only.

## Recommendation
1. **Engine in the sidecar, DataFusion** (primary). 14/14 on the Postgres-style suite unmodified, real typed Arrow results (Decimal128, Date32, Timestamp) that map 1:1 to the host's column types, load is cheap (build Arrow arrays directly from rows), pure Rust except a C bit for zstd (no C++/cmake), healthy governance. **Size budget: ~14 MB per platform (small profile), vs DuckDB 20.4 MB (−30%)**. Costs: 281 crates, ~3.5 min clean build (CI-cacheable), tokio dependency, async API, moderately rapid API churn. Savings vs DuckDB are real but modest (6 MB); we could trim further (disable features, try `tokio` current-thread only) — not attempted.
2. **Fallback A — DuckDB in the sidecar**, if the 14→20 MB delta is acceptable and DuckDB-only functions (e.g. `QUALIFY`, `list_*`, `strftime` formats) are wanted: best dialect, simplest API, but needs a C++ toolchain and is the biggest. **Fallback B — SQLite (`rusqlite` bundled) in the sidecar, 1.2 MB**, if size is paramount: 10/14 strict and dialect gaps (`date_trunc`, `percentile_cont`, `::`, `~`, dates as text) would need documentation or a thin SQL rewrite layer; types must be tracked outside the engine. Budget: ~1.2 MB.
3. **Frontend (sql.js) is not recommended as primary**: costs 0.34 MB gzip but only works if the iframe CSP allows `wasm-unsafe-eval` (undocumented, unverified), carries SQLite's dialect/type weaknesses, and moves up to 5000×50 results over the bridge. DuckDB-WASM (8 MB gzip) is impractical for a plugin iframe. Keep sql.js as a last-resort path only if the host confirms WASM CSP and the sidecar budget is zero.
4. Do not use ApexBase (no in-memory mode, silent wrong results, bus factor 1, preview format) or stoolap (young, wrong LIKE results, dialect gaps) for now; revisit stoolap in a year.

## Unverified / not done
- Windows and Linux builds/sizes/runtime; CI toolchain claims beyond "needs cc / C++ per the dependency tree".
- Real DBX iframe CSP; sql.js was tested only in a plain page with a meta CSP, not inside a DBX sandboxed iframe; DuckDB-WASM not run.
- Result *correctness* was checked only by comparing row counts and spot samples across engines, not full diff. Query 06 median values compared only between SQLite rewrite and DataFusion/DuckDB first rows by eye (483.9 SQLite).
- Optional trims not explored: DataFusion feature pruning / `strip=symbols` + `opt-level="s"`, SQLite `SQLITE_OMIT_*` beyond one flag set, DuckDB size reduction. gluesql and turso/limbo not evaluated: turso is pre-release (0.9.0-pre.1) and SQLite-dialect (same gaps as (a)); gluesql lacks window functions/ percentile per its docs (not tested); chosen d1/d2 for being the most complete PG-style engine and the most credible pure-Rust small engine respectively.
- stoolap's `wasm` feature and DataFusion-in-WASM not tested.
- Timing is single-machine, 3 samples/median; load for ApexBase includes disk-backed writes in a temp dir.

## 已采用的方案与补函数清单

采用 SQLite（`rusqlite` bundled，内存库，置于 `LocalEngine` trait 之后）+ Rust 注册函数。已补：`date_trunc`、`to_char`（仅 YYYY MM DD HH24 MI SS）、`left`/`right`/`split_part`、`greatest`/`least`、`regexp`（部分匹配）、`regexp_replace`、`median`/`percentile_cont`/`percentile_disc`（普通聚合，无 `WITHIN GROUP`）、`stddev_*`/`var_*`。未补并给出改写提示：`::`、`ILIKE`、`~`、`DISTINCT ON`、`WITHIN GROUP`。完整矩阵见 `spec/sqlnb-v1.md` §4.3。
