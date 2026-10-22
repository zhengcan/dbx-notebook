use crate::error::{NbError, Result};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// RPC code for `export/openFile` refusals and launch failures.
pub const OPEN_FAILED: i32 = -32050;
/// RPC code when the file is on a network location (UNC), which is never launched.
pub const UNSUPPORTED_LOCATION: i32 = -32051;
/// Most recently exported files that may still be opened.
pub const MAX_REGISTERED: usize = 20;

const ALLOWED_EXT: [&str; 2] = ["html", "pdf"];

fn refuse(why: &str) -> NbError {
    NbError::new(OPEN_FAILED, why)
}

fn ext_allowed(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| ALLOWED_EXT.iter().any(|a| e.eq_ignore_ascii_case(a)))
}

/// Files this plugin just exported. Only these may be handed to the system opener.
#[derive(Default)]
pub struct ExportRegistry {
    paths: Mutex<VecDeque<PathBuf>>,
}

impl ExportRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a finished export (canonical path). Returns false when it cannot be recorded.
    pub fn register(&self, path: &Path) -> bool {
        if !ext_allowed(path) {
            return false;
        }
        if !std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file()) {
            return false;
        }
        let Ok(canon) = std::fs::canonicalize(path) else { return false };
        let mut g = self.paths.lock().unwrap_or_else(|e| e.into_inner());
        g.retain(|p| p != &canon);
        g.push_back(canon);
        while g.len() > MAX_REGISTERED {
            g.pop_front();
        }
        true
    }

    /// Opens a registered export with `opener`. Errors never contain the path.
    pub fn open(&self, path: &Path, opener: &dyn Fn(&Path) -> std::io::Result<()>) -> Result<()> {
        self.open_checked(path, opener, &|_| {}, cfg!(windows))
    }

    /// `before_launch` runs right before the opener (tests use it to simulate a swap); `reject_network` is `cfg!(windows)` in production.
    fn open_checked(
        &self,
        path: &Path,
        opener: &dyn Fn(&Path) -> std::io::Result<()>,
        before_launch: &dyn Fn(&Path),
        reject_network: bool,
    ) -> Result<()> {
        // First, and string-only: any filesystem call on a UNC path would already reach out to the network.
        if reject_network && path.to_str().map_or(true, is_network_path) {
            return Err(NbError::new(UNSUPPORTED_LOCATION, "Files on network locations cannot be opened"));
        }
        if !path.is_absolute() || !ext_allowed(path) {
            return Err(refuse("Not an exported file"));
        }
        let meta = std::fs::symlink_metadata(path).map_err(|_| refuse("File not found"))?;
        if !meta.is_file() {
            return Err(refuse("Not a regular file"));
        }
        let canon = std::fs::canonicalize(path).map_err(|_| refuse("File not found"))?;
        if reject_network && canon.to_str().map_or(true, is_network_path) {
            return Err(NbError::new(UNSUPPORTED_LOCATION, "Files on network locations cannot be opened"));
        }
        let known = self.paths.lock().unwrap_or_else(|e| e.into_inner()).contains(&canon);
        if !known {
            return Err(refuse("Not an exported file"));
        }
        before_launch(&canon);
        // Narrow the check-to-launch window: the resolved path must still be a plain file, and that exact path is what gets launched.
        if !std::fs::symlink_metadata(&canon).is_ok_and(|m| m.is_file()) {
            return Err(refuse("Not a regular file"));
        }
        opener(&canon).map_err(|_| refuse("Could not open the file"))
    }
}

/// True for UNC / network and device paths in either separator style (`\\host\share`, `//host/share`, `\\?\UNC\…`, `\\.\…`).
/// Only the `\\?\X:\…` extended form of a local drive is not a network path. Pure string test, usable on every platform.
pub fn is_network_path(p: &str) -> bool {
    let b = p.as_bytes();
    let sep = |c: u8| c == b'\\' || c == b'/';
    if b.len() < 2 || !sep(b[0]) || !sep(b[1]) {
        return false;
    }
    let local_ext = b.len() >= 7 && b[2] == b'?' && sep(b[3]) && b[4].is_ascii_alphabetic() && b[5] == b':' && sep(b[6]);
    !local_ext
}

