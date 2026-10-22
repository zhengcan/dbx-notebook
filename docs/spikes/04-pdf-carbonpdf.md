# Spike 04 — PDF export via carbonpdf (headless Chrome) and typst

Code: `spikes/pdf-carbonpdf/` (carbonpdf bin) and `spikes/pdf-carbonpdf/typst/` (typst bin). Outputs and screenshots are in `spikes/pdf-carbonpdf/out/` (gitignored).
Machine: macOS arm64, 16 cores, Chrome and Edge both installed. Poppler `pdftoppm`/`pdftotext` for checks. **Only macOS arm64 was tested.**

## Verdict

**Use carbonpdf's approach (headless Chromium-family browser) when one is found, as an optional capability. Do not use it as the only path.**
- Quality is a different league from pdf_oxide (see below).
- Sidecar cost is small: about +2 MB.
- Weak point: it needs a Chrome, Edge or Chromium installed on the user's machine. DBX's Tauri webview doesn't help, since Tauri does not ship Chrome.
- Fallback: always offer self-contained HTML export. The HTML uses the same print CSS, so "open it and use Print → Save as PDF" gives the same output, plus a clear message when no browser is found.
- Consider using `chromiumoxide` directly rather than the `carbonpdf` crate (reasons below).
- typst is an attractive no-external-dependency alternative with very good output, but costs about 18–26 MB of binary and a notebook→Typst converter. Keep it as a later upgrade, not for v1.

## Comparison

| Criterion | pdf_oxide (spike 02) | carbonpdf 0.2.0 (Chrome) | typst as library (typst-as-lib 0.17 + typst-pdf 0.15) |
|---|---|---|---|
| Overall quality | Poor: hard-coded coordinates, plain table, header glitches | **Very good**, browser-grade | **Very good**, TeX-like, automatic syntax highlighting |
| CJK text | Works with an embedded font | Good (system PingFang via font stack, Type 3 subset fonts, text selectable) | Good, but the font must be supplied (see below) |
| Table pagination + repeated header | Manual | **Works** (`thead{display:table-header-group}`, rows kept intact; 60 rows → 3 pages) | **Works** (`table.header` repeats automatically) |
| SVG chart | Raster PNG only | **Vector** (0 images in the PDF); the PNG variant is also fine (1440×720 at 288 ppi) | **Vector** (SVG used directly) |
| Code block | Monospace box, clipped | Monospace, rounded box, `break-inside:avoid` | Same, with colours |
| Header/footer with page numbers | Glitchy | **Works** (`<span class=pageNumber/totalPages>`; "第 1 / 3 页") | **Works** (`counter(page)`) |
| Text selectable/searchable | Yes | Yes (`pdftotext` extracts Chinese, SQL and page footers) | Yes |
| PDF size (sample) | n/a | 226 KB (svg), 234 KB (png) | 167 KB |
| Sidecar size delta vs hello-world (macOS arm64, stripped, LTO, panic=abort) | small | **+2.77 MB** (opt 3, 3.07 MB total), **+1.97 MB** with `opt-level="z"` (2.27 MB). Hello-world baseline is 0.30 MB | **+26.0 MB** (26.3 MB total, opt 3), **+17.7 MB** with `z` (17.95 MB). Excludes the CJK font, which was read from disk at run time |
| Crates in tree / clean build | few | 220 crates, 36 s clean release on 16 cores (tokio, chromiumoxide, reqwest+rustls, tokio-tungstenite, hyper) | 384 crates, roughly 2.5–3 min on 16 cores |
| External runtime deps | **Chrome/Chromium/Edge installed** | same | None, but must ship a redistributable CJK font (Noto Sans CJK SC ≈ 8–16 MB per weight; would add to the `.dbxp`) |
| Latency per PDF | n/a | about 1.0 s wall (cold and warm are similar, 0.9–1.15 s; one Chrome launch per call) | about 0.17 s compile for this document |
| Platform risk | low | Windows: Edge is preinstalled, so very likely fine. macOS: only if the user has Chrome/Edge/Chromium, which is common but not guaranteed. Linux: depends on the distro; sandbox issues in containers | Low (pure Rust). Risk is only in fonts |
| Effort | Done, but poor | Low: the notebook already becomes HTML for the HTML export; add a print stylesheet | **High**: a Markdown/table/code/chart → Typst markup converter, escaping, SVG font fix-ups, own table layout |

## What was measured

