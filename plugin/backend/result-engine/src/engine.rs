use crate::error::{EngineError, Result};
use crate::json::{from_json, to_json};
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::limits::Limit;
use rusqlite::{params_from_iter, Connection};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ColumnSpec {
    pub name: String,
    pub type_hint: Option<String>,
}

#[derive(Debug, Clone)]
pub struct OutColumn {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone)]
pub struct QueryOutput {
    pub columns: Vec<OutColumn>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_total_rows: usize,
    pub query_timeout: Duration,
    /// Estimated cap on text/blob bytes returned per query (excess => truncated).
    pub max_result_bytes: usize,
    /// Cap on the in-memory database size (max_page_count); exceeding => -32021.
    pub max_db_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_total_rows: 500_000, query_timeout: Duration::from_secs(30),
            max_result_bytes: 64 * 1024 * 1024,
            max_db_bytes: 256 * 1024 * 1024,
        }
    }
}

pub trait ResultEngine {
    fn register(&mut self, name: &str, columns: &[ColumnSpec], rows: &[Vec<Value>]) -> Result<()>;
    fn drop_table(&mut self, name: &str) -> Result<()>;
    fn query(&mut self, sql: &str, max_rows: usize) -> Result<QueryOutput>;
    fn total_rows(&self) -> usize;
}

pub fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Integer,
    Real,
    Text,
    Boolean,
    Date,
    Timestamp,
    Decimal,
    Blob,
    Unknown,
}

/// Raw database type names (int8, NUMERIC(10,2), double precision, bigint unsigned, ...) map to
/// NUMERIC affinity so numeric strings ("12.50") that drivers emit for NUMERIC/BIGINT columns
/// become numbers and aggregates (median, min, max) work on them.
fn is_raw_numeric_type(h: &str) -> bool {
    let base: String = match h.find('(') {
        Some(i) => {
            let end = h[i..].find(')').map(|j| i + j + 1).unwrap_or(h.len());
            format!("{}{}", &h[..i], &h[end..])
        }
        None => h.to_string(),
    };
    let words: Vec<&str> = base.split_whitespace().filter(|w| !matches!(*w, "unsigned" | "signed" | "zerofill")).collect();
    let name = words.join(" ");
    if matches!(
        name.as_str(),
        "tinyint" | "smallint" | "mediumint" | "bigint" | "int" | "dec" | "numeric" | "number" | "money" | "smallmoney" | "fixed"
            | "float" | "double" | "double precision" | "smallserial" | "bigserial" | "serial"
    ) {
        return true;
    }
    let digits_after = |p: &str| name.strip_prefix(p).is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()));
    digits_after("int") || digits_after("uint") || digits_after("float") || digits_after("serial")
}

impl Kind {
    fn from_hint(h: Option<&str>) -> Kind {
        match h.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            Some("integer") => Kind::Integer,
            Some("real") => Kind::Real,
            Some("text") => Kind::Text,
            Some("boolean") => Kind::Boolean,
            Some("date") => Kind::Date,
            Some("timestamp") => Kind::Timestamp,
            Some("decimal") => Kind::Decimal,
            Some("blob") => Kind::Blob,
            Some(other) if is_raw_numeric_type(other) => Kind::Decimal,
            _ => Kind::Unknown,
        }
    }

    /// Declared SQL type. The declared name doubles as the type-hint carrier: it is
    /// read back with sqlite3_column_decltype for bare result columns. Names are
    /// chosen so SQLite's affinity rules give the intended affinity:
    /// `*_TEXT` -> TEXT (dates never get coerced to numbers), `BOOLEAN_INT` -> INTEGER,
    /// `DECIMAL` -> NUMERIC (values stored as given: JSON number or numeric string;
    /// numeric-looking strings are converted by SQLite, others stay text).
    fn decl(self) -> Option<&'static str> {
        Some(match self {
            Kind::Integer => "INTEGER",
            Kind::Real => "REAL",
            Kind::Text => "TEXT",
            Kind::Boolean => "BOOLEAN_INT",
            Kind::Date => "DATE_TEXT",
            Kind::Timestamp => "TIMESTAMP_TEXT",
            Kind::Decimal => "DECIMAL",
            Kind::Blob => "BLOB",
            Kind::Unknown => return None,
        })
    }

    fn from_decl(d: &str) -> Option<&'static str> {
        Some(match d {
            "INTEGER" => "integer",
            "REAL" => "real",
            "TEXT" => "text",
            "BOOLEAN_INT" => "boolean",
            "DATE_TEXT" => "date",
            "TIMESTAMP_TEXT" => "timestamp",
            "DECIMAL" => "decimal",
            "BLOB" => "blob",
            _ => return None,
        })
    }
}