/// Launches the platform opener with an argument array (never a shell). `path` must be absolute.
pub fn system_open(path: &Path) -> std::io::Result<()> {
    use std::process::{Command, Stdio};
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = Command::new("explorer.exe");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = Command::new("xdg-open");
    cmd.arg(path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nbopen-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn run(r: &ExportRegistry, p: &Path) -> (Result<()>, Vec<PathBuf>) {
        let calls = RefCell::new(Vec::new());
        let res = r.open(p, &|x| {
            calls.borrow_mut().push(x.to_path_buf());
            Ok(())
        });
        (res, calls.into_inner())
    }

    #[test]
    fn opens_registered_file() {
        let d = tmp("ok");
        let f = d.join("a.html");
        std::fs::write(&f, "x").unwrap();
        let r = ExportRegistry::new();
        assert!(r.register(&f));
        let (res, calls) = run(&r, &f);
        assert!(res.is_ok());
        assert_eq!(calls, vec![std::fs::canonicalize(&f).unwrap()]);
    }

    #[test]
    fn refuses_unregistered_file() {
        let d = tmp("unreg");
        let f = d.join("a.pdf");
        std::fs::write(&f, "x").unwrap();
        let (res, calls) = run(&ExportRegistry::new(), &f);
        assert_eq!(res.unwrap_err().code, OPEN_FAILED);
        assert!(calls.is_empty());
    }

    #[test]
    fn refuses_other_extensions_even_if_registered() {
        let d = tmp("ext");
        let f = d.join("a.sh");
        std::fs::write(&f, "x").unwrap();
        let r = ExportRegistry::new();
        assert!(!r.register(&f));
        let (res, calls) = run(&r, &f);
        assert!(res.is_err() && calls.is_empty());
    }

    #[test]
    fn refuses_relative_missing_and_directory() {
        let d = tmp("shape");
        let r = ExportRegistry::new();
        assert!(run(&r, Path::new("a.html")).0.is_err());
        assert!(run(&r, &d.join("missing.html")).0.is_err());
        let sub = d.join("dir.html");
        std::fs::create_dir(&sub).unwrap();
        assert!(!r.register(&sub));
        let (res, calls) = run(&r, &sub);
        assert!(res.is_err() && calls.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_even_to_registered_file() {
        let d = tmp("link");
        let f = d.join("real.html");
        std::fs::write(&f, "x").unwrap();
        let l = d.join("link.html");
        std::os::unix::fs::symlink(&f, &l).unwrap();
        let r = ExportRegistry::new();
        assert!(r.register(&f));
        let (res, calls) = run(&r, &l);
        assert!(res.is_err() && calls.is_empty());
    }

    #[test]
    fn hostile_names_are_passed_verbatim_as_one_path() {
        let d = tmp("evil");
        let f = d.join("a b'\"; rm -rf x $(id) `id`.html");
        if std::fs::write(&f, "x").is_err() {
            return;
        }
        let r = ExportRegistry::new();
        assert!(r.register(&f));
        let (res, calls) = run(&r, &f);
        assert!(res.is_ok());
        assert_eq!(calls, vec![std::fs::canonicalize(&f).unwrap()]);
        #[cfg(unix)]
        {
            let nl = d.join("line\nbreak.pdf");
            std::fs::write(&nl, "x").unwrap();
            assert!(r.register(&nl));
            assert_eq!(run(&r, &nl).1, vec![std::fs::canonicalize(&nl).unwrap()]);
            // an unregistered sibling with the same shape stays refused
            let other = d.join("other;id.pdf");
            std::fs::write(&other, "x").unwrap();
            assert!(run(&r, &other).0.is_err());
        }
    }

    #[test]
    fn registry_is_capped_to_recent_entries() {
        let d = tmp("cap");
        let r = ExportRegistry::new();
        let mut files = Vec::new();
        for i in 0..(MAX_REGISTERED + 3) {
            let f = d.join(format!("f{i}.html"));
            std::fs::write(&f, "x").unwrap();
            assert!(r.register(&f));
            files.push(f);
        }
        assert!(run(&r, &files[0]).0.is_err());
        assert!(run(&r, &files[2]).0.is_err());
        assert!(run(&r, &files[3]).0.is_ok());
        assert!(run(&r, files.last().unwrap()).0.is_ok());
    }

    #[test]
    fn errors_and_launch_failures_do_not_leak_paths() {
        let d = tmp("leak-secret");
        let f = d.join("a.html");
        std::fs::write(&f, "x").unwrap();
        let r = ExportRegistry::new();
        r.register(&f);
        let e = r.open(&f, &|_| Err(std::io::Error::new(std::io::ErrorKind::NotFound, f.display().to_string()))).unwrap_err();
        assert!(!e.rpc_message().contains("leak-secret"));
        let e = r.open(&d.join("zz.html"), &|_| Ok(())).unwrap_err();
        assert!(!e.rpc_message().contains("leak-secret"));
    }

    #[test]
    fn network_path_detection_is_pure_and_cross_platform() {
        for p in [r"\\server\share\x.html", "//server/share/x.html", r"\\?\UNC\server\share\x.pdf", r"\\.\pipe\x", r"\\?\GLOBALROOT\x.html", r"\/server/share/x.html"] {
            assert!(is_network_path(p), "{p}");
        }
        for p in [r"C:\out\x.html", "C:/out/x.html", r"\\?\C:\out\x.html", "/home/u/x.html", "/tmp//x.html", "relative/x.html", ""] {
            assert!(!is_network_path(p), "{p}");
        }
    }

    #[test]
    fn network_locations_are_refused_before_touching_the_filesystem() {
        let r = ExportRegistry::new();
        let calls = RefCell::new(0);
        let e = r
            .open_checked(Path::new(r"\\server\share\x.html"), &|_| { *calls.borrow_mut() += 1; Ok(()) }, &|_| {}, true)
            .unwrap_err();
        assert_eq!(e.code, UNSUPPORTED_LOCATION);
        assert!(!e.rpc_message().contains("server"));
        assert_eq!(*calls.borrow(), 0);
        let e = r.open_checked(Path::new("//server/share/x.pdf"), &|_| Ok(()), &|_| {}, true).unwrap_err();
        assert_eq!(e.code, UNSUPPORTED_LOCATION);
    }

    #[test]
    fn launcher_receives_the_canonical_path() {
        let d = tmp("canon");
        std::fs::create_dir(d.join("sub")).unwrap();
        let f = d.join("sub").join("a.html");
        std::fs::write(&f, "x").unwrap();
        let r = ExportRegistry::new();
        assert!(r.register(&f));
        let dotted = d.join("sub").join("..").join("sub").join("a.html");
        let (res, calls) = run(&r, &dotted);
        assert!(res.is_ok());
        assert_eq!(calls, vec![std::fs::canonicalize(&f).unwrap()]);
        assert_ne!(calls[0], dotted);
    }

    #[cfg(unix)]
    #[test]
    fn swap_to_symlink_before_launch_is_refused() {
        let d = tmp("swap");
        let f = d.join("a.html");
        std::fs::write(&f, "x").unwrap();
        let other = d.join("other.txt");
        std::fs::write(&other, "y").unwrap();
        let r = ExportRegistry::new();
        assert!(r.register(&f));
        let canon = std::fs::canonicalize(&f).unwrap();
        let calls = RefCell::new(0);
        let res = r.open_checked(&f, &|_| { *calls.borrow_mut() += 1; Ok(()) }, &|c| {
            std::fs::remove_file(c).unwrap();
            std::os::unix::fs::symlink(&other, c).unwrap();
        }, false);
        assert!(res.is_err());
        assert_eq!(*calls.borrow(), 0);
        assert!(canon.exists());
    }
}
