use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::error::Result;

pub trait Dialogs {
    fn pick_open(&self) -> Result<Option<PathBuf>>;
    fn pick_save(&self, suggested_name: &str) -> Result<Option<PathBuf>>;
    /// Save dialog restricted to one extension (`pdf`/`html`); `ext` is already whitelisted.
    fn pick_save_ext(&self, suggested_name: &str, _ext: &str) -> Result<Option<PathBuf>> {
        self.pick_save(suggested_name)
    }
    fn pick_folder(&self, _start: Option<&Path>) -> Result<Option<PathBuf>> {
        Ok(None)
    }
    /// Open dialog for any single file (no type filter), e.g. a browser executable.
    fn pick_file(&self) -> Result<Option<PathBuf>> {
        Ok(None)
    }
}

/// Appends the first of `exts` (e.g. `".pdf"`) unless the name already ends with one, ignoring case.
pub fn ensure_ext(path: PathBuf, exts: &[&str]) -> PathBuf {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
    if exts.iter().any(|e| name.ends_with(&e.to_lowercase())) {
        return path;
    }
    let mut s = path.into_os_string();
    s.push(exts[0]);
    PathBuf::from(s)
}

pub fn sanitize_file_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_control() && !matches!(*c, '"' | '\\' | '/' | ':' | '*' | '?' | '<' | '>' | '|'))
        .collect()
}

pub const EXPORT_EXTS: [&str; 2] = ["pdf", "html"];

pub fn suggested_with_ext(name: &str, ext: &str) -> String {
    let n = sanitize_file_name(name);
    if n.to_lowercase().ends_with(&format!(".{ext}")) { n } else { format!("{n}.{ext}") }
}

/// Rejects paths whose extension is not `ext` (case-insensitive) with BAD_PARAMS.
pub fn require_ext(path: &Path, ext: &str) -> Result<()> {
    use crate::error::{NbError, BAD_PARAMS};
    let ok = path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case(ext)).unwrap_or(false);
    if ok { Ok(()) } else { Err(NbError::new(BAD_PARAMS, format!("Path must end with .{ext}: {}", path.display()))) }
}

pub fn pick_save_as(dialogs: &dyn Dialogs, suggested_name: &str, ext: &str) -> Result<Option<PathBuf>> {
    use crate::error::{NbError, BAD_PARAMS};
    if !EXPORT_EXTS.contains(&ext) {
        return Err(NbError::new(BAD_PARAMS, format!("Unsupported export extension: {ext}")));
    }
    let name = suggested_with_ext(suggested_name, ext);
    let Some(picked) = dialogs.pick_save_ext(&name, ext)? else { return Ok(None) };
    let fixed = ensure_ext(picked.clone(), &[&format!(".{ext}")]);
    // The dialog only confirmed overwriting `picked`; a file we'd now hit by appending was never confirmed.
    if fixed != picked && fixed.exists() {
        return Err(NbError::new(crate::error::IO, format!("File already exists: {}", fixed.display())));
    }
    Ok(Some(fixed))
}

/// The folder a picker should open at: only an existing absolute directory, anything else is ignored.
pub fn folder_start(default_path: Option<&str>) -> Option<PathBuf> {
    let s = default_path?.trim();
    if s.is_empty() {
        return None;
    }
    let trimmed = s.trim_end_matches(|c| c == '/' || c == '\\');
    let p = PathBuf::from(if trimmed.is_empty() { s } else { trimmed });
    (p.is_absolute() && p.is_dir()).then_some(p)
}

/// Directory chooser for exports: the picked path without a trailing separator (except a root), which must be an existing directory.
pub fn pick_folder(dialogs: &dyn Dialogs, default_path: Option<&str>) -> Result<Option<PathBuf>> {
    use crate::error::{NbError, BAD_PARAMS};
    let Some(picked) = dialogs.pick_folder(folder_start(default_path).as_deref())? else { return Ok(None) };
    let s = picked.to_string_lossy();
    let trimmed = s.trim_end_matches(|c| c == '/' || c == '\\');
    let dir = if trimmed.is_empty() || trimmed.ends_with(':') { picked.clone() } else { PathBuf::from(trimmed) };
    if !dir.is_dir() {
        return Err(NbError::new(BAD_PARAMS, format!("Not a folder: {}", dir.display())));
    }
    Ok(Some(dir))
}

pub fn ensure_extension(path: PathBuf) -> PathBuf {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".sqlnb") || name.ends_with(".sqlnb.out") {
        return path;
    }
    let mut s = path.into_os_string();
    s.push(".sqlnb");
    PathBuf::from(s)
}

pub fn sanitize_name(name: &str) -> String {
    name.chars().filter(|c| !c.is_control() && *c != '"' && *c != '\\').collect()
}

pub fn pick_save(dialogs: &dyn Dialogs, suggested_name: &str) -> Result<Option<PathBuf>> {
    Ok(dialogs.pick_save(suggested_name)?.map(ensure_extension))
}

