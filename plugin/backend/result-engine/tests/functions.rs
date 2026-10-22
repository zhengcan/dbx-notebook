use result_engine::*;
use serde_json::{json, Value};

fn eng() -> SqliteEngine {
    let mut e = SqliteEngine::new(tl());
    let cols = |n: &[&str]| -> Vec<ColumnSpec> { n.iter().map(|x| ColumnSpec { name: x.to_string(), type_hint: None }).collect() };
    let rows = vec![
        vec![json!("2026-01-15"), json!(1)],
        vec![json!("2026-01-20"), json!(3)],
        vec![json!("2026-02-03"), json!(10)],
        vec![json!("2026-02-04"), json!(20)],
        vec![json!("2026-02-05"), Value::Null],
    ];
    e.register("t", &cols(&["d", "x"]), &rows).unwrap();
    e
}
fn q(sql: &str) -> Result<Value> {
    let mut e = eng();
    Ok(e.query(sql, 10)?.rows[0][0].clone())
}
fn ok(sql: &str) -> Value {
    q(sql).unwrap_or_else(|e| panic!("{sql}: {e}"))
}
fn err(sql: &str, frag: &str) {
    let e = q(sql).expect_err(sql);
    assert_eq!(e.code, -32602, "{sql}: {e}");
    assert!(e.message.contains(frag), "{sql}: {e}");
}
fn near(sql: &str, want: f64) {
    let v = ok(sql).as_f64().unwrap_or_else(|| panic!("{sql}: not number"));
    assert!((v - want).abs() < 1e-9, "{sql}: {v} != {want}");
}

#[test]
fn date_trunc_table() {
    let cases = [
        ("year", "2026-05-17", "2026-01-01"),
        ("quarter", "2026-05-17", "2026-04-01"),
        ("quarter", "2026-12-31", "2026-10-01"),
        ("month", "2026-05-17", "2026-05-01"),
        ("week", "2026-01-01", "2025-12-29"),
        ("week", "2026-05-17", "2026-05-11"),
        ("week", "2026-05-18", "2026-05-18"),
        ("week", "2024-03-01", "2024-02-26"),
        ("WEEK", "2021-01-03", "2020-12-28"),
        ("day", "2024-02-29", "2024-02-29"),
        ("Month", "2024-02-29", "2024-02-01"),
        ("hour", "2026-05-17", "2026-05-17"),
        ("year", "2026-05-17T10:20:30", "2026-01-01T00:00:00"),
        ("quarter", "2026-05-17 10:20:30", "2026-04-01 00:00:00"),
        ("month", "2026-05-17 10:20", "2026-05-01 00:00:00"),
        ("week", "2026-01-01T23:59:59", "2025-12-29T00:00:00"),
        ("day", "2026-05-17 10:20:30.123", "2026-05-17 00:00:00"),
        ("hour", "2026-05-17T10:20:30Z", "2026-05-17T10:00:00"),
        ("minute", "2026-05-17 10:20:30+02:00", "2026-05-17 10:20:00"),
        ("second", "2026-05-17T10:20:30.999", "2026-05-17T10:20:30"),
    ];
    for (u, ts, want) in cases {
        assert_eq!(ok(&format!("SELECT date_trunc('{u}', '{ts}')")), json!(want), "{u} {ts}");
    }
    assert_eq!(ok("SELECT date_trunc('day', NULL)"), Value::Null);
    assert_eq!(ok("SELECT date_trunc(NULL, '2026-01-01')"), Value::Null);
    err("SELECT date_trunc('decade', '2026-01-01')", "date_trunc:");
    for bad in ["2026-13-01", "2026-02-30", "2023-02-29", "hello", "", "2026-01-01X", "2026-01-01 25:00", "2026-1-1"] {
        err(&format!("SELECT date_trunc('day', '{bad}')"), "date_trunc:");
    }
    err("SELECT date_trunc('day', 5)", "date_trunc:");
    err("SELECT date_trunc('day')", "date_trunc");
    ok("SELECT date_trunc('month', '2024-02-29')");
}

