//! Postgres-style supplementary SQL functions for the local SQLite engine.
//!
//! Registered at engine creation; the read-only authorizer allows SQLITE_FUNCTION so
//! user queries may call them. All error messages start with the function name and
//! surface as -32602. No function panics on user data.
//!
//! Scalar: `date_trunc(unit, ts)`, `regexp(pattern, text)` (enables `text REGEXP pattern`),
//! `regexp_replace(text, pattern, repl[, flags])`, `left(s, n)`, `right(s, n)`,
//! `split_part(s, delim, n)`, `greatest(...)`, `least(...)`, `to_char(ts, fmt)`.
//! Aggregate: `median(x)`, `percentile_cont(x, p)`, `percentile_disc(x, p)`,
//! `stddev_samp`, `stddev_pop`, `var_samp`, `var_pop`.
//!
//! Decisions:
//! * Timestamps are `YYYY-MM-DD` or `YYYY-MM-DD[T ]HH:MM[:SS[.fff]][Z|±hh:mm]`; a zone
//!   suffix and fractions are accepted and ignored (fields are used as written).
//!   `date_trunc` keeps the input shape: date in -> date out (units below `day` leave
//!   it unchanged); timestamp in -> `YYYY-MM-DD HH:MM:SS` (or with `T` if the input used `T`).
//!   Weeks start on Monday (ISO).
//! * Aggregates accept only INTEGER/REAL (NULLs ignored) and return REAL. They are not
//!   usable as window functions.
//! * `greatest`/`least` ignore NULLs (NULL only if all are NULL); numbers compare
//!   numerically, text bytewise, mixed types by SQLite's order (numeric < text < blob).
//! * `regexp` is a partial match using the `regex` crate syntax (no look-around or
//!   backreferences in patterns); `regexp_replace` replacement uses `\1`..`\9`, `\&`
//!   (whole match), `\\`; `$` is literal.
//! * `to_char` supports only `YYYY MM DD HH24 MI SS` and `"quoted"` literals.
//! * `::` casts are NOT supported; use `CAST(x AS type)`.

use regex::{Regex, RegexBuilder};
use rusqlite::functions::{Aggregate, Context, FunctionFlags};
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, Error};
use std::cmp::Ordering;
use std::sync::{Arc, Mutex};

type R<T> = rusqlite::Result<T>;

const MAX_OUT: usize = 64 * 1024 * 1024;
const MAX_PATTERN: usize = 10_000;
const REGEX_SIZE_LIMIT: usize = 2 * 1024 * 1024;
const CACHE_SIZE: usize = 64;

fn ferr(f: &str, msg: impl std::fmt::Display) -> Error {
    Error::UserFunctionError(format!("{f}: {msg}").into())
}

fn flags() -> FunctionFlags {
    FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC
}

/// Ok(None) for NULL; numbers are stringified; blobs rejected.
fn text_arg(f: &str, ctx: &Context<'_>, i: usize) -> R<Option<String>> {
    match ctx.get_raw(i) {
        ValueRef::Null => Ok(None),
        ValueRef::Text(b) => std::str::from_utf8(b)
            .map(|s| Some(s.to_string()))
            .map_err(|_| ferr(f, "argument is not valid UTF-8")),
        ValueRef::Integer(n) => Ok(Some(n.to_string())),
        ValueRef::Real(x) => Ok(Some(x.to_string())),
        ValueRef::Blob(_) => Err(ferr(f, "argument must be text")),
    }
}

fn int_arg(f: &str, ctx: &Context<'_>, i: usize) -> R<Option<i64>> {
    match ctx.get_raw(i) {
        ValueRef::Null => Ok(None),
        ValueRef::Integer(n) => Ok(Some(n)),
        _ => Err(ferr(f, "argument must be an integer")),
    }
}

// ---------- calendar ----------

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
    }
}

struct Ts {
    y: i64,
    mo: i64,
    d: i64,
    h: i64,
    mi: i64,
    s: i64,
    has_time: bool,
    sep: char,
}

fn digits(b: &[u8], pos: usize, n: usize) -> Option<i64> {
    let sl = b.get(pos..pos + n)?;
    if !sl.iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(sl.iter().fold(0i64, |a, c| a * 10 + (c - b'0') as i64))
}

