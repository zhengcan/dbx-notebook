English | [简体中文](ai.zh-CN.md)

# AI features

SQL Notebook can have the model configured in DBX help you write SQL, interpret results, configure charts and generate big-number metrics. Every AI call is made from the plugin UI through `host.ai`; the backend process never calls AI. A model's output changes the notebook only after you click a button such as "Apply", "Replace" or "Insert".

## Requirements

- DBX must report the AI capability (`aiCompletion`): text generation needs DBX 0.6.28 or later; streaming output and cancellation need 0.6.31 or later (without them a single non-streaming request is used). When the host has no AI capability, the AI entry points are hidden and the AI settings on the start page explain why.
- The plugin needs the `host.ai` permission.
- Only one AI drawer and one AI request can be active at a time.

## Features

An AI entry point opens a drawer on the right (about 80% of the window width): the work product is on the left and a multi-turn chat on the right. In the chat input, `Enter` sends and `Shift+Enter` inserts a line break. Opening the drawer sends nothing; `Esc`, "Discard" or ✕ closes it and leaves the notebook unchanged.

| Entry point | What it does |
| --- | --- |
| "✨ Ask AI" on a SQL block | Chat with the model to generate or rewrite SQL. The left side is an editable SQL draft, and you can compare it with the block (diff, collapsed by default). "Test run" executes the draft read-only on the block's connection, showing at most 50 rows in the drawer and writing nothing to the notebook. "Confirm" or "Insert as new block" writes the draft |
| "📊 Interpret results" on a SQL block | Available when the block has a result. Opening it generates one interpretation of the result (Markdown preview). "Insert as Markdown block" inserts it below the block that opened the drawer |
| "Ask AI" on a chart block | Generates up to 3 chart proposals, shown as summary cards and one large preview; "Apply" writes the selected proposal's configuration into the block |
| "Ask AI" on a big-number block | Generates candidate metric cards from the local result tables already in the notebook (up to 12 per reply). You can "Update current block" (up to 8 metrics, all from the same source) or "Insert as new blocks" (metrics from the same source are merged into one block, up to 8 per block) |

Notes:

- After SQL is written, it is run automatically once only if the new SQL is a single read-only `SELECT` / `WITH … SELECT`, has no unfilled parameters and the upstream results are up to date; otherwise the reason is shown and nothing runs. The auto-run decision is a conservative text analysis: a `$` token, a backslash, a `/*!` or `/*+` comment, or a `--` not followed by whitespace always prevents auto-run. It judges only the shape of the statement and cannot recognize functions with side effects inside a `SELECT`.
- AI-generated SQL is formatted before it goes into the draft (per dialect, keeping `{{ parameter }}` unchanged); the formatted version is used only if it differs from the original in layout and keyword case alone, otherwise the original SQL is used. Text you type yourself is never formatted.
- Each confirmation becomes one "Applied · Undo" step (`Ctrl/⌘+Z`); if the block is modified after applying, the undo is rejected.
- Assistant replies are rendered as Markdown; raw HTML, images and non-http(s) links are dropped.
- Closing a SQL drawer that has unapplied changes shows four options: update the SQL block, insert as a new block, do nothing for now (the notebook stays unchanged) and cancel (the drawer stays open).

## Drawer details

- **Interpretation drawer**: opening it generates one interpretation (an already-cached interpretation is not sent again when reopened; the entry point is disabled when "Result data" is off). The drawer has no generate button: typing in the chat generates, and to redo it say "interpret again". In the chat, a model reply replaces the left preview only if it starts with `UPDATE:`; a reply that starts with `ANSWER:` or has no marker is just an answer and never changes the preview. "Insert as Markdown block" inserts below the block that opened the drawer (even if the block has since been moved); if that block has been deleted the button is disabled with an explanation.
- **Chart drawer**: "Generate proposals" requests a fresh set of proposals; once proposals exist the same button becomes "Regenerate" and replaces the whole set. Proposals are shown as summary cards without thumbnails. A change made in the chat applies only to the **selected** proposal: when the model returns one configuration it replaces only that proposal (a late-arriving reply does not move the selection), and when it returns a set it replaces all of them; reopening the drawer selects the proposal currently in use. The plugin sends the selected proposal's number with the request; writing "proposal 2" in a message is just part of the request text, interpreted by the model. "Apply" uses the previewed configuration and is disabled, with an explanation, when the block or its columns have changed.
- **SQL drawer**: "Confirm" is disabled, with an explanation, when the block has been modified since the drawer was opened, when the draft is empty, or when the draft is identical to the block. "Test run" has no cancel or timeout setting of its own, and only one can run at a time.
- **Big-number drawer**: a chat message such as "make metric 2 a percentage" changes only that card; returning a whole set of candidates replaces the whole set. "Generate metrics" (later "Regenerate") replaces the whole set of candidates; "Undo" restores the previous state in one step, including removing all inserted blocks. If the source result changes, the drawer notes that the candidates were based on an older structure and re-checks them; applying is rejected when a column no longer exists.
- Clicking the backdrop outside the drawer is equivalent to clicking ✕ or pressing `Esc` (with an unsent draft it asks first whether to discard it); both the press and the release must land on the backdrop, so selecting text by dragging inside the drawer never closes it by accident.
- When typing with an input method (IME), pressing `Enter` to confirm a candidate does not send the chat message, and does not submit the export file name, the start page path or path inputs.
- SQL syntax highlighting is used in the editor, the diff view and `sql` code blocks in the chat, with contrast protection against the host's background color (light, dark and DBX presets). A diff of more than 600 lines is shown as plain text, and the highlighting limit for a single code block is 512,000 characters.

