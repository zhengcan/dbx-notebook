use pdf_export::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn tmp(name: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!("pdfj-{name}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

enum Mode { Ok, Sleep(u64), Err, Never }
struct Fake(Mode, Mutex<Vec<PathBuf>>);
impl Renderer for Fake {
    fn render(&self, _req: &PdfRequest, profile: &Path, pid: &AtomicU32) -> Result<Vec<u8>, String> {
        self.1.lock().unwrap().push(profile.to_path_buf());
        pid.store(4242, Ordering::SeqCst);
        match self.0 {
            Mode::Ok => Ok(b"%PDF-fake".to_vec()),
            Mode::Sleep(ms) => { std::thread::sleep(Duration::from_millis(ms)); Ok(b"%PDF-fake".to_vec()) }
            Mode::Err => Err("boom".into()),
            Mode::Never => { std::thread::sleep(Duration::from_secs(30)); Err("x".into()) }
        }
    }
}

fn jobs(mode: Mode) -> (PdfJobs, Arc<Mutex<Vec<u32>>>, PathBuf) {
    let killed = Arc::new(Mutex::new(vec![]));
    let k = killed.clone();
    let j = PdfJobs::with_parts(Arc::new(Fake(mode, Mutex::new(vec![]))), Arc::new(move |pid, _p: &Path| k.lock().unwrap().push(pid)));
    (j, killed, tmp("d"))
}

fn req(dir: &Path, name: &str, timeout: u64) -> PdfRequest {
    PdfRequest { html: "<p>x</p>".into(), out_path: dir.join(name), orientation: Orientation::Portrait, browser: "/b".into(), timeout_secs: timeout, overwrite: true }
}

fn wait(j: &PdfJobs, id: &str) -> JobState {
    let t = Instant::now();
    loop {
        let s = j.status(id).unwrap();
        if !matches!(s, JobState::Running) || t.elapsed() > Duration::from_secs(10) { return s; }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn success_writes_file() {
    let (j, _k, d) = jobs(Mode::Ok);
    let id = j.start(req(&d, "a.pdf", 5), &d).unwrap();
    match wait(&j, &id) { JobState::Done { path, bytes } => { assert_eq!(bytes, 9); assert_eq!(std::fs::read(path).unwrap(), b"%PDF-fake"); } s => panic!("{s:?}") }
}

#[test]
fn renderer_error_is_export_failed() {
    let (j, _k, d) = jobs(Mode::Err);
    let id = j.start(req(&d, "a.pdf", 5), &d).unwrap();
    match wait(&j, &id) { JobState::Failed { code, message } => { assert_eq!(code, "EXPORT_FAILED"); assert!(message.contains("boom")); } s => panic!("{s:?}") }
    assert!(!d.join("a.pdf").exists());
}

#[test]
fn timeout_kills() {
    let (j, k, d) = jobs(Mode::Never);
    let id = j.start(req(&d, "a.pdf", 1), &d).unwrap();
    match wait(&j, &id) { JobState::Failed { code, .. } => assert_eq!(code, "EXPORT_TIMEOUT"), s => panic!("{s:?}") }
    assert_eq!(*k.lock().unwrap(), vec![4242]);
    assert!(!d.join("a.pdf").exists());
}

#[test]
fn cancel_running() {
    let (j, k, d) = jobs(Mode::Never);
    let id = j.start(req(&d, "a.pdf", 30), &d).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(j.cancel(&id));
    assert_eq!(j.status(&id), Some(JobState::Cancelled));
    assert_eq!(*k.lock().unwrap(), vec![4242]);
    assert!(!d.join("a.pdf").exists());
    let profiles: Vec<_> = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("export-profile-")).collect();
    assert!(profiles.is_empty());
}

#[test]
fn cancel_finished_false_unknown_none() {
    let (j, _k, d) = jobs(Mode::Ok);
    let id = j.start(req(&d, "a.pdf", 5), &d).unwrap();
    wait(&j, &id);
    assert!(!j.cancel(&id));
    assert_eq!(j.status("nope"), None);
    assert!(!j.cancel("nope"));
}

#[test]
fn concurrent_jobs_have_distinct_profiles() {
    let r = Arc::new(Fake(Mode::Sleep(300), Mutex::new(vec![])));
    let j = PdfJobs::with_parts(r.clone(), Arc::new(|_, _: &Path| {}));
    let d = tmp("conc");
    let a = j.start(req(&d, "a.pdf", 5), &d).unwrap();
    let b = j.start(req(&d, "b.pdf", 5), &d).unwrap();
    wait(&j, &a); wait(&j, &b);
    let p = r.1.lock().unwrap();
    assert_eq!(p.len(), 2);
    assert_ne!(p[0], p[1]);
}

#[test]
fn profile_removed_after_done() {
    let (j, _k, d) = jobs(Mode::Ok);
    let id = j.start(req(&d, "a.pdf", 5), &d).unwrap();
    wait(&j, &id);
    std::thread::sleep(Duration::from_millis(100));
    assert!(std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).all(|e| !e.file_name().to_string_lossy().starts_with("export-profile-")));
}

#[test]
#[ignore = "needs a local Chrome/Edge/Chromium; run with `cargo test -- --ignored`"]
fn renders_real_pdf_and_cancel_leaves_no_orphan() {
    let st = find_browser(None, &|k| std::env::var(k).ok(), &|p| p.exists());
    let Some(browser) = st.path else { eprintln!("no browser; skipping"); return };
    let d = tmp("real");
    let j = PdfJobs::new();
    let mut r = req(&d, "real.pdf", 60);
    r.browser = browser.clone();
    r.html = "<html><body><h1>你好</h1></body></html>".into();
    let id = j.start(r, &d).unwrap();
    match wait(&j, &id) { JobState::Done { path, .. } => { let b = std::fs::read(path).unwrap(); assert!(b.starts_with(b"%PDF-")); } s => panic!("{s:?}") }

    // cancel: no process using our profile dirs may survive
    let mut r = req(&d, "cancel.pdf", 60);
    r.browser = browser;
    r.html = "<h1>x</h1>".into();
    let id = j.start(r, &d).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    j.cancel(&id);
    std::thread::sleep(Duration::from_millis(4000));
    let out = std::process::Command::new("pgrep").args(["-f", &format!("{}/export-profile-", d.display())]).output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).trim().is_empty(), "orphan: {}", String::from_utf8_lossy(&out.stdout));
    assert!(!d.join("cancel.pdf").exists());
}