#[test]
fn median_cases() {
    near("SELECT median(x) FROM t", 6.5);
    near("SELECT median(x) FROM t WHERE x IN (1,3,10)", 3.0);
    near("SELECT median(x) FROM t WHERE x IN (1,3)", 2.0);
    assert_eq!(ok("SELECT median(x) FROM t WHERE x IS NULL"), Value::Null);
    assert_eq!(ok("SELECT median(x) FROM t WHERE 0"), Value::Null);
    near("SELECT median(x) FROM (SELECT 1.5 AS x UNION ALL SELECT 2.5)", 2.0);
    err("SELECT median(d) FROM t", "median:");
    err("SELECT median('5')", "median:");
    err("SELECT median(x, x) FROM t", "median");
}

#[test]
fn percentiles() {
    near("SELECT percentile_cont(x, 0.5) FROM t", 6.5);
    near("SELECT percentile_cont(x, 0) FROM t", 1.0);
    near("SELECT percentile_cont(x, 1) FROM t", 20.0);
    near("SELECT percentile_cont(x, 0.25) FROM t", 2.5);
    near("SELECT percentile_cont(x, 0.75) FROM t", 12.5);
    assert_eq!(ok("SELECT percentile_cont(x, 0.5) FROM t WHERE 0"), Value::Null);
    err("SELECT percentile_cont(x, x) FROM t", "percentile_cont:");
    err("SELECT percentile_cont(x, 1.5) FROM t", "percentile_cont:");
    err("SELECT percentile_cont(x, -0.1) FROM t", "percentile_cont:");
    err("SELECT percentile_cont(x, NULL) FROM t", "percentile_cont:");
    err("SELECT percentile_cont(x, 'a') FROM t", "percentile_cont:");
    err("SELECT percentile_cont(d, 0.5) FROM t", "percentile_cont:");
    near("SELECT percentile_disc(x, 0.5) FROM t", 3.0);
    near("SELECT percentile_disc(x, 0) FROM t", 1.0);
    near("SELECT percentile_disc(x, 1) FROM t", 20.0);
    near("SELECT percentile_disc(x, 0.51) FROM t", 10.0);
    near("SELECT percentile_disc(x, 0.75) FROM t", 10.0);
    near("SELECT percentile_disc(x, 0.76) FROM t", 20.0);
    err("SELECT percentile_disc(x, 2) FROM t", "percentile_disc:");
    assert_eq!(ok("SELECT percentile_disc(x, 0.5) FROM t WHERE x IS NULL"), Value::Null);
}

#[test]
fn stats() {
    let v = "(SELECT 2 AS x UNION ALL SELECT 4 UNION ALL SELECT 4 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 5 UNION ALL SELECT 7 UNION ALL SELECT 9 UNION ALL SELECT NULL)";
    near(&format!("SELECT var_pop(x) FROM {v}"), 4.0);
    near(&format!("SELECT stddev_pop(x) FROM {v}"), 2.0);
    near(&format!("SELECT var_samp(x) FROM {v}"), 32.0 / 7.0);
    near(&format!("SELECT stddev_samp(x) FROM {v}"), (32.0f64 / 7.0).sqrt());
    near("SELECT var_pop(x) FROM t WHERE x = 3", 0.0);
    assert_eq!(ok("SELECT var_samp(x) FROM t WHERE x = 3"), Value::Null);
    assert_eq!(ok("SELECT stddev_samp(x) FROM t WHERE x = 3"), Value::Null);
    assert_eq!(ok("SELECT stddev_samp(x) FROM t WHERE 0"), Value::Null);
    assert_eq!(ok("SELECT var_pop(x) FROM t WHERE 0"), Value::Null);
    assert_eq!(ok("SELECT stddev_pop(x) FROM t WHERE x IS NULL"), Value::Null);
    near("SELECT var_samp(x) FROM t", {
        let xs = [1.0, 3.0, 10.0, 20.0];
        let m = 34.0 / 4.0;
        xs.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / 3.0
    });
    err("SELECT stddev_pop(d) FROM t", "stddev_pop:");
    err("SELECT var_samp('a')", "var_samp:");
}

