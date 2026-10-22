// shared by every engine spike via include!
use std::time::Instant;

#[derive(Clone, Debug)]
pub enum Cell { Int(i64), Dbl(f64), Txt(String), Bool(bool), Date(i32), Ts(i64), Null }

pub const NROWS: usize = 5000;

/// (name, kind) kind in int,dbl,txt,bool,date,ts,nint,dec
pub fn cols() -> Vec<(String, &'static str)> {
    let mut v: Vec<(String, &'static str)> = vec![
        ("id".into(), "int"), ("grp".into(), "txt"), ("amount".into(), "dbl"), ("qty".into(), "int"),
        ("flag".into(), "bool"), ("d".into(), "date"), ("ts".into(), "ts"), ("note".into(), "ntxt"), ("price".into(), "dec"),
    ];
    let kinds = ["int", "dbl", "txt", "bool", "date", "ts", "nint", "dec"];
    let mut k = 9;
    while v.len() < 50 { let kd = kinds[k % 8]; v.push((format!("{}_{}", kd, k), kd)); k += 1; }
    v
}

fn lcg(s: &mut u64) -> u64 { *s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); *s >> 33 }

pub fn rows(n: usize) -> Vec<Vec<Cell>> {
    let cs = cols();
    let mut s = 42u64;
    (0..n).map(|i| {
        cs.iter().map(|(name, kind)| match (name.as_str(), *kind) {
            ("id", _) => Cell::Int(i as i64),
            ("grp", _) => Cell::Txt(format!("g{}", lcg(&mut s) % 10)),
            ("amount", _) => Cell::Dbl((lcg(&mut s) % 100000) as f64 / 100.0),
            ("qty", _) => Cell::Int((lcg(&mut s) % 50 + 1) as i64),
            ("flag", _) => Cell::Bool(lcg(&mut s) % 3 == 0),
            ("d", _) => Cell::Date(19358 + (i % 700) as i32), // 2023-01-01 +
            ("ts", _) => Cell::Ts((19358 + (i % 700) as i64) * 86400_000_000 + (lcg(&mut s) % 86400) as i64 * 1_000_000),
            ("note", _) => if i % 7 == 0 { Cell::Null } else { Cell::Txt(format!("Note {} Alpha-{}", i, lcg(&mut s) % 100)) },
            (_, "int") => Cell::Int(lcg(&mut s) as i64 % 100000),
            (_, "dbl") => Cell::Dbl(lcg(&mut s) as f64 / 1000.0),
            (_, "txt") => Cell::Txt(format!("txt{}", lcg(&mut s) % 1000)),
            (_, "bool") => Cell::Bool(lcg(&mut s) % 2 == 0),
            (_, "date") => Cell::Date(18000 + (lcg(&mut s) % 2000) as i32),
            (_, "ts") => Cell::Ts((18000 + (lcg(&mut s) % 2000) as i64) * 86400_000_000),
            (_, "nint") => if lcg(&mut s) % 4 == 0 { Cell::Null } else { Cell::Int(lcg(&mut s) as i64 % 1000) },
            (_, "dec") => Cell::Dbl((lcg(&mut s) % 1000000) as f64 / 100.0),
            _ => Cell::Null,
        }).collect()
    }).collect()
}

pub fn dim_rows() -> Vec<(String, String)> {
    (0..10).map(|i| (format!("g{}", i), ["north", "south", "east", "west", "central"][i % 5].to_string())).collect()
}

pub fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719468; let era = z.div_euclid(146097); let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
pub fn fmt_date(days: i32) -> String { let (y, m, d) = civil(days as i64); format!("{:04}-{:02}-{:02}", y, m, d) }
pub fn fmt_ts(us: i64) -> String {
    let secs = us.div_euclid(1_000_000); let days = secs.div_euclid(86400); let r = secs.rem_euclid(86400);
    format!("{} {:02}:{:02}:{:02}", fmt_date(days as i32), r / 3600, r % 3600 / 60, r % 60)
}

