[English](known-limits.md) | [简体中文](known-limits.zh-CN.md)

# Known limits

This page lists only the limits that still apply today. For the detailed behavior of each feature, see [Blocks](blocks.md) and [AI features](ai.md).

## Scope of verification

- Automated checks of UI behavior run in headless Chrome and jsdom; behavior in a real DBX host and in the user's own Chrome (real theme color tokens, the "Advanced settings" dialog, export results and so on) has not been verified item by item. When theme tokens are missing, light fallback color values are used, and the accent color may look weak in dark themes.
- Candidate packages are built by a GitHub workflow for five platforms and are all unsigned; the workflow has not actually been run on GitHub yet, and this needs to be confirmed on the first release.
- On a DBX 0.6.48+ host without AI capability, the notebook should work normally without the AI entry points; this has not yet been verified on a real host.

## Running and data

- At most 1–5000 rows (default 5000) are fetched and stored per block; anything beyond is truncated, and blocks that depend on a truncated result show "Based on partial data".
- Local SQL engine: query timeout 30 seconds, at most 500,000 rows registered per session, a total returned-result size limit of 64 MiB, and SQL text of at most 1,000,000 bytes; only a single read-only `SELECT`/`VALUES` is allowed.
- The single-statement check for local SQL (`check_single_statement` in Rust) and the TypeScript judgment used for AI auto-run (`analyzeSql`) are two independent implementations with different rules; the former is text-based, does not recognize Postgres dollar quoting or backslash escapes, and does not treat `/*!` and `/*+` comments specially; the local engine additionally has a read-only authorizer as a backstop.
- Date parameters are compared as ISO text in local SQL, so `<=`, `=` and `BETWEEN … AND {{d}}` miss the current day; use `date(column) <= {{d}}` or `column < next day`.
- Local SQL uses the SQLite dialect: `::` casts, `ILIKE`, `DISTINCT ON`, `WITHIN GROUP`, the `~` regex operator and similar are not supported, and `to_char` supports only some formats; see section 4.3 of [spec/sqlnb-v1.md](../spec/sqlnb-v1.md) for details.
- Parameters can only reference input variables, not the data of other blocks; the risk of MySQL multibyte client character sets (GBK, Big5, SJIS) is not mitigated, so use a UTF-8 connection.
- A pivot table shows at most 5000 rows and 500 columns; when a chart has too many grouped points, it asks you to reduce grouping. The UI adds at most 4 row fields, 3 column fields and 8 values.

## Big number

- Period-over-period/year-over-year compares calendar months; when the current month has not ended, it is compared with the full data of the previous month, with no proration.
- The month is taken from the first 7 characters of the date text, with no time-zone conversion; numbers, unparseable text and NULL are treated as having no date.
- A text filter cannot be written as `= ''` (an empty string is not a valid value); use "is empty" to match empty cells; "contains" is case-insensitive for ASCII letters only.

## Charts and labels

- Trade-offs of the hover tooltip for line/area charts: with more than 10 series only the 10 with the largest values are shown, followed by "… N more"; when the X axis is sparse (very few points or large gaps), the mouse hits the nearest X, which may be far from the mouse; the tooltip is plain text. These interactions exist only in on-screen rendering: exported HTML/PDF/SVG/PNG is static, contains no hover layer and looks the same as before, and the saved `.sqlnb` and the portable `spec` do not contain any of this either.
- The portable chart `spec` differs from the plugin's actual rendering: in the `spec` weeks start on Sunday while the plugin starts them on Monday, pie/donut charts use only the first row field and the first value, and histograms are not pivot-aggregated. When a pivot configuration exists, saving regenerates the `spec` from the configuration and overwrites hand edits.
- Scale, unit and category mappings affect display only and do not enter sorting, summaries, copied numbers or the portable `spec`.
- Label inputs commit only on change, blur or `Enter`.
- Row-header cells cannot be reached with `Tab` (use the "Advanced settings" dialog, or press `F2` on a header), summary/total headers cannot be focused either; a column field's name has no header on the table and can be edited only in the dialog.
- The "Advanced settings" dialog is `position: fixed`, and its width follows the plugin iframe rather than the block width; the preview is hidden when the container is below about 640 px wide. The headers in the preview are only a sketch and do not draw tooltips or export results; the preview takes at most 3 sample category values per field, and the remaining items have no badge.

