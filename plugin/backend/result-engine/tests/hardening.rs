use result_engine::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn tl() -> Limits {
    Limits { query_timeout: Duration::from_secs(10), ..Default::default() }
}
fn col(n: &str) -> ColumnSpec {
    ColumnSpec { name: n.into(), type_hint: None }
}
fn scalar(e: &mut SqliteEngine, sql: &str) -> Result<Value> {
    e.query(sql, 10).map(|q| q.rows[0][0].clone())
}

// ---- 1. case-insensitive table identity ----
#[test]
fn register_replaces_case_insensitively() {
    let mut e = SqliteEngine::new(Limits { max_total_rows: 400_000, ..tl() });
    let rows = |n: usize| (0..n).map(|i| vec![json!(i)]).collect::<Vec<_>>();
    e.register("T", &[col("a")], &rows(300_000)).unwrap();
    e.register("t", &[col("a")], &rows(300_000)).unwrap();
    assert_eq!(e.total_rows(), 300_000);
    assert_eq!(e.tables(), vec![("t".to_string(), 300_000)]);
}

#[test]
fn drop_is_case_insensitive_and_non_ascii_distinct() {
    let mut e = SqliteEngine::new(tl());
    e.register("Orders", &[col("a")], &[vec![json!(1)]]).unwrap();
    e.drop_table("oRDERS").unwrap();
    assert_eq!(e.total_rows(), 0);
    assert!(e.tables().is_empty());
    e.register("É", &[col("a")], &[vec![json!(1)]]).unwrap();
    e.register("é", &[col("a")], &[vec![json!(1)]]).unwrap();
    assert_eq!(e.tables().len(), 2);
    assert_eq!(e.total_rows(), 2);
}

#[test]
fn summary_shows_latest_display_name() {
    let mut e = SqliteEngine::new(tl());
    e.register("Foo", &[col("a")], &[vec![json!(1)]]).unwrap();
    e.register("fOO", &[col("a")], &[vec![json!(1)], vec![json!(2)]]).unwrap();
    assert_eq!(e.tables(), vec![("fOO".to_string(), 2)]);
}

// ---- 2. strict result byte cap ----
#[test]
fn byte_cap_drops_overflowing_row() {
    let mut e = SqliteEngine::new(Limits { max_result_bytes: 1 << 20, ..tl() });
    let q = e
        .query("SELECT zeroblob(600000) UNION ALL SELECT zeroblob(600000) UNION ALL SELECT zeroblob(600000)", 10)
        .unwrap();
    assert!(q.truncated);
    assert_eq!(q.rows.len(), 1);
}

#[test]
fn first_row_too_large_errors() {
    let mut e = SqliteEngine::new(Limits { max_result_bytes: 1 << 20, ..tl() });
    let err = e.query("SELECT zeroblob(2000000)", 10).unwrap_err();
    assert_eq!(err.code, -32602);
    assert!(err.message.contains("row_too_large") && err.message.contains("row too large"), "{err}");
    let err = e.query("SELECT printf('%.*c', 2000000, 'x')", 10).unwrap_err();
    assert!(err.message.contains("row too large"), "{err}");
    assert_eq!(scalar(&mut e, "SELECT 1").unwrap(), json!(1));
}

#[test]
fn two_60mb_blobs_under_default_cap() {
    let mut e = SqliteEngine::new(tl());
    let q = e.query("SELECT zeroblob(60000000) UNION ALL SELECT zeroblob(60000000)", 10);
    match q {
        Ok(q) => assert!(q.truncated || q.rows.len() == 2),
        Err(err) => assert_eq!(err.code, -32602),
    }
}

// ---- 3. sessions ----
#[test]
fn defaults_and_session_total_rows() {
    assert_eq!(Limits::default().max_db_bytes, 256 * 1024 * 1024);
    let mut s = Sessions::default();
    s.get_or_create("session-aaaa").unwrap().register("t", &[col("a")], &[vec![json!(1)], vec![json!(2)]]).unwrap();
    s.get_or_create("session-bbbb").unwrap().register("t", &[col("a")], &[vec![json!(1)]]).unwrap();
    assert_eq!(s.total_rows(), 3);
}