const MAX_SQL_BYTES: usize = 1_000_000;

/// Scans `sql` and verifies it holds exactly one statement (a single trailing `;`
/// and trailing whitespace/comments are fine). Honors quotes and comments.
fn check_single_statement(sql: &str) -> Result<()> {
    let b = sql.as_bytes();
    let (mut i, mut seen, mut ended, mut lead_semi) = (0, false, false, false);
    let multi = || EngineError::invalid("multiple_statements: only a single read-only SELECT statement is allowed");
    while i < b.len() {
        let c = b[i];
        match c {
            b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c => i += 1,
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i += 2;
            }
            b';' => {
                if seen {
                    ended = true;
                } else {
                    lead_semi = true;
                }
                i += 1;
            }
            _ => {
                if ended || lead_semi {
                    return Err(multi());
                }
                seen = true;
                let close = match c {
                    b'\'' | b'"' | b'`' => c,
                    b'[' => b']',
                    _ => {
                        i += 1;
                        continue;
                    }
                };
                i += 1;
                while i < b.len() && b[i] != close {
                    i += 1;
                }
                i += 1; // doubled quotes simply re-enter as a new quoted run
            }
        }
    }
    if !seen {
        return Err(EngineError::invalid("empty: statement is empty"));
    }
    Ok(())
}

fn read_only_err() -> EngineError {
    EngineError::invalid("read_only: only a single read-only SELECT statement is allowed")
}

fn authorize(ctx: AuthContext<'_>) -> Authorization {
    match ctx.action {
        AuthAction::Select | AuthAction::Recursive => Authorization::Allow,
        AuthAction::Read { table_name, .. } => {
            let t = table_name.to_ascii_lowercase();
            if t.starts_with("sqlite_") && t != "sqlite_master" && t != "sqlite_schema" {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }
        AuthAction::Function { function_name } => {
            match function_name.to_ascii_lowercase().as_str() {
                "load_extension" | "readfile" | "writefile" | "edit" | "fts3_tokenizer" => Authorization::Deny,
                _ => Authorization::Allow,
            }
        }
        _ => Authorization::Deny,
    }
}

/// Installs the read-only authorizer and the timeout handler; removes both on drop.
struct QueryGuard<'a> {
    conn: &'a Connection,
}

impl<'a> QueryGuard<'a> {
    fn new(conn: &'a Connection, deadline: Instant, fired: Arc<AtomicBool>) -> Self {
        conn.authorizer(Some(authorize));
        conn.progress_handler(
            1000,
            Some(move || {
                if Instant::now() >= deadline {
                    fired.store(true, Ordering::Relaxed);
                    true
                } else {
                    false
                }
            }),
        );
        Self { conn }
    }
}

impl Drop for QueryGuard<'_> {
    fn drop(&mut self) {
        self.conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        self.conn.progress_handler(0, None::<fn() -> bool>);
    }
}

const MAX_JSON_DEPTH: usize = 128;

/// Iterative depth check (no recursion) for arrays/objects destined to become text.
fn nested_too_deep(v: &Value) -> bool {
    if !matches!(v, Value::Array(_) | Value::Object(_)) {
        return false;
    }
    let mut stack = vec![(v, 1usize)];
    while let Some((v, d)) = stack.pop() {
        if d > MAX_JSON_DEPTH {
            return true;
        }
        match v {
            Value::Array(a) => stack.extend(a.iter().map(|x| (x, d + 1))),
            Value::Object(o) => stack.extend(o.values().map(|x| (x, d + 1))),
            _ => {}
        }
    }
    false
}