### carbonpdf quality (macOS, Chrome)
Screenshots in `spikes/pdf-carbonpdf/out/`:
- `s-1.png`, `s-2.png`, `s-3.png`: SVG-chart variant (`svg.pdf`)
- `p-1.png` to `p-3.png`: PNG-chart variant (`png.pdf`)
- `zs-1.png`, `zp-1.png`: 300 dpi crops
- `edge.pdf`: rendered with Edge, 5 s on its first launch

Findings:
- CJK headings and body text render cleanly. Fonts come from the system (PingFang SC, Menlo). They are embedded as Type 3 subsets, which is fine for viewing and text extraction.
- Table header repeats on every page and rows don't split.
- Page header/footer templates work. Note they ignore the page CSS and use their own 8 px default style: the header title falls back to a serif font unless you set `font-family` inside the template, and the `date` span prints a locale-formatted date and time.
- Compared with `spikes/pdf-oxide/out/p-1.png`, the pdf_oxide output has a clipped code block, a plain grid table, no pagination control and a raster chart. carbonpdf is clearly better.
- The font stack must list per-platform CJK fonts. I used `PingFang SC`, `Hiragino Sans GB`, `Microsoft YaHei`, `Noto Sans CJK SC`, `Source Han Sans SC`, `WenQuanYi Micro Hei`. Windows and Linux rendering is **unverified**.

### carbonpdf API and its bugs (read from source, 0.2.0)
- `PdfBuilder::new().html(..).page_size(PageSize::A4).margins(top,right,bottom,left in inches).print_background(true).header(html).footer(html).chrome_path(..).no_sandbox().chrome_args([..]).timeout(secs).build().await -> Vec<u8>`. `header()` and `footer()` also set `display_header_footer`.
- **Bug: `ChromeConfig.headless = true` (the default) calls `BrowserConfig::with_head()`.** That means a visible, headed Chrome window. Confirmed with `ps`: no `--headless` flag is passed, and `HEADFUL=1` in the spike reproduces it. Workaround: `.chrome_args(["--headless=new"])`. This alone makes me distrust the crate's maturity (it is about 800 lines, with a v0.2.0 tag).
- `prefer_css_page_size` is in `PdfConfig` but **not exposed on `PdfBuilder`**. A4 and margins come from the builder, so the CSS `@page` rule isn't honored by default. I rely on the builder's A4 and margins, and the `@page` rule matched. Also `generate_document_outline` and `generate_tagged_pdf` are hard-coded to false (no bookmarks, no tagged PDF).
- A new Chrome is launched per `build()`; there is no browser reuse across PDFs via the builder (`ChromeRenderer` could be reused).
- Honestly, the crate is a thin 800-line wrapper over `chromiumoxide`. `Page::pdf(PrintToPdfParams{..})` is a few lines; using chromiumoxide directly avoids the headless bug and exposes the full options, plus `reqwest`/`tokio-tungstenite`/`handlebars` are pulled in unnecessarily (reqwest is a non-optional dep). That would shrink the dependency tree.

