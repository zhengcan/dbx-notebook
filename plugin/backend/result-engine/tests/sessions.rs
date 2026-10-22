use result_engine::{ColumnSpec, ResultEngine, Sessions};
use serde_json::json;

fn col(n: &str) -> ColumnSpec { ColumnSpec { name: n.into(), type_hint: None } }
fn put(s: &mut Sessions, id: &str, table: &str) {
    s.get_or_create(id).unwrap().register(table, &[col("a")], &[vec![json!(1)], vec![json!(2)]]).unwrap();
}

#[test]
fn sessions_are_isolated() {
    let mut s = Sessions::default();
    put(&mut s, "session-aaaa", "t1");
    put(&mut s, "session-bbbb", "t2");
    let e = s.get("session-bbbb").unwrap().query("SELECT * FROM t1", 10).unwrap_err();
    assert_eq!(e.code, -32602);
    assert!(s.get("session-aaaa").unwrap().query("SELECT * FROM t1", 10).is_ok());
}

#[test]
fn evicts_least_recently_used_and_refreshes_on_access() {
    let mut s = Sessions::new(3, tl());
    for id in ["session-0001", "session-0002", "session-0003"] { put(&mut s, id, "t"); }
    assert!(s.get("session-0001").is_some()); // refresh 1; LRU is now 2
    put(&mut s, "session-0004", "t");
    assert_eq!(s.len(), 3);
    assert!(!s.contains("session-0002"));
    assert!(s.contains("session-0001") && s.contains("session-0003") && s.contains("session-0004"));
    s.get_or_create("session-0003").unwrap(); // refresh 3; LRU is 1
    put(&mut s, "session-0005", "t");
    assert!(!s.contains("session-0001"));
}

#[test]
fn ninth_session_evicts_oldest_by_default() {
    let mut s = Sessions::default();
    for i in 0..9 { put(&mut s, &format!("session-{i:04}"), "t"); }
    assert_eq!(s.len(), 8);
    assert!(!s.contains("session-0000"));
    assert!(s.contains("session-0008"));
}

#[test]
fn get_does_not_create_and_close_gives_empty_db() {
    let mut s = Sessions::default();
    assert!(s.get("session-none").is_none());
    assert_eq!(s.len(), 0);
    put(&mut s, "session-aaaa", "t");
    assert!(s.close("session-aaaa"));
    assert!(!s.close("session-aaaa"));
    assert!(!s.contains("session-aaaa"));
    let e = s.get_or_create("session-aaaa").unwrap();
    assert_eq!(e.total_rows(), 0);
    assert!(e.query("SELECT * FROM t", 10).is_err());
}

#[test]
fn rejects_invalid_ids() {
    let mut s = Sessions::default();
    for id in ["", "short", "bad id bad id", "bad/id/bad/id", "日本語日本語日本語日本語", &"a".repeat(65)] {
        let e = s.get_or_create(id).err().unwrap();
        assert_eq!(e.code, -32602, "{id}");
        assert!(e.message.contains("invalid sessionId"));
    }
    assert!(s.get_or_create(&"a".repeat(64)).is_ok());
    assert!(s.get_or_create("abcdefgh").is_ok());
    assert!(s.get_or_create("A_b-C_d-1").is_ok());
    assert_eq!(s.len(), 3);
}

#[test]
fn table_summary_sorted_with_counts() {
    let mut s = Sessions::default();
    put(&mut s, "session-aaaa", "zeta");
    put(&mut s, "session-aaaa", "alpha");
    assert_eq!(s.table_summary("session-aaaa"), Some(vec![("alpha".into(), 2), ("zeta".into(), 2)]));
    assert_eq!(s.table_summary("session-zzzz"), None);
}


// Tests never rely on the 30 s default timeout.
fn tl() -> result_engine::Limits {
    result_engine::Limits { query_timeout: std::time::Duration::from_secs(10), ..Default::default() }
}