fn req_no_overwrite(dir: &Path, name: &str) -> PdfRequest {
    PdfRequest { overwrite: false, ..req(dir, name, 5) }
}

#[test]
fn start_refuses_an_existing_target_without_overwrite() {
    let (j, _k, d) = jobs(Mode::Ok);
    std::fs::write(d.join("a.pdf"), b"precious").unwrap();
    let e = j.start(req_no_overwrite(&d, "a.pdf"), &d).unwrap_err();
    assert_eq!(e.code, TARGET_EXISTS);
    assert_eq!(std::fs::read(d.join("a.pdf")).unwrap(), b"precious");
    assert!(std::fs::read_dir(&d).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(PROFILE_PREFIX)));
}

#[test]
fn overwrite_replaces_an_existing_target() {
    let (j, _k, d) = jobs(Mode::Ok);
    std::fs::write(d.join("a.pdf"), b"old").unwrap();
    let id = j.start(req(&d, "a.pdf", 5), &d).unwrap();
    assert!(matches!(wait(&j, &id), JobState::Done { .. }));
    assert_eq!(std::fs::read(d.join("a.pdf")).unwrap(), b"%PDF-fake");
}

#[test]
fn no_overwrite_writes_a_new_target() {
    let (j, _k, d) = jobs(Mode::Ok);
    let id = j.start(req_no_overwrite(&d, "new.pdf"), &d).unwrap();
    assert!(matches!(wait(&j, &id), JobState::Done { .. }));
    assert_eq!(std::fs::read(d.join("new.pdf")).unwrap(), b"%PDF-fake");
}

#[test]
fn target_appearing_while_rendering_is_not_clobbered() {
    let (j, _k, d) = jobs(Mode::Sleep(300));
    let id = j.start(req_no_overwrite(&d, "late.pdf"), &d).unwrap();
    std::fs::write(d.join("late.pdf"), b"someone else").unwrap();
    match wait(&j, &id) {
        JobState::Failed { code, .. } => assert_eq!(code, TARGET_EXISTS_CODE),
        s => panic!("{s:?}"),
    }
    assert_eq!(std::fs::read(d.join("late.pdf")).unwrap(), b"someone else");
    assert!(std::fs::read_dir(&d).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains(".tmp-")));
}