fn parse_ts(s: &str) -> Option<Ts> {
    let b = s.trim().as_bytes();
    let y = digits(b, 0, 4)?;
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let mo = digits(b, 5, 2)?;
    let d = digits(b, 8, 2)?;
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo) {
        return None;
    }
    let mut t = Ts { y, mo, d, h: 0, mi: 0, s: 0, has_time: false, sep: ' ' };
    if b.len() == 10 {
        return Some(t);
    }
    t.sep = match b[10] {
        b'T' => 'T',
        b' ' => ' ',
        _ => return None,
    };
    t.has_time = true;
    t.h = digits(b, 11, 2)?;
    if b.get(13) != Some(&b':') {
        return None;
    }
    t.mi = digits(b, 14, 2)?;
    let mut pos = 16;
    if b.get(pos) == Some(&b':') {
        t.s = digits(b, pos + 1, 2)?;
        pos += 3;
        if b.get(pos) == Some(&b'.') {
            let start = pos + 1;
            pos = start;
            while b.get(pos).is_some_and(|c| c.is_ascii_digit()) {
                pos += 1;
            }
            if pos == start {
                return None;
            }
        }
    }
    match &b[pos..] {
        [] | [b'Z'] | [b'z'] => {}
        [sign, ..] if (*sign == b'+' || *sign == b'-') && b.len() == pos + 6 => {
            let oh = digits(b, pos + 1, 2)?;
            let om = digits(b, pos + 4, 2)?;
            if b[pos + 3] != b':' || oh > 23 || om > 59 {
                return None;
            }
        }
        _ => return None,
    }
    if t.h > 23 || t.mi > 59 || t.s > 59 {
        return None;
    }
    Some(t)
}

fn date_trunc(ctx: &Context<'_>) -> R<Option<String>> {
    const F: &str = "date_trunc";
    let (Some(unit), Some(ts)) = (text_arg(F, ctx, 0)?, text_arg(F, ctx, 1)?) else {
        return Ok(None);
    };
    if !matches!(ctx.get_raw(1), ValueRef::Text(_)) {
        return Err(ferr(F, "timestamp must be text"));
    }
    let unit = unit.to_ascii_lowercase();
    if !["year", "quarter", "month", "week", "day", "hour", "minute", "second"].contains(&unit.as_str()) {
        return Err(ferr(F, format!("invalid unit '{}'", unit.chars().take(40).collect::<String>())));
    }
    let mut t = parse_ts(&ts).ok_or_else(|| ferr(F, "cannot parse timestamp (expected YYYY-MM-DD[ HH:MM[:SS]])"))?;
    match unit.as_str() {
        "year" => {
            t.mo = 1;
            t.d = 1;
        }
        "quarter" => {
            t.mo = (t.mo - 1) / 3 * 3 + 1;
            t.d = 1;
        }
        "month" => t.d = 1,
        "week" => {
            let days = days_from_civil(t.y, t.mo, t.d);
            let (y, m, d) = civil_from_days(days - (days + 3).rem_euclid(7));
            t.y = y;
            t.mo = m;
            t.d = d;
        }
        _ => {}
    }
    if matches!(unit.as_str(), "year" | "quarter" | "month" | "week" | "day") {
        t.h = 0;
        t.mi = 0;
        t.s = 0;
    } else if unit == "hour" {
        t.mi = 0;
        t.s = 0;
    } else if unit == "minute" {
        t.s = 0;
    }
    Ok(Some(if t.has_time {
        format!("{:04}-{:02}-{:02}{}{:02}:{:02}:{:02}", t.y, t.mo, t.d, t.sep, t.h, t.mi, t.s)
    } else {
        format!("{:04}-{:02}-{:02}", t.y, t.mo, t.d)
    }))
}

