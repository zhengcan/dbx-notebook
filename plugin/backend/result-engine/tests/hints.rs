use result_engine::{dialect_hint, ResultEngine, SqliteEngine, ColumnSpec};
use serde_json::json;

fn real_err(sql: &str) -> String {
    let mut e = SqliteEngine::new(tl());
    let cols = vec![ColumnSpec { name: "x".into(), type_hint: None }, ColumnSpec { name: "y".into(), type_hint: None }];
    e.register("t", &cols, &[vec![json!(1), json!("a")]]).unwrap();
    e.query(sql, 10).err().map(|e| e.message).unwrap_or_default()
}

fn check(sql: &str, want: &str) {
    let err = real_err(sql);
    assert!(!err.is_empty(), "expected failure for {sql}");
    assert_eq!(dialect_hint(sql, &err), Some(want), "{sql} / {err}");
}

#[test]
fn rules_fire_on_real_sqlite_errors() {
    check("SELECT x::int FROM t", "cast_operator");
    check("SELECT * FROM t WHERE y ILIKE 'A%'", "ilike");
    check("SELECT DISTINCT ON (x) x, y FROM t", "distinct_on");
    check("SELECT upper(y) FILTER (WHERE x > 0) FROM t", "filter_clause");
    check("SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM t", "within_group");
    check("SELECT * FROM t WHERE y ~ 'a+'", "regex_operator");
    check("SELECT * FROM t WHERE y !~* 'a+'", "regex_operator");
}

#[test]
fn spec_near_colon_error() {
    assert_eq!(dialect_hint("SELECT x::int FROM t", "near \":\": syntax error"), Some("cast_operator"));
}

#[test]
fn case_and_whitespace() {
    let e = "near \"x\": syntax error";
    assert_eq!(dialect_hint("select a ilike 'x'", e), Some("ilike"));
    assert_eq!(dialect_hint("select a iLiKe 'x'", e), Some("ilike"));
    assert_eq!(dialect_hint("select distinct\n\t  on (a) a from t", e), Some("distinct_on"));
    assert_eq!(dialect_hint("select distinct on(a) a from t", e), Some("distinct_on"));
    assert_eq!(dialect_hint("select count(*) filter\n(where a) from t", e), Some("filter_clause"));
    assert_eq!(dialect_hint("select count(*) filter(where a) from t", e), Some("filter_clause"));
    assert_eq!(dialect_hint("select x within\n group (order by a)", e), Some("within_group"));
    assert_eq!(dialect_hint("select 'a'::int", e), Some("cast_operator"));
}

#[test]
fn blanked_regions_do_not_fire() {
    let e = "near \"x\": syntax error";
    for sql in [
        "SELECT 'a::b' FROM t", "SELECT 'it''s ILIKE' FROM t", "SELECT \"x::y\" FROM t",
        "SELECT 1 -- ILIKE\n, 2", "SELECT 1 /* DISTINCT ON */", "SELECT `a::b` FROM t",
        "SELECT [a::b] FROM t", "SELECT 'x ~ y'", "SELECT \"ILIKE\" FROM t",
        "SELECT ilike_col, my_filter (1), distinctive on_x FROM t", "SELECT notilike FROM t",
        "SELECT 'a' || '''::''' ",
    ] {
        assert_eq!(dialect_hint(sql, e), None, "{sql}");
    }
}

#[test]
fn trigger_after_blanked_region_still_fires() {
    assert_eq!(dialect_hint("SELECT 'a''b', x::int", "syntax error"), Some("cast_operator"));
    assert_eq!(dialect_hint("/* c */ SELECT x::int -- c", "syntax error"), Some("cast_operator"));
}

#[test]
fn gate_on_unrelated_errors() {
    for err in ["query timed out", "interrupted", "no such table: t", "engine session is full"] {
        assert_eq!(dialect_hint("SELECT x::int FROM t", err), None, "{err}");
    }
    assert_eq!(dialect_hint("SELECT 1", "near \"FROM\": syntax error"), None);
}

#[test]
fn priority_order() {
    let e = "syntax error";
    assert_eq!(dialect_hint("SELECT x::int FROM t WHERE y ILIKE 'a'", e), Some("cast_operator"));
    assert_eq!(dialect_hint("SELECT DISTINCT ON (x) y FROM t WHERE y ILIKE 'a'", e), Some("ilike"));
    assert_eq!(dialect_hint("SELECT DISTINCT ON (x) count(*) FILTER (WHERE a)", e), Some("distinct_on"));
    assert_eq!(dialect_hint("SELECT count(*) FILTER (WHERE a), p WITHIN GROUP (ORDER BY a) WHERE y ~ 'a'", e), Some("filter_clause"));
    assert_eq!(dialect_hint("SELECT p WITHIN GROUP (ORDER BY a) WHERE y ~ 'a'", e), Some("within_group"));
}

#[test]
fn empty_inputs() {
    assert_eq!(dialect_hint("", ""), None);
    assert_eq!(dialect_hint("", "syntax error"), None);
    assert_eq!(dialect_hint("SELECT x::int", ""), Some("cast_operator"));
}


// Tests never rely on the 30 s default timeout.
fn tl() -> result_engine::Limits {
    result_engine::Limits { query_timeout: std::time::Duration::from_secs(10), ..Default::default() }
}