// ---- 4a. register scale ----
#[test]
#[ignore = "large; run manually with --release --ignored"]
fn register_500k_by_3() {
    let mut e = SqliteEngine::new(tl());
    let rows: Vec<Vec<Value>> = (0..500_000).map(|i| vec![json!(i), json!(format!("s{i}")), json!(i as f64 * 0.5)]).collect();
    let t = Instant::now();
    e.register("t", &[col("a"), col("b"), col("c")], &rows).unwrap();
    eprintln!("register 500k x 3: {:?}", t.elapsed());
    assert_eq!(scalar(&mut e, "SELECT count(*) FROM t").unwrap(), json!(500_000));
}

#[test]
fn register_5000_by_50_bounded() {
    let mut e = SqliteEngine::new(tl());
    let cols: Vec<ColumnSpec> = (0..50).map(|i| col(&format!("c{i}"))).collect();
    let rows: Vec<Vec<Value>> = (0..5000).map(|i| (0..50).map(|j| json!(format!("{i}-{j}"))).collect()).collect();
    let t = Instant::now();
    e.register("t", &cols, &rows).unwrap();
    assert!(t.elapsed() < Duration::from_secs(20));
}

// ---- 4b. deep nesting ----
fn nested(depth: usize) -> Value {
    let mut v = json!(1);
    for _ in 0..depth {
        v = Value::Array(vec![v]);
    }
    v
}
fn deep_rows(depth: usize) -> Vec<Vec<Value>> {
    vec![vec![nested(depth)]]
}

#[test]
fn deeply_nested_value_rejected_without_overflow() {
    let h = std::thread::Builder::new()
        .stack_size(512 * 1024)
        .spawn(|| {
            let mut e = SqliteEngine::new(tl());
            let rows = deep_rows(10_000);
            let err = e.register("t", &[col("a")], &rows).unwrap_err();
            assert_eq!(err.code, -32602);
            assert!(err.message.contains("value nested too deeply"), "{err}");
            // iterative drop to keep this test itself from recursing
            let mut v = rows.into_iter().next().unwrap().into_iter().next().unwrap();
            while let Value::Array(mut a) = v {
                v = a.pop().unwrap();
            }
            assert_eq!(e.total_rows(), 0);
        })
        .unwrap();
    h.join().unwrap();
}

#[test]
fn moderately_nested_value_is_text() {
    let mut e = SqliteEngine::new(tl());
    e.register("t", &[col("a")], &deep_rows(20)).unwrap();
    assert_eq!(scalar(&mut e, "SELECT a FROM t").unwrap().as_str().unwrap().len(), 20 * 2 + 1);
}

// ---- 4c. date_trunc ----
#[test]
fn date_trunc_week_boundaries() {
    let mut e = SqliteEngine::new(tl());
    for (i, o) in [
        ("2026-01-01", "2025-12-29"),
        ("2024-12-30", "2024-12-30"),
        ("2021-01-03", "2020-12-28"),
        ("2024-02-29", "2024-02-26"),
        ("0000-01-01", "-001-12-27"),
    ] {
        let r = scalar(&mut e, &format!("SELECT date_trunc('week', '{i}')"));
        if i.starts_with("0000") {
            // year 0 / negative years are not representable in the 4-digit format: must not panic
            let _ = r;
        } else {
            assert_eq!(r.unwrap(), json!(o), "{i}");
        }
    }
    assert_eq!(scalar(&mut e, "SELECT date_trunc('month', '2024-02-29')").unwrap(), json!("2024-02-01"));
    assert_eq!(scalar(&mut e, "SELECT date_trunc('year', '2024-02-29 13:45:10')").unwrap(), json!("2024-01-01 00:00:00"));
    assert_eq!(scalar(&mut e, "SELECT date_trunc('day', '2024-02-29')").unwrap(), json!("2024-02-29"));
}