fn to_char(ctx: &Context<'_>) -> R<Option<String>> {
    const F: &str = "to_char";
    let (Some(ts), Some(fmt)) = (text_arg(F, ctx, 0)?, text_arg(F, ctx, 1)?) else {
        return Ok(None);
    };
    let t = parse_ts(&ts).ok_or_else(|| ferr(F, "cannot parse timestamp (expected YYYY-MM-DD[ HH:MM[:SS]])"))?;
    let mut out = String::new();
    let mut rest = fmt.as_str();
    while let Some(c) = rest.chars().next() {
        if c == '"' {
            let body = &rest[1..];
            let end = body.find('"').ok_or_else(|| ferr(F, "unterminated quoted text"))?;
            out.push_str(&body[..end]);
            rest = &body[end + 1..];
        } else if c.is_ascii_alphabetic() {
            let toks: [(&str, String); 6] = [
                ("YYYY", format!("{:04}", t.y)),
                ("HH24", format!("{:02}", t.h)),
                ("MM", format!("{:02}", t.mo)),
                ("DD", format!("{:02}", t.d)),
                ("MI", format!("{:02}", t.mi)),
                ("SS", format!("{:02}", t.s)),
            ];
            if let Some((tok, val)) = toks.iter().find(|(k, _)| rest.starts_with(k)) {
                out.push_str(val);
                rest = &rest[tok.len()..];
            } else {
                let run: String = rest.chars().take_while(|c| c.is_ascii_alphabetic()).take(40).collect();
                return Err(ferr(F, format!("unsupported format token {run}")));
            }
        } else {
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
        if out.len() > MAX_OUT {
            return Err(ferr(F, "result too large"));
        }
    }
    Ok(Some(out))
}

// ---------- regex ----------

#[derive(Clone, Default)]
struct RegexCache(Arc<Mutex<Vec<(String, bool, Regex)>>>);

impl RegexCache {
    fn get(&self, f: &str, pattern: &str, ci: bool) -> R<Regex> {
        if pattern.len() > MAX_PATTERN {
            return Err(ferr(f, "pattern too long (max 10000 bytes)"));
        }
        let mut c = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(i) = c.iter().position(|(p, i, _)| p == pattern && *i == ci) {
            let e = c.remove(i);
            let re = e.2.clone();
            c.push(e);
            return Ok(re);
        }
        let re = RegexBuilder::new(pattern)
            .case_insensitive(ci)
            .size_limit(REGEX_SIZE_LIMIT)
            .dfa_size_limit(REGEX_SIZE_LIMIT)
            .build()
            .map_err(|e| {
                let m = e.to_string();
                ferr(f, format!("invalid pattern: {}", m.lines().last().unwrap_or("").chars().take(200).collect::<String>()))
            })?;
        if c.len() >= CACHE_SIZE {
            c.remove(0);
        }
        c.push((pattern.to_string(), ci, re.clone()));
        Ok(re)
    }
}

/// Convert `\1`..`\9`, `\&`, `\\` to the regex crate syntax; `$` becomes literal.
/// Returns the template and the number of group references.
fn convert_repl(r: &str) -> (String, usize) {
    let mut out = String::with_capacity(r.len() + 8);
    let mut refs = 0;
    let mut it = r.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '$' => out.push_str("$$"),
            '\\' => match it.peek().copied() {
                Some(d) if d.is_ascii_digit() && d != '0' => {
                    it.next();
                    out.push_str(&format!("${{{d}}}"));
                    refs += 1;
                }
                Some('&') => {
                    it.next();
                    out.push_str("${0}");
                    refs += 1;
                }
                Some('\\') => {
                    it.next();
                    out.push('\\');
                }
                Some(o) => {
                    it.next();
                    if o == '$' {
                        out.push_str("$$");
                    } else {
                        out.push(o);
                    }
                }
                None => out.push('\\'),
            },
            c => out.push(c),
        }
    }
    (out, refs)
}

fn regexp_replace(ctx: &Context<'_>, cache: &RegexCache) -> R<Option<String>> {
    const F: &str = "regexp_replace";
    let (Some(text), Some(pat), Some(repl)) = (text_arg(F, ctx, 0)?, text_arg(F, ctx, 1)?, text_arg(F, ctx, 2)?) else {
        return Ok(None);
    };
    let (mut global, mut ci) = (false, false);
    if ctx.len() == 4 {
        for c in text_arg(F, ctx, 3)?.unwrap_or_default().chars() {
            match c {
                'g' => global = true,
                'i' => ci = true,
                o => return Err(ferr(F, format!("unsupported flag '{o}'"))),
            }
        }
    }
    let re = cache.get(F, &pat, ci)?;
    let (tpl, refs) = convert_repl(&repl);
    let mut out = String::new();
    let mut last = 0;
    for caps in re.captures_iter(&text) {
        let Some(m) = caps.get(0) else { continue };
        if out.len() + m.start() - last + repl.len() + refs * m.len() > MAX_OUT {
            return Err(ferr(F, "result too large"));
        }
        out.push_str(&text[last..m.start()]);
        caps.expand(&tpl, &mut out);
        last = m.end();
        if !global {
            break;
        }
    }
    if out.len() + text.len() - last > MAX_OUT {
        return Err(ferr(F, "result too large"));
    }
    out.push_str(&text[last..]);
    Ok(Some(out))
}

// ---------- string helpers ----------

