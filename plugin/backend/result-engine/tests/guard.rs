use result_engine::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn cols(n: &[&str]) -> Vec<ColumnSpec> {
    n.iter().map(|x| ColumnSpec { name: x.to_string(), type_hint: None }).collect()
}
fn eng_with(l: Limits) -> SqliteEngine {
    let mut e = SqliteEngine::new(l);
    let rows: Vec<Vec<Value>> = (0..3).map(|i| vec![json!(i), json!(format!("n{i}"))]).collect();
    e.register("t", &cols(&["id", "name"]), &rows).unwrap();
    e
}
fn eng() -> SqliteEngine {
    eng_with(tl())
}
fn alive(e: &mut SqliteEngine) {
    let q = e.query("SELECT count(*) FROM t", 10).unwrap();
    assert_eq!(q.rows[0][0], json!(3));
    e.register("fresh", &cols(&["a"]), &[vec![json!(1)]]).unwrap();
    e.drop_table("fresh").unwrap();
}
fn rejected(sql: &str, code: i32, frag: &str) {
    let mut e = eng();
    let err = e.query(sql, 10).unwrap_err();
    assert_eq!(err.code, code, "{sql:?} -> {err}");
    assert!(err.message.contains(frag), "{sql:?} -> {err}");
    assert!(err.message.len() < 300);
    alive(&mut e);
}

#[test]
fn single_statement_variants_ok() {
    let mut e = eng();
    for s in [
        "SELECT 1;", "SELECT 1; -- comment", "SELECT 1;;", "SELECT 1;  \n\t ", "SELECT 1 /* ; DROP TABLE t */",
        "/* lead */ SELECT 1 -- x", "SELECT * FROM \"t\" WHERE name = 'a;b'", "SELECT 'it''s; ok'",
        "SELECT 1 AS \"a;b\"", "SELECT 1 AS [a;b]", "VALUES (1),(2)", "SELECT 1; /* a */ -- b\n",
        "SELECT a.id, row_number() OVER (ORDER BY a.id) FROM t a JOIN t b ON a.id=b.id WHERE a.id IN (SELECT id FROM t)",
        "WITH x AS (SELECT 1 AS v) SELECT v FROM x",
        "SELECT * FROM sqlite_master",
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<5) SELECT count(*) FROM c",
        "SELECT 1 AS \"名前\" FROM t WHERE name <> '日本;'",
    ] {
        e.query(s, 10).unwrap_or_else(|er| panic!("{s:?}: {er}"));
    }
    assert_eq!(e.query("VALUES (1),(2)", 10).unwrap().rows.len(), 2);
    alive(&mut e);
}

#[test]
fn empty_and_multi() {
    for s in ["", "   ", "-- only comment", "/* c */", ";", " ; ", "/* unterminated"] {
        rejected(s, -32602, "empty");
    }
    for s in ["SELECT 1; SELECT 2", "; DROP TABLE t", "SELECT 1; DROP TABLE t", "SELECT 1; -- c\nSELECT 2", "SELECT 1;;SELECT 2"] {
        rejected(s, -32602, "multiple_statements");
    }
}

#[test]
fn write_and_admin_statements_rejected() {
    for s in [
        "ATTACH DATABASE ':memory:' AS x", "DETACH DATABASE main", "PRAGMA table_info(t)", "PRAGMA user_version",
        "PRAGMA writable_schema=ON", "CREATE TABLE z(a)", "CREATE TEMP TABLE z(a)", "CREATE VIEW v AS SELECT 1",
        "CREATE TEMP VIEW v AS SELECT 1", "CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END",
        "INSERT INTO t VALUES (9,'x')", "UPDATE t SET id=1", "DELETE FROM t", "DROP TABLE t",
        "ALTER TABLE t RENAME TO u", "VACUUM", "REINDEX", "ANALYZE", "BEGIN", "COMMIT", "SAVEPOINT a", "ROLLBACK",
        "WITH x AS (SELECT 1) INSERT INTO t VALUES (1,'a')", "WITH x AS (SELECT 1) DELETE FROM t",
        "WITH x AS (SELECT 1) UPDATE t SET id=0", "REPLACE INTO t VALUES (1,'a')",
        "INSERT INTO t VALUES (1,'a') RETURNING id", "EXPLAIN SELECT 1", "EXPLAIN QUERY PLAN SELECT 1",
        "SELECT * FROM sqlite_stat1", "SELECT * FROM sqlite_temp_master",
    ] {
        let mut e = eng();
        let err = e.query(s, 10).err().unwrap_or_else(|| panic!("accepted: {s}"));
        assert_eq!(err.code, -32602, "{s}: {err}");
        assert!(err.message.contains("read_only") || err.message.contains("multiple_statements") || err.message.contains("no such table"), "{s}: {err}");
        alive(&mut e);
    }
}

#[test]
fn attach_creates_no_file() {
    let p = std::path::Path::new("/tmp/evil_sqlnb_guard.db");
    let _ = std::fs::remove_file(p);
    rejected("ATTACH DATABASE '/tmp/evil_sqlnb_guard.db' AS x", -32602, "read_only");
    assert!(!p.exists());
}

