use crate::job::{ALIVE_MARKER, Orientation, PdfRequest, Renderer};
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::page::PrintToPdfParams;
use futures::StreamExt;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

const FOOTER: &str = r#"<div style="width:100%;text-align:center;font-size:8px;color:#666;font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC','Source Han Sans SC','WenQuanYi Micro Hei',sans-serif;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>"#;
const HEADER: &str = "<div></div>";

/// Drives a local Chrome/Edge/Chromium through chromiumoxide (carbonpdf 0.2.0 cannot do
/// landscape or `prefer_css_page_size`, and starts a headed browser by default).
pub struct ChromeRenderer;

fn needs_no_sandbox() -> bool {
    cfg!(target_os = "linux") && (Path::new("/.dockerenv").exists() || std::env::var("USER").map(|u| u == "root").unwrap_or(false))
}

impl Renderer for ChromeRenderer {
    fn render(&self, req: &PdfRequest, profile: &Path, pid: &AtomicU32) -> Result<Vec<u8>, String> {
        let alive = || profile.join(ALIVE_MARKER).exists();
        if !alive() {
            return Err("job was cancelled".into());
        }
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        rt.block_on(async {
            let mut b = BrowserConfig::builder()
                .chrome_executable(&req.browser)
                .user_data_dir(profile)
                .new_headless_mode()
                .launch_timeout(Duration::from_secs(30))
                .arg("--disable-gpu")
                .arg("--no-first-run")
                .arg("--no-default-browser-check");
            if needs_no_sandbox() {
                b = b.no_sandbox();
            }
            let cfg = b.build().map_err(|e| format!("browser config: {e}"))?;
            let (mut browser, mut handler) = Browser::launch(cfg).await.map_err(|e| format!("Failed to launch browser: {e}"))?;
            if let Some(id) = browser.get_mut_child().and_then(|c| c.as_mut_inner().id()) {
                pid.store(id, Ordering::SeqCst);
                let _ = std::fs::write(profile.join("chrome.pid"), id.to_string());
            }
            if !profile.join(ALIVE_MARKER).exists() {
                let _ = browser.kill().await;
                crate::kill_process_tree(0, Some(profile));
                return Err("job was cancelled".into());
            }
            let pump = tokio::spawn(async move { while handler.next().await.is_some() {} });
            let result = async {
                let page = browser.new_page("about:blank").await.map_err(|e| e.to_string())?;
                page.set_content(&req.html).await.map_err(|e| e.to_string())?;
                let params = PrintToPdfParams::builder()
                    .landscape(req.orientation == Orientation::Landscape)
                    .print_background(true)
                    .display_header_footer(true)
                    .header_template(HEADER)
                    .footer_template(FOOTER)
                    .paper_width(8.27)
                    .paper_height(11.69)
                    .margin_top(0.5)
                    .margin_bottom(0.6)
                    .margin_left(0.4)
                    .margin_right(0.4)
                    .build();
                page.pdf(params).await.map_err(|e| e.to_string())
            }
            .await;
            let _ = browser.close().await;
            let _ = browser.wait().await;
            pump.abort();
            result
        })
    }
}