#[test]
fn regexp_match() {
    let t = |s: &str, want: i64| assert_eq!(ok(&format!("SELECT {s}")), json!(want), "{s}");
    t("'abc' REGEXP 'b'", 1);
    t("'abc' REGEXP '^b'", 0);
    t("'abc' REGEXP '^abc$'", 1);
    t("regexp('b', 'abc')", 1);
    t("regexp('B', 'abc')", 0);
    t("regexp('(?i)B', 'abc')", 1);
    t("'日本語テキスト' REGEXP '本語'", 1);
    t("'日本語' REGEXP '^.{3}$'", 1);
    t("'héllo' REGEXP '^h.llo$'", 1);
    t("12345 REGEXP '^\\d+$'", 1);
    for s in ["NULL REGEXP 'a'", "'a' REGEXP NULL", "regexp(NULL, NULL)"] {
        assert_eq!(ok(&format!("SELECT {s}")), Value::Null);
    }
    err("SELECT 'a' REGEXP '('", "regexp:");
    err("SELECT 'a' REGEXP '(?<=a)b'", "regexp:");
    err(&format!("SELECT 'a' REGEXP '{}'", "a".repeat(10_001)), "regexp:");
    err("SELECT 'a' REGEXP '((a{100}){100}){100}'", "regexp:");
    err("SELECT regexp('a')", "regexp");
    err("SELECT regexp(x'00', 'a')", "regexp:");
}

#[test]
fn regexp_cache_many_patterns() {
    let mut e = eng();
    let r = e.query("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<299) SELECT sum(regexp('^p'||i||'$', 'p'||(i+1))) + sum(regexp('^p'||i||'$', 'p'||i)) FROM n", 1).unwrap();
    assert_eq!(r.rows[0][0], json!(300));
    let r = e.query("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<299) SELECT sum(regexp('^p'||(i%100)||'$', 'p'||i)) FROM n", 1).unwrap();
    assert_eq!(r.rows[0][0], json!(100));
    let r = e.query("SELECT count(*) FROM t WHERE d REGEXP '^2026-0[12]-0'", 1).unwrap();
    assert_eq!(r.rows[0][0], json!(3));
    let r = e.query("SELECT count(*) FROM t WHERE d REGEXP '^2026-01'", 1).unwrap();
    assert_eq!(r.rows[0][0], json!(2));
}

#[test]
fn regexp_replace_cases() {
    let t = |s: &str, want: &str| assert_eq!(ok(&format!("SELECT {s}")), json!(want), "{s}");
    t("regexp_replace('aaa', 'a', 'b')", "baa");
    t("regexp_replace('aaa', 'a', 'b', 'g')", "bbb");
    t("regexp_replace('AaA', 'a', 'b', 'gi')", "bbb");
    t("regexp_replace('AaA', 'a', 'b', 'i')", "baA");
    t("regexp_replace('AaA', 'a', 'b', '')", "AbA");
    t("regexp_replace('john smith', '(\\w+) (\\w+)', '\\2, \\1')", "smith, john");
    t("regexp_replace('a-b', '(a)-(b)', '\\2\\1\\\\')", "ba\\");
    t("regexp_replace('abc', 'b', '$1 ${0} $$')", "a$1 ${0} $$c");
    t("regexp_replace('abc', 'b', '\\&\\&')", "abbc");
    t("regexp_replace('abc', '(x)?b', '[\\1]')", "a[]c");
    t("regexp_replace('abc', 'b', '\\5')", "ac");
    t("regexp_replace('日本語', '本', 'X')", "日X語");
    t("regexp_replace('abc', '', '-', 'g')", "-a-b-c-");
    assert_eq!(ok("SELECT regexp_replace(NULL, 'a', 'b')"), Value::Null);
    assert_eq!(ok("SELECT regexp_replace('a', NULL, 'b')"), Value::Null);
    assert_eq!(ok("SELECT regexp_replace('a', 'a', NULL)"), Value::Null);
    err("SELECT regexp_replace('a', '(', 'b')", "regexp_replace:");
    err("SELECT regexp_replace('a', 'a', 'b', 'x')", "regexp_replace:");
    err("SELECT regexp_replace('a', 'a')", "regexp_replace");
}

#[test]
fn regexp_replace_output_cap() {
    let mut e = eng();
    let r = e.query("WITH RECURSIVE r(s,n) AS (SELECT 'a',1 UNION ALL SELECT s||s,n+1 FROM r WHERE n<25) SELECT length(regexp_replace((SELECT s FROM r WHERE n=25), 'a', 'bbbbbbbbbbbbbbbb', 'g'))", 1);
    let m = r.expect_err("cap").message;
    assert!(m.contains("regexp_replace:"), "{m}");
}

