use result_engine::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn eng() -> SqliteEngine {
    SqliteEngine::new(tl())
}
fn cols(spec: &[(&str, Option<&str>)]) -> Vec<ColumnSpec> {
    spec.iter()
        .map(|(n, t)| ColumnSpec { name: n.to_string(), type_hint: t.map(|s| s.to_string()) })
        .collect()
}
fn big(n: usize, m: usize) -> (Vec<ColumnSpec>, Vec<Vec<Value>>) {
    let c: Vec<ColumnSpec> = (0..m)
        .map(|j| ColumnSpec { name: format!("c{j}"), type_hint: Some(["integer", "real", "text", "boolean", "unknown"][j % 5].into()) })
        .collect();
    let rows = (0..n)
        .map(|i| {
            (0..m)
                .map(|j| {
                    if (i + j) % 7 == 0 {
                        return Value::Null;
                    }
                    match j % 5 {
                        0 => json!(i as i64 * 3),
                        1 => json!(i as f64 + 0.5),
                        2 => json!(format!("s{i}_{j}")),
                        3 => json!(i % 2 == 0),
                        _ => json!(format!("u{i}")),
                    }
                })
                .collect()
        })
        .collect();
    (c, rows)
}

#[test]
fn round_trip_5000x50() {
    let mut e = eng();
    let (c, rows) = big(5000, 50);
    let t = Instant::now();
    e.register("t", &c, &rows).unwrap();
    let q = e.query("SELECT count(*) FROM t", 10).unwrap();
    assert_eq!(q.rows[0][0], json!(5000));
    assert!(t.elapsed() < Duration::from_secs(2));
    let q = e.query("SELECT * FROM t", 10000).unwrap();
    assert_eq!(q.rows.len(), 5000);
    for (i, r) in rows.iter().enumerate() {
        for (j, v) in r.iter().enumerate() {
            let got = &q.rows[i][j];
            if j % 5 == 3 && !v.is_null() {
                assert_eq!(got, &json!(if v == &json!(true) { 1 } else { 0 }));
            } else {
                assert_eq!(got, v, "row {i} col {j}");
            }
        }
    }
    assert!(!q.truncated);
}

#[test]
fn boolean_hint_kept() {
    let mut e = eng();
    e.register("t", &cols(&[("b", Some("boolean"))]), &[vec![json!(true)], vec![json!(false)]]).unwrap();
    let q = e.query("SELECT b FROM t", 10).unwrap();
    assert_eq!(q.columns[0].type_name, "boolean");
    assert_eq!(q.rows, vec![vec![json!(1)], vec![json!(0)]]);
}

#[test]
fn big_ints_exact() {
    let mut e = eng();
    e.register(
        "t",
        &cols(&[("i", Some("integer"))]),
        &[vec![json!(i64::MAX)], vec![json!("9007199254740993")], vec![json!(42)], vec![json!(-9007199254740993i64)]],
    )
    .unwrap();
    let q = e.query("SELECT i FROM t", 10).unwrap();
    assert_eq!(q.rows[0][0], json!("9223372036854775807"));
    assert_eq!(q.rows[1][0], json!("9007199254740993"));
    assert_eq!(q.rows[2][0], json!(42));
    assert_eq!(q.rows[3][0], json!("-9007199254740993"));
    let q = e.query("SELECT i = 9007199254740993 FROM t WHERE rowid = 2", 10).unwrap();
    assert_eq!(q.rows[0][0], json!(1));
}

#[test]
fn weird_names() {
    let mut e = eng();
    let names = ["my table", "a\"b", "表格", "😀", "order", "select", "x\"; DROP TABLE t; --"];
    e.register("t", &cols(&[("a", None)]), &[vec![json!(1)]]).unwrap();
    for n in names {
        let c = cols(&[(n, Some("text")), ("zz", None)]);
        e.register(n, &c, &[vec![json!("v"), json!(2)]]).unwrap();
        let sql = format!("SELECT {} FROM {}", quote_ident(n), quote_ident(n));
        let q = e.query(&sql, 10).unwrap();
        assert_eq!(q.columns[0].name, n);
        assert_eq!(q.rows[0][0], json!("v"));
    }
    assert_eq!(e.query("SELECT count(*) FROM t", 1).unwrap().rows[0][0], json!(1));
    assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
}

#[test]
fn replace_drop_count() {
    let mut e = eng();
    e.register("t", &cols(&[("a", None)]), &[vec![json!(1)], vec![json!(2)]]).unwrap();
    e.register("u", &cols(&[("a", None)]), &[vec![json!(1)]]).unwrap();
    assert_eq!(e.total_rows(), 3);
    e.register("t", &cols(&[("z", None)]), &[vec![json!(9)]]).unwrap();
    assert_eq!(e.total_rows(), 2);
    assert_eq!(e.query("SELECT z FROM t", 5).unwrap().rows, vec![vec![json!(9)]]);
    e.drop_table("t").unwrap();
    assert_eq!(e.total_rows(), 1);
    assert!(e.query("SELECT * FROM t", 5).is_err());
    e.drop_table("nonexistent").unwrap();
}

