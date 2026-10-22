English | [简体中文](sqlnb-format.zh-CN.md)

# .sqlnb file format guide

This guide helps readers understand the structure of a `.sqlnb` file. The **normative definition** is [spec/sqlnb-v1.md](../spec/sqlnb-v1.md) and [spec/sqlnb-v1.schema.json](../spec/sqlnb-v1.schema.json); this guide neither repeats nor replaces them, and where they differ the spec wins. Example files are in [spec/examples/](../spec/examples/).

## Basics

- UTF-8, LF line endings, YAML 1.2 using only a safe subset: no anchors, aliases, tags or merge keys; strings are always double-quoted or written as `|` block scalars.
- Key order and block `id`s are kept stable so diffs in version control stay readable.
- The file stores the notebook's **configuration** (text, variables, SQL, chart settings), not data. Run results are by default written to a `<name>.sqlnb.out` file (JSON) next to it, can be embedded in a block's `outputs` field, or can be left unsaved. Chart and big-number blocks never store results.
- The file contains no AI requests, conversations or generation content.

## Top-level structure

| Field | Required | Description |
| --- | --- | --- |
| `sqlnb` | Yes | Format version, the string `"1"` |
| `metadata` | No | `createdAt`, `modifiedAt` (ISO 8601); other keys are treated as unknown keys |
| `settings` | No | `defaultConnection`, `defaultDatabase`, `defaultSchema`, `outputs` (`separate`, `inline`, `none`), `maxRows` |
| `connections` | No | A list of `{ name, dialect }` |
| `blocks` | Yes | The array of blocks; array order is display order |
| `clients` | No | Private data of individual clients |

## Blocks

Each block has an `id` (unique within the file, matching `^[A-Za-z0-9_-]{1,64}$`) and a `type`, and may have `content` (Markdown or SQL text) and `metadata` (depends on the type).

| `type` | Main fields |
| --- | --- |
| `markdown` | `content` |
| `input` | `metadata.variable`, `inputType` (`text`, `number`, `date`, `boolean`, `select`), `value`, `options`, `multiple` |
| `sql` | `content`; `metadata.resultName`, `connection`, `database`, `schema`, `source` (`database` or `results`) |
| `chart` | `metadata.data`, `spec`; optional `pivot`, `view`, `chartOptions` |
| `big-number` | `metadata.data`, `value`; optional `label`, `format`, `metrics` |

Value ranges, limits and repair rules for each field are in section 4 of the spec; the matching UI features are described in [Blocks](blocks.md).

### Markdown image convention (non-normative)

The file format is unchanged: a Markdown block's `content` is still plain text. The SQL Notebook plugin's convention is to reference images next to the notebook with relative-path Markdown image links such as `![caption](./pic.png)`; pasted images are saved in a `<notebook file name>.assets/` folder, with links of the form `![](<notebook file name>.assets/image-<date-time>-<8-char hash>.<extension>)`. The image itself is not in the `.sqlnb` file, which holds only that line of relative-path text; when you move a notebook, move its images with it. This is only a usage convention of the plugin: the spec (`spec/`) is unchanged and other clients need not implement it.

## Connections are referenced by name

Only connection **names** appear in the file (`settings.defaultConnection`, a block's `metadata.connection`, `connections[].name`), never connection IDs, hosts, accounts or passwords. Each client maps names to its own local connections, and that mapping is never written to the file. `dialect` is only a hint; the actual rendering rules depend on the real database type of the resolved connection. If a name does not exist in DBX, the plugin reports the missing connection and disables running, but does not modify the file.

## Client-private data

Client-specific data may only live under `clients.<client name>`; other clients ignore it but preserve it. For example, this plugin stores a result table's transposed state in a SQL block's `metadata.clients.dbx.transposed` (omitted when `false`).

## Compatibility

- Unknown top-level fields, block fields, `metadata` fields and unknown block types are preserved on a read/write round trip; a block of an unknown type needs only `id` and `type`, and is shown in the UI as unsupported while its content is kept.
- The format is only extended additively: new optional fields do not change the meaning of old files, and older clients ignore them. For example, for the chart label fields (`label`, `valueLabels`, `nullLabel`, `summaryLabel`, `axisTitles`) and the big-number metric `filter` and `compare`, older clients show automatic names or the value without filter/comparison.
- A malformed optional analysis configuration does not make the notebook invalid: on load the plugin repairs it to defaults, notifies the user and marks the notebook as modified.
- A file whose `sqlnb` is not `"1"` should be opened read-only or rejected with a clear message.

## Example

The file below contains a description, a date input, a SQL block and a big-number block, and has been validated against `spec/sqlnb-v1.schema.json`.

```yaml
sqlnb: "1"
metadata:
  createdAt: "2026-10-01T08:00:00Z"
settings:
  defaultConnection: "sales-db"
  outputs: "separate"
connections:
  - name: "sales-db"
    dialect: "postgres"
blocks:
  - id: "b_intro"
    type: "markdown"
    content: |
      # 月度销售
  - id: "b_start"
    type: "input"
    metadata:
      variable: "start_date"
      inputType: "date"
      value: "2026-09-01"
  - id: "b_sales"
    type: "sql"
    content: |
      SELECT channel, amount FROM orders WHERE created_at >= {{ start_date }}
    metadata:
      resultName: "sales"
      clients:
        dbx:
          transposed: false
  - id: "b_total"
    type: "big-number"
    metadata:
      data: "sales"
      value: { field: "amount", aggregate: "sum" }
      label: "销售额"
      format: { kind: "thousands", decimals: 0 }
```

## Results file

`<name>.sqlnb.out` is a JSON object containing the version wrapper `sqlnbOut: "1"` and `outputs` keyed by block `id`. The structure, staleness checks and tolerance rules for corrupted files are in section 6 of the spec. A reader that meets a corrupted `.sqlnb.out` must not fail; it simply ignores it.
