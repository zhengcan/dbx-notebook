# sqlnb v1 — SQL Notebook file format

## 1. Purpose

`.sqlnb` is a plain-text, client-neutral notebook format for SQL work: markdown, input (parameter), SQL, chart and big-number blocks. Any client may read and write it. The file contains no client-specific connection IDs, no credentials and no per-execution noise. Machine validation: `sqlnb-v1.schema.json` (JSON Schema draft 2020-12). Examples: `examples/`.

## 2. Encoding and YAML subset

- UTF-8, LF line endings, YAML 1.2.
- Safe subset only: **no anchors, aliases, tags, or merge keys**. Writers MUST quote every string (`"..."`) or use a `|` block scalar; unquoted scalars are only used for numbers, booleans and `null`.
- Stable key order and stable block `id`s, so diffs stay clean. Per-execution fields (e.g. execution counts) MUST NOT be written to the main file.

## 3. Top-level fields

| Field | Required | Description |
|---|---|---|
| `sqlnb` | yes | Format version, the string `"1"`. |
| `metadata` | no | `createdAt`, `modifiedAt` (ISO 8601 strings). Other keys are unknown and handled by the general rule (readers ignore them; writers preserve them). |
| `settings` | no | `defaultConnection` (a connection name); `defaultDatabase`, `defaultSchema` (optional strings, hints; see 4.3); `outputs`: `separate` (default) \| `inline` \| `none`; `maxRows` (optional integer 1–5000, default 5000; see 6). |
| `connections` | no | List of `{ name, dialect }`. Connections are referenced **by name**. `dialect` is a hint only; clients choose rendering rules from the real database type of the resolved connection. Names are user-defined and not guaranteed unique; clients map names to local connections themselves (the mapping is never stored in the file). |
| `blocks` | yes | Ordered array of blocks. Array order is the display order (no sort keys). |
| `outputs` | no | Reserved for `inline` mode; in v1 inline results are written in each block's `outputs` field (section 5). |
| `clients` | no | Client-private data under `clients.<clientName>`. Other clients ignore but preserve it. Client-specific data MUST live only here. |

## 4. Block common fields

| Field | Description |
|---|---|
| `id` | Required. Unique in the file, matches `^[A-Za-z0-9_-]{1,64}$`. |
| `type` | Required. `markdown`, `input`, `sql`, `chart`, `big-number`, or an unknown type (preserved). |
| `content` | Text body (markdown source, SQL text). |
| `metadata` | Type-specific object. |
| `outputs` | Only in `inline` mode; same structure as one `.sqlnb.out` entry. |

`resultName` and input `variable` names match `^[A-Za-z_][A-Za-z0-9_]{0,62}$`.

### 4.1 `markdown`
`content` (required) is Markdown.

### 4.2 `input`
`metadata`:
- `variable` (required): variable name.
- `inputType` (required): `text` | `number` | `date` | `boolean` | `select`.
- `value`: current value (string, number, boolean; array for multi-select).
- `options`: array of choices for `select`.
- `multiple`: boolean, `select` only; multi-select.

### 4.3 `sql`
`content` is the SQL text. `metadata` is optional (a sql block may have only `id`, `type`, `content`):
- `resultName` (optional): name under which the result is registered, usable by later blocks. A block without it exposes no named result. When present it must match the name pattern.
- `connection`: connection name; defaults to `settings.defaultConnection`.
- `database`, `schema`: optional. Effective value priority: block `metadata.database`/`schema` → `settings.defaultDatabase`/`defaultSchema` → the connection's own database (database only; there is no connection-level schema default) → unspecified. Empty or whitespace-only strings count as unset. These are hints: clients ignore values that do not exist on the connection.
- `source`: `"database"` (default; absent = same) runs on the database; `"results"` = run in the client's local engine against earlier blocks' results.
- `clients` (optional): client-private per-block data under `clients.<clientName>`, ignored but preserved by other clients. The SQL Notebook DBX plugin stores `clients.dbx.transposed: true` when the result table is shown transposed; the key is omitted when false (default), and empty containers are removed on save.

Dialects: database blocks use the connection's dialect; `source: "results"` blocks use the **SQLite** dialect (embedded in the client, extended with Postgres-style functions). Editors should switch highlighting/completion accordingly.

