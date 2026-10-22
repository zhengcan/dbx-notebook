# Spike 02 — pdf_oxide PDF generation

**Conclusion: PASS** — pdf_oxide 0.3.78 can generate the required PDF; plan 5 may include PDF export (with the caveats below).

Code: `spikes/pdf-oxide/` (standalone Cargo binary, `cargo run --release`, writes `out/spike.pdf`, gitignored).

## Results per criterion
| Criterion | Result |
|---|---|
| Chinese title/paragraph renders correctly | PASS. Embedded as Type0/Identity-H CID TrueType subset (verified with `pdffonts`; `pdftotext` extracts the text). |
| 60 x 6 table spans pages | PASS. Auto-paginates across 3 pages (rows 1-15 on page 1 below the chart, 16-57 on page 2, the rest on page 3); header repeats on every page with `repeat_header(true)`. |
| PNG chart embedded clearly | PASS. 600x300 RGB PNG (generated with the `png` crate) placed via `image_from_bytes`; crisp in the rasterised page. |
| Monospace SQL readable | PASS. `code_block("sql", ...)` uses base-14 Courier 9pt on a grey box; readable. No syntax highlighting; Courier is non-embedded and Latin-only, so CJK in SQL comments/strings would need an embedded mono CJK font. |

## Sizes
- Output PDF: 121,470 bytes (whole CJK font file subset-embedded; ~94 KB when the header alias was not registered).
- Release binary: 3,828,112 bytes vs 435,552 for an empty hello-world, a delta of about 3.4 MB (default features, no strip/LTO tuning). First clean build took about 70 s.

## API summary
- `DocumentBuilder::new().register_embedded_font(name, EmbeddedFont::from_file(path)?)`, then `doc.a4_page().font(name, size).at(x, y).text(..)` ... `.done()`, `doc.build()` -> `Vec<u8>` (or `.save(path)`).
- It uses an absolute-position cursor model (`at(x, y)`, PDF origin bottom-left). `text`, `heading`, `paragraph`, `code_block`, `image_from_bytes(bytes, Rect)`, `table(Table)` and `streaming_table(config)` are available. Rect is `pdf_oxide::geometry::Rect::new(x, y, w, h)`.
- `streaming_table(StreamingTableConfig::new().repeat_header(true).column(StreamingColumn::new("h").width_pt(50.0)))`, then `push_row(|r| { r.cell(..)... })`, then `finish()` returns the page builder. It auto-paginates and repeats the header.
- Other features present: bookmarks, links, annotations, forms, barcodes, watermark.

## Caveats / findings
1. **Streaming-table header uses `<font>-Bold`**, which is not registered by default, so CJK headers render as `??`. Workaround: register the same font file a second time as `"<name>-Bold"`. This doubles the embedded font data. A real bold CJK face would be better.
2. Header text sits slightly high relative to its grey fill box (cosmetic).
3. The cursor does not flow automatically between text/image/table. Callers must compute y positions (we hard-coded them); only the table paginates itself. Plan 5 needs its own small layout layer for mixed content (e.g. heights from `remaining_space()`/`measure()`).
4. Font handling: `EmbeddedFont::from_file` accepted `Arial Unicode.ttf` (TTF). `.ttc` collections (Songti, PingFang, Hiragino) were not tried. The embedded font is not subset by name (shows as `Unknown`) but glyphs are subset.
5. **Font licensing**: no font file is committed. The spike loads `/Library/Fonts/Arial Unicode.ttf` at runtime. Apple/Microsoft system fonts must not be redistributed or necessarily embedded into user-shared PDFs; for the product, ship Noto Sans SC (SIL OFL 1.1, embedding and redistribution allowed, ~10 MB full / subset recommended) or let the user pick a font path. Plan 5 should bundle a Noto Sans SC subset or download it on demand.
6. The crate pulls in many deps (image, office_oxide, qcms, etc.) under default features; trimming features (`default-features = false`) is worth trying for size.
