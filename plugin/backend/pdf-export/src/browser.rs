use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserStatus {
    pub found: bool,
    pub path: Option<PathBuf>,
    pub source: &'static str,
    pub reason: Option<String>,
    /// Machine-readable failure kind (`notFound` / `notExecutable`); None when found.
    pub code: Option<&'static str>,
}

fn candidates() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = vec![];
    if cfg!(target_os = "macos") {
        for p in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ] {
            v.push(p.into());
        }
    } else if cfg!(windows) {
        for p in [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ] {
            v.push(p.into());
        }
    } else {
        for dir in ["/usr/bin", "/usr/local/bin", "/snap/bin", "/opt/google/chrome", "/opt/chromium.org/chromium"] {
            for n in ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "chrome"] {
                v.push(Path::new(dir).join(n));
            }
        }
    }
    v
}

const KNOWN_NAMES: [&str; 10] = [
    "chrome.exe", "msedge.exe", "chrome", "chromium", "google-chrome-stable", "google-chrome", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "msedge",
];

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(true)
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        true
    }
}

/// Resolves a directory the user picked to the browser executable inside it: a macOS `.app` bundle
/// (`Contents/MacOS/<name>`) or an install folder holding a well-known browser binary.
pub fn resolve_browser_dir(dir: &Path) -> Option<PathBuf> {
    let macos = dir.join("Contents").join("MacOS");
    if macos.is_dir() {
        let stem = dir.file_stem().map(|s| s.to_os_string());
        if let Some(s) = stem {
            let same = macos.join(&s);
            if same.is_file() && is_executable(&same) {
                return Some(same);
            }
        }
        let mut files: Vec<PathBuf> = std::fs::read_dir(&macos).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_file() && is_executable(p)).collect();
        files.sort();
        return if files.len() == 1 { files.pop() } else { None };
    }
    KNOWN_NAMES.iter().map(|n| dir.join(n)).find(|p| p.is_file() && is_executable(p))
}

/// Native picker for the manual browser setting. `kind` is `file` or `dir`; an `.app` bundle or install
/// folder is resolved to its executable, anything unresolvable is returned as-is so validation can explain it.
pub fn pick_browser(dialogs: &dyn notebook_files::dialogs::Dialogs, kind: &str) -> notebook_files::error::Result<Option<PathBuf>> {
    use notebook_files::error::{NbError, BAD_PARAMS};
    let picked = match kind {
        "file" => dialogs.pick_file()?,
        "dir" => dialogs.pick_folder(None)?,
        o => return Err(NbError::new(BAD_PARAMS, format!("Bad kind: {o}"))),
    };
    Ok(picked.map(|p| {
        let s = p.to_string_lossy();
        let trimmed = s.trim_end_matches(|c| c == '/' || c == '\\');
        let b = trimmed.as_bytes();
        let bare_drive = b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
        let p = if trimmed.is_empty() || bare_drive { p.clone() } else { PathBuf::from(trimmed) };
        if p.is_dir() { resolve_browser_dir(&p).unwrap_or(p) } else { p }
    }))
}

pub fn find_browser(manual: Option<&str>, env: &dyn Fn(&str) -> Option<String>, exists: &dyn Fn(&Path) -> bool) -> BrowserStatus {
    let miss = |source, reason: String, code| BrowserStatus { found: false, path: None, source, reason: Some(reason), code: Some(code) };
    let hit = |source, p: PathBuf| BrowserStatus { found: true, path: Some(p), source, reason: None, code: None };
    if let Some(m) = manual.map(str::trim).filter(|m| !m.is_empty()) {
        let mut p = PathBuf::from(m);
        if p.is_dir() {
            match resolve_browser_dir(&p) {
                Some(r) => p = r,
                None => return miss("manual", format!("No browser executable found in folder: {m}"), "notFound"),
            }
        }
        if !exists(&p) {
            return miss("manual", format!("Browser path does not exist: {m}"), "notFound");
        }
        if p.is_file() && !is_executable(&p) {
            return miss("manual", format!("Browser file is not executable: {m}"), "notExecutable");
        }
        return hit("manual", p);
    }
    if let Some(c) = env("CHROME").filter(|c| !c.is_empty()) {
        let p = PathBuf::from(c);
        if exists(&p) {
            return hit("env", p);
        }
    }
    for p in candidates() {
        if exists(&p) {
            return hit("auto", p);
        }
    }
    miss("none", "No Chrome, Edge or Chromium found".into(), "notFound")
}
