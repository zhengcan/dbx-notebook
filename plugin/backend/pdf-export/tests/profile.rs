use pdf_export::{kill_tree, sweep_stale_profiles, write_atomic, write_export, Procs, TARGET_EXISTS};
use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("pdfx-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

struct Fake {
    alive: Vec<u32>,
    cmds: Vec<(u32, String)>,
    killed: RefCell<Vec<u32>>,
}
impl Procs for Fake {
    fn alive(&self, pid: u32) -> bool { self.alive.contains(&pid) }
    fn cmdline(&self, pid: u32) -> Option<String> { self.cmds.iter().find(|c| c.0 == pid).map(|c| c.1.clone()) }
    fn list(&self) -> Vec<(u32, String)> { self.cmds.clone() }
    fn kill(&self, pid: u32) { self.killed.borrow_mut().push(pid) }
}
fn fake(alive: &[u32], cmds: &[(u32, String)]) -> Fake {
    Fake { alive: alive.to_vec(), cmds: cmds.to_vec(), killed: RefCell::new(vec![]) }
}
fn cmd(dir: &std::path::Path) -> String { format!("/Chrome --headless --user-data-dir={} --foo", dir.display()) }

#[test]
fn sweep_kills_matching_chrome_and_helpers_of_dead_owner() {
    let d = tmp("sweep");
    let stale = d.join("export-profile-1-a");
    let other = d.join("something-else");
    fs::create_dir_all(&stale).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::write(stale.join("chrome.pid"), "4242").unwrap();
    let p = fake(&[4242, 4243], &[(4242, cmd(&stale)), (4243, cmd(&stale)), (5000, "vim".into())]);
    sweep_stale_profiles(&d, &p);
    let mut k = p.killed.borrow().clone();
    k.sort();
    assert_eq!(k, vec![4242, 4243]);
    assert!(!stale.exists());
    assert!(other.exists());
}

#[test]
fn sweep_does_not_kill_recycled_pid() {
    let d = tmp("recycled");
    let stale = d.join("export-profile-1-a");
    fs::create_dir_all(&stale).unwrap();
    fs::write(stale.join("chrome.pid"), "4242").unwrap();
    let p = fake(&[4242], &[(4242, "/usr/bin/some-user-app --x".into())]);
    sweep_stale_profiles(&d, &p);
    assert!(p.killed.borrow().is_empty());
    assert!(!stale.exists());
    let p = fake(&[], &[]);
    fs::create_dir_all(&stale).unwrap();
    fs::write(stale.join("chrome.pid"), "4242").unwrap();
    sweep_stale_profiles(&d, &p);
    assert!(p.killed.borrow().is_empty());
}

#[test]
fn sweep_skips_profiles_of_live_owner_and_self() {
    let d = tmp("sweepown");
    let mine = d.join(format!("export-profile-{}-x", std::process::id()));
    let live = d.join("export-profile-77-x");
    fs::create_dir_all(&mine).unwrap();
    fs::create_dir_all(&live).unwrap();
    fs::write(live.join("chrome.pid"), "4242").unwrap();
    let p = fake(&[77, 4242], &[(4242, cmd(&live))]);
    sweep_stale_profiles(&d, &p);
    assert!(mine.exists() && live.exists());
    assert!(p.killed.borrow().is_empty());
}

#[test]
fn kill_tree_isolates_prefix_profiles() {
    let d = tmp("kt");
    let p1 = d.join("export-profile-9-1");
    let p10 = d.join("export-profile-9-10");
    let p = fake(&[], &[(10, cmd(&p1)), (11, cmd(&p10)), (12, format!("/Chrome --user-data-dir={}", p1.display()))]);
    kill_tree(&p, 0, Some(&p1));
    let mut k = p.killed.borrow().clone();
    k.sort();
    assert_eq!(k, vec![10, 12]);
}

#[test]
fn kill_tree_handles_regex_metacharacters_literally() {
    let d = tmp("kt2");
    let weird = d.join("a.b+(c)");
    let lookalike = d.join("aXb+(c)");
    let p = fake(&[], &[(10, cmd(&weird)), (11, cmd(&lookalike))]);
    kill_tree(&p, 0, Some(&weird));
    assert_eq!(*p.killed.borrow(), vec![10]);
}

#[test]
fn kill_tree_known_pid_only_if_cmdline_matches() {
    let d = tmp("kt3");
    let pr = d.join("export-profile-9-1");
    let p = fake(&[], &[(7, "/usr/bin/other".into())]);
    kill_tree(&p, 7, Some(&pr));
    assert!(p.killed.borrow().is_empty());
    let p = fake(&[], &[(7, cmd(&pr))]);
    kill_tree(&p, 7, Some(&pr));
    assert_eq!(*p.killed.borrow(), vec![7]);
}

#[test]
fn write_atomic_overwrites() {
    let d = tmp("wa");
    let f = d.join("a.pdf");
    write_atomic(&f, b"one").unwrap();
    write_atomic(&f, b"two").unwrap();
    assert_eq!(fs::read(&f).unwrap(), b"two");
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
}

#[test]
fn write_atomic_missing_parent_errs() {
    let d = tmp("wa2");
    let e = write_atomic(&d.join("nope/a.pdf"), b"x").unwrap_err();
    assert_eq!(e.code, notebook_files::error::IO);
}

#[test]
fn write_atomic_dest_is_dir_errs() {
    let d = tmp("wa3");
    let sub = d.join("sub");
    fs::create_dir(&sub).unwrap();
    assert!(write_atomic(&sub, b"x").is_err());
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn write_atomic_readonly_dir_leaves_no_temp() {
    use std::os::unix::fs::PermissionsExt;
    let d = tmp("wa4");
    let ro = d.join("ro");
    fs::create_dir(&ro).unwrap();
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o555)).unwrap();
    let r = write_atomic(&ro.join("a.pdf"), b"x");
    let n = fs::read_dir(&ro).unwrap().count();
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o755)).unwrap();
    if std::process::id() != 0 { assert!(r.is_err()); }
    assert_eq!(n, 0);
}

#[test]
fn write_export_refuses_existing_without_overwrite() {
    let d = tmp("we1");
    let f = d.join("a.html");
    fs::write(&f, b"precious").unwrap();
    let e = write_export(&f, b"new", false).unwrap_err();
    assert_eq!(e.code, TARGET_EXISTS);
    assert_eq!(fs::read(&f).unwrap(), b"precious");
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
}

#[test]
fn write_export_overwrite_replaces_atomically() {
    let d = tmp("we2");
    let f = d.join("a.html");
    fs::write(&f, b"old").unwrap();
    write_export(&f, b"new", true).unwrap();
    assert_eq!(fs::read(&f).unwrap(), b"new");
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
}

#[test]
fn write_export_creates_a_new_file_without_leftovers() {
    let d = tmp("we3");
    let f = d.join("a.html");
    write_export(&f, b"fresh", false).unwrap();
    assert_eq!(fs::read(&f).unwrap(), b"fresh");
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn write_export_treats_a_dangling_symlink_as_existing() {
    let d = tmp("we4");
    let f = d.join("a.html");
    std::os::unix::fs::symlink(d.join("missing"), &f).unwrap();
    assert_eq!(write_export(&f, b"x", false).unwrap_err().code, TARGET_EXISTS);
    assert!(!d.join("missing").exists());
}