#[test]
fn left_right() {
    let t = |s: &str, want: &str| assert_eq!(ok(&format!("SELECT {s}")), json!(want), "{s}");
    t("left('abcde', 2)", "ab");
    t("left('abcde', -2)", "abc");
    t("left('abcde', 0)", "");
    t("left('abcde', 10)", "abcde");
    t("left('abcde', -10)", "");
    t("right('abcde', 2)", "de");
    t("right('abcde', -2)", "cde");
    t("right('abcde', 0)", "");
    t("right('abcde', 10)", "abcde");
    t("right('abcde', -10)", "");
    t("left('日本語テ', 2)", "日本");
    t("right('日本語テ', 2)", "語テ");
    t("right('日本語テ', -1)", "本語テ");
    t("left('日本語テ', -1)", "日本語");
    t("left(12345, 2)", "12");
    assert_eq!(ok("SELECT left(NULL, 2)"), Value::Null);
    assert_eq!(ok("SELECT right('a', NULL)"), Value::Null);
    err("SELECT left('a', 'x')", "left:");
    err("SELECT right('a', 1.5)", "right:");
    err("SELECT left(x'41', 1)", "left:");
    err("SELECT left('a')", "left");
    err("SELECT right('a',1,2)", "right");
}

#[test]
fn split_part_cases() {
    let t = |s: &str, want: &str| assert_eq!(ok(&format!("SELECT {s}")), json!(want), "{s}");
    t("split_part('a,b,c', ',', 1)", "a");
    t("split_part('a,b,c', ',', 3)", "c");
    t("split_part('a,b,c', ',', 4)", "");
    t("split_part('a,b,c', ',', -1)", "c");
    t("split_part('a,b,c', ',', -3)", "a");
    t("split_part('a,b,c', ',', -4)", "");
    t("split_part('a,,c', ',', 2)", "");
    t("split_part('abc', '', 1)", "abc");
    t("split_part('abc', '', 2)", "");
    t("split_part('abc', '', -1)", "abc");
    t("split_part('', ',', 1)", "");
    t("split_part('a::b::c', '::', 2)", "b");
    t("split_part('日,本,語', ',', 2)", "本");
    assert_eq!(ok("SELECT split_part(NULL, ',', 1)"), Value::Null);
    assert_eq!(ok("SELECT split_part('a', ',', NULL)"), Value::Null);
    err("SELECT split_part('a', ',', 0)", "split_part:");
    err("SELECT split_part('a', ',', 'x')", "split_part:");
    err("SELECT split_part('a', ',')", "split_part");
}

#[test]
fn greatest_least() {
    assert_eq!(ok("SELECT greatest(1, 5, 3)"), json!(5));
    assert_eq!(ok("SELECT least(4, 2, 3)"), json!(2));
    assert_eq!(ok("SELECT greatest(1, NULL, 3)"), json!(3));
    assert_eq!(ok("SELECT least(NULL, 7)"), json!(7));
    assert_eq!(ok("SELECT greatest(NULL, NULL)"), Value::Null);
    assert_eq!(ok("SELECT least(NULL)"), Value::Null);
    assert_eq!(ok("SELECT greatest(5)"), json!(5));
    assert_eq!(ok("SELECT greatest(1, 2.5)"), json!(2.5));
    assert_eq!(ok("SELECT least(1, 0.5, 2)"), json!(0.5));
    assert_eq!(ok("SELECT greatest(2, 2.0)").as_f64(), Some(2.0));
    assert_eq!(ok("SELECT greatest('a', 'b', 'B')"), json!("b"));
    assert_eq!(ok("SELECT least('b', 'a')"), json!("a"));
    assert_eq!(ok("SELECT greatest(10, 9)"), json!(10));
    assert_eq!(ok("SELECT greatest(100, 'a')"), json!("a"));
    assert_eq!(ok("SELECT least(100, 'a')"), json!(100));
    assert_eq!(ok("SELECT greatest(9007199254740993, 9007199254740992)"), json!("9007199254740993"));
    assert_eq!(ok("SELECT max(greatest(x, 2)) FROM t"), json!(20));
    err("SELECT greatest()", "greatest");
    err("SELECT least()", "least");
}