## Markdown images

- Only PNG, JPEG, GIF and WebP are supported; AVIF, JPEG XL, HEIC and SVG are not supported (alt text or "Unsupported image" is shown), with no commitment to support them later.
- Remote `http(s)` images are not loaded (the plugin does not access the network); only the alt text is shown.
- Images must be files in the notebook's folder or its subfolders, referenced by relative path; each displayed image is at most 8 MiB and about 64 million pixels, each pasted image at most 10 MiB with at most 10 images per action, and embedded images in an export total at most 50 MiB, beyond which they are replaced with alt text in the export.
- When an image first loads, the content below it moves once.
- Images modified on disk are not refreshed automatically: they are cached by path while the same notebook stays open, and are read again only after reopening the notebook (including at the same path) or after "Save as" to a new path.
- Undoing a paste removes only the link, and the saved image file stays on disk; the plugin never deletes images automatically, so unreferenced images need to be cleaned up yourself.
- "Save as" processes only links that actually render as images (those inside code are not processed); image links whose alt text spans several lines are not rewritten. For reference-style image links, the definition line is what is rewritten: if the same definition is also used by an ordinary link, that link changes along with it.
- Moving or renaming a `.sqlnb` file outside the plugin without taking the images along breaks the relative links (shown as "Image not found").
- Hard links cannot be recognized: a hard link that points to content outside the folder will not be detected.
- Pasting takes effect only when the clipboard holds image files and no text.
- Path behavior on Windows has not been tested.
- Real clipboard behavior and performance with large notebooks have not been verified in real DBX. In a web host, non-image files dropped onto the plugin window are ignored (the plugin intercepts the default "open file" behavior).

## Markdown toolbar and desktop drop

- Desktop drop is received through the host's `fileTransfer.onDrop` (detected at runtime, falling back to web drop when unsupported). DBX desktop previously enabled native drag-and-drop handling at the Tauri default, and whether file drops are still intercepted and whether `onDrop` is actually triggered has **not yet been verified in real DBX**; if they are still intercepted, dropping has no effect, so use paste or the toolbar's "Insert image" instead.
- System drops have no drop-point coordinates: in preview mode the image is appended to the end, in edit mode it is inserted at the cursor; when none of several Markdown blocks has been clicked, only a notice to click a block first is shown. Folders do not keep their structure.
- The same drop may trigger both a web event and a host event: when the host provides a `dropId`, it is used for de-duplication; otherwise "file name + size" is used, so a repeated drop with the same name and size within 1 second may be merged into one.
- Drop subscription happens only after the host is ready (`ready`); when it does not appear, it retries every 250 ms for up to about 5 seconds and then gives up (desktop drop is unavailable).
- `Ctrl/⌘+B` may conflict with the sidebar shortcut in real DBX and is to be verified on a real device; if it conflicts, the shortcut has to be removed.
- The toolbar's "Insert image" uses the host's `pick`: the shape the host returns when the user cancels has not been confirmed on a real device (the plugin treats an empty result or an error carrying cancel/abort as cancellation); when `pick` is unavailable, it falls back to the browser's file chooser.
- The toolbar's recognition of bold/italic markers is heuristic, not a full CommonMark parse; `_`-style emphasis is not handled; removing a code block drops the language line.
- Edit mode is taller than preview mode by the height of the toolbar (one row is about 33 px, wrapping to two rows of about 63 px at about 320 px wide; the toolbar and the editing box form one unit with no gap).
- The IME (input method) behavior of the toolbar, desktop drop and image paste, and their behavior on Windows/Linux, were checked only in headless Chrome and jsdom and **have not been verified in real DBX with real input methods**.

## Export