fn left_right(ctx: &Context<'_>, is_left: bool) -> R<Option<String>> {
    let f = if is_left { "left" } else { "right" };
    let (Some(s), Some(n)) = (text_arg(f, ctx, 0)?, int_arg(f, ctx, 1)?) else {
        return Ok(None);
    };
    let len = s.chars().count() as i64;
    let keep = if n >= 0 { n.min(len) } else { (len + n).max(0) };
    Ok(Some(if is_left {
        s.chars().take(keep as usize).collect()
    } else {
        s.chars().skip((len - keep) as usize).collect()
    }))
}

fn split_part(ctx: &Context<'_>) -> R<Option<String>> {
    const F: &str = "split_part";
    let (Some(s), Some(delim), Some(n)) = (text_arg(F, ctx, 0)?, text_arg(F, ctx, 1)?, int_arg(F, ctx, 2)?) else {
        return Ok(None);
    };
    if n == 0 {
        return Err(ferr(F, "field position must not be zero"));
    }
    if delim.is_empty() {
        return Ok(Some(if n == 1 || n == -1 { s } else { String::new() }));
    }
    let parts: Vec<&str> = s.split(delim.as_str()).collect();
    let idx = if n > 0 { n - 1 } else { parts.len() as i64 + n };
    Ok(Some(if idx >= 0 && (idx as usize) < parts.len() { parts[idx as usize].to_string() } else { String::new() }))
}

fn type_rank(v: &ValueRef<'_>) -> u8 {
    match v {
        ValueRef::Null => 0,
        ValueRef::Integer(_) | ValueRef::Real(_) => 1,
        ValueRef::Text(_) => 2,
        ValueRef::Blob(_) => 3,
    }
}

