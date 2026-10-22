//! Pure dispatch for the sidecar's `engine/*` RPC methods.
//!
//! `engine/query` on a session that does not exist runs against a fresh empty session
//! (created via `get_or_create`); that session persists in the LRU like any other.
use crate::{dialect_hint, ColumnSpec, EngineError, Sessions};
use crate::engine::ResultEngine;
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, MutexGuard};

const DEFAULT_MAX_ROWS: i64 = 5000;
const MAX_COLUMNS: usize = 500;

fn bad(name: &str) -> EngineError {
    EngineError::invalid(format!("Missing/invalid param: {name}"))
}

fn lock(m: &Mutex<Sessions>) -> MutexGuard<'_, Sessions> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn session_id(params: &Value) -> Result<&str, EngineError> {
    let id = params.get("sessionId").and_then(Value::as_str).ok_or_else(|| bad("sessionId"))?;
    if (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        Ok(id)
    } else {
        Err(EngineError::invalid("invalid sessionId"))
    }
}

fn table_name(params: &Value) -> Result<&str, EngineError> {
    let raw = params.get("name").and_then(Value::as_str).ok_or_else(|| bad("name"))?;
    let n = raw.trim();
    let len = n.chars().count();
    if len == 0 || len > 128 {
        return Err(bad("name"));
    }
    if raw.chars().any(char::is_control) {
        return Err(EngineError::invalid("invalid param: name"));
    }
    Ok(n)
}

fn parse_columns(params: &Value) -> Result<Vec<ColumnSpec>, EngineError> {
    let arr = params.get("columns").and_then(Value::as_array).ok_or_else(|| bad("columns"))?;
    if arr.len() > MAX_COLUMNS {
        return Err(EngineError::invalid(format!("too many columns: {} exceeds limit {MAX_COLUMNS}", arr.len())));
    }
    arr.iter()
        .map(|c| {
            let name = c.get("name").and_then(Value::as_str).ok_or_else(|| bad("columns"))?;
            if name.is_empty() || name.chars().count() > 128 || name.chars().any(char::is_control) {
                return Err(bad("columns"));
            }
            let type_hint = match c.get("type") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if s.chars().count() <= 32 => Some(s.clone()),
                Some(_) => return Err(bad("columns")),
            };
            Ok(ColumnSpec { name: name.to_string(), type_hint })
        })
        .collect()
}

fn parse_rows(params: &Value) -> Result<Vec<Vec<Value>>, EngineError> {
    let arr = params.get("rows").and_then(Value::as_array).ok_or_else(|| bad("rows"))?;
    arr.iter().map(|r| r.as_array().cloned().ok_or_else(|| bad("rows"))).collect()
}

fn max_rows(params: &Value) -> usize {
    let n = params.get("maxRows").and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|u| u.min(i64::MAX as u64) as i64)));
    n.unwrap_or(DEFAULT_MAX_ROWS).clamp(1, DEFAULT_MAX_ROWS) as usize
}

fn panic_error() -> EngineError {
    EngineError::new(-32603, "internal error in engine")
}

/// Runs `f` under the lock, converting a panic into -32603 and evicting the session.
fn guarded<T>(
    sessions: &Mutex<Sessions>,
    sid: &str,
    f: impl FnOnce(&mut Sessions) -> Result<T, EngineError>,
) -> Result<T, EngineError> {
    let res = catch_unwind(AssertUnwindSafe(|| {
        let mut g = lock(sessions);
        f(&mut g)
    }));
    match res {
        Ok(r) => r,
        Err(_) => {
            lock(sessions).close(sid);
            Err(panic_error())
        }
    }
}

/// Returns `None` unless `method` is exactly one of the known `engine/*` methods.
pub fn dispatch(sessions: &Mutex<Sessions>, method: &str, params: &Value) -> Option<Result<Value, EngineError>> {
    if !matches!(method, "engine/register" | "engine/drop" | "engine/query" | "engine/close" | "engine/status") {
        return None;
    }
    Some(run(sessions, method, params))
}

