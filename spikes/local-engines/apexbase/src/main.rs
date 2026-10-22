#![allow(dead_code)]
include!("../../common/data.rs");
use apexbase::data::Value;
use apexbase::embedded::{ApexDB, Row};
use apexbase::storage::on_demand::ColumnType;
use arrow::util::display::array_value_to_string;

fn main() {
    let dir = std::env::temp_dir().join(format!("apex-spike-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let db = ApexDB::builder(&dir).drop_if_exists(true).build().unwrap();
    let cs = cols();
    let rs = rows(NROWS);
    let t0 = Instant::now();
    let schema: Vec<(String, ColumnType)> = cs.iter().map(|(n, k)| (n.clone(), match *k {
        "int" | "nint" => ColumnType::Int64, "dbl" | "dec" => ColumnType::Float64, "txt" | "ntxt" => ColumnType::String,
        "bool" => ColumnType::Bool, "date" => ColumnType::Date, _ => ColumnType::Timestamp })).collect();
    let t = db.create_table_with_schema("t", &schema).unwrap();
    let recs: Vec<Row> = rs.iter().map(|r| r.iter().zip(&cs).map(|(c, (n, _))| (n.clone(), match c {
        Cell::Int(i) => Value::Int64(*i), Cell::Dbl(f) => Value::Float64(*f), Cell::Txt(s) => Value::String(s.clone()),
        Cell::Bool(b) => Value::Bool(*b), Cell::Date(d) => Value::Date(*d), Cell::Ts(x) => Value::Timestamp(*x), Cell::Null => Value::Null })).collect()).collect();
    t.insert_batch(&recs).unwrap();
    let dim = db.create_table_with_schema("dim", &[("grp".into(), ColumnType::String), ("region".into(), ColumnType::String)]).unwrap();
    let dr: Vec<Row> = dim_rows().into_iter().map(|(g, r)| [("grp".to_string(), Value::String(g)), ("region".to_string(), Value::String(r))].into_iter().collect()).collect();
    dim.insert_batch(&dr).unwrap();
    println!("LOAD 5000x{} = {:.1}ms (on-disk dir {})", cs.len(), t0.elapsed().as_secs_f64() * 1000.0, dir.display());
    println!("schema roundtrip: {:?}", t.schema().unwrap().iter().skip(3).take(6).collect::<Vec<_>>());

    if let Ok(q) = std::env::var("PROBE") {
        for sql in q.split(";;") {
            match db.execute(sql) { Ok(r) => { let b = r.to_record_batch().unwrap(); println!("OK  {sql}\n    cols={:?} rows={}", b.schema().fields().iter().map(|f| f.name().clone()).collect::<Vec<_>>(), b.num_rows()); }
                Err(e) => println!("ERR {sql}\n    {e}") }
        }
        return;
    }
    run_suite(|sql| {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| db.execute(sql)));
        let rs = match res { Ok(Ok(r)) => r, Ok(Err(e)) => return Err(format!("{e}")), Err(_) => return Err("PANIC".into()) };
        let b = rs.to_record_batch().map_err(|e| e.to_string())?;
        let sch = b.schema();
        let types = sch.fields().iter().map(|f| format!("{}:{}", f.name(), f.data_type())).collect::<Vec<_>>().join(", ");
        let sample = if b.num_rows() > 0 { (0..b.num_columns()).map(|i| array_value_to_string(b.column(i), 0).unwrap_or_else(|_| "?".into())).collect::<Vec<_>>().join("; ") } else { String::new() };
        Ok(QRes { rows: b.num_rows(), ncols: b.num_columns(), types, sample })
    }, |name| match &name[..2] {
        "01" => vec!["SELECT id, amount, grp FROM t WHERE amount > 500 AND flag = true ORDER BY amount DESC LIMIT 10"],
        "06" => vec!["SELECT grp, median(amount) AS med FROM t GROUP BY grp ORDER BY grp", "SELECT grp, percentile_cont(amount, 0.5) AS med FROM t GROUP BY grp ORDER BY grp", "SELECT grp, approx_percentile(amount, 0.5) AS med FROM t GROUP BY grp ORDER BY grp", "SELECT grp, percentile(amount, 0.5) AS med FROM t GROUP BY grp ORDER BY grp"],
        "07" => vec!["SELECT date_trunc('month', d) AS m, count(*) FROM t GROUP BY date_trunc('month', d) ORDER BY m", "SELECT date_trunc('month', d) AS m, count(*) FROM t GROUP BY m ORDER BY m", "SELECT strftime('%Y-%m', d) AS m, count(*) FROM t GROUP BY m ORDER BY m", "SELECT year(d) AS y, month(d) AS mo, count(*) FROM t GROUP BY y, mo ORDER BY y, mo"],
        "08" => vec!["SELECT lower(note), substr(note, 1, 6), concat('x', grp), concat(grp, '-', qty) FROM t WHERE note LIKE '%Alpha-1_' OR note LIKE 'Note 1%'", "SELECT lower(note), substr(note, 1, 6) FROM t WHERE note LIKE '%Alpha-1_' OR note LIKE 'Note 1%'", "SELECT lower(note), upper(grp), length(note) FROM t WHERE note LIKE 'Note 1%'"],
        "09" => vec!["SELECT CAST(amount AS INTEGER) AS ai, CAST(qty AS VARCHAR) AS qs, CAST(d AS VARCHAR) AS ds FROM t LIMIT 20", "SELECT CAST(amount AS INTEGER) AS ai, CAST(qty AS VARCHAR) AS qs FROM t LIMIT 20"],
        "10" => vec!["SELECT CASE WHEN amount > 750 THEN 'high' WHEN amount > 250 THEN 'mid' ELSE 'low' END AS band, count(*) FROM t GROUP BY CASE WHEN amount > 750 THEN 'high' WHEN amount > 250 THEN 'mid' ELSE 'low' END", "SELECT band, count(*) FROM (SELECT CASE WHEN amount > 750 THEN 'high' WHEN amount > 250 THEN 'mid' ELSE 'low' END AS band FROM t) x GROUP BY band ORDER BY band"],
        "11" => vec!["SELECT coalesce(note, 'n/a') AS n, nullif(qty, 1) AS q, count(note) AS cn FROM t WHERE note IS NULL OR qty IS NOT NULL LIMIT 20", "SELECT coalesce(note, 'n/a') AS n, count(note) AS cn FROM t WHERE note IS NULL LIMIT 20", "SELECT note, qty FROM t WHERE note IS NULL LIMIT 5", "SELECT count(note) AS cn, count(*) AS c FROM t"],
        _ => vec![],
    });
    let _ = std::fs::remove_dir_all(&dir);
}