pub fn to_response(picked: Result<Option<PathBuf>>) -> Result<Value> {
    Ok(match picked? {
        Some(p) => json!({ "path": p.display().to_string() }),
        None => json!({ "cancelled": true }),
    })
}

pub struct SystemDialogs;

/// The start folder arrives as argv, never spliced into the script text.
#[allow(dead_code)]
const FOLDER_SCRIPT: &str = "on run argv\nif (count of argv) > 0 then\nreturn POSIX path of (choose folder default location (POSIX file (item 1 of argv) as alias))\nend if\nreturn POSIX path of (choose folder)\nend run";

#[cfg(target_os = "macos")]
fn osascript(script: String, args: &[String]) -> Result<Option<PathBuf>> {
    use crate::error::{NbError, IO};
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .args(args)
        .output()
        .map_err(|e| NbError::new(IO, format!("osascript failed: {e}")))?;
    if out.status.success() {
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Ok(if p.is_empty() { None } else { Some(PathBuf::from(p)) });
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("-128") {
        Ok(None)
    } else {
        Err(NbError::new(IO, format!("osascript error: {}", err.trim())))
    }
}

#[cfg(target_os = "macos")]
impl Dialogs for SystemDialogs {
    fn pick_open(&self) -> Result<Option<PathBuf>> {
        osascript(r#"POSIX path of (choose file of type {"sqlnb"})"#.to_string(), &[])
    }
    fn pick_save(&self, suggested_name: &str) -> Result<Option<PathBuf>> {
        let name = sanitize_name(suggested_name);
        osascript(format!(r#"POSIX path of (choose file name default name "{name}")"#), &[])
    }
    fn pick_save_ext(&self, suggested_name: &str, _ext: &str) -> Result<Option<PathBuf>> {
        self.pick_save(suggested_name)
    }
    fn pick_folder(&self, start: Option<&Path>) -> Result<Option<PathBuf>> {
        let args: Vec<String> = start.map(|p| p.display().to_string()).into_iter().collect();
        osascript(FOLDER_SCRIPT.to_string(), &args)
    }
    fn pick_file(&self) -> Result<Option<PathBuf>> {
        osascript("POSIX path of (choose file)".to_string(), &[])
    }
}

#[cfg(not(target_os = "macos"))]
impl Dialogs for SystemDialogs {
    fn pick_open(&self) -> Result<Option<PathBuf>> {
        Ok(rfd::FileDialog::new().add_filter("SQL Notebook", &["sqlnb"]).pick_file())
    }
    fn pick_save(&self, suggested_name: &str) -> Result<Option<PathBuf>> {
        Ok(rfd::FileDialog::new()
            .add_filter("SQL Notebook", &["sqlnb"])
            .set_file_name(suggested_name)
            .save_file())
    }
    fn pick_save_ext(&self, suggested_name: &str, ext: &str) -> Result<Option<PathBuf>> {
        Ok(rfd::FileDialog::new().add_filter(ext, &[ext]).set_file_name(suggested_name).save_file())
    }
    fn pick_folder(&self, start: Option<&Path>) -> Result<Option<PathBuf>> {
        let mut d = rfd::FileDialog::new();
        if let Some(p) = start {
            d = d.set_directory(p);
        }
        Ok(d.pick_folder())
    }
    fn pick_file(&self) -> Result<Option<PathBuf>> {
        Ok(rfd::FileDialog::new().pick_file())
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(Option<PathBuf>);
    impl Dialogs for Fake {
        fn pick_open(&self) -> Result<Option<PathBuf>> {
            Ok(self.0.clone())
        }
        fn pick_save(&self, _: &str) -> Result<Option<PathBuf>> {
            Ok(self.0.clone())
        }
    }

    #[test]
    fn pick_save_ensures_sqlnb_extension() {
        let cases = [
            ("/a/report", "/a/report.sqlnb"),
            ("/a/report.sqlnb", "/a/report.sqlnb"),
            ("/a/report.sqlnb.out", "/a/report.sqlnb.out"),
            ("/a/report.SQLNB", "/a/report.SQLNB.sqlnb"),
        ];
        for (input, want) in cases {
            let got = pick_save(&Fake(Some(input.into())), "x").unwrap();
            assert_eq!(got, Some(PathBuf::from(want)));
        }
        assert_eq!(pick_save(&Fake(None), "x").unwrap(), None);
    }

    #[test]
    fn pick_save_as_appends_and_dedupes_ext() {
        let f = |p: &str, ext: &str| pick_save_as(&Fake(Some(p.into())), "x", ext).unwrap();
        assert_eq!(f("/a/report", "pdf"), Some(PathBuf::from("/a/report.pdf")));
        assert_eq!(f("/a/report.pdf", "pdf"), Some(PathBuf::from("/a/report.pdf")));
        assert_eq!(f("/a/report.PDF", "pdf"), Some(PathBuf::from("/a/report.PDF")));
        assert_eq!(f("/a/r", "html"), Some(PathBuf::from("/a/r.html")));
        assert_eq!(pick_save_as(&Fake(None), "x", "pdf").unwrap(), None);
    }

    #[test]
    fn pick_save_as_rejects_appended_ext_overwrite() {
        let dir = std::env::temp_dir().join(format!("dlg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("rep.pdf"), b"x").unwrap();
        let bare = dir.join("rep");
        let e = pick_save_as(&Fake(Some(bare)), "x", "pdf").unwrap_err();
        assert_eq!(e.code, crate::error::IO);
        // the dialog itself confirmed overwriting a path that already has the extension
        let full = dir.join("rep.pdf");
        assert_eq!(pick_save_as(&Fake(Some(full.clone())), "x", "pdf").unwrap(), Some(full));
    }

    #[test]
    fn pick_folder_trims_separator_and_requires_a_directory() {
        struct Dir(Option<PathBuf>);
        impl Dialogs for Dir {
            fn pick_open(&self) -> Result<Option<PathBuf>> { Ok(None) }
            fn pick_save(&self, _: &str) -> Result<Option<PathBuf>> { Ok(None) }
            fn pick_folder(&self, _: Option<&Path>) -> Result<Option<PathBuf>> { Ok(self.0.clone()) }
        }
        let dir = std::env::temp_dir().join(format!("dlg-folder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let with_slash = PathBuf::from(format!("{}/", dir.display()));
        assert_eq!(pick_folder(&Dir(Some(with_slash)), None).unwrap(), Some(dir.clone()));
        assert_eq!(pick_folder(&Dir(Some(dir.clone())), None).unwrap(), Some(dir.clone()));
        assert_eq!(pick_folder(&Dir(Some("/".into())), None).unwrap(), Some(PathBuf::from("/")));
        assert_eq!(pick_folder(&Dir(None), None).unwrap(), None);
        let e = pick_folder(&Dir(Some(dir.join("missing"))), None).unwrap_err();
        assert_eq!(e.code, crate::error::BAD_PARAMS);
        assert_eq!(pick_folder(&Fake(None), None).unwrap(), None);
    }

    #[test]
    fn folder_start_keeps_only_existing_absolute_directories() {
        let dir = std::env::temp_dir().join(format!("dlg-start-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f.txt");
        std::fs::write(&file, b"x").unwrap();
        let d = dir.display().to_string();
        assert_eq!(folder_start(Some(&d)), Some(dir.clone()));
        assert_eq!(folder_start(Some(&format!("{d}/"))), Some(dir.clone()));
        assert_eq!(folder_start(Some(&file.display().to_string())), None);
        assert_eq!(folder_start(Some(&dir.join("missing").display().to_string())), None);
        assert_eq!(folder_start(Some("relative/dir")), None);
        assert_eq!(folder_start(Some("")), None);
        assert_eq!(folder_start(None), None);
        // quotes and shell/AppleScript metacharacters are plain path text, never interpreted
        let odd = dir.join("a \"b\" $(x) ' \\ z");
        std::fs::create_dir_all(&odd).unwrap();
        assert_eq!(folder_start(Some(&odd.display().to_string())), Some(odd));
    }

    #[test]
    fn folder_script_takes_the_path_from_argv_only() {
        assert!(FOLDER_SCRIPT.contains("item 1 of argv"));
        assert!(!FOLDER_SCRIPT.contains('{') || !FOLDER_SCRIPT.contains("{}"));
    }

    #[test]
    fn suggested_name_gets_extension() {
        assert_eq!(suggested_with_ext("a/b", "pdf"), "ab.pdf");
        assert_eq!(suggested_with_ext("r.PDF", "pdf"), "r.PDF");
    }

    #[test]
    fn require_ext_checks_case_insensitively() {
        assert!(require_ext(Path::new("/a/b.PDF"), "pdf").is_ok());
        assert_eq!(require_ext(Path::new("/a/b.sh"), "pdf").unwrap_err().code, crate::error::BAD_PARAMS);
        assert_eq!(require_ext(Path::new("/a/b"), "html").unwrap_err().code, crate::error::BAD_PARAMS);
    }

    #[test]
    fn pick_save_as_rejects_bad_ext() {
        let e = pick_save_as(&Fake(Some("/a/b".into())), "x", "sh").unwrap_err();
        assert_eq!(e.code, crate::error::BAD_PARAMS);
    }

    #[test]
    fn sanitize_file_name_strips_separators_and_reserved() {
        assert_eq!(sanitize_file_name("a/b\\c\n\"d\":*?<>|e"), "abcde");
    }

    #[test]
    fn sanitize_name_strips_control_chars_and_quotes() {
        assert_eq!(sanitize_name("a\n\"b\r\\c\t.sqlnb"), "abc.sqlnb");
    }

    #[test]
    fn fake_dialog_cancel_maps_to_cancelled() {
        let v = to_response(Fake(None).pick_open()).unwrap();
        assert_eq!(v, json!({ "cancelled": true }));
        let v = to_response(Fake(Some("/a/b.sqlnb".into())).pick_save("x")).unwrap();
        assert_eq!(v, json!({ "path": "/a/b.sqlnb" }));
    }
}