Parameters `{{ name }}` (§5) are available in both database blocks (rendered by the connection's `dbType`) and `source: "results"` blocks (rendered with the SQLite rules). They cannot reference data of other blocks (e.g. `IN ({{ df.col }})`); `{{ … }}` placeholders are not table references and never create dependencies.
**Date comparison in local blocks.** Timestamps registered from a database are ISO text (`2026-10-01 03:00:00` or `2026-10-01T03:00:00.000Z`) and a `date` input renders as `'2026-10-01'`, so comparisons are TEXT comparisons: `col < {{d}}` works as intended, but `<=`, `=` and `BETWEEN … AND {{d}}` drop or miss the whole day, and offsets compare as UTC text. Use `date(col) <= {{d}}` or `col < <next day>`. Clients may show a hint for this.

#### SQLite dialect support matrix (`source: "results"`)

| Construct | Status | Write instead / notes |
|---|---|---|
| `x::int` casts | not supported | `CAST(x AS INTEGER)` |
| `ILIKE` | not supported | `LOWER(a) LIKE LOWER(b)` |
| `~`, `~*`, `!~` | not supported | `col REGEXP 'pat'` (`NOT (col REGEXP 'pat')`; case-insensitive: `'(?i)pat'`). REGEXP is a **partial** match, like Postgres |
| `date_trunc(unit, ts)` | supported | unit: `year\|quarter\|month\|week\|day\|hour\|minute\|second`; `ts` must be ISO text; output keeps the input shape (date stays date, timestamp stays timestamp); weeks start on Monday (the portable chart spec of §4.4 uses Sunday weeks). Invalid dates in analysis queries are handled by the client and are not part of the format |
| `percentile_cont(x, p)`, `percentile_disc(x, p)`, `median(x)` | supported as plain aggregates | `WITHIN GROUP (ORDER BY …)` syntax is not supported |
| `stddev_samp`, `stddev_pop`, `var_samp`, `var_pop` | supported | |
| `regexp_replace(s, pat, repl[, flags])` | supported | flags `g`, `i` only |
| `left`, `right`, `split_part` | supported | |
| `greatest`, `least` | supported | ignore NULLs; NULL only if all arguments are NULL |
| `to_char(ts, fmt)` | partial | only `YYYY MM DD HH24 MI SS` (and `"quoted text"`); other tokens are an error |
| `GROUP BY 1` | supported | native SQLite |
| Window functions | supported | native SQLite |
| `DISTINCT ON (…)` | not supported | `ROW_NUMBER() OVER (PARTITION BY … ORDER BY …) = 1` in a subquery/CTE |
| `FILTER (WHERE …)` | supported | on aggregates, modern SQLite |
| CTEs, `WITH RECURSIVE` | supported | |
| `EXPLAIN`, `PRAGMA`, DDL, DML, multiple statements | rejected | only a single read-only `SELECT`/`VALUES` statement |
| `{{ name }}` parameters | supported | rendered with the SQLite literal rules (§5.1): plain `'…'` strings, backslash literal, booleans `1`/`0`; cannot reference data of other blocks |
| Types | weak typing | dates/timestamps are ISO text; decimals are NUMERIC; booleans are 0/1 |
| Limits | | `maxRows` per query, 30 s timeout, 500,000 rows registered per session, a cap on returned result size (excess is truncated) |

When a query fails and the SQL contains one of the rewritable constructs above, the client appends a hint with the suggested rewrite.

Referenced results are identified by identifiers in **table position** only (after `FROM`, `JOIN`, `INTO`, `UPDATE`, and after commas in a `FROM` list; an optional `main.`/`temp.` prefix is allowed). A column or alias that happens to share a result's name is not a reference. `resultName` rules: it matches the name pattern; unique within the notebook, case-insensitively; SQL reserved words must be double-quoted when referenced; names starting with `sqlite_` are invalid.

Client behaviour notes (non-normative): a block's saved result is shown as stale when its `sql`, `params`, `source`, or the `upstream` fingerprints differ from the saved ones. Re-running an upstream block does not refresh downstream blocks; each is stale until re-run itself. A block whose type or source changed is stale ("block type changed"). A downstream result computed from a truncated upstream is flagged "based on partial data".

Database blocks cannot reference data from earlier blocks (e.g. `IN ({{ df.col }})`); cross-block data flows only through `source: "results"` blocks. Only database blocks are executed against connections, and only read-only single statements are expected.

### 4.4 `chart`
`metadata`: `data` (required, a `resultName`), `spec` (required, a Vega-Lite spec object **without** `data.values`; the client injects data). Charts store configuration only, never images.

Optional analysis keys (unknown keys are preserved; the schema does not constrain their shape):

- `pivot`: `{ rows, columns, values, totals?, sort?, summaryLabel? }`. `rows`/`columns` are arrays of `{ field, grain?, label?, valueLabels?, nullLabel? }` (`grain`: `day|week|month|quarter|year`, only for temporal fields). `values` is an array of `{ field, agg, label?, format?, summary? }` with `agg` one of `sum, count, countDistinct, avg, min, max, median` and `format` `{ kind: "plain"|"thousands"|"percent", decimals?, unit?, scale? }` (`decimals` 0–6). `totals` is `{ row?, column?, grand? }` (booleans, default all `false`) and switches on the *summaries*: a row summary adds a column that combines each row's displayed cells, a column summary adds a row that combines each column's displayed cells, and the grand summary combines all displayed cells. Summaries are computed over the cells shown in the pivot table (not re-aggregated from the source records), per value; a table truncated for display is summarised over the displayed part only. Each value picks its method with `summary`: `sum`, `count`, `avg`, `min`, `max`, `median` or `none` (skip that value). When `summary` is omitted it follows the value's aggregate: `sum`/`count`/`countDistinct` → `sum`, `avg` → `avg`, `min` → `min`, `max` → `max`, `median` → `median`. Null cells are ignored, and `count` counts the non-null cells. The three toggles are independent: the row summary (a column) is shown only when `totals.row` is set and there are column fields, the column summary (a row) only when `totals.column` is set and there are row fields, and the grand summary (the corner cell, over all displayed cells) only when `totals.grand` is set and there are both row and column fields; a summary column/row/cell stays visible even when every value is `none` (it then shows a placeholder), so the method can be changed back. In this client the method is edited in the table's summary cells (double-click, or Enter/F2 on a focused cell, reads "Sum: 1,234" style); it is stored per value as `summary`, so changing it in any summary cell of a value changes all of that value's summaries. Copied TSV contains just the numbers. Sorting by a value orders the outermost row groups by a score: a group with exactly one cell is ranked by that cell's value; otherwise by the value's summary method over the group's cells (its default method when `summary` is `none`; `count` ranks by the sum of the cells). Groups with no value sort last in either direction, and ties keep ascending key order. This changes no file format (no format version change). An invalid `summary` is dropped with a warning. `sort` is `{ by: "name"|"value", valueIndex?, dir: "asc"|"desc" }` or `null` (default: none). Limits: at most 6 rows, 3 columns and 8 values; field names are at most 256 characters and must not contain NUL. **Display labels (additive, optional; since 0.5.11).** `rows[i].label` / `columns[i].label` replace the field name in headers and default axis/legend titles; `valueLabels` maps the category value to display text (at most 200 entries, key at most 256 characters; the key is `String(value)` of the raw value — `"0"`, `"1.5"`, `"true"`, strings as-is, temporal buckets as their displayed text such as `2024-03`; `1` and `"1"` share a key; mapping is display-only and never merges rows); `nullLabel` is the text for null (null is never a `valueLabels` key); `values[i].label` is the measure name; `summaryLabel` replaces the summary row/column/corner text; `format.unit` (at most 20 characters) is appended after the formatted number and `format.scale` (finite number, `> 0`, at most `1e12`) divides the raw value for display (`kind: "percent"` multiplies by 100 and ignores `scale`, which is dropped). Display order: scale/percent → round → thousands → `%` → `unit`. Scaling and mapping are display-only: sorting, summaries and the portable `spec` use raw, unscaled values and field names. Every new label string is capped at 200 characters (longer values are truncated on load without warning); an empty or whitespace-only string means "auto" and is omitted (setting back to auto deletes the key, never writes `""`); a string containing NUL, a non-string, an invalid `scale`/`unit` or an over-limit `valueLabels` entry is dropped with a normalizer warning, never an error. The pre-existing `values[].label` is still read up to 256 characters (longer: dropped), but new writes are capped at 200. Unknown keys are ignored by older clients; files without these fields are unchanged.
- `view`: `table`, `chart` or `both` (default `both` for a block that has a `pivot`).
- `chartOptions`: `{ type, stacking?, labels?, title?, bins?, timeAxis?, axisTitles? }`. `axisTitles` is `{ x?, y?, legend? }` (each a string, at most 200 characters, empty = auto, unknown keys ignored) and overrides the default axis/legend titles in this client; the portable `spec` does not use it. `type` is one of `line, area, bar, barHorizontal, scatter, pie, donut, histogram` (default `bar`); `stacking` is `none|stacked|grouped|percent` and applies to bar/area charts with a series (absent = stacked; for bar charts `none` and `grouped` both lay the series side by side, and since 0.3.3 `none` renders exactly like `grouped` — in 0.3.0–0.3.2 it behaved as stacked (0.3.0/0.3.1) or overlaid (0.3.2); for area charts `none` overlays the series and `grouped` is treated as `stacked`; `percent` is 100% stacked). Files with `stacking` absent are unchanged (absent = stacked); `labels` boolean (default `false`); `bins` a positive integer used by `histogram`.
- `chartOptions.timeAxis`: `sparse` (default; absent means `sparse`) or `compact`. It applies only when the first `rows` field is temporal and `type` is `line`, `area`, `bar` or `barHorizontal`; for any other type or a non-temporal first row field it is ignored without error. `sparse` is a continuous time axis with marks at their true time positions. `compact` shows only the periods that actually have data, evenly spaced in chronological order (missing intermediate periods are simply absent; lines connect the existing points only), with labels formatted per `grain`: `day` `2026-03-07`, `week` the Monday date `2026-03-02`, `month` `2026-03`, `quarter` `2026-Q1`, `year` `2026`. The portable `spec` then uses an `ordinal` x with the same `timeUnit` and `sort: "ascending"`. Other clients MAY ignore `timeAxis` and show a continuous axis. An invalid value is dropped on load with a notice (§4.4 repair rules).

**Repair on load.** A malformed optional analysis config (wrong types, invalid enum values, out-of-range numbers, over-limit lists) does NOT make the notebook invalid. Clients repair it on load by normalising to defaults, notify the user and mark the notebook modified; the file is never rejected for it.

**Portable `spec` vs. rendering.** `spec` is a Vega-Lite v5 object generated from `pivot` + `chartOptions` for other tools. It references the source by `data: { name: <data> }` and contains no `values`; clients inject data. It aggregates the *raw source rows* with Vega-Lite `aggregate`/`timeUnit` transforms. The SQL Notebook DBX plugin does not render that spec: it renders from data aggregated by its local SQLite engine, so results can differ in details: the portable `week` grain uses `yearweek` (weeks start on **Sunday**) while the plugin buckets weeks on **Monday**; `pie`/`donut` use the first row and first value only; `histogram` bins the raw rows (no pivot aggregation); `format` is applied in tooltips and labels only. When `pivot` exists, the config is authoritative: the plugin regenerates `spec` from it on save, overriding a hand-edited `spec`.

**Read-only legacy path.** A chart with only `data` and `spec` (no `pivot`) remains valid. Clients render it as-is, treat it as read-only and leave it untouched on save.

### 4.5 `big-number`
`metadata`: `data` (required, a `resultName`), `value` (required: `{ field, aggregate? }`, aggregate one of `sum, mean, average, min, max, count, median, first, last, distinct`), `label` (optional string, max 200 characters), `format` (optional, `{ kind: "plain"|"thousands"|"percent", decimals? }`, client-neutral number formatting).

**Multiple metrics (optional `metrics`).** A block has one source (`data`) and MAY carry `metrics`: an array of at most 8 entries `{ label?, field, aggregate?, format?, filter?, compare? }`, each with exactly the semantics of `value` + `label` + `format` above (unknown keys on an entry are preserved; an unknown `aggregate` on one entry is kept verbatim and shown as an error on that metric only). When `metrics` is present it is authoritative and clients lay the metrics out side by side. Writers that emit `metrics` MUST keep `value`, `label` and `format` mirroring `metrics[0]`, so clients that only know the single-metric form still show the first metric. A file without `metrics` is one metric (`value`/`label`/`format`); a client does not add `metrics` to it until a second metric is added, and removing metrics down to one keeps `metrics` with a single entry. Invalid entries (non-objects, malformed `label`/`format`) are repaired or dropped on load and entries beyond 8 are dropped, with a notice as in §4.4; a non-array `metrics` is ignored with a notice. The schema leaves `metrics` unconstrained so such a file still opens. (Design decided by the project controller.)

**Per-metric `distinct`, `filter` and `compare` (additive in sqlnb-v1 (0.5.10)).** Each `metrics` entry MAY also carry:

- aggregate `distinct`: the count of distinct non-null values of `field` (`field` required; any column kind).
- `filter`: `[{ field, op, value? }]`, at most 5 entries, AND-combined and applied before the aggregate. `op` is one of `=`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `notIn` (`value` an array, at most 50), `contains` (text only, case-insensitive), `isNull`, `notNull` (no `value`). Number columns take number values, text/date columns string values (dates ISO `YYYY-MM-DD…`), boolean columns boolean values. Text filter values are trimmed; an empty string is not a valid filter value (to match empty cells use `isNull`).
- `compare`: `{ kind: "mom"|"yoy", dateField }`. The current period is the calendar month of the latest non-null `dateField` among the filtered rows; `mom` compares with the previous calendar month, `yoy` with the same month one year earlier. The metric's own aggregate and filter are computed for each period. The delta is (current − previous) / |previous|, and is null when the previous value is null or 0 (or either value is not a number). A partially elapsed current month is compared with the full previous month (a known caveat that is not corrected).

**`compare` edge cases (clarification).** The period of a row is the first 7 characters (`YYYY-MM`) of its `dateField` text **as written**: only well-formed ISO values (`YYYY-MM-DD`, optionally followed by ` `/`T` and a time, fraction and `Z`/`±hh:mm`) count, and no timezone conversion is applied (`2026-10-31T23:30:00-05:00` belongs to `2026-10`). Numbers, unparseable text and NULL are treated as having no date and are ignored. If no filtered row has a date (including when the filter matches no rows), the metric shows its plain value without a comparison (not an error). A `dateField` that is missing from the data, is not a date column, or a `kind` that is unknown is an error on that metric only. A previous period without rows gives a null previous value; a previous value of null or 0 gives a null delta (shown as "—", never infinity or NaN); a negative previous value uses its absolute value in the denominator. `first`/`last` values that are not numbers also give a null delta.

A metric with `filter` or `compare` always lives in `metrics` (never only in the single-metric `value`/`label`/`format` form); `value`/`label`/`format` keep mirroring `metrics[0]`. Unknown keys on an entry are preserved; an unknown `aggregate`, `op` or `kind` is kept verbatim and shown as an error on that metric only. Malformed `filter` entries (non-object, missing `field`, bad `op`) are dropped with a notice, entries beyond 5 are dropped, and a malformed `compare` is ignored with a notice, as in §4.4. Clients that ignore these fields still show a valid number: metric 1 is shown without its filter and without any comparison (unfiltered, uncompared). The schema leaves these keys unconstrained, so files with and without them validate.

`mean` and `average` are aliases and are kept as written. `first`/`last` use the source result's row order. The schema does not constrain `aggregate`: an unknown aggregate (e.g. `stddev`) is tolerated and preserved verbatim; clients show it as an error rather than rewriting it. A malformed optional `label`/`format` is repaired on load as in §4.4.

## 5. Parameters `{{ name }}`

- `{{ name }}` (whitespace inside braces optional) refers to an `input` block variable. In v1 only input variables are resolved. No control flow (`{% %}`) is supported.
- Clients substitute **literals** before execution (bind parameters are unavailable), choosing the rule by the connection's actual `dbType` (database blocks) or the SQLite rules (`source: "results"` blocks, which run in the local SQLite engine). Parameters cannot reference data of other blocks.
- A substitution inside an existing SQL string literal, comment or identifier position is not supported; clients SHOULD reject it.
- Unresolved variable, wrong type, or a value that cannot be rendered safely MUST abort execution with an error (never fall back to raw interpolation).

### 5.0 Decisions and clarifications

- `{{ … }}` that is not valid variable syntax stays verbatim in the SQL.
- Any variable-syntax reference inside a string, identifier or comment is rejected. Clients lex the following constructs per dialect family: single/double quotes; backticks (MySQL, ClickHouse, SQLite); `[ident]` (SQL Server); `--` line comments; `/* */` block comments (nested for Postgres, DuckDB, SQL Server); `#` line comments (MySQL, ClickHouse); dollar quoting (Postgres, DuckDB); Oracle `q'…'` alternative quoting.
- Empty or unset values (including a text value of `''`) abort execution with an error.
- Adjacent references are separated by a single space when rendered.
- Negative numbers are rendered parenthesised (see §5.1).
- When duplicating an `input` block, clients MAY rename its variable (e.g. `name_2`) to avoid duplicate variable names.
- Residual risks: MySQL `NO_BACKSLASH_ESCAPES` only alters data, not statement structure; multibyte client charsets (GBK, Big5, SJIS) are not mitigated. Clients SHOULD connect with UTF-8.

### 5.1 Literal rendering rules

| Input type | Rendered as | Validation |
|---|---|---|
| `text` | String literal `'...'`. Single quote doubled (`''`). For MySQL/MariaDB and ClickHouse (backslash is an escape char) also escape `\` as `\\`. For the Postgres family (Postgres, Cockroach, Redshift, Greenplum), a value containing a backslash is rendered as `E'...'` with each `\` doubled (safe under either `standard_conforming_strings` setting); values without a backslash use plain `'...'`. For SQLite, SQL Server, Oracle, DuckDB backslash is literal and left as-is. | Reject NUL (`\0`) and other control characters except `\t \n \r`; reject invalid Unicode. SQL Server: prefix `N'...'` for non-ASCII. |
| `number` | Bare numeric literal, canonical decimal form (`12.5`); negative numbers are parenthesised (`(-12.5)`) to prevent `--` comment fusion. | Must match `^-?\d+(\.\d+)?([eE][+-]?\d+)?$`; reject NaN/Infinity/empty. |
| `date` | Quoted ISO string `'YYYY-MM-DD'`; Oracle: `DATE '2026-09-01'`; Postgres/DuckDB/ClickHouse/MySQL/SQLite/SQL Server accept the quoted string (optionally with a `DATE` prefix). | Must match `^\d{4}-\d{2}-\d{2}$` and be a real calendar date. |
| `boolean` | `TRUE` / `FALSE` for Postgres, MySQL, DuckDB, ClickHouse; `1` / `0` for SQL Server, SQLite, Oracle. | Must be a real boolean. |
| `select` multiple | Parenthesised list of per-element literals: `('a', 'b')`; used as `IN {{ v }}`. Element rendering follows the option value type. | Empty selection is rejected (`IN ()` is invalid). Every element validated as above. |
| `select` single | Same as one element of its value type. | Value should be one of `options`. |

Unknown `dbType`: clients use the conservative rule — double single quotes, reject any value containing a backslash or control character.

## 6. Results storage

`settings.outputs`:
- `separate` (default): results in `<name>.sqlnb.out` next to the notebook; runs do not change the main file.
- `inline`: each block's `outputs` field in the main file (git churn is expected).
- `none`: nothing saved.

Mode switching takes effect on the next save: `inline` → `separate`/`none` strips `outputs` from the main file; `separate` → `inline` writes `outputs` into the main file and removes the `.out`; `none` deletes the `.out` (clients confirm first); → `separate` creates the `.out`.

Save order: when the main file must be written it is written first, then the `.out`. If only results changed and the main file is untouched, only the `.out` is written. A failing `.out` write MUST NOT fail the main save (the client reports "results not saved"). Results for deleted blocks are dropped at save time.

`chart` and `big-number` blocks never have `outputs`: they hold configuration only and are computed from the referenced result when displayed. They add nothing to the `.out` file and nothing inline.

Load: a present, valid `.out` takes precedence over inline `outputs`.

The per-block row cap (default 5000, range 1–5000) is a client setting; it applies to both the query and the stored output. The optional `settings.maxRows` field (integer 1–5000) in a file is a hint that other clients MAY honour as their cap; out-of-range or non-integer values are clamped/ignored by clients, and the schema rejects them. The SQL Notebook DBX plugin does not honour it: it uses its own plugin-level setting shared by all notebooks, never writes this field, and preserves it untouched on round trip.

### 6.1 `.sqlnb.out` structure (JSON)

The file is a JSON object with a version wrapper: `sqlnbOut` (the string `"1"`) and `outputs` (a map from block `id` to an entry). Inline-mode `outputs` fields hold one entry without the wrapper.

```json
{
  "sqlnbOut": "1",
  "outputs": {
    "<blockId>": {
      "columns": [{ "name": "status", "type": "text" }],
      "rows": [["refunded", 12]],
      "executedAt": "2026-10-17T14:31:00Z",
      "elapsedMs": 84,
      "truncated": false,
      "error": null,
      "sqlHash": "fnv1a32:0a1b2c3d",
      "params": { "start_date": "2026-09-01" }
    }
  }
}
```

- Keyed by block `id`. Required fields: `columns`, `rows` (arrays of arrays), `executedAt`. Optional: `elapsedMs` (default 0 when absent), `truncated` (default false when absent), `error` (string or absent/null), `sqlHash` (optional for foreign writers; a missing hash means "unknown, treat as stale" for clients that compare; hash of the rendered-input SQL text, formatted `fnv1a32:<8 lowercase hex>`; opaque to other clients, which MUST NOT interpret or recompute it and only preserve it), `params` (parameter values used; JSON-serializable object), optional `upstream` (map of `resultName` → the `executedAt` of the upstream run the result was computed from, e.g. `{"refunds": "2026-10-17T14:31:00Z"}`; used by clients to detect upstream changes; other clients preserve it).
- `error` is the message text only (writers never emit an empty string for a failed run); clients restore it as a generic error.
- `sqlHash` is best-effort: hashes restored from files written by a different normaliser may show a one-time false "stale".
- The number of rows saved equals the number fetched: one per-block row cap (`maxRows`, default 5000) applies to both the query and the stored output; nothing is truncated again at save time. `truncated` is true if the cap was hit; dependent blocks and charts show a "partial data" warning but still run. Writers may offer a lower `maxRows` to keep files small.
- Alignment: results match blocks by `id`. A result whose `sqlHash`/`params` differ from the current block is shown as **stale**, not discarded.
- Staleness (client-side): the SQL hash is computed after normalising line endings to LF, trimming trailing whitespace on each line and removing leading/trailing blank lines (so whitespace-only edits are not stale). `params` are compared by raw value; a variable that was deleted counts as changed. A missing `sqlHash` means unknown, hence stale.
- Corrupt-file tolerance: readers MUST NOT fail on a damaged `.sqlnb.out`. A non-JSON file, a wrong or unknown `sqlnbOut` version, or a missing `outputs` map yields no results plus a warning (the file is ignored; the next save rewrites it); a malformed entry (non-array columns/rows, row length differing from column count, missing `executedAt`, non-object `params`, a present but non-numeric/negative `elapsedMs`, a non-boolean `truncated`) is dropped with a warning while other entries are kept. Non-finite numbers are written as `null`. Unknown entry-level and top-level fields MUST be preserved on round-trip (written after the known fields, sorted by key). Writers emit entries sorted by block id, 2-space indent, trailing newline.
- An inline `outputs` field has exactly the entry structure above.

## 7. Forward compatibility

- Unknown top-level fields, block fields, metadata fields and **unknown block types MUST be preserved** on round-trip.
- Clients ignore (but preserve) other clients' `clients.<name>` data.
- The schema only strictly validates known fields/types; additional properties are allowed. A block of unknown `type` only needs `id` and `type`.
- A `sqlnb` version other than `"1"` should be opened read-only or refused with a clear message.
