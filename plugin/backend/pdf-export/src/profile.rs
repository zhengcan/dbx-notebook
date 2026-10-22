use notebook_files::error::{NbError, Result, IO, TARGET_EXISTS};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const PROFILE_PREFIX: &str = "export-profile-";

/// Process inspection/killing, injectable so tests never touch real processes.
pub trait Procs {
    fn alive(&self, pid: u32) -> bool;
    fn cmdline(&self, pid: u32) -> Option<String>;
    /// All processes as (pid, command line). Empty where unsupported.
    fn list(&self) -> Vec<(u32, String)>;
    fn kill(&self, pid: u32);
    /// False where command lines cannot be read (Windows); then nothing is killed by scanning.
    fn can_inspect(&self) -> bool {
        true
    }
}

pub struct SysProcs;

#[cfg(unix)]
fn run_ps(args: &[&str]) -> Option<String> {
    let o = std::process::Command::new("ps").args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).to_string())
}

impl Procs for SysProcs {
    #[cfg(unix)]
    fn alive(&self, pid: u32) -> bool {
        std::process::Command::new("kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(windows)]
    fn alive(&self, pid: u32) -> bool {
        std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}")]).output().map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string())).unwrap_or(false)
    }
    #[cfg(unix)]
    fn cmdline(&self, pid: u32) -> Option<String> {
        run_ps(&["-p", &pid.to_string(), "-o", "command="]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }
    #[cfg(windows)]
    fn cmdline(&self, _pid: u32) -> Option<String> {
        None
    }
    #[cfg(unix)]
    fn list(&self) -> Vec<(u32, String)> {
        run_ps(&["-axo", "pid=,command="])
            .unwrap_or_default()
            .lines()
            .filter_map(|l| {
                let l = l.trim_start();
                let (pid, cmd) = l.split_once(char::is_whitespace)?;
                Some((pid.parse().ok()?, cmd.trim_start().to_string()))
            })
            .collect()
    }
    #[cfg(windows)]
    fn list(&self) -> Vec<(u32, String)> {
        vec![]
    }
    #[cfg(unix)]
    fn kill(&self, pid: u32) {
        let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).stderr(std::process::Stdio::null()).status();
    }
    #[cfg(windows)]
    fn kill(&self, pid: u32) {
        let _ = std::process::Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).status();
    }
    fn can_inspect(&self) -> bool {
        cfg!(unix)
    }
}

/// True if `cmd` has the literal argument `--user-data-dir=<profile>` ending at a space or the end
/// (so profile `…-1` never matches `…-10`).
pub fn cmd_has_profile(cmd: &str, profile: &Path) -> bool {
    let token = format!("--user-data-dir={}", profile.display());
    let mut from = 0;
    while let Some(i) = cmd[from..].find(&token) {
        let end = from + i + token.len();
        if end == cmd.len() || cmd[end..].starts_with(' ') {
            return true;
        }
        from = from + i + 1;
    }
    false
}

/// Kills every process running from `profile` (browser and helpers, found by exact command-line
/// token) and `pid` itself only if its command line still shows that profile (guards pid reuse).
pub fn kill_tree(procs: &dyn Procs, pid: u32, profile: Option<&Path>) {
    let mut pids: Vec<u32> = vec![];
    if let Some(p) = profile {
        pids.extend(procs.list().into_iter().filter(|(_, c)| cmd_has_profile(c, p)).map(|(i, _)| i));
    }
    if pid != 0 && !pids.contains(&pid) {
        let ours = match (procs.can_inspect(), profile) {
            (false, _) => true, // Windows: the pid is the browser this job just started
            (true, Some(p)) => procs.cmdline(pid).map(|c| cmd_has_profile(&c, p)).unwrap_or(false),
            (true, None) => false,
        };
        if ours {
            pids.push(pid);
        }
    }
    for p in pids {
        procs.kill(p);
    }
}

pub fn kill_process_tree(pid: u32, profile: Option<&Path>) {
    kill_tree(&SysProcs, pid, profile)
}

/// Removes profile dirs of dead sidecars, first killing any browser still running from them.
/// Dir name is `export-profile-<sidecar pid>-<job>`; chrome's pid is in `<dir>/chrome.pid`.
/// Profiles of this process or of another live sidecar are left alone.
pub fn sweep_stale_profiles(data_dir: &Path, procs: &dyn Procs) {
    let Ok(rd) = fs::read_dir(data_dir) else { return };
    let me = std::process::id();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(PROFILE_PREFIX) else { continue };
        let owner: Option<u32> = rest.split('-').next().and_then(|s| s.parse().ok());
        if !e.path().is_dir() || owner == Some(me) || owner.map(|o| procs.alive(o)).unwrap_or(false) {
            continue;
        }
        let chrome = fs::read_to_string(e.path().join("chrome.pid")).ok().and_then(|s| s.trim().parse::<u32>().ok()).unwrap_or(0);
        if procs.can_inspect() {
            kill_tree(procs, chrome, Some(&e.path()));
        }
        let _ = fs::remove_dir_all(e.path());
    }
}

static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<()> {
    write_export(dest, bytes, true)
}

/// Like `write_atomic`, but with `overwrite == false` an existing target (also a dangling symlink) is
/// never replaced: it fails with `TARGET_EXISTS`, checked up front and again atomically when publishing
/// (hard link, which cannot clobber), so a file created meanwhile survives.
pub fn write_export(dest: &Path, bytes: &[u8], overwrite: bool) -> Result<()> {
    let io = |what: &str, e: std::io::Error| NbError::new(IO, format!("{what} {}: {e}", dest.display()));
    let exists = || NbError::new(TARGET_EXISTS, format!("Target already exists: {}", dest.display()));
    if dest.is_dir() {
        return Err(NbError::new(IO, format!("Destination is a directory: {}", dest.display())));
    }
    if !overwrite && fs::symlink_metadata(dest).is_ok() {
        return Err(exists());
    }
    let dir = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("export");
    let tmp: PathBuf = dir.join(format!(".{name}.tmp-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
    if let Err(e) = fs::write(&tmp, bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(io("Cannot write", e));
    }
    let published = if overwrite {
        fs::rename(&tmp, dest)
    } else {
        match fs::hard_link(&tmp, dest) {
            Ok(()) => { let _ = fs::remove_file(&tmp); return Ok(()); }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => { let _ = fs::remove_file(&tmp); return Err(exists()); }
            // Filesystems without hard links: fall back to a re-check plus rename.
            Err(_) if fs::symlink_metadata(dest).is_ok() => { let _ = fs::remove_file(&tmp); return Err(exists()); }
            Err(_) => fs::rename(&tmp, dest),
        }
    };
    if let Err(e) = published {
        let _ = fs::remove_file(&tmp);
        return Err(io("Cannot replace", e));
    }
    Ok(())
}