/// Postgres-flavoured notebook queries (primary form).
pub const QUERIES: &[(&str, &str)] = &[
    ("01 filter+order+limit", "SELECT id, amount, grp FROM t WHERE amount > 500 AND flag ORDER BY amount DESC LIMIT 10"),
    ("02 group by+having", "SELECT grp, count(*) AS n, sum(amount) AS s FROM t GROUP BY grp HAVING sum(amount) > 1000 ORDER BY grp"),
    ("03 join", "SELECT t.grp, d.region, count(*) AS n FROM t JOIN dim d ON t.grp = d.grp GROUP BY t.grp, d.region ORDER BY 1"),
    ("04 cte", "WITH big AS (SELECT * FROM t WHERE amount > 100) SELECT grp, avg(amount) AS a FROM big GROUP BY grp ORDER BY grp"),
    ("05 window", "SELECT id, row_number() OVER (PARTITION BY grp ORDER BY amount DESC) AS rn, sum(amount) OVER (PARTITION BY grp ORDER BY id) AS run, lag(amount) OVER (PARTITION BY grp ORDER BY id) AS prev FROM t"),
    ("06 median/percentile", "SELECT grp, percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) AS med FROM t GROUP BY grp ORDER BY grp"),
    ("07 date_trunc", "SELECT date_trunc('month', d) AS m, date_trunc('week', ts) AS w, count(*) FROM t GROUP BY 1, 2 ORDER BY 1, 2"),
    ("08 string fns", "SELECT lower(note), substr(note, 1, 6), 'x' || grp, concat(grp, '-', qty) FROM t WHERE note ~ 'Alpha-1[0-9]$' OR note LIKE 'Note 1%'"),
    ("09 cast", "SELECT CAST(amount AS INTEGER) AS ai, CAST(qty AS VARCHAR) AS qs, amount::int AS a2, CAST(d AS VARCHAR) AS ds FROM t LIMIT 20"),
    ("10 case", "SELECT CASE WHEN amount > 750 THEN 'high' WHEN amount > 250 THEN 'mid' ELSE 'low' END AS band, count(*) FROM t GROUP BY 1 ORDER BY 1"),
    ("11 null handling", "SELECT coalesce(note, 'n/a') AS n, nullif(qty, 1) AS q, count(note) AS cn, count(*) AS c FROM t WHERE note IS NULL OR qty IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 20"),
    ("12 in-list", "SELECT count(*) FROM t WHERE grp IN ('g1', 'g3', 'g5') AND qty IN (1, 2, 3, 4)"),
    ("13 distinct", "SELECT count(DISTINCT grp) AS cg, (SELECT count(*) FROM (SELECT DISTINCT qty FROM t) x) AS cq FROM t"),
    ("14 subquery", "SELECT id, amount FROM t WHERE amount > (SELECT avg(amount) FROM t) AND grp IN (SELECT grp FROM dim WHERE region = 'north') ORDER BY id LIMIT 10"),
];

pub struct QRes { pub rows: usize, pub ncols: usize, pub types: String, pub sample: String }

/// `run(sql)` executes and fully materialises rows. `alts(name)` gives rewritten variants (tried if primary fails).
pub fn run_suite(mut run: impl FnMut(&str) -> Result<QRes, String>, alts: impl Fn(&str) -> Vec<&'static str>) {
    let (mut strict, mut any) = (0, 0);
    for (name, sql) in QUERIES {
        let mut variants = vec![*sql]; variants.extend(alts(name));
        let mut done = false; let mut first_err = String::new();
        for (vi, v) in variants.iter().enumerate() {
            match run(v) {
                Ok(r) => {
                    let mut ts = vec![];
                    for _ in 0..3 { let t = Instant::now(); let _ = run(v); ts.push(t.elapsed().as_secs_f64() * 1000.0); }
                    ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    let tag = if vi == 0 { strict += 1; "PASS" } else { "PASS-REWRITE" };
                    any += 1;
                    println!("{tag:12} {name:24} rows={:<5} cols={:<2} med={:.2}ms types=[{}]", r.rows, r.ncols, ts[1], r.types);
                    println!("             sample: {}", r.sample);
                    if vi > 0 { println!("             primary error: {first_err}\n             used: {v}"); }
                    done = true; break;
                }
                Err(e) => { if vi == 0 { first_err = e.replace('\n', " "); } }
            }
        }
        if !done { println!("FAIL         {name:24} error: {first_err}"); }
    }
    println!("SUMMARY strict_pass={strict}/14 pass_with_rewrite={any}/14");
}
