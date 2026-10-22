//! Executes SQL produced by plugin/ui-src/src/analysis/sql.ts (see test/analysisSql.test.ts for the
//! generator tests that produce each string) on the real SqliteEngine.
//! The SQL comes from tests/fixtures/analysis_sql.json (generator output).
use result_engine::*;
use serde_json::{json, Value};

// Fixture is generated from plugin/ui-src/test/sqlFixtureCases.ts (`npm run gen:sql-fixture -w plugin/ui-src`);
// a TS test fails when it is stale.
fn sql(name: &str) -> String {
    let v: Vec<Value> = serde_json::from_str(include_str!("fixtures/analysis_sql.json")).unwrap();
    v.iter()
        .find(|x| x["name"] == name)
        .unwrap_or_else(|| panic!("no fixture {name}"))["sql"]
        .as_str()
        .unwrap()
        .to_string()
}

fn eng() -> SqliteEngine {
    let mut e = SqliteEngine::new(Limits { query_timeout: std::time::Duration::from_secs(10), ..Default::default() });
    let cols: Vec<ColumnSpec> = ["name with space", "created at", "amount", "金额", "order"]
        .iter()
        .map(|n| ColumnSpec { name: n.to_string(), type_hint: None })
        .collect();
    let rows = vec![
        vec![json!("a b"), json!("2026-01-15 10:00:00"), json!(10), json!(1.0), json!("x")],
        vec![json!("a b"), json!("2026-01-20 09:00:00"), json!(20), json!(3.0), json!("x")],
        vec![json!("c"), json!("2026-02-03"), json!(40), json!(5.0), json!("y")],
        vec![Value::Null, Value::Null, Value::Null, json!(7.0), Value::Null],
        vec![json!("c"), json!("not a date"), json!(5), Value::Null, json!("y")],
        vec![json!("d"), json!("2026-02-30"), json!(1), json!(1.0), json!("y")],
    ];
    e.register("t", &cols, &rows).unwrap();
    e
}

fn run(sql: &str) -> Vec<Vec<Value>> {
    eng().query(sql, 100).unwrap_or_else(|e| panic!("{e}")).rows
}

#[test]
fn date_trunc_errors_on_unparseable_so_generator_guards_it() {
    let e = eng().query("SELECT date_trunc('month', 'not a date')", 10).unwrap_err();
    assert!(e.message.contains("cannot parse timestamp"), "{e}");
    // the generated guard turns unparseable values into NULL instead of erroring
    let rows = run(&sql("month"));
    assert_eq!(rows.len(), 2);
}

#[test]
fn month_bucketing_excludes_null_and_unparseable() {
    // analysisSql.test.ts: 'every grain wraps date_trunc with a guard and excludes null buckets'
    assert_eq!(run(&sql("month")), vec![
        vec![json!("2026-01-01 00:00:00"), json!(30)],
        vec![json!("2026-02-01"), json!(40)],
    ]);
}

#[test]
fn week_starts_monday() {
    assert_eq!(run(&sql("week")), vec![
        vec![json!("2026-01-12 00:00:00"), json!(1)],
        vec![json!("2026-01-19 00:00:00"), json!(1)],
        vec![json!("2026-02-02"), json!(1)],
    ]);
}

#[test]
fn excluded_counts() {
    assert_eq!(run(&sql("excluded")), vec![vec![json!(3)]]);
    // raw temporal: only the NULL row is excluded
    assert_eq!(run(&sql("excluded_raw")), vec![vec![json!(1)]]);
}

#[test]
fn median_with_nulls_last() {
    assert_eq!(run(&sql("median")), vec![
        vec![json!("x"), json!(2.0)],
        vec![json!("y"), json!(3.0)],
        vec![Value::Null, json!(7.0)],
    ]);
}

#[test]
fn count_distinct() {
    assert_eq!(run(&sql("distinct")), vec![
        vec![json!("x"), json!(1)],
        vec![json!("y"), json!(2)],
        vec![Value::Null, json!(0)],
    ]);
}

#[test]
fn multi_dim_group_by() {
    assert_eq!(run(&sql("multi")), vec![
        vec![json!("a b"), json!("x"), json!("2026-01-01 00:00:00"), json!(30)],
        vec![json!("c"), json!("y"), json!("2026-01-01"), json!(40)],
    ]);
}

#[test]
fn grand_total_no_group_by() {
    let rows = run(&sql("grand"));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][0], json!(76));
    assert!((rows[0][1].as_f64().unwrap() - 3.4).abs() < 1e-9);
}

#[test]
fn first_and_last_by_rowid() {
    assert_eq!(run(&sql("first")), vec![vec![json!("a b")]]);
    assert_eq!(run(&sql("last")), vec![vec![json!("d")]]);
}

