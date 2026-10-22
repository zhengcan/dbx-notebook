use pdf_export::find_browser;
use std::path::{Path, PathBuf};

fn no_env(_: &str) -> Option<String> { None }

#[test]
fn manual_path_wins() {
    let s = find_browser(Some("/m/chrome"), &no_env, &|p: &Path| p == Path::new("/m/chrome"));
    assert!(s.found);
    assert_eq!(s.source, "manual");
    assert_eq!(s.path, Some(PathBuf::from("/m/chrome")));
}

#[test]
fn invalid_manual_does_not_fall_back() {
    let env = |k: &str| (k == "CHROME").then(|| "/e/chrome".to_string());
    let s = find_browser(Some("/bad/path"), &env, &|_: &Path| true);
    // exists() says true for everything except we must check manual specifically
    assert!(s.found); // exists true => manual accepted
    let s = find_browser(Some("/bad/path"), &env, &|p: &Path| p == Path::new("/e/chrome"));
    assert!(!s.found);
    assert_eq!(s.source, "manual");
    assert!(s.reason.unwrap().contains("/bad/path"));
}

#[test]
fn env_chrome_used() {
    let env = |k: &str| (k == "CHROME").then(|| "/e/chrome".to_string());
    let s = find_browser(None, &env, &|p: &Path| p == Path::new("/e/chrome"));
    assert_eq!((s.found, s.source), (true, "env"));
}

#[test]
fn auto_candidate_found() {
    let s = find_browser(None, &no_env, &|p: &Path| p.to_string_lossy().contains("Microsoft Edge")
        || p.to_string_lossy().ends_with("/chromium"));
    assert!(s.found);
    assert_eq!(s.source, "auto");
}

#[test]
fn nothing_found() {
    let s = find_browser(None, &no_env, &|_: &Path| false);
    assert_eq!((s.found, s.source), (false, "none"));
    assert!(s.path.is_none());
    assert!(s.reason.is_some());
}

mod manual_resolution {
    use super::*;
    use notebook_files::dialogs::Dialogs;
    use pdf_export::{pick_browser, resolve_browser_dir};

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("br-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn exe(p: &Path, mode: u32) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        let _ = mode;
    }
    fn real(p: &Path) -> bool { p.exists() }

    #[test]
    fn app_bundle_directory_resolves_to_inner_executable() {
        let d = tmp("app");
        let app = d.join("Google Chrome.app");
        let inner = app.join("Contents/MacOS/Google Chrome");
        exe(&inner, 0o755);
        exe(&app.join("Contents/MacOS/other-helper"), 0o755);
        assert_eq!(resolve_browser_dir(&app), Some(inner.clone()));
        let s = find_browser(Some(app.to_str().unwrap()), &no_env, &real);
        assert_eq!((s.found, s.source), (true, "manual"));
        assert_eq!(s.path, Some(inner));
    }

    #[test]
    fn app_bundle_with_trailing_slash_and_odd_name_uses_only_executable() {
        let d = tmp("odd");
        let app = d.join("Brave Browser.app");
        let inner = app.join("Contents/MacOS/Brave Browser Beta");
        exe(&inner, 0o755);
        let with_slash = format!("{}/", app.display());
        let s = find_browser(Some(&with_slash), &no_env, &real);
        assert_eq!(s.path, Some(inner));
    }

    #[test]
    fn plain_install_folder_resolves_known_executable_names() {
        let d = tmp("dir");
        let inner = d.join("chrome");
        exe(&inner, 0o755);
        exe(&d.join("README"), 0o644);
        assert_eq!(resolve_browser_dir(&d), Some(inner));
    }

    #[test]
    fn folder_without_a_browser_is_reported_not_found() {
        let d = tmp("empty");
        let s = find_browser(Some(d.to_str().unwrap()), &no_env, &real);
        assert!(!s.found);
        assert_eq!(s.code, Some("notFound"));
        assert!(s.reason.unwrap().contains(d.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_file_is_flagged() {
        let d = tmp("noexec");
        let f = d.join("chrome");
        exe(&f, 0o644);
        let s = find_browser(Some(f.to_str().unwrap()), &no_env, &real);
        assert!(!s.found);
        assert_eq!(s.code, Some("notExecutable"));
        assert_eq!(s.path, None);
    }

    #[test]
    fn missing_manual_path_has_not_found_code() {
        let s = find_browser(Some("/bad/path"), &no_env, &|_: &Path| false);
        assert_eq!(s.code, Some("notFound"));
        let ok = find_browser(None, &no_env, &|_: &Path| false);
        assert_eq!(ok.code, Some("notFound"));
    }

    struct Pick(Option<PathBuf>, std::cell::Cell<Option<&'static str>>);
    impl Dialogs for Pick {
        fn pick_open(&self) -> notebook_files::error::Result<Option<PathBuf>> { Ok(None) }
        fn pick_save(&self, _: &str) -> notebook_files::error::Result<Option<PathBuf>> { Ok(None) }
        fn pick_folder(&self, _: Option<&Path>) -> notebook_files::error::Result<Option<PathBuf>> { self.1.set(Some("folder")); Ok(self.0.clone()) }
        fn pick_file(&self) -> notebook_files::error::Result<Option<PathBuf>> { self.1.set(Some("file")); Ok(self.0.clone()) }
    }

    #[test]
    fn pick_browser_routes_kind_and_resolves_app_bundles() {
        let d = tmp("pick");
        let app = d.join("Chromium.app");
        let inner = app.join("Contents/MacOS/Chromium");
        exe(&inner, 0o755);
        let p = Pick(Some(app.clone()), Default::default());
        assert_eq!(pick_browser(&p, "dir").unwrap(), Some(inner.clone()));
        assert_eq!(p.1.get(), Some("folder"));
        let p = Pick(Some(app.clone()), Default::default());
        assert_eq!(pick_browser(&p, "file").unwrap(), Some(inner));
        assert_eq!(p.1.get(), Some("file"));
        // an unresolvable pick is passed through so the status line can explain it
        let plain = d.join("nothing");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(pick_browser(&Pick(Some(plain.clone()), Default::default()), "dir").unwrap(), Some(plain));
        assert_eq!(pick_browser(&Pick(None, Default::default()), "file").unwrap(), None);
        assert_eq!(pick_browser(&Pick(None, Default::default()), "x").unwrap_err().code, notebook_files::error::BAD_PARAMS);
    }

    #[test]
    fn pick_browser_keeps_separator_of_drive_and_filesystem_roots() {
        for root in ["C:\\", "C:/", "/"] {
            let got = pick_browser(&Pick(Some(PathBuf::from(root)), Default::default()), "dir").unwrap();
            assert_eq!(got, Some(PathBuf::from(root)), "{root}");
        }
    }
}
