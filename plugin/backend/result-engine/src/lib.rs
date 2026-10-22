//! In-memory SQLite result engine.
//!
//! Memory: each session's database is capped by `Limits::max_db_bytes` (default 256 MiB);
//! with the default 8 sessions the worst case is 2 GiB. A global budget is not implemented.
//! Result sizes are capped by `Limits::max_result_bytes` (a row that would exceed the cap
//! is dropped and `truncated` is set; a first row over the cap is an error).

mod engine;
mod error;
mod functions;
mod json;

pub use engine::{quote_ident, ColumnSpec, Limits, OutColumn, QueryOutput, ResultEngine, SqliteEngine};
pub use error::{EngineError, Result};
pub mod hints;
pub mod sessions;
pub use hints::dialect_hint;
pub use sessions::Sessions;
pub mod rpc;
