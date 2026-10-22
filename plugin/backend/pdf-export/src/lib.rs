mod browser;
mod chrome;
mod job;
mod profile;

pub use browser::{find_browser, pick_browser, resolve_browser_dir, BrowserStatus};
pub use chrome::ChromeRenderer;
pub use job::{ALIVE_MARKER, JobState, Orientation, PdfJobs, PdfRequest, Renderer};
pub use profile::{cmd_has_profile, kill_process_tree, kill_tree, sweep_stale_profiles, Procs, SysProcs, write_atomic, write_export, PROFILE_PREFIX};
pub use notebook_files::error::TARGET_EXISTS;

/// RPC error code (rendered as `[-32020] ...` for the UI) when no usable browser exists.
pub const BROWSER_MISSING: i32 = -32020;
/// Job-level codes reported in `export/pdfStatus`.
pub const EXPORT_FAILED: &str = "EXPORT_FAILED";
pub const EXPORT_TIMEOUT: &str = "EXPORT_TIMEOUT";
pub const CANCELLED: &str = "CANCELLED";
/// Job-level code when the target appeared (or existed) and overwrite was not requested.
pub const TARGET_EXISTS_CODE: &str = "TARGET_EXISTS";
