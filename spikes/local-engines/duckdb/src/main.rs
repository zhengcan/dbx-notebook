#![allow(dead_code)]
include!("../../common/data.rs");
use duckdb::{types::{TimeUnit, Value}, Connection};

fn main() {
    let conn = Connection::open_in_memory().unwrap();
    let cs = cols();
    let rs = rows(NROWS);
    let t0 = Instant::now();
    let decl: Vec<String> = cs.iter().map(|(n, k)| format!("{} {}", n, match *k {
        "int" | "nint" => "BIGINT", "dbl" => "DOUBLE", "txt" | "ntxt" => "VARCHAR", "bool" => "BOOLEAN", "date" => "DATE", "ts" => "TIMESTAMP", _ => "DECIMAL(12,2)" })).collect();
    conn.execute_batch(&format!("CREATE TABLE t ({}); CREATE TABLE dim (grp VARCHAR, region VARCHAR);", decl.join(","))).unwrap();
    {
        let mut ap = conn.appender("t").unwrap();
        for r in &rs {
            let ps: Vec<Value> = r.iter().zip(&cs).map(|(c, (_, k))| match c {
                Cell::Int(i) => Value::BigInt(*i), Cell::Dbl(f) => if *k == "dec" { Value::Double(*f) } else { Value::Double(*f) },
                Cell::Txt(s) => Value::Text(s.clone()), Cell::Bool(b) => Value::Boolean(*b),
                Cell::Date(d) => Value::Date32(*d), Cell::Ts(t) => Value::Timestamp(TimeUnit::Microsecond, *t), Cell::Null => Value::Null }).collect();
            ap.append_row(duckdb::appender_params_from_iter(ps)).unwrap();
        }
        ap.flush().unwrap();
    }
    for (g, r) in dim_rows() { conn.execute("INSERT INTO dim VALUES (?, ?)", [g, r]).unwrap(); }
    println!("LOAD 5000x{} = {:.1}ms (Appender)", cs.len(), t0.elapsed().as_secs_f64() * 1000.0);

    run_suite(|sql| {
        let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = st.query([]).map_err(|e| e.to_string())?;
        let n = rows.as_ref().unwrap().column_count();
        let names: Vec<String> = rows.as_ref().unwrap().column_names();
        let types: Vec<String> = (0..n).map(|i| format!("{:?}", rows.as_ref().unwrap().column_type(i))).collect();
        let (mut cnt, mut sample) = (0, String::new());
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            if cnt == 0 { for i in 0..n { sample.push_str(&format!("{:?}; ", r.get_ref(i).unwrap())); } }
            cnt += 1;
        }
        Ok(QRes { rows: cnt, ncols: n, types: names.iter().zip(&types).map(|(a, b)| format!("{a}:{b}")).collect::<Vec<_>>().join(", "), sample })
    }, |_| vec![]);
}
