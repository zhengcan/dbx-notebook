#![allow(dead_code)]
include!("../../common/data.rs");
use rusqlite::{types::ValueRef, Connection};

fn main() {
    let conn = Connection::open_in_memory().unwrap();
    println!("sqlite_version={}", rusqlite::version());
    let cs = cols();
    let rs = rows(NROWS);
    let t0 = Instant::now();
    let decl: Vec<String> = cs.iter().map(|(n, k)| format!("{} {}", n, match *k {
        "int" | "nint" => "BIGINT", "dbl" => "DOUBLE", "txt" | "ntxt" => "TEXT", "bool" => "BOOLEAN", "date" => "DATE", "ts" => "TIMESTAMP", _ => "DECIMAL(12,2)" })).collect();
    conn.execute(&format!("CREATE TABLE t ({})", decl.join(",")), []).unwrap();
    conn.execute("CREATE TABLE dim (grp TEXT, region TEXT)", []).unwrap();
    conn.execute_batch("BEGIN").unwrap();
    {
        let mut st = conn.prepare(&format!("INSERT INTO t VALUES ({})", vec!["?"; cs.len()].join(","))).unwrap();
        for r in &rs {
            let ps: Vec<rusqlite::types::Value> = r.iter().map(|c| match c {
                Cell::Int(i) => (*i).into(), Cell::Dbl(f) => (*f).into(), Cell::Txt(s) => s.clone().into(), Cell::Bool(b) => (*b as i64).into(),
                Cell::Date(d) => fmt_date(*d).into(), Cell::Ts(t) => fmt_ts(*t).into(), Cell::Null => rusqlite::types::Value::Null }).collect();
            st.execute(rusqlite::params_from_iter(ps)).unwrap();
        }
        let mut sd = conn.prepare("INSERT INTO dim VALUES (?,?)").unwrap();
        for (g, r) in dim_rows() { sd.execute([g, r]).unwrap(); }
    }
    conn.execute_batch("COMMIT").unwrap();
    println!("LOAD 5000x{} = {:.1}ms", cs.len(), t0.elapsed().as_secs_f64() * 1000.0);

    run_suite(|sql| {
        let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
        let n = st.column_count();
        let decl: Vec<String> = (0..n).map(|i| st.columns()[i].decl_type().unwrap_or("-").to_string()).collect();
        let mut rows = st.query([]).map_err(|e| e.to_string())?;
        let (mut cnt, mut types, mut sample) = (0, vec![String::new(); n], String::new());
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            for i in 0..n {
                let v = r.get_ref(i).unwrap();
                let t = match v { ValueRef::Null => "NULL", ValueRef::Integer(_) => "int", ValueRef::Real(_) => "real", ValueRef::Text(_) => "text", ValueRef::Blob(_) => "blob" };
                if !types[i].contains(t) { if !types[i].is_empty() { types[i].push('|'); } types[i].push_str(t); }
                if cnt == 0 { sample.push_str(&format!("{:?}; ", v)); }
            }
            cnt += 1;
        }
        let ty = (0..n).map(|i| format!("{}:{}", decl[i], types[i])).collect::<Vec<_>>().join(", ");
        Ok(QRes { rows: cnt, ncols: n, types: ty, sample })
    }, |name| match &name[..2] {
        "06" => vec!["SELECT grp, avg(amount) FROM (SELECT grp, amount, row_number() OVER (PARTITION BY grp ORDER BY amount) rn, count(*) OVER (PARTITION BY grp) c FROM t) WHERE rn IN ((c+1)/2, (c+2)/2) GROUP BY grp ORDER BY grp"],
        "07" => vec!["SELECT strftime('%Y-%m-01', d) AS m, date(ts, 'weekday 0', '-6 days') AS w, count(*) FROM t GROUP BY 1, 2 ORDER BY 1, 2"],
        "08" => vec!["SELECT lower(note), substr(note, 1, 6), 'x' || grp, grp || '-' || qty FROM t WHERE note LIKE '%Alpha-1_' OR note LIKE 'Note 1%'"],
        "09" => vec!["SELECT CAST(amount AS INTEGER) AS ai, CAST(qty AS VARCHAR) AS qs, CAST(d AS VARCHAR) AS ds FROM t LIMIT 20"],
        _ => vec![],
    });
}
