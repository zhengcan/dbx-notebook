#![allow(dead_code)]
include!("../../common/data.rs");
use stoolap::{Database, Value, DataType};

fn tname(v: &Value) -> &'static str {
    match v { Value::Null(_) => "NULL", Value::Integer(_) => "Integer", Value::Float(_) => "Float", Value::Text(_) => "Text", Value::Boolean(_) => "Boolean", Value::Timestamp(_) => "Timestamp", Value::Extension(_) => "Ext" }
}

fn main() {
    let db = Database::open_in_memory().unwrap();
    let cs = cols();
    let rs = rows(NROWS);
    let t0 = Instant::now();
    let decl: Vec<String> = cs.iter().map(|(n, k)| format!("{} {}", n, match *k {
        "int" | "nint" => "INTEGER", "dbl" | "dec" => "FLOAT", "txt" | "ntxt" => "TEXT", "bool" => "BOOLEAN", _ => "TIMESTAMP" })).collect();
    db.execute(&format!("CREATE TABLE t ({})", decl.join(",")), ()).unwrap();
    db.execute("CREATE TABLE dim (grp TEXT, region TEXT)", ()).unwrap();
    let ph: Vec<String> = (1..=cs.len()).map(|i| format!("${}", i)).collect();
    let ins = format!("INSERT INTO t VALUES ({})", ph.join(","));
    let ts = |us: i64| Value::timestamp(chrono::DateTime::<chrono::Utc>::from_timestamp_micros(us).unwrap());
    for r in &rs {
        let ps: Vec<Value> = r.iter().zip(&cs).map(|(c, (_, k))| match c {
            Cell::Int(i) => Value::integer(*i), Cell::Dbl(f) => Value::from(*f), Cell::Txt(s) => Value::text(s.as_str()), Cell::Bool(b) => Value::from(*b),
            Cell::Date(d) => ts(*d as i64 * 86400_000_000), Cell::Ts(x) => ts(*x),
            Cell::Null => Value::null(match *k { "nint" => DataType::Integer, _ => DataType::Text }) }).collect();
        db.execute(&ins, ps).unwrap();
    }
    for (g, r) in dim_rows() { db.execute("INSERT INTO dim VALUES ($1, $2)", vec![Value::text(g.as_str()), Value::text(r.as_str())]).unwrap(); }
    println!("LOAD 5000x{} = {:.1}ms", cs.len(), t0.elapsed().as_secs_f64() * 1000.0);

    if let Ok(q) = std::env::var("PROBE") {
        for sql in q.split(";;") {
            match db.query(sql, ()) { Ok(r) => { let v: Vec<_> = r.map(|x| x.map(|x| (0..x.len()).map(|i| format!("{}", x.get_value(i).unwrap())).collect::<Vec<_>>().join(",")).unwrap_or_else(|e| e.to_string())).take(3).collect(); println!("OK  {sql}\n    {:?}", v); }
                Err(e) => println!("ERR {sql}\n    {e}") }
        }
        return;
    }
    run_suite(|sql| {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<QRes, String> {
            let rows = db.query(sql, ()).map_err(|e| e.to_string())?;
            let names: Vec<String> = rows.columns().to_vec();
            let n = names.len();
            let (mut cnt, mut types, mut sample) = (0, vec![String::new(); n], String::new());
            for r in rows {
                let r = r.map_err(|e| e.to_string())?;
                for i in 0..n {
                    let v = r.get_value(i).unwrap();
                    let t = tname(v);
                    if !types[i].contains(t) { if !types[i].is_empty() { types[i].push('|'); } types[i].push_str(t); }
                    if cnt == 0 { sample.push_str(&format!("{}; ", v)); }
                }
                cnt += 1;
            }
            Ok(QRes { rows: cnt, ncols: n, types: names.iter().zip(&types).map(|(a, b)| format!("{a}:{b}")).collect::<Vec<_>>().join(", "), sample })
        }));
        match res { Ok(r) => r, Err(_) => Err("PANIC".into()) }
    }, |name| match &name[..2] {
        "06" => vec!["SELECT grp, median(amount) AS med FROM t GROUP BY grp ORDER BY grp", "SELECT grp, percentile_cont(amount, 0.5) AS med FROM t GROUP BY grp ORDER BY grp"],
        "07" => vec!["SELECT date_trunc('month', d) AS m, count(*) FROM t GROUP BY date_trunc('month', d) ORDER BY m"],
        "08" => vec!["SELECT lower(note), substr(note, 1, 6), 'x' || grp, concat(grp, '-', qty) FROM t WHERE note LIKE '%Alpha-1_' OR note LIKE 'Note 1%'"],
        "09" => vec!["SELECT CAST(amount AS INTEGER) AS ai, CAST(qty AS TEXT) AS qs, CAST(d AS TEXT) AS ds FROM t LIMIT 20"],
        "01" => vec!["SELECT id, amount, grp FROM t WHERE amount > 500 AND flag = true ORDER BY amount DESC LIMIT 10"],
        _ => vec![],
    });
}