## What is sent to the model

Each chat turn is a **single prompt** (one `host.ai` request): your request text, plus the current SQL, result summary or chart configuration placed in a fence as untrusted data, plus the earlier conversation. Your request text is at most 2000 characters; the whole request is at most 100,000 characters, and when it is exceeded result rows are dropped first, then table schemas, and the conversation drops its oldest turns first; the request says what was omitted.

The settings are in "AI assistant" on the start page; all three are on by default:

| Setting | What is sent when on |
| --- | --- |
| Table schema | Table names, column names and types; the SQL drawer also sends the table list of the block's database/schema and the structure of relevant tables |
| Current SQL | The current block's SQL and the SQL in earlier replies |
| Result data | The result summary and first rows (for big numbers, up to 5 sample rows and per-column statistics), plus earlier interpretations and chart proposals |

- The switches are re-checked on every turn and they also filter the conversation history: with "Current SQL" off, SQL in earlier replies is replaced with `[earlier reply omitted]`; with "Result data" off, the data part and earlier interpretations/chart proposals are no longer sent. Your own earlier messages are sent verbatim.
- With "Table schema" off, no catalog queries are made and neither table lists nor schemas are sent (the big-number assistant is unavailable). With "Result data" off, the interpretation and chart assistants are unavailable, and the big-number assistant generates candidates from names only.
- The database type (such as `postgres`) is written into the prompt and is not controlled by the switches.
- The values on big-number candidate cards are computed locally with the same code as the block and are never sent to the model.
- If the settings cannot be read, the plugin treats them as off and sends no optional content.

## Consent

Before every request is sent, DBX shows its own confirmation dialog (with the plugin, the model, the first line of the prompt and its size). If you refuse, the request is cancelled, the plugin shows a notice and changes nothing. The plugin provides no preview of its own; the confirmation dialog is the only gate before sending. In the DBX dialog you can tick "Don't ask again for this workspace" (DBX's in-session memory; the first request of each session always asks).

## Table list scope (SQL drawer)

With "Table schema" on, the first prompt carries a table list for the block's scope:

- If the block sets a schema (Postgres-like) or a database (MySQL-like), the tables of that scope are listed; if not, the user tables of all non-system schemas are listed (as `schema.table`). The table list has at most 300 names.
- When the model needs more information it can reply `NEED_LIST: <schema>` or `NEED_TABLES: a, b` (at most 8 names); the plugin fetches it and requests again automatically. At most 3 extra rounds are added automatically per message; the 4th request shows a notice and is not saved. Each read shows a one-line notice.
- Catalog queries are fixed statements executed under the notebook's existing `host.data:read` authorization, so no new permission is needed. Postgres, MySQL/MariaDB and SQLite are supported; other types use only the tables that appear in the notebook and show a note.
- Schema/database names with quotes or special characters are not supported: a name may contain only letters, digits, `_ $ . -` and spaces (at most 64 characters); otherwise a notice is shown and no table list is read.

## What is never written to files

AI requests, conversations, notes, column information and settings are **never** written to a `.sqlnb`, `.sqlnb.out` or export file.

- Settings (the send switches and the model choice) are stored in the local `host.storage` and contain no API key.
- Conversations are cached per block in the local `host.storage` (SQL, interpretation and chart conversations are stored separately) and are restored when you reopen the notebook at the same path; "Clear chat" in the drawer deletes them, and deleting a block deletes its conversations. Limits: 40 messages and 60,000 characters per block, at most 200 KiB per stored value, and at most 30 blocks with 400,000 characters in total (oldest dropped first).
- Renaming/moving the file, or an unsaved notebook (which has no path), does not carry conversations over; if `host.storage` fails, conversations are kept in memory only.
- Cached messages may contain content derived from data (the AI's SQL, interpretations, chart proposals); they exist only on your machine and are filtered by the switches when sent.

## Limits

- Only one result is generated at a time. Output is capped at 2048 tokens; truncated or unparseable output is rejected (with an "output too long" notice) and never partially applied. Truncation detection is heuristic: output is judged truncated only once it reaches 8000 characters, and for Chinese output 2048 tokens may be reached first; in that case parsing and validation reject corrupted structured output, while plain-text interpretations are constrained only by the length cap.
- The host's `host.ai` accepts a single prompt per request, so the conversation history is concatenated into the prompt rather than sent as separate messages.
- With "Table schema" off, table or column names can still appear in earlier text written by you or the model; free text cannot be filtered reliably, so this is not guaranteed.
- With "Current SQL" off and "Table schema" on, table names are still extracted from the current SQL to fetch their structure (turn "Table schema" off if you need to avoid this).
- The text-level read-only check cannot recognize functions with side effects inside a `SELECT` (such as `pg_sleep`, `nextval`, `load_extension`); the host's own read-only enforcement is the backstop. Check the SQL before applying it.
- Error text returned by the database or host is shown in the UI as is (the plugin neither logs nor stores it).
- To decide whether an interpretation still matches the result, only column names, the row count and the first 20 rows are compared; later changes are not detected.
- A chart proposal's preview is aggregated in memory (date granularity is derived from ISO strings, at most 2000 groups) and may differ slightly from the actual chart.
- Big-number candidates that reference a missing table/column, have an invalid filter, a non-date compare field or an incompatible aggregate are marked and cannot be applied.
