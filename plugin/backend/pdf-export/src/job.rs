use crate::profile::{kill_process_tree, write_export, PROFILE_PREFIX};
use crate::{EXPORT_FAILED, EXPORT_TIMEOUT, TARGET_EXISTS_CODE};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Present in the profile dir while the job is live; removed with the dir on cancel/timeout, so a
/// renderer that was still launching can notice and shut its browser down.
pub const ALIVE_MARKER: &str = "job.alive";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    Portrait,
    Landscape,
}

#[derive(Debug, Clone)]
pub struct PdfRequest {
    pub html: String,
    pub out_path: PathBuf,
    pub orientation: Orientation,
    pub browser: PathBuf,
    pub timeout_secs: u64,
    /// Replace an existing target; when false an existing target fails the job (checked at start and when publishing).
    pub overwrite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobState {
    Running,
    Done { path: PathBuf, bytes: u64 },
    Failed { code: String, message: String },
    Cancelled,
}

/// Renders HTML to PDF bytes. Must store the browser's pid into `pid` as soon as it is known
/// so the job can kill it on timeout/cancel. Blocking; runs on its own thread.
pub trait Renderer: Send + Sync {
    fn render(&self, req: &PdfRequest, profile: &Path, pid: &AtomicU32) -> Result<Vec<u8>, String>;
}

type Killer = Arc<dyn Fn(u32, &Path) + Send + Sync>;

pub struct PdfJobs {
    jobs: Arc<Mutex<HashMap<String, JobEntry>>>,
    renderer: Arc<dyn Renderer>,
    kill: Killer,
    seq: AtomicU64,
}

struct JobEntry {
    state: JobState,
    pid: Arc<AtomicU32>,
    profile: PathBuf,
}

impl Default for PdfJobs {
    fn default() -> Self {
        Self::new()
    }
}

impl PdfJobs {
    pub fn new() -> Self {
        Self::with_parts(Arc::new(crate::ChromeRenderer), Arc::new(|pid, p: &Path| kill_process_tree(pid, Some(p))))
    }

    pub fn with_parts(renderer: Arc<dyn Renderer>, kill: Killer) -> Self {
        Self { jobs: Default::default(), renderer, kill, seq: AtomicU64::new(0) }
    }

    pub fn start(&self, req: PdfRequest, data_dir: &Path) -> notebook_files::error::Result<String> {
        use notebook_files::error::{NbError, IO, TARGET_EXISTS};
        if !req.overwrite && std::fs::symlink_metadata(&req.out_path).is_ok() {
            return Err(NbError::new(TARGET_EXISTS, format!("Target already exists: {}", req.out_path.display())));
        }
        crate::sweep_stale_profiles(data_dir, &crate::SysProcs);
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let id = format!("pdf-{}-{n}", std::process::id());
        let profile = data_dir.join(format!("{PROFILE_PREFIX}{}-{n}", std::process::id()));
        std::fs::create_dir_all(&profile).map_err(|e| NbError::new(IO, format!("Cannot create profile dir: {e}")))?;
        let _ = std::fs::write(profile.join(ALIVE_MARKER), b"");
        let pid = Arc::new(AtomicU32::new(0));
        self.jobs.lock().unwrap().insert(id.clone(), JobEntry { state: JobState::Running, pid: pid.clone(), profile: profile.clone() });

        let (tx, rx) = mpsc::channel();
        {
            let renderer = self.renderer.clone();
            let (req, profile, pid) = (req.clone(), profile.clone(), pid.clone());
            std::thread::spawn(move || {
                let _ = tx.send(renderer.render(&req, &profile, &pid));
            });
        }
        let (jobs, kill, job_id) = (self.jobs.clone(), self.kill.clone(), id.clone());
        std::thread::spawn(move || {
            let outcome = rx.recv_timeout(Duration::from_secs(req.timeout_secs.max(1)));
            let mut g = jobs.lock().unwrap();
            let Some(entry) = g.get_mut(&job_id) else { return };
            if entry.state != JobState::Running {
                return; // already cancelled
            }
            let finish = |entry: &mut JobEntry, state: JobState, kill_it: bool| {
                if kill_it {
                    kill(entry.pid.load(Ordering::SeqCst), &entry.profile);
                }
                let _ = std::fs::remove_dir_all(&entry.profile);
                entry.state = state;
            };
            match outcome {
                Ok(Ok(bytes)) => {
                    let len = bytes.len() as u64;
                    let state = match write_export(&req.out_path, &bytes, req.overwrite) {
                        Ok(()) => JobState::Done { path: req.out_path.clone(), bytes: len },
                        Err(e) if e.code == TARGET_EXISTS => JobState::Failed { code: TARGET_EXISTS_CODE.into(), message: e.message },
                        Err(e) => JobState::Failed { code: EXPORT_FAILED.into(), message: e.message },
                    };
                    finish(entry, state, false);
                }
                Ok(Err(m)) => finish(entry, JobState::Failed { code: EXPORT_FAILED.into(), message: m }, true),
                Err(mpsc::RecvTimeoutError::Timeout) => finish(
                    entry,
                    JobState::Failed { code: EXPORT_TIMEOUT.into(), message: format!("PDF rendering timed out after {}s", req.timeout_secs) },
                    true,
                ),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    finish(entry, JobState::Failed { code: EXPORT_FAILED.into(), message: "Renderer stopped unexpectedly".into() }, true)
                }
            }
        });
        Ok(id)
    }

    pub fn status(&self, id: &str) -> Option<JobState> {
        self.jobs.lock().unwrap().get(id).map(|e| e.state.clone())
    }

    pub fn cancel(&self, id: &str) -> bool {
        let mut g = self.jobs.lock().unwrap();
        let Some(e) = g.get_mut(id) else { return false };
        if e.state != JobState::Running {
            return false;
        }
        (self.kill)(e.pid.load(Ordering::SeqCst), &e.profile);
        let _ = std::fs::remove_dir_all(&e.profile);
        e.state = JobState::Cancelled;
        true
    }
}