fn cmp_values(a: &ValueRef<'_>, b: &ValueRef<'_>) -> Ordering {
    match (a, b) {
        (ValueRef::Integer(x), ValueRef::Integer(y)) => x.cmp(y),
        (ValueRef::Integer(x), ValueRef::Real(y)) => (*x as f64).partial_cmp(y).unwrap_or(Ordering::Equal),
        (ValueRef::Real(x), ValueRef::Integer(y)) => x.partial_cmp(&(*y as f64)).unwrap_or(Ordering::Equal),
        (ValueRef::Real(x), ValueRef::Real(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (ValueRef::Text(x), ValueRef::Text(y)) | (ValueRef::Blob(x), ValueRef::Blob(y)) => x.cmp(y),
        _ => type_rank(a).cmp(&type_rank(b)),
    }
}

fn greatest_least(ctx: &Context<'_>, want: Ordering) -> R<Value> {
    let f = if want == Ordering::Greater { "greatest" } else { "least" };
    if ctx.is_empty() {
        return Err(ferr(f, "requires at least one argument"));
    }
    let mut best: Option<ValueRef<'_>> = None;
    for i in 0..ctx.len() {
        let v = ctx.get_raw(i);
        if matches!(v, ValueRef::Null) {
            continue;
        }
        if best.as_ref().is_none_or(|b| cmp_values(&v, b) == want) {
            best = Some(v);
        }
    }
    Ok(best.map(Value::from).unwrap_or(Value::Null))
}

// ---------- aggregates ----------

fn num_arg(f: &str, ctx: &Context<'_>, i: usize) -> R<Option<f64>> {
    match ctx.get_raw(i) {
        ValueRef::Null => Ok(None),
        ValueRef::Integer(n) => Ok(Some(n as f64)),
        ValueRef::Real(x) => Ok(Some(x)),
        _ => Err(ferr(f, "argument must be numeric (INTEGER or REAL)")),
    }
}

#[derive(Clone, Copy)]
enum Pk {
    Median,
    Cont,
    Disc,
}

struct Percentile(Pk);

impl Percentile {
    fn name(&self) -> &'static str {
        match self.0 {
            Pk::Median => "median",
            Pk::Cont => "percentile_cont",
            Pk::Disc => "percentile_disc",
        }
    }
}

#[derive(Default)]
struct PState {
    vals: Vec<f64>,
    p: Option<f64>,
}

impl Aggregate<PState, Option<f64>> for Percentile {
    fn init(&self, _: &mut Context<'_>) -> R<PState> {
        Ok(PState::default())
    }
    fn step(&self, ctx: &mut Context<'_>, st: &mut PState) -> R<()> {
        let f = self.name();
        if !matches!(self.0, Pk::Median) {
            let p = match ctx.get_raw(1) {
                ValueRef::Integer(n) => n as f64,
                ValueRef::Real(x) => x,
                _ => return Err(ferr(f, "percentile must be a number")),
            };
            if !(0.0..=1.0).contains(&p) {
                return Err(ferr(f, "percentile must be between 0 and 1"));
            }
            match st.p {
                Some(q) if q != p => return Err(ferr(f, "percentile must be constant across rows")),
                _ => st.p = Some(p),
            }
        }
        if let Some(x) = num_arg(f, ctx, 0)? {
            st.vals.push(x);
        }
        Ok(())
    }
    fn finalize(&self, _: &mut Context<'_>, st: Option<PState>) -> R<Option<f64>> {
        let Some(mut st) = st else { return Ok(None) };
        if st.vals.is_empty() {
            return Ok(None);
        }
        st.vals.sort_by(|a, b| a.total_cmp(b));
        let n = st.vals.len();
        let p = if matches!(self.0, Pk::Median) { 0.5 } else { st.p.unwrap_or(0.5) };
        Ok(Some(match self.0 {
            Pk::Disc => st.vals[((p * n as f64).ceil() as usize).clamp(1, n) - 1],
            _ => {
                let pos = p * (n - 1) as f64;
                let lo = pos.floor() as usize;
                let hi = (pos.ceil() as usize).min(n - 1);
                st.vals[lo] + (st.vals[hi] - st.vals[lo]) * (pos - lo as f64)
            }
        }))
    }
}

struct Moment {
    name: &'static str,
    sample: bool,
    sqrt: bool,
}

#[derive(Default)]
struct WState {
    n: u64,
    mean: f64,
    m2: f64,
}

impl Aggregate<WState, Option<f64>> for Moment {
    fn init(&self, _: &mut Context<'_>) -> R<WState> {
        Ok(WState::default())
    }
    fn step(&self, ctx: &mut Context<'_>, st: &mut WState) -> R<()> {
        if let Some(x) = num_arg(self.name, ctx, 0)? {
            st.n += 1;
            let d = x - st.mean;
            st.mean += d / st.n as f64;
            st.m2 += d * (x - st.mean);
        }
        Ok(())
    }
    fn finalize(&self, _: &mut Context<'_>, st: Option<WState>) -> R<Option<f64>> {
        let Some(st) = st else { return Ok(None) };
        if st.n == 0 || (self.sample && st.n < 2) {
            return Ok(None);
        }
        let v = st.m2 / (if self.sample { st.n - 1 } else { st.n }) as f64;
        Ok(Some(if self.sqrt { v.sqrt() } else { v }))
    }
}

pub fn register_all(conn: &Connection) -> R<()> {
    let fl = flags();
    conn.create_scalar_function("date_trunc", 2, fl, date_trunc)?;
    conn.create_scalar_function("to_char", 2, fl, to_char)?;
    conn.create_scalar_function("left", 2, fl, |c| left_right(c, true))?;
    conn.create_scalar_function("right", 2, fl, |c| left_right(c, false))?;
    conn.create_scalar_function("split_part", 3, fl, split_part)?;
    conn.create_scalar_function("greatest", -1, fl, |c| greatest_least(c, Ordering::Greater))?;
    conn.create_scalar_function("least", -1, fl, |c| greatest_least(c, Ordering::Less))?;

    let cache = RegexCache::default();
    let c1 = cache.clone();
    conn.create_scalar_function("regexp", 2, fl, move |ctx| {
        let (Some(p), Some(t)) = (text_arg("regexp", ctx, 0)?, text_arg("regexp", ctx, 1)?) else {
            return Ok(None);
        };
        Ok(Some(c1.get("regexp", &p, false)?.is_match(&t)))
    })?;
    for n in [3, 4] {
        let c = cache.clone();
        conn.create_scalar_function("regexp_replace", n, fl, move |ctx| regexp_replace(ctx, &c))?;
    }

    conn.create_aggregate_function("median", 1, fl, Percentile(Pk::Median))?;
    conn.create_aggregate_function("percentile_cont", 2, fl, Percentile(Pk::Cont))?;
    conn.create_aggregate_function("percentile_disc", 2, fl, Percentile(Pk::Disc))?;
    for (name, sample, sqrt) in [
        ("stddev_samp", true, true),
        ("stddev_pop", false, true),
        ("var_samp", true, false),
        ("var_pop", false, false),
    ] {
        conn.create_aggregate_function(name, 1, fl, Moment { name, sample, sqrt })?;
    }
    Ok(())
}