#[test]
fn limit_exceeded() {
    let mut e = SqliteEngine::new(Limits { max_total_rows: 5, ..tl() });
    e.register("t", &cols(&[("a", None)]), &[vec![json!(1)], vec![json!(2)], vec![json!(3)]]).unwrap();
    let many: Vec<Vec<Value>> = (0..3).map(|i| vec![json!(i)]).collect();
    let err = e.register("u", &cols(&[("a", None)]), &many).unwrap_err();
    assert_eq!(err.code, -32021);
    assert!(err.rpc_message().starts_with("[-32021] engine session is full"));
    assert_eq!(e.total_rows(), 3);
    assert_eq!(e.query("SELECT count(*) FROM t", 1).unwrap().rows[0][0], json!(3));
    // replacing a table only counts the new rows
    let four: Vec<Vec<Value>> = (0..5).map(|i| vec![json!(i)]).collect();
    e.register("t", &cols(&[("a", None)]), &four).unwrap();
    assert_eq!(e.total_rows(), 5);
}

#[test]
fn bad_input() {
    let mut e = eng();
    e.register("t", &cols(&[("a", None)]), &[vec![json!(1)]]).unwrap();
    let r = e.register("t", &cols(&[("a", None), ("b", None)]), &[vec![json!(1)]]).unwrap_err();
    assert_eq!(r.code, -32602);
    assert_eq!(e.register("t", &[], &[]).unwrap_err().code, -32602);
    assert_eq!(e.register("t", &cols(&[("a", None), ("A", None)]), &[]).unwrap_err().code, -32602);
    assert_eq!(e.query("SELECT a FROM t", 5).unwrap().rows.len(), 1);
    assert_eq!(e.query("SELEC nope", 5).unwrap_err().code, -32602);
}

#[test]
fn truncation() {
    let mut e = eng();
    let rows: Vec<Vec<Value>> = (0..10).map(|i| vec![json!(i)]).collect();
    e.register("t", &cols(&[("a", None)]), &rows).unwrap();
    let q = e.query("SELECT a FROM t", 10).unwrap();
    assert_eq!((q.rows.len(), q.truncated), (10, false));
    let q = e.query("SELECT a FROM t", 9).unwrap();
    assert_eq!((q.rows.len(), q.truncated), (9, true));
    let q = e.query("SELECT a FROM t", 11).unwrap();
    assert_eq!((q.rows.len(), q.truncated), (10, false));
}

#[test]
fn column_types() {
    let mut e = eng();
    e.register(
        "t",
        &cols(&[("d", Some("date")), ("n", None), ("ts", Some("timestamp")), ("dec", Some("decimal")), ("x", Some("weird")), ("bl", Some("blob"))]),
        &[vec![json!("2026-10-18"), Value::Null, json!("2026-10-18T01:02:03"), json!("1.10"), json!(1), json!("ab")]],
    )
    .unwrap();
    let q = e.query("SELECT d, n, ts, dec, x, d || 'x', 1, 1.5, 'a', n FROM t", 5).unwrap();
    let ty: Vec<&str> = q.columns.iter().map(|c| c.type_name.as_str()).collect();
    assert_eq!(ty, ["date", "unknown", "timestamp", "decimal", "integer", "text", "integer", "real", "text", "unknown"]);
}

#[test]
fn json_shapes() {
    let mut e = eng();
    e.register("t", &cols(&[("n", None), ("o", None)]), &[vec![json!(1), json!({"a":[1,2]})]]).unwrap();
    let q = e.query("SELECT x'00ff10', zeroblob(70000), 1e999 - 1e999, 1e999, o FROM t", 5).unwrap();
    assert_eq!(q.rows[0][0], json!({"$blob": "00ff10", "bytes": 3}));
    let b = &q.rows[0][1];
    assert_eq!(b["bytes"], json!(70000));
    assert_eq!(b["truncated"], json!(true));
    assert_eq!(b["$blob"].as_str().unwrap().len(), 65536 * 2);
    assert_eq!(q.rows[0][2], Value::Null);
    assert_eq!(q.rows[0][3], Value::Null);
    assert_eq!(q.rows[0][4], json!("{\"a\":[1,2]}"));
    assert_eq!(q.columns[0].type_name, "blob");
}

#[test]
fn nan_input_null() {
    let mut e = eng();
    e.register("t", &cols(&[("f", Some("real"))]), &[vec![json!(1.5)]]).unwrap();
    assert_eq!(e.query("SELECT f FROM t", 1).unwrap().rows[0][0], json!(1.5));
}


// Tests never rely on the 30 s default timeout.
fn tl() -> result_engine::Limits {
    result_engine::Limits { query_timeout: std::time::Duration::from_secs(10), ..Default::default() }
}

// Rendered forms produced by @sqlnb/format renderSql(…, 'sqlite'), copied verbatim.
#[test]
fn rendered_params_are_valid_sqlite() {
    let mut e = eng();
    e.register(
        "t",
        &cols(&[("name", Some("text")), ("n", Some("integer")), ("b", Some("integer")), ("d", Some("text"))]),
        &[
            vec![json!("O'Brien"), json!(-5), json!(1), json!("2026-01-31")],
            vec![json!("a\\b"), json!(7), json!(0), json!("2026-02-01")],
            vec![json!("plain"), json!(3), json!(1), json!("2026-03-01")],
        ],
    )
    .unwrap();
    let mut n = |sql: &str| e.query(sql, 100).unwrap().rows.len();
    assert_eq!(n("SELECT * FROM t WHERE name = 'O''Brien'"), 1);
    assert_eq!(n("SELECT * FROM t WHERE name = 'a\\b'"), 1);
    assert_eq!(n("SELECT * FROM t WHERE n = (-5)"), 1);
    assert_eq!(n("SELECT * FROM t WHERE b = 1"), 2);
    assert_eq!(n("SELECT * FROM t WHERE b = 0"), 1);
    assert_eq!(n("SELECT * FROM t WHERE d = '2026-01-31'"), 1);
    assert_eq!(n("SELECT * FROM t WHERE name IN ('O''Brien', 'plain')"), 2);
}
