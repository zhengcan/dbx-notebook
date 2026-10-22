use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use crate::error::{NbError, Result, BAD_PARAMS, IO, NOT_FOUND, PARENT_MISSING, STALE_MTIME};

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn check_ext(path: &Path) -> Result<()> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".sqlnb") || name.ends_with(".sqlnb.out") {
        Ok(())
    } else {
        Err(NbError::new(BAD_PARAMS, "Only .sqlnb and .sqlnb.out files are supported"))
    }
}

fn io_err(e: std::io::Error) -> NbError {
    NbError::new(IO, e.to_string())
}

fn mtime_ms(path: &Path) -> std::io::Result<i64> {
    let m = fs::metadata(path)?.modified()?;
    Ok(match m.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    })
}

pub fn read(path: &Path) -> Result<(String, i64)> {
    check_ext(path)?;
    let text = fs::read_to_string(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            NbError::new(NOT_FOUND, format!("File not found: {}", path.display()))
        } else {
            io_err(e)
        }
    })?;
    let m = mtime_ms(path).map_err(io_err)?;
    Ok((text, m))
}

pub fn read_lossy(path: &Path) -> Result<(String, i64)> {
    check_ext(path)?;
    let bytes = fs::read(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            NbError::new(NOT_FOUND, format!("File not found: {}", path.display()))
        } else {
            io_err(e)
        }
    })?;
    let m = mtime_ms(path).map_err(io_err)?;
    Ok((String::from_utf8_lossy(&bytes).into_owned(), m))
}

pub fn exists(path: &Path) -> Result<(bool, Option<i64>)> {
    check_ext(path)?;
    if !path.is_file() {
        return Ok((false, None));
    }
    Ok((true, mtime_ms(path).ok()))
}

pub fn parse_expected_mtime(value: Option<&serde_json::Value>) -> Result<Option<i64>> {
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .and_then(|n| i64::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| NbError::new(BAD_PARAMS, "expectedMtimeMs must be a non-negative integer")),
    }
}

pub fn write(path: &Path, text: &str, expected_mtime_ms: Option<i64>) -> Result<i64> {
    check_ext(path)?;
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    if !parent.is_dir() {
        return Err(NbError::new(
            PARENT_MISSING,
            format!("Parent directory does not exist: {}", parent.display()),
        ));
    }
    // TOCTOU: the mtime check and the rename below are not atomic together; another
    // process could modify the file in between. Accepted for a single-user tool,
    // and mtimes are compared at millisecond resolution.
    if let Some(expected) = expected_mtime_ms {
        match mtime_ms(path) {
            Ok(actual) if actual == expected => {}
            _ if !path.exists() => {
                return Err(NbError::new(NOT_FOUND, format!("File not found: {}", path.display())))
            }
            _ => return Err(NbError::new(STALE_MTIME, "File was modified externally")),
        }
    }
    let tmp: PathBuf = parent.join(format!(
        ".{}.tmp-{}-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("nb"),
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(io_err(e));
    }
    mtime_ms(path).map_err(io_err)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nbf-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn expected_mtime_param_validation() {
        use serde_json::json;
        assert_eq!(parse_expected_mtime(None).unwrap(), None);
        assert_eq!(parse_expected_mtime(Some(&json!(null))).unwrap(), None);
        assert_eq!(parse_expected_mtime(Some(&json!(123))).unwrap(), Some(123));
        for bad in [json!(1.5), json!("5"), json!(-1), json!(true)] {
            assert_eq!(parse_expected_mtime(Some(&bad)).unwrap_err().code, BAD_PARAMS, "{bad}");
        }
    }

    #[test]
    fn write_then_read_roundtrip() {
        let d = tmp("rt");
        let p = d.join("a.sqlnb");
        let m = write(&p, "hello", None).unwrap();
        assert_eq!(read(&p).unwrap(), ("hello".to_string(), m));
        let p2 = d.join("b.sqlnb.out");
        write(&p2, "x", None).unwrap();
    }

    #[test]
    fn paths_with_spaces_and_non_ascii() {
        let d = tmp("na");
        let p = d.join("分析 报告.sqlnb");
        let m = write(&p, "内容 ✓", None).unwrap();
        assert_eq!(read(&p).unwrap(), ("内容 ✓".to_string(), m));
    }

    #[test]
    fn write_rejects_stale_mtime() {
        let d = tmp("stale");
        let p = d.join("a.sqlnb");
        let m = write(&p, "one", None).unwrap();
        let e = write(&p, "two", Some(m + 1)).unwrap_err();
        assert_eq!(e.code, STALE_MTIME);
        assert_eq!(read(&p).unwrap().0, "one");
        assert!(write(&p, "two", Some(m)).is_ok());
    }

    #[test]
    fn write_is_atomic_no_partial_file_on_error() {
        let d = tmp("atomic");
        let p = d.join("a.sqlnb");
        write(&p, "orig", None).unwrap();
        // Target is a non-empty directory, so the final rename fails.
        let blocked = d.join("dir.sqlnb");
        fs::create_dir_all(blocked.join("child")).unwrap();
        let e = write(&blocked, "new", None).unwrap_err();
        assert_eq!(e.code, IO);
        assert_eq!(read(&p).unwrap().0, "orig");
        let names: Vec<_> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2, "temp file left behind: {names:?}");
    }

    #[test]
    fn rejects_non_sqlnb_extension() {
        let d = tmp("ext");
        let p = d.join("a.txt");
        assert_eq!(write(&p, "x", None).unwrap_err().code, BAD_PARAMS);
        fs::write(&p, "x").unwrap();
        assert_eq!(read(&p).unwrap_err().code, BAD_PARAMS);
    }

    #[test]
    fn write_fails_when_parent_missing() {
        let d = tmp("parent");
        let p = d.join("nope").join("a.sqlnb");
        assert_eq!(write(&p, "x", None).unwrap_err().code, PARENT_MISSING);
        assert!(!d.join("nope").exists());
    }

    #[test]
    fn write_deleted_file_with_expected_mtime_is_not_found() {
        let d = tmp("deleted");
        let p = d.join("a.sqlnb");
        let m = write(&p, "one", None).unwrap();
        fs::remove_file(&p).unwrap();
        assert_eq!(write(&p, "two", Some(m)).unwrap_err().code, NOT_FOUND);
        assert!(write(&p, "two", None).is_ok());
    }

    #[test]
    fn exists_reports_presence_and_checks_extension() {
        let d = tmp("exists");
        let p = d.join("a.sqlnb");
        assert_eq!(exists(&p).unwrap(), (false, None));
        let m = write(&p, "x", None).unwrap();
        assert_eq!(exists(&p).unwrap(), (true, Some(m)));
        assert_eq!(exists(&d.join("a.txt")).unwrap_err().code, BAD_PARAMS);
    }

    #[test]
    fn read_missing_is_32010() {
        let d = tmp("missing");
        assert_eq!(read(&d.join("a.sqlnb")).unwrap_err().code, NOT_FOUND);
    }
}
