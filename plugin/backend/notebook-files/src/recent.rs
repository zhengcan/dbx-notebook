use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{NbError, Result, IO};

const MAX_ITEMS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub opened_at: i64,
}

pub fn list(data_dir: &Path) -> Vec<RecentItem> {
    fs::read_to_string(data_dir.join("recent.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn touch(data_dir: &Path, path: &str, title: Option<String>, now_ms: i64) -> Result<()> {
    let mut items = list(data_dir);
    items.retain(|i| i.path != path);
    items.push(RecentItem { path: path.to_string(), title, opened_at: now_ms });
    items.sort_by(|a, b| b.opened_at.cmp(&a.opened_at));
    items.truncate(MAX_ITEMS);
    let io = |e: std::io::Error| NbError::new(IO, e.to_string());
    fs::create_dir_all(data_dir).map_err(io)?;
    let json = serde_json::to_string_pretty(&items).map_err(|e| NbError::new(IO, e.to_string()))?;
    let target = data_dir.join("recent.json");
    let tmp = data_dir.join(format!("recent.json.tmp-{}", std::process::id()));
    if let Err(e) = fs::write(&tmp, json).and_then(|_| fs::rename(&tmp, &target)) {
        let _ = fs::remove_file(&tmp);
        return Err(io(e));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nbr-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn recent_dedup_and_cap_20() {
        let d = tmp("cap");
        for i in 0..25 {
            touch(&d, &format!("/n/{i}.sqlnb"), None, 1000 + i).unwrap();
        }
        touch(&d, "/n/10.sqlnb", Some("T".into()), 5000).unwrap();
        let items = list(&d);
        assert_eq!(items.len(), 20);
        assert_eq!(items[0].path, "/n/10.sqlnb");
        assert_eq!(items[0].title.as_deref(), Some("T"));
        assert_eq!(items.iter().filter(|i| i.path == "/n/10.sqlnb").count(), 1);
        assert!(items.windows(2).all(|w| w[0].opened_at >= w[1].opened_at));
    }

    #[test]
    fn recent_touch_leaves_no_temp_files() {
        let d = tmp("notmp");
        touch(&d, "/n/x.sqlnb", None, 1).unwrap();
        touch(&d, "/n/y.sqlnb", None, 2).unwrap();
        let names: Vec<_> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("recent.json")]);
    }

    #[test]
    fn recent_failed_write_cleans_up_temp() {
        let d = tmp("fail");
        fs::create_dir_all(d.join("recent.json").join("child")).unwrap();
        assert!(touch(&d, "/n/x.sqlnb", None, 1).is_err());
        let names: Vec<_> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[test]
    fn recent_missing_data_dir_is_created() {
        let d = tmp("mk").join("a").join("b");
        assert!(list(&d).is_empty());
        touch(&d, "/n/x.sqlnb", None, 1).unwrap();
        assert!(d.join("recent.json").exists());
    }

    #[test]
    fn recent_tolerates_corrupt_json() {
        let d = tmp("bad");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("recent.json"), "{not json").unwrap();
        assert!(list(&d).is_empty());
        touch(&d, "/n/x.sqlnb", None, 1).unwrap();
        assert_eq!(list(&d).len(), 1);
    }
}