#[test]
fn source_columns_named_like_generated_aliases() {
    let mut e = SqliteEngine::new(Limits { query_timeout: std::time::Duration::from_secs(10), ..Default::default() });
    let cols: Vec<ColumnSpec> = ["r0", "c0", "v0", "__sqlnb_r0"]
        .iter()
        .map(|n| ColumnSpec { name: n.to_string(), type_hint: None })
        .collect();
    let rows = vec![
        vec![json!("b"), json!("p"), json!(1), json!("z")],
        vec![json!("a"), json!("q"), json!(2), json!("y")],
        vec![json!("b"), json!("p"), json!(10), json!("z")],
        vec![Value::Null, json!("p"), json!(5), json!("x")],
    ];
    e.register("odd", &cols, &rows).unwrap();
    let got = e.query(&sql("odd_names"), 100).unwrap().rows;
    assert_eq!(got, vec![
        vec![json!("a"), json!("y"), json!("q"), json!(2), json!(2)],
        vec![json!("b"), json!("z"), json!("p"), json!(11), json!(10)],
        vec![Value::Null, json!("x"), json!("p"), json!(5), json!(5)],
    ]);
    let got = e.query(&sql("odd_column_totals"), 100).unwrap().rows;
    assert_eq!(got, vec![vec![json!("p"), json!(16)], vec![json!("q"), json!(2)]]);
}

fn eng_numeric_strings(hint: Option<&str>) -> SqliteEngine {
    let mut e = SqliteEngine::new(Limits { query_timeout: std::time::Duration::from_secs(10), ..Default::default() });
    let cols = vec![ColumnSpec { name: "amt".into(), type_hint: hint.map(|s| s.to_string()) }];
    let rows = vec![vec![json!("12.50")], vec![json!("3")], vec![json!("100")], vec![Value::Null]];
    e.register("t", &cols, &rows).unwrap();
    e
}

#[test]
fn numeric_strings_aggregate_numerically_for_raw_db_type_hints() {
    for hint in [Some("numeric"), Some("NUMERIC(10,2)"), Some("int8"), Some("double precision"), Some("decimal"), Some("bigint unsigned"), Some("money")] {
        let mut e = eng_numeric_strings(hint);
        let r = e
            .query("SELECT sum(\"amt\"), avg(\"amt\"), median(\"amt\"), min(\"amt\"), max(\"amt\"), count(DISTINCT \"amt\") FROM \"t\"", 10)
            .unwrap_or_else(|x| panic!("{hint:?}: {x}"))
            .rows;
        let f = |i: usize| r[0][i].as_f64().unwrap_or_else(|| panic!("{hint:?} col {i}: {:?}", r[0][i]));
        assert_eq!(f(0), 115.5, "{hint:?}");
        assert!((f(1) - 115.5 / 3.0).abs() < 1e-9, "{hint:?}");
        assert_eq!(f(2), 12.5, "{hint:?}");
        assert_eq!(f(3), 3.0, "{hint:?}");
        assert_eq!(f(4), 100.0, "{hint:?}");
        assert_eq!(f(5), 3.0, "{hint:?}");
    }
}

#[test]
fn numeric_strings_with_inferred_decimal_hint() {
    let mut e = eng_numeric_strings(Some("decimal"));
    let r = e.query("SELECT median(\"amt\"), min(\"amt\") FROM \"t\"", 10).unwrap().rows;
    assert_eq!(r[0][0].as_f64(), Some(12.5));
    assert_eq!(r[0][1].as_f64(), Some(3.0));
}

// Big-number probe (plan 12 T3): distinct, filters (LIKE ... ESCAPE) and the month/period expression run unchanged.
#[test]
fn big_number_distinct_filters_and_period() {
    assert_eq!(run(&sql("bn_distinct")), vec![vec![json!(2)]]);
    // no order value contains "x%_\'" literally
    assert_eq!(run(&sql("bn_contains")), vec![vec![json!(0)]]);
    assert_eq!(run(&sql("bn_filtered_sum")), vec![vec![json!(76)]]);
    // 2026-02-30 and 'not a date' are guarded out; the latest valid month is 2026-02
    assert_eq!(run(&sql("bn_period")), vec![vec![json!("2026-02")]]);
    assert_eq!(run(&sql("bn_period_value")), vec![vec![json!(30)]]);
}

#[test]
fn like_escape_matches_literal_wildcards() {
    let mut e = SqliteEngine::new(Limits { query_timeout: std::time::Duration::from_secs(10), ..Default::default() });
    let cols = vec![ColumnSpec { name: "s".into(), type_hint: None }];
    let rows = vec![vec![json!("50%_x")], vec![json!("500x")], vec![json!("A")]];
    e.register("u", &cols, &rows).unwrap();
    let r = e.query(r#"SELECT count(*) FROM "u" WHERE "s" LIKE '%50\%\_%' ESCAPE '\'"#, 10).unwrap().rows;
    assert_eq!(r, vec![vec![json!(1)]]);
}