#[test]
fn to_char_cases() {
    let t = |s: &str, want: &str| assert_eq!(ok(&format!("SELECT {s}")), json!(want), "{s}");
    t("to_char('2026-05-07 09:08:07', 'YYYY-MM-DD HH24:MI:SS')", "2026-05-07 09:08:07");
    t("to_char('2026-05-07T19:08:07Z', 'DD/MM/YYYY HH24.MI')", "07/05/2026 19.08");
    t("to_char('2026-05-07', 'YYYYMMDD')", "20260507");
    t("to_char('2026-05-07', 'HH24:MI:SS')", "00:00:00");
    t("to_char('2026-05-07 01:02:03', 'SS')", "03");
    t("to_char('2026-05-07', '\"Year\" YYYY \"Q\"')", "Year 2026 Q");
    t("to_char('2026-05-07', 'YYYY年MM月DD日')", "2026年05月07日");
    t("to_char('2026-05-07', '')", "");
    t("to_char('2026-05-07', '[YYYY]')", "[2026]");
    assert_eq!(ok("SELECT to_char(NULL, 'YYYY')"), Value::Null);
    assert_eq!(ok("SELECT to_char('2026-05-07', NULL)"), Value::Null);
    err("SELECT to_char('2026-05-07', 'YYYY-Q')", "to_char: unsupported format token Q");
    err("SELECT to_char('2026-05-07', 'Month')", "to_char: unsupported format token Month");
    err("SELECT to_char('2026-05-07', 'HH')", "to_char: unsupported format token HH");
    err("SELECT to_char('2026-05-07', 'yyyy')", "to_char: unsupported format token yyyy");
    err("SELECT to_char('2026-05-07', '\"abc')", "to_char:");
    err("SELECT to_char('nope', 'YYYY')", "to_char:");
    err("SELECT to_char('2026-05-07')", "to_char");
}

#[test]
fn through_query_path_group_window() {
    let mut e = eng();
    let r = e.query("SELECT date_trunc('month', d) AS m, median(x), count(*) FROM t GROUP BY 1 ORDER BY 1", 10).unwrap();
    assert_eq!(r.rows.len(), 2);
    assert_eq!(r.rows[0][0], json!("2026-01-01"));
    assert_eq!(r.rows[0][1].as_f64(), Some(2.0));
    assert_eq!(r.rows[1][1].as_f64(), Some(15.0));
    let r = e.query("SELECT to_char(d,'YYYY-MM') m, percentile_cont(x,0.5), stddev_pop(x) FROM t GROUP BY m ORDER BY m", 10).unwrap();
    assert_eq!(r.rows[1][0], json!("2026-02"));
    let r = e.query("SELECT d, greatest(x, 5) g, row_number() OVER (ORDER BY left(d, 7), d) rn FROM t WHERE d REGEXP '^2026-02' ORDER BY d", 10).unwrap();
    assert_eq!(r.rows.len(), 3);
    assert_eq!(r.rows[2][1], json!(5));
    let r = e.query("SELECT split_part(d, '-', 2), count(*) FROM t GROUP BY 1 ORDER BY 1", 10).unwrap();
    assert_eq!(r.rows[0][0], json!("01"));
    let r = e.query("SELECT regexp_replace(d, '-', '/', 'g') FROM t ORDER BY d LIMIT 1", 10).unwrap();
    assert_eq!(r.rows[0][0], json!("2026/01/15"));
    assert!(e.query("SELECT date_trunc('x', d) FROM t", 10).is_err());
    assert_eq!(e.query("SELECT right(d, 2) FROM t ORDER BY d LIMIT 1", 10).unwrap().rows[0][0], json!("15"));
    assert_eq!(e.query("SELECT least(x, 5) FROM t WHERE x = 10", 10).unwrap().rows[0][0], json!(5));
    let r = e.query("SELECT var_samp(x), stddev_samp(x), var_pop(x), percentile_disc(x, 0.5) FROM t", 10).unwrap();
    assert_eq!(r.rows.len(), 1);
}


// Tests never rely on the 30 s default timeout.
fn tl() -> result_engine::Limits {
    result_engine::Limits { query_timeout: std::time::Duration::from_secs(10), ..Default::default() }
}