#[test]
fn dangerous_functions() {
    let mut e = eng();
    for s in ["SELECT load_extension('x')", "SELECT readfile('/etc/passwd')", "SELECT writefile('/tmp/x_sqlnb','a')", "SELECT edit('a')"] {
        let err = e.query(s, 10).unwrap_err();
        assert_eq!(err.code, -32602, "{s}: {err}");
    }
    assert!(!std::path::Path::new("/tmp/x_sqlnb").exists());
    alive(&mut e);
}

#[test]
fn nul_and_too_long() {
    rejected("SELECT 1\0; DROP TABLE t", -32602, "invalid");
    let long = format!("SELECT '{}'", "a".repeat(1_000_001));
    rejected(&long, -32602, "sql too long");
    let ok = format!("SELECT '{}'", "a".repeat(900_000));
    let mut e = eng();
    assert_eq!(e.query(&ok, 10).unwrap().rows.len(), 1);
}

fn slow_engine() -> SqliteEngine {
    let mut e = eng_with(Limits { query_timeout: Duration::from_millis(50), ..tl() });
    let rows: Vec<Vec<Value>> = (0..5000).map(|i| vec![json!(i)]).collect();
    e.register("a", &cols(&["x"]), &rows).unwrap();
    e.register("b", &cols(&["x"]), &rows).unwrap();
    e
}

#[test]
fn timeouts() {
    let mut e = slow_engine();
    for s in [
        "SELECT count(*) FROM a, b, a AS c",
        "SELECT * FROM a, b, a AS c WHERE a.x+b.x+c.x < 0",
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
        "SELECT * FROM a, b, a AS c ORDER BY a.x+b.x+c.x DESC",
    ] {
        let t = Instant::now();
        let err = e.query(s, 10).unwrap_err();
        assert_eq!(err.code, -32020, "{s}: {err}");
        assert!(err.message.contains("timed out after 50 ms"), "{err}");
        assert!(t.elapsed() < Duration::from_secs(3), "{s}");
        alive(&mut e);
    }
    e.register("after", &cols(&["a"]), &[vec![json!(1)]]).unwrap();
}

#[test]
fn timeout_during_iteration() {
    let mut e = slow_engine();
    let s = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c";
    let err = e.query(s, usize::MAX).unwrap_err();
    assert_eq!(err.code, -32020, "{err}");
    alive(&mut e);
}

#[test]
fn memory_bombs() {
    let mut e = eng();
    for s in [
        "SELECT randomblob(2000000000)", "SELECT zeroblob(2000000000)", "SELECT printf('%.*c', 2000000000, 'x')",
        "SELECT hex(zeroblob(100000000))", "SELECT replace(printf('%.*c', 60000000, 'x'), 'x', 'xxxxxxxxxx')",
        "SELECT length(randomblob(100000000))",
    ] {
        let t = Instant::now();
        match e.query(s, 10) {
            // printf/replace-style functions yield NULL on SQLITE_TOOBIG; nothing is allocated
            Ok(q) => assert_eq!(q.rows[0][0], Value::Null, "{s}"),
            Err(err) => assert_eq!(err.code, -32602, "{s}: {err}"),
        }
        assert!(t.elapsed() < Duration::from_secs(5));
        alive(&mut e);
    }
}

#[test]
fn result_byte_cap_truncates() {
    let mut e = eng_with(Limits { max_result_bytes: 10_000, ..tl() });
    let q = e.query("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<1000) SELECT printf('%.*c', 1000, 'x') FROM c", 100000).unwrap();
    assert!(q.truncated);
    assert!(q.rows.len() >= 9 && q.rows.len() <= 12, "{}", q.rows.len());
    let q = e.query("SELECT 'abc' FROM t", 100).unwrap();
    assert!(!q.truncated);
    assert_eq!(q.rows.len(), 3);
    alive(&mut e);
}

#[test]
fn max_rows_exact() {
    let mut e = eng();
    let q = e.query("SELECT * FROM t", 3).unwrap();
    assert!(!q.truncated && q.rows.len() == 3);
    let q = e.query("SELECT * FROM t", 2).unwrap();
    assert!(q.truncated && q.rows.len() == 2);
}

#[test]
fn register_after_failures_and_successes() {
    let mut e = eng();
    let _ = e.query("ATTACH DATABASE ':memory:' AS x", 10);
    e.register("r1", &cols(&["a"]), &[vec![json!(1)]]).unwrap();
    e.query("SELECT 1", 10).unwrap();
    e.register("r2", &cols(&["a"]), &[vec![json!(1)]]).unwrap();
    let q = e.query("SELECT count(*) FROM r1 JOIN r2", 10).unwrap();
    assert_eq!(q.rows[0][0], json!(1));
}

#[test]
fn db_size_cap_maps_to_full() {
    let mut e = SqliteEngine::new(Limits { max_db_bytes: 256 * 1024, ..tl() });
    let big: Vec<Vec<Value>> = (0..2000).map(|i| vec![json!("x".repeat(500)), json!(i)]).collect();
    let err = e.register("big", &cols(&["a", "b"]), &big).unwrap_err();
    assert_eq!(err.code, -32021, "{err}");
    assert!(err.message.contains("engine session is full"));
    e.register("small", &cols(&["a"]), &[vec![json!(1)]]).unwrap();
}


// Tests never rely on the 30 s default timeout.
fn tl() -> result_engine::Limits {
    result_engine::Limits { query_timeout: std::time::Duration::from_secs(10), ..Default::default() }
}