- Syntax highlighting in export covers only SQL and the Markdown fences sql, json, yaml, javascript/typescript, python and bash; other languages such as html, xml, css and markdown are output as plain text (the corresponding parsers are not bundled, to keep the size down). Inline code is not colored.
- PDF requires Chrome, Edge or Chromium installed on the machine; without one, only HTML can be exported. When it is not found automatically, you can specify the browser in the start page "Settings" (type a path, or use "Choose file…" or "Choose folder…").
- "Open" in the export-complete box is handed to the system opener (macOS `open`, Windows `explorer`, Linux `xdg-open`), and the plugin cannot know whether a program actually opened the file: with no associated program or no desktop environment there may be no reaction at all; an error is shown only when launching the opener itself fails. Only files exported during the current run can be opened, and after restarting the plugin you need to open them manually in a file manager.
- When the exported file is on a network location (a Windows UNC path such as `\\server\share\…`), "Open" is not executed and only a notice to open it in a file manager is shown, to avoid triggering automatic access to the network share; the export itself is not affected. The behavior of "Open" using `explorer` when a file name contains a comma on Windows has not been tested.
- Result-table column widths are estimated from the character count: wide glyphs (capital W, emoji) and very wide numeric columns may be wider than estimated and overflow, and the sequence-number column is not included in the estimate.
- Styles use `color-mix()`: older webviews or PDF engines that do not support it lose the faint background of quotes, code and table headers.

## AI

- Error text returned by the database/host is shown as is.
- The text-level read-only check cannot recognize functions with side effects inside a `SELECT` (such as `pg_sleep`, `nextval`, `load_extension`); auto-run happens only when the statement is a single read-only `SELECT`/`WITH … SELECT`, so check the SQL before applying it.
- The output limit is 2048 tokens; truncation detection is heuristic (8000 characters) and may not trigger for Chinese output, in which case parsing and validation reject the damaged structured output.
- With "Table structure" turned off, table and column names in free text cannot be filtered reliably; when "Current SQL" is off and "Table structure" is on, table names are still extracted from the SQL.
- The table list has at most 300 names; lists for non-public schemas/databases depend on the `schema`/`database` fields of the host's `queryData` and the schema parameter of `getTableMetadata`, and whether the host honors them has not been verified; MySQL schema suggestions come from `SHOW DATABASES` and include system databases; schema names with quotes or special characters are not supported; tables that are not found cannot be told apart from tables the user may not read.
- Renamed or moved files and unsaved notebooks do not reuse the conversation cache; conversations are not synchronized between machines and are subject to the `host.storage` quota.
- Whether an interpretation is stale compares only column names, row count and the first 20 rows.
- The preview of a chart proposal is aggregated in memory (at most 2000 groups) and may differ slightly from the actual chart.
- DBX's confirmation box is the only gate before sending; the plugin provides no preview of its own.

## History

Undo/redo covers all changes to document content (see [Blocks](blocks.md)), is keyboard-only, is limited to 200 steps or about 16 MB, and the history lives in memory only. Known limits:

- Run results and run state are not restored: undoing a deletion restores the block, but it must be run again; undo does not cancel a running query.
- UI state such as selection, and AI conversations, are not covered.
- In plain inputs, text areas and dropdowns the browser's own undo is used, separate from the notebook history.
- Number and date inputs have no IME composition handling.
- The actual reading by screen readers has not been verified with real screen-reader software.

### Extension point: notebook history

`plugin/ui-src/src/state/history.ts` provides a generic undo/redo stack (`store.history`, `store.undo()`, `store.redo()`, limited to 200 steps or about 16 MB). The document entries in the stack are diff-based `DocEntry` objects (`docHistory.ts`): they store only the before and after snapshots of the affected blocks (and optionally the order, `settings`, `connections` and `metadata`), not the whole document. To hook other changes in:

1. Do not push entries onto the stack yourself; wrap the change in `recordEdit(label, source, touched, mutate)`: `touched` declares the affected block ids (`ids`), whether the order changes (`order`) and document-level fields (`doc`); `recordEdit` calls `cloneTouched` before and after `mutate()` to obtain `before`/`after`, records nothing if they are equal, and otherwise creates a `DocEntry` (undo/redo is carried out by `applyDelta`).
2. The conflict check is done by `checkDelta`: on undo, the affected blocks and document-level fields must still equal `after`, and on redo they must equal `before` (the chart's derived field `metadata.spec` is not part of the comparison); otherwise it returns `'conflict'`: the stack does not perform that entry, discards it, and the UI shows "This block was modified and can no longer be undone".
3. Document changes are recorded through `recordEdit`, with continuous typing merged within 800 ms; nothing is recorded during IME composition, and one step is recorded when the composition ends. The SQL editor's own history has been removed and its shortcuts call the notebook history directly; the global shortcut `useHistoryShortcuts` ignores plain inputs, text areas, dropdowns and editable content.
4. The limits, clearing (cleared on load, save as and close; a plain save does not clear it) and the status marker after a successful undo/redo are handled by the stack and the store.
