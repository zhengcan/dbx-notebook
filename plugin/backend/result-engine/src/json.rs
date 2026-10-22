use rusqlite::types::{Value as Sql, ValueRef};
use serde_json::{json, Value};

const MAX_EXACT: i64 = 1 << 53;
pub(crate) const BLOB_CAP: usize = 64 * 1024;

pub fn to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => {
            if (-MAX_EXACT..=MAX_EXACT).contains(&i) {
                json!(i)
            } else {
                Value::String(i.to_string())
            }
        }
        ValueRef::Real(f) => {
            if f.is_finite() {
                json!(f)
            } else {
                Value::Null
            }
        }
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => {
            let cut = &b[..b.len().min(BLOB_CAP)];
            let hex: String = cut.iter().map(|x| format!("{x:02x}")).collect();
            let mut o = json!({"$blob": hex, "bytes": b.len()});
            if b.len() > BLOB_CAP {
                o["truncated"] = json!(true);
            }
            o
        }
    }
}

/// `integer_col`: numeric strings are parsed to i64 so big ints round-trip.
pub fn from_json(v: &Value, integer_col: bool) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Sql::Integer(i),
            None => n.as_f64().map_or(Sql::Text(n.to_string()), Sql::Real),
        },
        Value::String(s) => {
            if integer_col {
                if let Ok(i) = s.trim().parse::<i64>() {
                    return Sql::Integer(i);
                }
            }
            Sql::Text(s.clone())
        }
        Value::Array(_) | Value::Object(_) => Sql::Text(v.to_string()),
    }
}