### Finding Chrome (chromiumoxide 0.8)
Search order:
1. env `CHROME`, if the path exists.
2. `which` for `chrome`, `chrome-browser`, `google-chrome-stable`, `chromium`, `chromium-browser`, `msedge`, `microsoft-edge`, `microsoft-edge-stable`.
3. Windows registry.
4. Hard-coded paths:
   - macOS: `/Applications/Google Chrome.app`, `Chromium.app`, `Microsoft Edge.app`.
   - Windows: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` (Edge only in that path; the registry covers Chrome).
   - Linux: `/opt/google/chrome`, `/opt/chromium.org/chromium`.

Notes:
- Edge is accepted with the default detection options. Verified on macOS by running with `CHROME=".../Microsoft Edge"`: same output. Brave is **not** auto-detected but works if `chrome_path` is given.
- There is **no auto-download** in carbonpdf. chromiumoxide has an optional `fetcher` feature, not reachable through carbonpdf. The "Chrome for Testing" download is roughly 150 MB. I did not build the fetcher, and it would conflict with the 'no big downloads' goal anyway.
- Absent Chrome: auto-detect returns `Could not auto detect a chrome executable`. carbonpdf wraps it as `ChromeProcess("Failed to launch Chrome: …")`. With a bad explicit path I measured: `Error: ChromeProcess("Failed to launch Chrome: No such file or directory (os error 2)")`. I could not remove Chrome from this machine to test auto-detect absence, so that message is from source only.
- Up-front detection: `chromiumoxide::detection::default_executable(DetectionOptions{msedge:true, unstable:false})` is public, so the plugin can check at startup (and enable or disable the export-PDF button) without launching anything. Add a user setting for a custom browser path.

### Process behaviour (macOS)
- Latency: 1.14 s (first run), then 0.92–0.98 s warm per PDF; each call starts and stops one Chrome.
- Temp profile: a `TempDir` is created per run and removed on a normal exit (no growth of `.tmp*` directories).
- **Orphans: killing the parent with SIGKILL mid-run leaves Chrome processes alive** (5 Chrome processes remained after killing at 0.3 s, 11 after killing at 0.6 s; I removed them with `pkill -f remote-debugging-port`). Chrome does not exit when the CDP socket drops. A plugin that can be killed by the host (DBX closing it) will leak browsers and temp profiles. Mitigation: run Chrome with a known profile dir under the plugin's data directory, record the PID, and kill stale ones on start. Alternatively, put Chrome in a process group or job object (Windows Job Object with kill-on-close).
- Launching from a detached subprocess works: `start_new_session=True` with stdin null and a minimal env (`PATH=/usr/bin:/bin`), and through `osascript do shell script` with `env -i`. Both produced valid PDFs in about 1 s. This approximates a GUI-spawned child, but I did not test from inside the actual Tauri app. A real signed/notarized app bundle may hit macOS permission prompts that I couldn't reproduce.
- Concurrency: each build launches a separate Chrome with its own temp profile, so parallel exports don't lock each other. I did not test heavy concurrency. A shared fixed `user-data-dir` would collide with Chrome's profile lock (`SingletonLock`).
- Linux sandbox: chromiumoxide adds `--no-sandbox` only when asked (`no_sandbox()`); it is needed in Docker or as root, or on kernels without user namespaces. **Not tested.**

### typst
Built with `typst-as-lib 0.17` + `typst-pdf 0.15`. Output is `spikes/pdf-carbonpdf/out/typst.pdf`, with screenshots `t-1.png` to `t-4.png`.
- Quality is very good, with automatic SQL syntax highlighting, vector SVG, repeated table header and page X / Y footers.
- 4 pages here. That is only because of my naive equal-width columns, which wrap the "备注内容 note N" column; the layout must be tuned. Also `figure(caption:)` duplicated "图 1". Those are my markup choices, not limits of the tool.
- I used macOS STHeiti and Menlo, read from disk at run time. A shipped plugin needs a redistributable CJK font (for example Noto Sans CJK SC, **8–16 MB**), which would be a separate cost on top of the 18–26 MB binary.
- SVG text needs its `font-family` rewritten to a font typst knows (I replaced `sans-serif`). Vega's SVG output would need the same.
- Effort: building a Typst markup string for the content was easy here, since the template is simple. A general notebook converter means Markdown→Typst (Typst's own markup differs from Markdown; escaping `#`, `$`, `*`, `_`, `@`, `<`, backticks, etc.), HTML tables, and arbitrary cell outputs. I estimate several days, versus hours for the HTML route.
- Typst gives no `@page`-like CSS to reuse from the HTML export, so there are two render paths to maintain.

## Unverified
- Windows and Linux: Chrome/Edge discovery, CJK fonts, sandbox, process cleanup (no Job Object test), typst font behaviour.
- Behaviour inside the real DBX Tauri app (macOS TCC prompts, quarantine on downloaded sidecars, Edge/Chrome running with the user's profile open).
- Cold start after a reboot, with Chrome not yet in the disk cache (Edge's first launch took 5 s here, which suggests a cost on first launch).
- Absent-Chrome message from the auto-detection path (read from source only).
- Large notebooks (thousands of rows): the Chrome print time and memory were not measured; `timeout_seconds` defaults to 30.
- Binary sizes of the other platforms (only macOS arm64 measured); expect Windows to be somewhat larger.
- Page-header font and exact Chrome version differences across platforms.

## Recommendation
1. Ship HTML export (self-contained, with print CSS as in `spikes/pdf-carbonpdf/src/main.rs`) as the guaranteed baseline. Its "Save as PDF" print dialog path costs nothing.
2. Add "Export PDF" backed by chromiumoxide (or carbonpdf with the `--headless=new` workaround). Detect a browser first with `detection::default_executable`. If none is found, disable the PDF button and show "Install Chrome/Edge, or export HTML and print it". Use a plugin-owned profile directory and clean orphans on startup. Use `no_sandbox` only on Linux when needed.
3. Drop pdf_oxide.
4. Revisit typst only if "no external browser" becomes a hard requirement, accepting an 18–26 MB sidecar plus a bundled CJK font.

Other candidates, one line each: `wkhtmltopdf` (unmaintained, needs its own binary), WeasyPrint (Python), the system webview's native print (Tauri's `print()` / WebView2 `PrintToPdf` could avoid shipping Chrome, but it lives in the app, not in a sidecar).