#[test]
fn date_trunc_ignores_offsets_and_rejects_negative_years() {
    let mut e = SqliteEngine::new(tl());
    assert_eq!(scalar(&mut e, "SELECT date_trunc('hour', '2024-03-01T23:59:59+05:30')").unwrap(), json!("2024-03-01T23:00:00"));
    assert_eq!(scalar(&mut e, "SELECT date_trunc('day', '2024-03-01T23:59:59Z')").unwrap(), json!("2024-03-01T00:00:00"));
    assert_eq!(scalar(&mut e, "SELECT date_trunc('hour', '2024-03-01 10:20:30-08:00')").unwrap(), json!("2024-03-01 10:00:00"));
    assert_eq!(e.query("SELECT date_trunc('day', '-001-01-01')", 1).unwrap_err().code, -32602);
    assert_eq!(scalar(&mut e, "SELECT date_trunc('week', '0000-01-03')").unwrap(), json!("0000-01-03"));
}

// ---- 4d. regex limits ----
#[test]
fn regex_blowup_patterns_fail_fast() {
    let mut e = SqliteEngine::new(tl());
    for p in [r"\p{L}{1000}", "(?:a{1000}){1000}", r"(?:\p{L}{100}){100}", r"\w{1000}{1000}"] {
        let t = Instant::now();
        let err = e.query(&format!("SELECT 'a' REGEXP '{p}'"), 1).unwrap_err();
        assert_eq!(err.code, -32602, "{p}: {err}");
        assert!(t.elapsed() < Duration::from_secs(5), "{p}");
    }
    let long = "a".repeat(10_001);
    let err = e.query(&format!("SELECT 'a' REGEXP '{long}'"), 1).unwrap_err();
    assert!(err.message.contains("pattern too long"), "{err}");
    let ok = "a".repeat(10_000);
    assert_eq!(scalar(&mut e, &format!("SELECT 'a' REGEXP '{ok}'")).unwrap(), json!(0));
}

#[test]
fn regex_matching_large_input_is_bounded() {
    let mut e = SqliteEngine::new(Limits { query_timeout: Duration::from_secs(10), ..Default::default() });
    let t = Instant::now();
    let r = scalar(&mut e, "SELECT '(a*)*b' REGEXP 'x' OR regexp('(a+)+$', printf('%.*c', 100000, 'a') || 'b')");
    assert!(r.is_ok());
    assert!(t.elapsed() < Duration::from_secs(8));
}

// ---- 4f. to_json conversions ----
#[test]
fn to_json_edge_values() {
    let mut e = SqliteEngine::new(tl());
    let v = scalar(&mut e, "SELECT -0.0").unwrap();
    assert_eq!(v.as_f64().unwrap(), 0.0);
    assert!(v.to_string() == "-0.0" || v.to_string() == "0.0");
    assert_eq!(scalar(&mut e, "SELECT 1e308").unwrap().as_f64().unwrap(), 1e308);
    assert_eq!(scalar(&mut e, "SELECT 5e-324").unwrap().as_f64().unwrap(), 5e-324);
    assert_eq!(scalar(&mut e, "SELECT 1e999").unwrap(), Value::Null);
    assert_eq!(scalar(&mut e, "SELECT -1e999").unwrap(), Value::Null);
    assert_eq!(scalar(&mut e, "SELECT 'a' || char(0) || 'b'").unwrap(), json!("a\u{0}b"));
    assert_eq!(scalar(&mut e, "SELECT CAST(x'ff' AS TEXT)").unwrap(), json!("\u{fffd}"));
    assert_eq!(scalar(&mut e, "SELECT CAST(x'61ff62' AS TEXT)").unwrap(), json!("a\u{fffd}b"));
}

// ---- 5. unterminated bracket identifier ----
#[test]
fn unterminated_bracket_rejected() {
    let mut e = SqliteEngine::new(tl());
    for s in ["SELECT 1; [", "SELECT [a; SELECT 2", "SELECT 1; SELECT [x"] {
        let err = e.query(s, 1).unwrap_err();
        assert_eq!(err.code, -32602, "{s}");
    }
    assert_eq!(scalar(&mut e, "SELECT 1").unwrap(), json!(1));
}
