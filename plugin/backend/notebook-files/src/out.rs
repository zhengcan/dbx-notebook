use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{NbError, Result, BAD_PARAMS, IO};
use crate::files;

pub fn out_path(notebook_path: &Path) -> Result<PathBuf> {
    let name = notebook_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !name.ends_with(".sqlnb") {
        return Err(NbError::new(BAD_PARAMS, "Path must be a .sqlnb notebook file"));
    }
    let mut s = notebook_path.as_os_str().to_os_string();
    s.push(".out");
    Ok(PathBuf::from(s))
}

pub fn read_out(notebook_path: &Path) -> Result<Option<(String, i64)>> {
    let p = out_path(notebook_path)?;
    match files::read_lossy(&p) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.code == crate::error::NOT_FOUND => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn write_out(notebook_path: &Path, text: &str) -> Result<i64> {
    files::write(&out_path(notebook_path)?, text, None)
}

pub fn delete_out(notebook_path: &Path) -> Result<bool> {
    let p = out_path(notebook_path)?;
    match fs::remove_file(&p) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(NbError::new(IO, e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{BAD_PARAMS, IO, PARENT_MISSING};
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nbo-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn count(d: &Path) -> usize {
        fs::read_dir(d).unwrap().count()
    }

    #[test]
    fn read_missing_is_none() {
        let d = tmp("missing");
        assert_eq!(read_out(&d.join("a.sqlnb")).unwrap(), None);
    }

    #[test]
    fn roundtrip_and_overwrite() {
        let d = tmp("rt");
        let p = d.join("a.sqlnb");
        let m = write_out(&p, "one").unwrap();
        assert_eq!(read_out(&p).unwrap(), Some(("one".to_string(), m)));
        assert!(d.join("a.sqlnb.out").is_file());
        write_out(&p, "two").unwrap();
        assert_eq!(read_out(&p).unwrap().unwrap().0, "two");
        assert_eq!(count(&d), 1);
    }

    #[test]
    fn parent_missing_not_created() {
        let d = tmp("parent");
        let p = d.join("nope").join("a.sqlnb");
        assert_eq!(write_out(&p, "x").unwrap_err().code, PARENT_MISSING);
        assert!(!d.join("nope").exists());
    }

    #[test]
    fn wrong_extensions_rejected() {
        let d = tmp("ext");
        for n in ["a.txt", "a.sqlnb.out", "a"] {
            let p = d.join(n);
            assert_eq!(read_out(&p).unwrap_err().code, BAD_PARAMS, "{n}");
            assert_eq!(write_out(&p, "x").unwrap_err().code, BAD_PARAMS, "{n}");
            assert_eq!(delete_out(&p).unwrap_err().code, BAD_PARAMS, "{n}");
        }
        assert_eq!(count(&d), 0);
    }

    #[test]
    fn delete_existing_and_missing() {
        let d = tmp("del");
        let p = d.join("a.sqlnb");
        assert!(!delete_out(&p).unwrap());
        write_out(&p, "x").unwrap();
        assert!(delete_out(&p).unwrap());
        assert_eq!(read_out(&p).unwrap(), None);
        assert!(!delete_out(&p).unwrap());
    }

    #[test]
    fn five_mb_roundtrip() {
        let d = tmp("big");
        let p = d.join("a.sqlnb");
        let text = "x".repeat(5 * 1024 * 1024);
        write_out(&p, &text).unwrap();
        assert_eq!(read_out(&p).unwrap().unwrap().0, text);
    }

    #[test]
    fn unicode_path_and_content() {
        let d = tmp("uni");
        let p = d.join("分析 报告.sqlnb");
        let m = write_out(&p, "内容 ✓ 🚀").unwrap();
        assert_eq!(read_out(&p).unwrap(), Some(("内容 ✓ 🚀".to_string(), m)));
        assert!(d.join("分析 报告.sqlnb.out").is_file());
    }

    #[test]
    fn reading_directory_is_io_error() {
        let d = tmp("dir");
        fs::create_dir(d.join("x.sqlnb.out")).unwrap();
        assert_eq!(read_out(&d.join("x.sqlnb")).unwrap_err().code, IO);
    }

    #[test]
    fn invalid_utf8_is_read_lossily() {
        let d = tmp("utf8");
        fs::write(d.join("a.sqlnb.out"), [0xffu8, 0xfe, b'{']).unwrap();
        let (t, _) = read_out(&d.join("a.sqlnb")).unwrap().unwrap();
        assert_eq!(t, "\u{fffd}\u{fffd}{");
    }

    #[cfg(unix)]
    #[test]
    fn no_temp_left_after_forced_failure() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("ro");
        let p = d.join("a.sqlnb");
        fs::set_permissions(&d, fs::Permissions::from_mode(0o555)).unwrap();
        let unwritable = fs::File::create(d.join("probe")).is_err();
        let _ = fs::remove_file(d.join("probe"));
        let r = write_out(&p, "x");
        fs::set_permissions(&d, fs::Permissions::from_mode(0o755)).unwrap();
        if unwritable {
            assert_eq!(r.unwrap_err().code, IO);
            assert_eq!(count(&d), 0);
        } else {
            assert!(r.is_ok());
            let names: Vec<String> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            assert_eq!(names, vec!["a.sqlnb.out".to_string()]);
        }
    }

    // Chosen behaviour: write replaces a symlinked .out (rename swaps the link); the target is untouched.
    #[cfg(unix)]
    #[test]
    fn symlinked_out_is_replaced_not_followed() {
        let d = tmp("sym");
        let target = d.join("target.txt");
        fs::write(&target, "orig").unwrap();
        std::os::unix::fs::symlink(&target, d.join("a.sqlnb.out")).unwrap();
        write_out(&d.join("a.sqlnb"), "new").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "orig");
        assert!(!fs::symlink_metadata(d.join("a.sqlnb.out")).unwrap().file_type().is_symlink());
        assert_eq!(read_out(&d.join("a.sqlnb")).unwrap().unwrap().0, "new");
    }
}
