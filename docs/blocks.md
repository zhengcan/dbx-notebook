[English](blocks.md) | [简体中文](blocks.zh-CN.md)

# Blocks

This page describes each block type in a notebook: its fields, behavior, limits and export result. For how blocks are stored in the file, see the [.sqlnb format guide](sqlnb-format.md); for AI assistance, see [AI features](ai.md).

## Common actions

- Between blocks there are `+ Markdown`, `+ SQL`, `+ Local SQL`, `+ Input`, `+ Chart` and `+ Big number` buttons that insert a block after the current one. When the notebook is empty, the same buttons appear in the middle of the page.
- Every block has ↑ (move up), ↓ (move down), ⧉ (duplicate) and ✕ (delete). Deleting a block whose `content` is not empty (Markdown and SQL) asks for confirmation first; input, chart and big-number blocks are deleted directly.
- Toolbar: Home, New, Open, Save (`Ctrl/⌘+S`), Save as, Run all, Run from selected block, Stop (stops after the current block finishes), Export, plus the "Save results" mode and the default connection selector.
- Undo/redo is keyboard-only (there are no toolbar buttons): `Ctrl/⌘+Z`, and redo with `Shift+Ctrl/⌘+Z` or `Ctrl+Y`. It covers SQL and Markdown text, input variables, big-number metrics, chart configuration, changes applied by AI, block settings and metadata, and adding, deleting, moving and duplicating blocks, as well as "Visualize". It does not cover run results and run state, UI state such as selection, or AI conversations. Continuous typing is merged into one step after an 800 ms pause (losing focus, `Enter`, switching to another field, running, saving or undoing ends the current step); one IME composition counts as one step. The history is limited to 200 steps or about 16 MB. It lives in memory only and is cleared on open, new and save as; a plain save does not clear it. When you undo back to the saved state, the "unsaved" marker disappears. In plain inputs, text areas and dropdowns, `Ctrl/⌘+Z` uses the browser's own undo; in the SQL editor it acts on the notebook history (the editor has no history of its own); modal dialogs handle keys themselves. Undoing a deletion restores the block (same id, position and content) but not its run result, so you need to run it again. After an undo/redo, screen readers receive an "Undone: …" / "Redone: …" announcement, and focus does not move.
- Results are not lost when the notebook is saved: how run results are stored is described in [Saving results](#saving-results).

## Markdown

- Field: `content` (Markdown source).
- Use: an empty block goes straight into edit mode; click or double-click the preview to edit; `Ctrl/⌘+Enter`, `Esc` or losing focus returns to the preview. Enter during IME composition does not trigger any action.
- Supported: h1–h6, emphasis, strikethrough, nested lists and quotes, tables (column alignment; wide tables scroll horizontally), inline and fenced code, horizontal rules, links.
- Not supported: task lists, footnotes, raw HTML (ignored). Links open in a new window. For images, see [Images](#images) below.
- The block height stays the same when switching between edit and preview, so the page does not jump.
- Export: output with the same styling, using a fixed light color scheme. Fenced code blocks (<code>```language</code>) are syntax-highlighted for `sql` (including `postgres`, `mysql`, `sqlite`), `json`, `yaml`/`yml`, `javascript`/`js`, `typescript`/`ts`, `python`/`py` and `bash`/`sh`/`shell`; code blocks in other languages or without a language are not colored and are output as plain text; the language is never guessed.

<p align="center"><img src="images/block-markdown.png" alt="Preview of a Markdown block" width="760"><br><sub>Preview of a Markdown block.</sub></p>

### Images

A Markdown block can display local images located next to the notebook.

- Only PNG, JPEG, GIF and WebP are supported. Other formats such as AVIF, JPEG XL, HEIC and SVG are not supported (alt text or "Unsupported image" is shown), and there is no commitment to support them later.
- How to reference: use a **relative path**, relative to the folder containing the notebook, such as `![caption](./pic.png)` or `![](<notebook file name>.assets/image-….png)` (`<notebook file name>` includes `.sqlnb`, for example `monthly-sales.sqlnb.assets/`). The `.sqlnb` file stores only this line of relative-path text, not the image itself; for preview and export, the plugin backend reads the image and shows it as embedded data.
- Remote `http(s)` images are not loaded (only the alt text is shown): the plugin never accesses the network. `data:image/` inline images accept only base64 PNG, JPEG, GIF and WebP; oversized ones (base64 over 1 MiB) show "Image too large".
- Path restrictions: only files in the notebook's folder or its subfolders can be referenced; absolute paths and `..` are not accepted, and symlinks pointing outside the folder are rejected.
- Size limits: for display, each image is at most 8 MiB and about 64 million pixels; when pasting or dropping, each image is at most 10 MiB and at most 10 images per action (extra ones are ignored, with a notice).
- On first load, an image shifts the content below it once (a placeholder is shown first and expands to the image size once loaded).

<p align="center"><img src="images/block-markdown-image.png" alt="An image shown in a Markdown block preview" width="760"><br><sub>An image in a Markdown block preview (the picture is a generated sample).</sub></p>

### Editing toolbar

In edit mode there is a formatting toolbar above the editing box (there is none in preview mode, so edit mode is taller than preview mode by the height of the toolbar: one row is about 33 px (buttons 28 px), and two wrapped rows are about 63 px; the toolbar wraps to two rows when the width gets down to about 320 px; the toolbar and the editing box form one unit with no gap, sharing a single 1 px divider; when the editing box has focus, a 2 px theme-colored focus ring is drawn inside the box). There are 11 buttons in 4 groups:

| Group | Buttons |
| --- | --- |
| Inline | Heading (cycles), Bold, Italic, Inline code |
| Code and link | Code block, Link |
| Block | Quote, Bulleted list, Numbered list |
| Insert | Table, Insert image |

<p align="center"><img src="images/block-markdown-toolbar.png" alt="Formatting toolbar of a Markdown block in edit mode" width="760"><br><sub>The formatting toolbar in edit mode (with the word "区域" selected).</sub></p>

- **Shortcuts**: `Ctrl/⌘+B` (bold), `Ctrl/⌘+I` (italic) and `Ctrl/⌘+K` (link), active inside the editing box. Shortcuts match physical keys (`KeyB`/`KeyI`/`KeyK`), so on layouts such as Dvorak or AZERTY the position of these three letters may differ from the letters themselves. On macOS only `⌘` is recognized (`Ctrl+B` is still the browser's cursor-left); on Windows/Linux only `Ctrl` is recognized; holding Shift or Alt at the same time does not trigger them. `Ctrl/⌘+B` may conflict with the sidebar shortcut in real DBX, **to be verified on a real device**.
- **Toggle and cancel**: clicking again on text that already has the format removes it (bold, italic, inline code, link, quote, lists and code block all behave the same way). With no selection, placeholder text is inserted and selected so you can type over it directly. The heading button cycles: none → `#` → `##` → `###` → none (`####` and deeper are simply removed). Bulleted and numbered lists switch into each other; numbered lists are renumbered 1, 2, 3.
- **Removing a code block drops the language line**: when the fence is removed, a language tag such as ```` ```sql ```` disappears with it.
- **Literal text is not rewritten**: asterisks inside inline code, asterisks inside URLs, `\*` escapes and multiplication signs (such as `2 * 3`, `a*b`) are not treated as bold/italic markers; when the cursor or selection lies strictly inside inline code or a URL, the bold/italic buttons leave the text unchanged. Marker detection is heuristic, not a full CommonMark parse, and `_`-style emphasis is not handled.
- **Undo**: each button action is **one undo step**, and after undo the cursor returns to the changed position.
- **IME**: during IME composition the buttons and shortcuts do nothing (the buttons appear disabled).
- **Keyboard**: `Shift+Tab` moves from the editing box into the toolbar, `←`/`→`/`Home`/`End` move between buttons, `Tab` returns to the editing box, and `Esc` returns to the editing box and keeps the selection. Clicking a button does not make the editing box lose focus.
- **Insert image**: DBX's file picker (`pick`, multi-select) is used first; when the host does not provide it, the browser's file chooser is the fallback. Cancelling the selection does nothing. The save location and limits are the same as for pasting (see below).

**Paste and drop**: in edit mode, when you paste an image (`Ctrl/⌘+V`, the editing box must have focus) or drop one onto the Markdown editing box, the plugin saves the image into the `<notebook file name>.assets/` folder next to the notebook, with the file name `image-<date-time>-<8-character hash>.<extension>` (for example `monthly-sales.sqlnb.assets/image-20261021-093000-3f9a1c2e.png`), and inserts a `![](…)` link at the cursor. You can keep typing while the image is being saved: the plugin re-locates the insertion point using the text before and after it; if your edit overlaps the insertion point and it cannot be located, the link is inserted at the current cursor and the notice "The text changed while the image was being saved; it was inserted at the cursor" is shown. When a drop lands in the middle of a character made of two code units, such as an emoji, the link is inserted before that character.

- The folder name is the notebook's full file name plus `.assets`; in the file name, `\ / % : ? # * < > | "` and control characters are replaced with `_`, trailing dots and spaces are removed, a leading `~` becomes `_`, and when the folder name is a reserved Windows name (such as `CON`), `_` is prepended.
- Inserting the link is **one undo step**; undo only removes the link and **does not delete** the saved image file. The plugin never deletes image files automatically, and images with identical content reuse the existing file.
- Only when the clipboard holds image files and no text is the paste handled as an image; when there is text, the text is pasted as usual.
- The notebook must be saved: when it is not, the notice "Save the notebook before pasting images" is shown; relative-path images in an unsaved notebook show "Save the notebook to show images".
- The drop target is the whole Markdown block, and preview mode works too: there is no cursor then, so the image link is appended to the end of the content as a new paragraph (with a blank line before it when the content is not empty), the block stays in preview mode and the action can be undone in one step; saving, count and size limits and notices are the same as in edit mode. In edit mode, a drop onto the editing box inserts at the drop point, and a drop onto another area of the block inserts at the current cursor. While dragging, the block shows a dashed outline that disappears when the drag leaves; drags that contain no files, such as text or links, are unaffected. Dropping non-image files such as PDF or TXT saves nothing and does not make the page navigate to that file. When the content is only whitespace, the image link replaces that whitespace.
- **Desktop drop**: DBX desktop receives files dragged from Finder/Explorer through the host's `fileTransfer.onDrop` (the `capabilities.fileTransfer.drop` capability is detected at runtime; when the host does not support it or lacks the capability, it silently falls back to the web drop described above). System drops have no drop-point coordinates, so the block is chosen with the following priority: ① the block being edited (the image is inserted at the cursor); ② the most recently hovered or focused block (appended to the end; with several blocks the notice "Added to the most recently used Markdown block (undoable)" is shown); ③ the only Markdown block in the notebook; ④ if none of these applies, nothing is changed and the notice "Click the Markdown block to insert images into first" is shown (the floating bar during the drag shows the same message). During the drag, candidate blocks show a dashed outline. Light notices of this kind disappear automatically after 3 seconds; notices tied to an insertion (such as "undoable") disappear immediately on undo, redo or when the document is changed by another action; error notices (such as "Save the notebook first") stay for 8 seconds. Unsupported files are ignored with the notice "N non-image file(s) ignored"; when a folder holds too many files only the first part is processed, files that fail to read also count as ignored, and the rest are inserted as usual in one step; the web event and the host event of the same drop are handled only once. The limits are the same as for pasting: 10 MiB per file, at most 10 images per action, PNG/JPEG/GIF/WebP only; folders do not keep their structure.
- When unsupported files are dropped, the notice "N file(s) are not supported images (PNG, JPEG, GIF or WebP only) and were ignored" is shown and no file is saved.

**Save as**: when you "Save as" to another location, the plugin copies the images referenced in the blocks to the new location and rewrites the links; the original files are left untouched. At most 500 files and 200 MiB in total are copied per action; images that fail to copy produce the notice "N image(s) could not be copied to the new location" followed by the first 3 file names (file names only; ending with "…" when there are more than 3). Only links that actually render as images are processed: `![](…)` inside inline code, fenced code blocks and indented code blocks is neither copied nor rewritten. The inline form `![caption](path)` and reference-style image links (full `![alt][ref]`, collapsed `![ref][]`, shortcut `![ref]`) are all rewritten; for the reference style, the `[ref]: path` definition line is what is rewritten, and only definitions that are referenced by images. Links whose alt text spans several lines are not processed.

**Moving or renaming**: if you move or rename the notebook file outside the plugin (for example in Finder) without moving the images along with it, the relative links break and show "Image not found"; moving the file back restores them.

**Placeholders and notices**: when an image cannot be displayed, the preview shows the alt text and the reason, and screen readers read out "alt text: reason". The reasons are:

| Notice | Meaning |
| --- | --- |
| Image not found | The file does not exist |
| Unsupported image | The format is not PNG, JPEG, GIF or WebP |
| Image too large | Over the display limit |
| Invalid image path | The path does not meet the restrictions above |
| Cannot display this image | Decoding or reading failed |
| Save the notebook to show images | The notebook has not been saved yet |
| Loading image | Being read |

**Export**: HTML and PDF export embed the images as data and make no external requests. All images together are limited to 50 MiB; images that exceed the limit, cannot be read, or belong to an unsaved notebook are replaced with their alt text, and the number is counted in the exported info block ("N image(s) not embedded").

**Refresh**: the plugin does not watch the disk, and images that have been displayed are cached, so an image modified on disk while the same notebook stays open is not refreshed automatically. Reopening a notebook at the same path clears the image cache (images that changed on disk are read again), and "Save as" to a new path also resets it; after pasting a new image only the corresponding file is refreshed; an image whose read failed can be retried after 3 seconds.

## Input variable

- Fields: variable name (`variable`), input type (`inputType`: text, number, date, boolean, dropdown), value (`value`), dropdown options (`options`, one per line), multiple selection (`multiple`).
- The variable name box has a visible "Variable name" label, next to a bordered `{{ name }}` reference marker; when the variable name is empty the hint "Enter a variable name first" is shown.
- Variable names must match `[A-Za-z_][A-Za-z0-9_]*` and be at most 63 characters; a name shared with another input block is flagged, and running a SQL block that references it fails with "multiple input blocks".
- Options are one per line; only lines that round-trip exactly are treated as numbers (`007`, `1.0` and `1e3` stay text), lines that are exactly `true`/`false` are booleans; duplicates are ignored; quotes are not supported.
- When the input type is switched, the value is kept as far as possible (text and number, and text and date, can be converted into each other); otherwise it is cleared.
- The "Copy variable name" button copies `{{ name }}`.
- Reference it in SQL as `{{ name }}`. Before running, it is rendered as a literal for the connection's database type (text is quoted and escaped, numbers, dates and booleans are rendered per dialect, and multiple selection is rendered as `('a', 'b')`, to be used with `IN {{ v }}`). Running is refused, with the reason, when the variable is undefined, has no value set (including text `''`), the value cannot be rendered safely, or the reference appears inside a string, identifier or comment. A multiple selection with nothing selected is also refused.
- Date parameters are compared as ISO text in local SQL; see [Known limits](known-limits.md).
- Export: by default a small gray line `name: value` is output at the original position (an unset value shows "(not set)"); "Include input parameters" can be turned off in the export dialog.

<p align="center"><img src="images/block-input.png" alt="Input variable blocks: date and dropdown" width="760"><br><sub>A date input and a dropdown input.</sub></p>

## SQL (database query)

- Fields: SQL text, result name (`resultName`), connection (`connection`), database (`database`), schema (`schema`).
- Run: `Ctrl/⌘+Enter` (inside the editor) or the "Run" button. Only a single read-only statement is allowed; when the connection is missing, not connected or the plugin is not authorized, the run button is disabled and gives the reason.
- Connection selection: the dropdown lists "Connected" connections first, then "Not connected" ones (gray, not selectable); connections that the notebook references but that do not exist in DBX are placed in a final "Not found in DBX" group with a warning. When database and schema are left empty they inherit the notebook defaults, and the dropdown lists can be refreshed; dialects without schemas do not show the schema field.
- Result name: matches `[A-Za-z_][A-Za-z0-9_]*` (at most 63); unique within the notebook, case-insensitively; cannot start with `sqlite_`; a name equal to an SQLite reserved word must be double-quoted when referenced in local SQL (the UI hints at this). Only blocks with a result name can be referenced by later blocks.
- Result table:
  - Virtual scrolling; click a header to sort (ascending, descending, off).
  - Cell selection: click, extend with `Shift+click` or `Shift+arrow keys`, click a row number/header to select a whole row/column, `Ctrl/⌘+A` selects all, `Esc` clears the selection; `Ctrl/⌘+C` copies as TSV, `Shift+Ctrl/⌘+C` copies with the header; the context menu has "Copy" and "Copy with header"; the space key shows the full content of the selected cell.
  - Over-long or JSON cells are shown truncated, while copying still gives the full content; NULL is shown as a gray `NULL`.
  - "Transpose" is available when the result has 1–20 rows; the choice is stored in the block's `metadata.clients.dbx.transposed`.
  - The "Visualize" button creates a chart block for the current result; a result without a name is named automatically.
- Row count: the maximum number of rows fetched and stored per block is set by "Max rows per block" on the start page (1–5000, default 5000, applied to all notebooks). When exceeded, the result is marked as truncated and blocks that depend on it show "Based on partial data".
- Stale marker: when the SQL, parameters, block type or an upstream result no longer match the stored result, the result shows "Stale" with the reason; stale results are kept. Re-running an upstream block does not refresh downstream blocks automatically.
- Errors: the error text returned by the database or DBX is shown; if the error relates to a missing object, a hint suggests checking the database and schema selection.
- Export: the result table is output according to the export dialog settings (see [Export](#export)). The SQL can optionally be output above the table; in PDF and HTML the SQL is syntax-highlighted (light print colors; colors are kept when printing, and copied text matches the original SQL; blocks over 200,000 characters or 5000 rows are not highlighted).

<p align="center"><img src="images/block-sql.png" alt="SQL block and result table" width="760"><br><sub>A SQL block: editor, run state and result table.</sub></p>

## Local SQL (SQL over local results)

- In the "Block type" dropdown it is "Local result SQL" (`metadata.source: "results"`), and the toolbar's `+ Local SQL` creates this kind of block directly.
- It runs on the plugin's built-in SQLite engine against the results of earlier blocks. A table name is the result name of an earlier block; referenced results are shown with a "Referenced results" label that you can click to jump to them, with a warning when a result is missing or not yet run; a block cannot reference itself or a later block, and duplicate result names cause an error.
- Only a single read-only `SELECT` / `VALUES` (optionally with CTEs) is allowed. `EXPLAIN`, `PRAGMA`, DDL, DML and multiple statements are rejected.
- Engine limits: the number of result rows is capped by the rows-per-block setting; query timeout is 30 seconds; at most 500,000 rows can be registered per session; the total bytes of returned results are capped (64 MiB, truncated beyond that).
- Dialect differences: `::` casts, `ILIKE`, `DISTINCT ON`, `WITHIN GROUP`, `FILTER` clauses (flagged in local blocks) and similar constructs are not supported, and when a run fails the UI suggests rewrites. For the full matrix, see section 4.3 of [spec/sqlnb-v1.md](../spec/sqlnb-v1.md).
- Date comparison: date parameters are compared as ISO text; to include the current day, use `date(column) <= {{name}}` or `column < next day`, and the editor shows a hint when it detects such a pattern.
- The result of a local SQL block can be used by chart and big-number blocks.

<p align="center"><img src="images/block-local-sql.png" alt="Local SQL block" width="760"><br><sub>A local SQL block: further aggregating the named result `sales`.</sub></p>

## Chart (pivot)

### Data source and view

- "Data source" selects an existing SQL block that has a result name (database or local SQL both work); when the source block has not run, "Run the source block first" is shown. After the source block runs again, the chart block shows "Stale", and clicking "Refresh" recalculates it.
- "View": table, chart, side by side.
- When the selected fields cannot be found in the source, the configuration is kept with a notice, and you can fix it inside the block.

### Rows, columns, values

- Up to 4 rows (the file allows up to 6, but the UI stops adding at 4), up to 3 columns and up to 8 values. Each field has move up, move down and remove.
- Date-type row/column fields can use a time granularity: raw, day, week, month, quarter, year. Weeks start on Monday.
- Value aggregation: sum, count, distinct count, average, min, max, median; "(rows)" counts records. A value can have a format (as is, thousands separator, percentage) and decimals (0–6). Some aggregations are not available for non-numeric columns.
- Field names are at most 256 characters.

### Summaries

- "Row summary" adds a column on the right, "Column summary" adds a row at the bottom, and "Grand summary" adds one cell at the bottom right (this needs both row and column fields).
- Summaries are computed from the cells shown in the table, not re-aggregated from the raw records; empty cells are ignored.
- Each value has its own summary method: sum, count, average, min, max, median, skip. The default follows the value's aggregation (sum/count/distinct count → sum). Double-click a summary cell, or focus it and press `Enter`/`F2`, to change it; the change applies to all summaries of that value.
- Copied TSV contains numbers only.

### Sorting

- Click a row-header cell to sort by name, and click a value column header to sort by value; each click cycles between ascending, descending and off.
- When sorting by value, a row group with only one cell is sorted by that cell; otherwise it is sorted by the result of the value's summary method over all cells of the row group (count uses sum). Row groups with no value come last in both directions, and equal scores keep the keys in ascending order.

### Chart options

- Chart types: line, area, bar (vertical), bar (horizontal), scatter, pie, donut, histogram.
- Stacking (bar/area charts, needs a "Columns" field or multiple values): overlay, stacked, grouped, percent stacked.
- "Value labels" shows the values on the chart when ticked.
- "Time axis": when the first row field is a time and the chart is a line, area or bar chart, you can choose "Sparse" (true time positions) or "Compact" (only periods that have data, evenly spaced).
- "Title": the chart title, at most 200 characters.
- Hover tooltip (on-screen charts only; exported HTML/PDF/image charts are static and look unchanged): for line and area charts (including multiple series, stacking, a time axis and several row fields), moving the mouse anywhere inside the plot area shows the values of all series at the nearest X: the first line is that X, followed by one line per series sorted by value from largest to smallest; with more than 10 series only the first 10 are listed, followed by "… N more". A faint vertical guide line is drawn at that X, and each series has a highlighted dot there (dots of stacked areas sit on the cumulative value). Points with a null value do not trigger the tooltip, and an X with no valid value is skipped. For scatter charts, the hit area is enlarged to about 16 px in diameter, so you do not need to aim precisely at a small dot. Hover behavior for bar, pie, donut and histogram charts is unchanged. The values in the tooltip match the text shown on the chart (units, scaling, thousands separators and so on).
- Pie and donut charts use only the first row field and the first value; a histogram bins the raw records directly, without pivot aggregation.
- When the number of grouped points in a chart exceeds 5000, "Too many points — reduce grouping" is shown; a pivot table shows at most 5000 rows and 500 columns and notes truncation beyond that.
- Legacy charts that have only `data` and `spec` and no pivot configuration are displayed read-only and are not modified on save.

<p align="center"><img src="images/block-chart.png" alt="Chart block: pivot table and stacked bar chart side by side" width="760"><br><sub>The "side by side" view of a chart block.</sub></p>

### Advanced settings dialog

Open it with "Advanced" in the configuration area (modal; focus is trapped inside the dialog and `Tab` cycles within it; `Esc` first restores an input that is being edited and not yet committed, and then closes the dialog; `Esc` during IME composition is ignored). Each commit (change, blur or `Enter`, not every keystroke) takes effect immediately and is one undo step; undo/redo also works while the dialog is open. Leaving a field empty means automatic (the corresponding key is deleted), and customized items show a "customised" marker.

There are four tabs (switch with the arrow keys, `Home`, `End`):

| Tab | What can be set |
| --- | --- |
| Table | Row field names, column field names, metric names, summary text |
| Chart | Chart title, X axis title, Y axis title, legend title |
| Numbers | Unit for each value (at most 20 characters), scale (divide by; greater than 0 and at most 1e12) |
| Categories | Display name for each category value of the row/column fields, including the display text for empty values (NULL) |

- Each tab shows the number of customized items and a "This page affects: …" hint; "Reset this page to auto (n)" resets only the current page and "Reset all to auto (n)" resets everything, both as one undo step, without confirmation.
- Items are numbered as `n title · field`, and the preview on the right side of the dialog marks the matching positions with small badges (the preview is hidden when the dialog container is below about 640 px wide). The table sketch in the preview draws at most 2 row fields and 2 column fields, with at most 3 sample category values per field, and the chart sketch draws at most 2 groups (3 when there are several column groups).
- When there are more than 50 category values, a search box appears (case-insensitive, matches the original value or the display name, at most 200 matches shown).
- Text is at most 200 characters and mappings at most 200 entries; invalid values are discarded with a notice.
- Display order for numbers: divide by scale (percentage: multiply by 100, scale ignored) → round → thousands separator → `%` → unit. Scale, unit and category mappings affect display only: sorting, summaries, copied numbers and the portable chart `spec` still use the original values and field names; the header of the copied TSV uses the custom names. Mappings do not merge rows; when two original values are displayed as the same text, the chart shows them as `display name (original value)`.
- Changing a row/column field discards that field's customizations; changing only the time granularity keeps names and the empty-value text and discards the category mappings.
- Another way in: the small edit button next to a header or a chart title/axis text opens a non-modal popover (input, reset to auto, done); on a focused header or row header, `F2`, `Shift+F10` or the menu key also open it. `Enter` commits and `Esc` cancels. The dialog and the popover are never open at the same time.
- Export always uses the custom names, units, scale and mappings; there is no switch.

<p align="center"><img src="images/dialog-advanced-settings.png" alt="Advanced settings dialog" width="760"><br><sub>The "Advanced settings" dialog.</sub></p>

### Undo

Changes to rows, columns, values, summaries, sorting, view, chart options and labels are each one undo step; a change that makes no actual difference is not written and does not mark the notebook as modified.

### Export

The table (pivot table, with summaries) and/or the chart is output according to the view; when chart generation fails, a text placeholder is output and a warning appears in the export result. The chart title is output once as a heading above the table.

## Big number

### Metrics

- One data source per block (an existing SQL block with a result name), with up to 8 metrics shown side by side; "+ Add metric" adds one, and each metric can be moved up, moved down or removed.
- Each metric: field ("(rows)" counts records), aggregate, label, format (plain, thousands separator, percentage), decimals.
- Aggregates: sum, average (mean), min, max, count, median, first row, last row, distinct count. `average` is an alias of `mean`, kept only for existing files: it appears in the dropdown only for metrics that already use it. Sum, average and median require a numeric field (not selectable for non-numeric columns); min and max are not selectable for boolean columns; distinct count works on any column type but is not selectable on the "(rows)" field; first row/last row follow the row order of the source result.
- A label is shown on at most 2 lines on the card, with the full text in a tooltip; cards in the same row have equal height.

<p align="center"><img src="images/block-big-number.png" alt="Three metric cards of a big-number block" width="760"><br><sub>A big-number block: three metric cards.</sub></p>

### Filters

- Each metric has at most 5 conditions, combined with "and" and applied before aggregation.
- Operators: equals, not equals, greater than, greater than or equal, less than, less than or equal, in, not in (up to 50 values, separated by commas), contains, is empty, is not empty.
- Numeric columns use numbers, text and date columns use strings (write dates as `YYYY-MM-DD…`), and boolean columns use `true`/`false`. Text values are trimmed of leading and trailing whitespace, and an empty string is not a valid value (use "is empty" to match empty cells). "Contains" is case-insensitive for ASCII letters only.
- A newly added condition is not written to the notebook until its input is valid, and shows "Not saved yet".

### Comparison (period over period / year over year)

- Choose the comparison type (period over period, year over year) and the date field (only date columns can be chosen; when there is no date column it is disabled with a notice).
- The current period is the calendar month of the latest date among the **filtered** rows; period over period compares with the previous calendar month, year over year with the same month of the previous year; each period is calculated separately with the metric's aggregate and filters. The card shows `▲/▼ x% vs YYYY-MM (period over period)`, and the change rate is (current − previous) / |previous|.
- When the current month has not ended, it is compared with the full data of the previous month, with no proration.
- The month of a row is taken from the first 7 characters of its date text, with no time-zone conversion; numbers, unparseable text and NULL are treated as having no date.
- When there is no usable date, the plain value is shown with a notice; when the date field does not exist, is not a date column or its type is unknown, only that metric shows an error; when the previous period is empty or 0, the change rate shows `—`.

### Other

- "Ask AI" generates candidate metrics from a description; see [AI features](ai.md).
- Undo: manual changes to metrics and changes applied by AI can both be undone; see [Common actions](#common-actions).
- Export: each metric is output as a card, including the comparison line; card labels are also limited to 2 lines.

## Export

"Export" on the toolbar outputs the most recent run results of the current notebook as a read-only report, without re-running any SQL; charts and big numbers are recalculated locally from the stored results.

- Formats: PDF (needs Chrome, Edge or Chromium on the machine, found automatically, or specified under "Export: browser path (manual)" in the start page "Settings" (collapsed by default, click to expand): type the path directly, or use "Choose file…" to pick the browser executable, or "Choose folder…" to pick the folder containing the browser or a macOS `.app` bundle, from which the plugin resolves the executable automatically; leave empty to auto-detect) or HTML (a single self-contained file, with no scripts and no external requests). When no browser is found, the PDF option is disabled with a hint that you can export HTML and print it from a browser.
- File name: each time the dialog suggests `<notebook file name>-<yyyyMMdd-HHmmss>.<extension>` and remembers only the folder; the HTML title and PDF document title are the exported file name, and the notebook title is not printed.
- "General" tab: format; query information (include SQL, include input parameters); header information (exported by, export time, data source names, data run time); result table rows (all or the first N, with "Showing the first N rows of M" noted when truncated); layout (portrait/landscape); number of leading columns repeated on each page (0–5, default 0); a note at the end of the report.
- "Blocks" tab: whether each block is included, and whether each SQL result table is transposed (follow current, on, off); a table can have its column-page break positions set manually or be divided evenly by number of pages.
- Info block at the end: exported by, export time, data source names, data run time of each block (numbered in block order), and the note (last). In PDF the info block is never split across pages. "Exported by" is the operating system user name; it is read by the backend from environment variables when the dialog is open and the toggle is on, is written only into the exported file, and the item is hidden when it cannot be read.
- Result tables: widths are estimated from the content, and numeric columns do not wrap; text columns do not wrap when their longest cell or header is at most 24 width units (a Chinese character counts as 2, other characters as 1) and wrap when longer; when the total width of non-wrapping columns exceeds 100 units, the widest text column is switched to wrapping; the table is scaled to the page width or split into column pages, and every column page repeats the sequence-number column. The PDF footer shows page numbers.
- Blocks without run results are skipped (the dialog lists them beforehand); export is not possible while any block is still running. Stale results can still be exported, and the file carries no stale marker. The exported file contains no connection list, host, account or AI conversation content.
- Export settings are stored in `host.storage` and are not written into the notebook.
- After the export completes, the notice box has "OK" and "Open" buttons; the default focus and Enter are on "OK", and Esc closes it; "Open" opens the file just exported with the system default program (HTML in the default browser, PDF in the default PDF reader) and closes the box. When opening fails, one line of error is shown inside the box and the box does not close. The backend only opens `.html` / `.pdf` files that the plugin has just exported during the current run (the most recent 20), and never any other path. Files exported to a network location (UNC path) cannot be opened with "Open"; the notice asks you to open them in a file manager.

<p align="center"><img src="images/dialog-export.png" alt="Export dialog" width="760"><br><sub>The "General" tab of the export dialog: format, content, result table rows, layout and save location.</sub></p>

<p align="center"><img src="images/start-page-settings.png" alt="Start page with Settings expanded: max rows per block and browser path (with Choose file… and Choose folder… buttons)" width="640"><br><sub>The start page with "Settings" expanded; the browser path in the example is fictional.</sub></p>

## Saving results

"Save results" on the toolbar decides where run results are stored:

- Sidecar file `.sqlnb.out` (default): results are written to `<name>.sqlnb.out` next to the notebook, so running does not change the main file.
- In notebook (inline): written into each block's `outputs` field, so the file changes when you run.
- Do not save: results are not saved; when you switch to this option from another one and results already exist, you are asked to confirm first, and the existing `.sqlnb.out` is deleted.

A change takes effect on the next save. When saving, the main file is written first and then the results file; a failure to write the results file does not make the main file save fail, and the notice "Results not saved" is shown. Chart and big-number blocks do not store results and are recalculated from the source results after the notebook is opened. Saving uses a temporary file plus rename, and checks before writing whether the file was modified externally; if it was, you choose between overwriting and reloading.

## Notebook, tab title and connections

### Notebook title

A notebook has no overall title: the UI neither shows nor edits one, and export does not print one. When you need a title, put a Markdown block at the top. The format has no notebook title field; a `title` in the `metadata` of an old file is just an unknown key that is not read or shown, is preserved as-is on save like other unknown keys, and is not written by new notebooks.

### Tab title

When the host supports it (capability `workbenchTitle`; floating windows and sidebar windows do not), the DBX tab title follows the current notebook: the file name without the `.sqlnb` extension, `● name` when there are unsaved changes, and "Untitled notebook" for a notebook that has no file yet. It is updated on open, save, save as and rename (throttled), and DBX's default title is restored when the notebook is closed. When the host does not support it, nothing is sent and the UI is unchanged. The title does not contain connection information.

### Connections

The connection picker and the "missing connection" check use the host's connection list (`host.getConnections`, permission `host.connections:read`, capability `connectionsApi`).

- The host returns only a summary without secrets: ID, name, dialect, whether connected, whether read-only and (optionally) the database; there are no passwords, hosts or connection strings.
- The list is kept in memory only and refreshed when the window gains focus (at most about once per second) and when you click "↻"; it is never written to the notebook, plugin storage, AI conversation history or caches, is not sent to AI and does not enter exports. The notebook stores only the connection **name**.
- When a notebook references a connection name that is not in the host's list, a notice is shown at the top of the notebook, the related SQL blocks show a warning, and the run button is disabled with the reason; the file is not modified and not marked as modified. Adding a connection with the same name in DBX and refreshing restores it. When the list is unavailable (permission denied, an older host or a host error), the picker explains this, no "missing" notice is shown, and the notebook runs as usual.
- The connection context menu has only "New SQL notebook". The plugin has no connection registry of its own; a `connections.json` in the plugin data directory of older versions (or `connections.v1` in storage) is ignored and can be deleted manually.

### Permissions

| Permission | Purpose |
| --- | --- |
| `host.data:read` | Run read-only queries on connections (including database/schema lists and AI catalog queries) |
| `host.schema:read` | Read table-structure metadata (column-name completion in the editor, and table-structure context for AI) |
| `host.ai` | Call the model configured in DBX to generate text |
| `host.storage` | Store settings, export options and the AI conversation cache |
| `host.workbench` | Set the tab title |
| `host.connections:read` | Read connection summary information (required) |

`engines.dbx` is `>=0.6.48`; lower versions do not recognize `host.connections:read` and reject the manifest. When upgrading from an older version, the install/upgrade dialog shows the newly added permissions. Reading and writing notebook files, the file picker dialogs and PDF generation are done by the plugin's own backend process.