/// Estimated cost of one value in a result: text = its length (+2 quotes); a blob is
/// counted as raw bytes plus the hex JSON copy (2 bytes per byte, capped like `to_json`).
fn value_bytes(v: rusqlite::types::ValueRef<'_>) -> usize {
    match v {
        rusqlite::types::ValueRef::Text(t) => t.len() + 2,
        rusqlite::types::ValueRef::Blob(b) => b.len() + 2 * b.len().min(crate::json::BLOB_CAP) + 40,
        _ => 8,
    }
}

pub struct SqliteEngine {
    conn: Connection,
    limits: Limits,
    /// Keyed by ASCII-lowercased name (SQLite identifiers are ASCII-case-insensitive);
    /// the value keeps the last-registered display name.
    tables: HashMap<String, (String, usize)>,
}

impl SqliteEngine {
    /// Registered tables with row counts, sorted by name.
    pub fn tables(&self) -> Vec<(String, usize)> {
        let mut v: Vec<(String, usize)> = self.tables.values().cloned().collect();
        v.sort();
        v
    }

    pub fn new(limits: Limits) -> Self {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, 64 * 1024 * 1024);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_BYTES as i32);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, 250_000);
        let _ = conn.set_limit(Limit::SQLITE_LIMIT_EXPR_DEPTH, 200);
        crate::functions::register_all(&conn).expect("register SQL functions");
        let pages = (limits.max_db_bytes / 4096).max(16);
        let _ = conn.execute_batch(&format!(
            "PRAGMA max_page_count={pages}; PRAGMA trusted_schema=OFF; PRAGMA cell_size_check=ON;"
        ));
        Self {
            conn,
            limits,
            tables: HashMap::new(),
        }
    }

    fn insert_all(&mut self, name: &str, columns: &[ColumnSpec], kinds: &[Kind], rows: &[Vec<Value>]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute_batch(&format!("DROP TABLE IF EXISTS {}", quote_ident(name)))?;
        let defs: Vec<String> = columns
            .iter()
            .zip(kinds)
            .map(|(c, k)| match k.decl() {
                Some(d) => format!("{} {}", quote_ident(&c.name), d),
                None => quote_ident(&c.name),
            })
            .collect();
        tx.execute_batch(&format!("CREATE TABLE {} ({})", quote_ident(name), defs.join(", ")))?;
        let marks = vec!["?"; columns.len()].join(", ");
        {
            let mut st = tx.prepare(&format!("INSERT INTO {} VALUES ({})", quote_ident(name), marks))?;
            for row in rows {
                let vals = row.iter().zip(kinds).map(|(v, k)| from_json(v, *k == Kind::Integer));
                st.execute(params_from_iter(vals))?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

impl ResultEngine for SqliteEngine {
    fn register(&mut self, name: &str, columns: &[ColumnSpec], rows: &[Vec<Value>]) -> Result<()> {
        if columns.is_empty() {
            return Err(EngineError::invalid("table needs at least one column"));
        }
        let mut seen = std::collections::HashSet::new();
        for c in columns {
            if !seen.insert(c.name.to_lowercase()) {
                return Err(EngineError::invalid(format!("duplicate column name: {}", c.name)));
            }
        }
        if let Some(i) = rows.iter().position(|r| r.len() != columns.len()) {
            return Err(EngineError::invalid(format!(
                "row {i} has {} values, expected {}",
                rows[i].len(),
                columns.len()
            )));
        }
        if rows.iter().flatten().any(nested_too_deep) {
            return Err(EngineError::invalid("value nested too deeply"));
        }
        let key = name.to_ascii_lowercase();
        let others: usize = self.tables.iter().filter(|(k, _)| k.as_str() != key).map(|(_, (_, n))| *n).sum();
        if others + rows.len() > self.limits.max_total_rows {
            return Err(EngineError::new(
                -32021,
                format!(
                    "engine session is full: {} rows registered + {} new exceeds limit {}",
                    others,
                    rows.len(),
                    self.limits.max_total_rows
                ),
            ));
        }
        let kinds: Vec<Kind> = columns.iter().map(|c| Kind::from_hint(c.type_hint.as_deref())).collect();
        self.insert_all(name, columns, &kinds, rows)?;
        self.tables.insert(key, (name.to_string(), rows.len()));
        Ok(())
    }

    fn drop_table(&mut self, name: &str) -> Result<()> {
        self.conn.execute_batch(&format!("DROP TABLE IF EXISTS {}", quote_ident(name)))?;
        self.tables.remove(&name.to_ascii_lowercase());
        Ok(())
    }

    fn query(&mut self, sql: &str, max_rows: usize) -> Result<QueryOutput> {
        let start = Instant::now();
        if sql.len() > MAX_SQL_BYTES {
            return Err(EngineError::invalid("sql too long"));
        }
        if sql.contains('\0') {
            return Err(EngineError::invalid("invalid: sql contains a NUL byte"));
        }
        check_single_statement(sql)?;
        let timeout = self.limits.query_timeout;
        let fired = Arc::new(AtomicBool::new(false));
        let guard = QueryGuard::new(&self.conn, start + timeout, fired.clone());
        let timed_out = || EngineError::new(-32020, format!("query timed out after {} ms", timeout.as_millis()));
        let map = |e: rusqlite::Error| -> EngineError {
            if fired.load(Ordering::Relaxed) {
                return timed_out();
            }
            if let rusqlite::Error::SqliteFailure(f, _) = &e {
                if f.code == rusqlite::ErrorCode::AuthorizationForStatementDenied {
                    return read_only_err();
                }
            }
            e.into()
        };
        let result = (|| {
            let mut st = self.conn.prepare(sql).map_err(&map)?;
            if !st.readonly() || st.column_count() == 0 || st.is_explain() != 0 {
                return Err(read_only_err());
            }
            let n = st.column_count();
            let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
            let decls: Vec<Option<&'static str>> = st
                .columns()
                .iter()
                .map(|c| c.decl_type().and_then(|d| Kind::from_decl(&d.to_ascii_uppercase())))
                .collect();
            let mut rows: Vec<Vec<Value>> = Vec::new();
            let mut truncated = false;
            let mut bytes = 0usize;
            let mut inferred: Vec<Option<&'static str>> = vec![None; n];
            let mut q = st.query([]).map_err(&map)?;
            while let Some(r) = q.next().map_err(&map)? {
                if rows.len() >= max_rows {
                    truncated = true;
                    break;
                }
                if start.elapsed() >= timeout {
                    return Err(timed_out());
                }
                let mut row_bytes = 0usize;
                for i in 0..n {
                    row_bytes = row_bytes.saturating_add(value_bytes(r.get_ref(i).map_err(&map)?));
                }
                let cap = self.limits.max_result_bytes;
                if row_bytes > cap && rows.is_empty() {
                    return Err(EngineError::invalid(format!(
                        "row_too_large: row too large ({row_bytes} bytes, limit {cap})"
                    )));
                }
                if bytes.saturating_add(row_bytes) > cap {
                    truncated = true;
                    break;
                }
                bytes += row_bytes;
                let mut out = Vec::with_capacity(n);
                for i in 0..n {
                    let v = r.get_ref(i).map_err(&map)?;
                    if inferred[i].is_none() {
                        inferred[i] = match v {
                            rusqlite::types::ValueRef::Null => None,
                            rusqlite::types::ValueRef::Integer(_) => Some("integer"),
                            rusqlite::types::ValueRef::Real(_) => Some("real"),
                            rusqlite::types::ValueRef::Text(_) => Some("text"),
                            rusqlite::types::ValueRef::Blob(_) => Some("blob"),
                        };
                    }
                    out.push(to_json(v));
                }
                rows.push(out);
            }
            let columns = (0..n)
                .map(|i| OutColumn {
                    name: names[i].clone(),
                    type_name: decls[i].or(inferred[i]).unwrap_or("unknown").to_string(),
                })
                .collect();
            Ok(QueryOutput { columns, rows, truncated, elapsed_ms: start.elapsed().as_millis() as u64 })
        })();
        drop(guard);
        result
    }

    fn total_rows(&self) -> usize {
        self.tables.values().map(|(_, n)| *n).sum()
    }
}