fn run(sessions: &Mutex<Sessions>, method: &str, params: &Value) -> Result<Value, EngineError> {
    match method {
        "engine/register" => {
            let sid = session_id(params)?;
            let name = table_name(params)?;
            let columns = parse_columns(params)?;
            let rows = parse_rows(params)?;
            let (n, total) = guarded(sessions, sid, |s| {
                let e = s.get_or_create(sid)?;
                e.register(name, &columns, &rows)?;
                Ok((rows.len(), e.total_rows()))
            })?;
            Ok(json!({ "rows": n, "total": total }))
        }
        "engine/drop" => {
            let sid = session_id(params)?;
            let name = table_name(params)?;
            guarded(sessions, sid, |s| match s.get(sid) {
                Some(e) => e.drop_table(name),
                None => Ok(()),
            })?;
            Ok(json!({}))
        }
        "engine/query" => {
            let sid = session_id(params)?;
            let sql = params.get("sql").and_then(Value::as_str).ok_or_else(|| bad("sql"))?;
            let limit = max_rows(params);
            let out = guarded(sessions, sid, |s| s.get_or_create(sid)?.query(sql, limit)).map_err(|mut e| {
                if let Some(rule) = dialect_hint(sql, &e.message) {
                    e.message = format!("{}\nhint:{rule}", e.message);
                }
                e
            })?;
            let columns: Vec<Value> =
                out.columns.iter().map(|c| json!({ "name": c.name, "type": c.type_name })).collect();
            Ok(json!({ "columns": columns, "rows": out.rows, "truncated": out.truncated, "elapsedMs": out.elapsed_ms }))
        }
        "engine/close" => {
            let sid = session_id(params)?;
            let closed = guarded(sessions, sid, |s| Ok(s.close(sid)))?;
            Ok(json!({ "closed": closed }))
        }
        "engine/status" => {
            let sid = session_id(params)?;
            let tables = guarded(sessions, sid, |s| Ok(s.table_summary(sid)))?;
            Ok(match tables {
                Some(t) => json!({
                    "exists": true,
                    "tables": t.iter().map(|(n, r)| json!({ "name": n, "rows": r })).collect::<Vec<_>>(),
                }),
                None => json!({ "exists": false, "tables": [] }),
            })
        }
        _ => Err(EngineError::new(-32603, "internal error in engine")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const S: &str = "session-0001";

    fn sess() -> Mutex<Sessions> {
        Mutex::new(Sessions::default())
    }
    fn call(m: &Mutex<Sessions>, method: &str, p: Value) -> Result<Value, EngineError> {
        dispatch(m, method, &p).expect("engine method")
    }
    fn reg(m: &Mutex<Sessions>, sid: &str, name: &str) -> Value {
        call(
            m,
            "engine/register",
            json!({"sessionId": sid, "name": name, "columns": [{"name":"d","type":"date"},{"name":"x","type":"integer"}],
                "rows": [["2024-01-15", 1], ["2024-01-20", 3], ["2024-02-01", null], ["2024-02-10", 5], ["2024-02-11", 9007199254740993i64]]}),
        )
        .unwrap()
    }
    fn code(r: Result<Value, EngineError>) -> i32 {
        r.unwrap_err().code
    }

    #[test]
    fn register_counts_and_round_trip() {
        let m = sess();
        assert_eq!(reg(&m, S, "t"), json!({"rows": 5, "total": 5}));
        let r = reg(&m, S, "u");
        assert_eq!(r, json!({"rows": 5, "total": 10}));
        let q = call(&m, "engine/query", json!({"sessionId": S,
            "sql": "SELECT date_trunc('month', d) AS m, median(x) AS med, count(*) c FROM t GROUP BY 1 ORDER BY 1"})).unwrap();
        assert_eq!(q["columns"].as_array().unwrap().len(), 3);
        assert_eq!(q["rows"].as_array().unwrap().len(), 2);
        assert_eq!(q["truncated"], json!(false));
        assert!(q["elapsedMs"].is_u64());
    }

    #[test]
    fn big_int_is_string() {
        let m = sess();
        reg(&m, S, "t");
        let q = call(&m, "engine/query", json!({"sessionId": S, "sql": "SELECT x FROM t ORDER BY x DESC LIMIT 1"})).unwrap();
        assert_eq!(q["rows"][0][0], json!("9007199254740993"));
    }

    #[test]
    fn drop_unknown_ok_and_known_removed() {
        let m = sess();
        assert_eq!(call(&m, "engine/drop", json!({"sessionId": S, "name": "zz"})).unwrap(), json!({}));
        reg(&m, S, "t");
        call(&m, "engine/drop", json!({"sessionId": S, "name": "zz"})).unwrap();
        call(&m, "engine/drop", json!({"sessionId": S, "name": "t"})).unwrap();
        let st = call(&m, "engine/status", json!({"sessionId": S})).unwrap();
        assert_eq!(st["tables"], json!([]));
    }

    #[test]
    fn query_unknown_session_persists_fresh() {
        let m = sess();
        let e = call(&m, "engine/query", json!({"sessionId": S, "sql": "SELECT * FROM t"})).unwrap_err();
        assert!(e.message.contains("no such table"));
        assert!(!e.message.contains("hint:"));
        assert_eq!(call(&m, "engine/status", json!({"sessionId": S})).unwrap()["exists"], json!(true));
        assert_eq!(call(&m, "engine/query", json!({"sessionId": S, "sql": "SELECT 1"})).unwrap()["rows"], json!([[1]]));
    }

    #[test]
    fn status_never_creates_and_close() {
        let m = sess();
        assert_eq!(call(&m, "engine/status", json!({"sessionId": S})).unwrap(), json!({"exists": false, "tables": []}));
        assert!(m.lock().unwrap().is_empty());
        assert_eq!(call(&m, "engine/close", json!({"sessionId": S})).unwrap(), json!({"closed": false}));
        reg(&m, S, "b");
        reg(&m, S, "a");
        let st = call(&m, "engine/status", json!({"sessionId": S})).unwrap();
        assert_eq!(st, json!({"exists": true, "tables": [{"name":"a","rows":5},{"name":"b","rows":5}]}));
        assert_eq!(call(&m, "engine/close", json!({"sessionId": S})).unwrap(), json!({"closed": true}));
        assert_eq!(call(&m, "engine/status", json!({"sessionId": S})).unwrap()["exists"], json!(false));
    }

    #[test]
    fn invalid_session_ids() {
        let m = sess();
        let long = "a".repeat(65);
        for method in ["engine/register", "engine/drop", "engine/query", "engine/close", "engine/status"] {
            for sid in [json!("short"), json!(long), json!("bad id!!!!"), json!("bad/idxxxx"), json!(5), Value::Null] {
                let p = json!({"sessionId": sid, "name": "t", "columns": [{"name":"a"}], "rows": [], "sql": "SELECT 1"});
                assert_eq!(code(call(&m, method, p)), -32602, "{method} {sid}");
            }
            let p = json!({"name": "t", "columns": [{"name":"a"}], "rows": [], "sql": "SELECT 1"});
            assert_eq!(code(call(&m, method, p)), -32602, "{method} missing");
        }
        let e = call(&m, "engine/close", json!({"sessionId": "x"})).unwrap_err();
        assert_eq!(e.rpc_message().starts_with("[-32602] "), true);
        assert!(m.lock().unwrap().is_empty());
    }

    #[test]
    fn missing_or_ill_typed_params() {
        let m = sess();
        let ok_cols = json!([{"name":"a"}]);
        let cases = vec![
            ("engine/register", json!({"sessionId": S, "columns": ok_cols, "rows": []}), "name"),
            ("engine/register", json!({"sessionId": S, "name": 5, "columns": ok_cols, "rows": []}), "name"),
            ("engine/register", json!({"sessionId": S, "name": "  ", "columns": ok_cols, "rows": []}), "name"),
            ("engine/register", json!({"sessionId": S, "name": "x".repeat(129), "columns": ok_cols, "rows": []}), "name"),
            ("engine/register", json!({"sessionId": S, "name": "t", "rows": []}), "columns"),
            ("engine/register", json!({"sessionId": S, "name": "t", "columns": "a", "rows": []}), "columns"),
            ("engine/register", json!({"sessionId": S, "name": "t", "columns": [{"x":1}], "rows": []}), "columns"),
            ("engine/register", json!({"sessionId": S, "name": "t", "columns": [{"name":"a","type":3}], "rows": []}), "columns"),
            ("engine/register", json!({"sessionId": S, "name": "t", "columns": ok_cols}), "rows"),
            ("engine/register", json!({"sessionId": S, "name": "t", "columns": ok_cols, "rows": [1]}), "rows"),
            ("engine/register", json!({"sessionId": S, "name": "t", "columns": ok_cols, "rows": "x"}), "rows"),
            ("engine/drop", json!({"sessionId": S}), "name"),
            ("engine/query", json!({"sessionId": S}), "sql"),
            ("engine/query", json!({"sessionId": S, "sql": 1}), "sql"),
        ];
        for (method, p, field) in cases {
            let e = call(&m, method, p.clone()).unwrap_err();
            assert_eq!(e.code, -32602, "{p}");
            assert_eq!(e.message, format!("Missing/invalid param: {field}"), "{p}");
        }
    }

    #[test]
    fn register_name_and_column_hardening() {
        let m = sess();
        let r = |name: &str, cols: Value| {
            call(&m, "engine/register", json!({"sessionId": S, "name": name, "columns": cols, "rows": []}))
        };
        let ok = json!([{"name":"a"}]);
        for good in ["表😀", "naïve"] {
            r(good, ok.clone()).unwrap();
        }
        r("c", json!([{"name":"é😀","type":"x".repeat(32)}])).unwrap();
        for bad_name in ["a\u{0}b", "a\u{7}b", "a\u{7f}", "a\u{85}", "a\nb", &"x".repeat(129)] {
            assert_eq!(code(r(bad_name, ok.clone())), -32602, "{bad_name:?}");
        }
        let long = "y".repeat(129);
        for cols in [
            json!([{"name":""}]),
            json!([{"name":"a\u{7}"}]),
            json!([{"name":"a\u{9f}"}]),
            json!([{"name": long}]),
            json!([{"name":"a","type":"x".repeat(33)}]),
        ] {
            assert_eq!(code(r("t2", cols.clone())), -32602, "{cols}");
        }
        assert_eq!(r("t3", json!([{"name":"y".repeat(128)}])).is_ok(), true);
    }

    #[test]
    fn too_many_columns_and_ragged_rows() {
        let m = sess();
        let cols: Vec<Value> = (0..501).map(|i| json!({"name": format!("c{i}")})).collect();
        assert_eq!(code(call(&m, "engine/register", json!({"sessionId": S, "name": "t", "columns": cols, "rows": []}))), -32602);
        let e = call(&m, "engine/register", json!({"sessionId": S, "name": "t", "columns": [{"name":"a"},{"name":"b"}], "rows": [[1,2],[3]]})).unwrap_err();
        assert_eq!(e.code, -32602);
        assert!(e.message.contains("row 1"));
    }

    #[test]
    fn max_rows_clamping() {
        let m = sess();
        let sql = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 6000) SELECT i FROM n";
        let n = |mr: Value| {
            let mut p = json!({"sessionId": S, "sql": sql});
            if !mr.is_null() {
                p["maxRows"] = mr;
            }
            call(&m, "engine/query", p).unwrap()["rows"].as_array().unwrap().len()
        };
        assert_eq!(n(Value::Null), 5000);
        assert_eq!(n(json!(0)), 1);
        assert_eq!(n(json!(-1)), 1);
        assert_eq!(n(json!(10)), 10);
        assert_eq!(n(json!(1_000_000_000)), 5000);
        assert_eq!(n(json!(1e9)), 5000);
        assert_eq!(n(json!("x")), 5000);
        assert_eq!(n(json!(2.5)), 5000);
        assert_eq!(call(&m, "engine/query", json!({"sessionId": S, "sql": sql})).unwrap()["truncated"], json!(true));
    }

    #[test]
    fn error_format_and_hints() {
        let m = sess();
        reg(&m, S, "t");
        let e = call(&m, "engine/query", json!({"sessionId": S, "sql": "SELECT x::int FROM t"})).unwrap_err();
        assert!(e.rpc_message().starts_with(&format!("[{}] ", e.code)));
        assert!(e.rpc_message().ends_with("\nhint:cast_operator"), "{}", e.rpc_message());
        let e = call(&m, "engine/query", json!({"sessionId": S, "sql": "SELECT * FROM nope"})).unwrap_err();
        assert!(e.message.contains("no such table"));
        assert!(!e.message.contains("hint:"));
    }

    #[test]
    fn read_only_violation_keeps_session() {
        let m = sess();
        reg(&m, S, "t");
        let e = call(&m, "engine/query", json!({"sessionId": S, "sql": "DROP TABLE t"})).unwrap_err();
        assert_eq!(e.code, -32602);
        assert!(e.message.contains("read_only"));
        let q = call(&m, "engine/query", json!({"sessionId": S, "sql": "SELECT count(*) FROM t"})).unwrap();
        assert_eq!(q["rows"], json!([[5]]));
    }

    #[test]
    fn non_engine_method_is_none() {
        let m = sess();
        assert!(dispatch(&m, "notebook/read", &json!({})).is_none());
        assert!(dispatch(&m, "engine", &json!({})).is_none());
        assert!(dispatch(&m, "engine/nope", &json!({})).is_none());
        assert!(dispatch(&m, "engine/", &json!({})).is_none());
        assert!(dispatch(&m, "engine/status ", &json!({})).is_none());
    }

    #[test]
    fn hundred_thousand_rows() {
        let m = sess();
        let rows: Vec<Value> = (0..100_000).map(|i| json!([i, "v"])).collect();
        let r = call(&m, "engine/register", json!({"sessionId": S, "name": "big", "columns": [{"name":"a"},{"name":"b"}], "rows": rows})).unwrap();
        assert_eq!(r, json!({"rows": 100000, "total": 100000}));
    }

    #[test]
    fn poisoned_mutex_recovers() {
        let m = Arc::new(sess());
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("boom");
        })
        .join();
        assert!(m.is_poisoned());
        assert_eq!(reg(&m, S, "t"), json!({"rows": 5, "total": 5}));
        assert_eq!(call(&m, "engine/status", json!({"sessionId": S})).unwrap()["exists"], json!(true));
    }

    #[test]
    fn panic_is_mapped_and_session_evicted() {
        let m = sess();
        reg(&m, S, "t");
        let r: Result<(), _> = guarded(&m, S, |_| panic!("engine bug"));
        let e = r.unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (-32603, "internal error in engine"));
        assert_eq!(call(&m, "engine/status", json!({"sessionId": S})).unwrap()["exists"], json!(false));
        assert_eq!(reg(&m, S, "t"), json!({"rows": 5, "total": 5}));
    }

    #[test]
    fn concurrent_sessions_no_deadlock() {
        let m = Arc::new(sess());
        let (tx, rx) = std::sync::mpsc::channel();
        for sid in ["session-aaaa", "session-bbbb"] {
            let (m, tx) = (m.clone(), tx.clone());
            std::thread::spawn(move || {
                for _ in 0..20 {
                    reg(&m, sid, "t");
                    call(&m, "engine/query", json!({"sessionId": sid, "sql": "SELECT count(*) FROM t"})).unwrap();
                }
                tx.send(()).unwrap();
            });
        }
        for _ in 0..2 {
            rx.recv_timeout(std::time::Duration::from_secs(30)).expect("deadlock");
        }
    }
}
