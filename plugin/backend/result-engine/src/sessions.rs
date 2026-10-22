use crate::engine::{Limits, ResultEngine, SqliteEngine};
use crate::error::{EngineError, Result};
use std::collections::HashMap;

pub const DEFAULT_CAPACITY: usize = 8;

/// Per-page isolated engines with LRU eviction.
///
/// Each engine owns an in-memory SQLite database; evicting or closing a
/// session drops the engine and therefore frees all of its data.
pub struct Sessions {
    engines: HashMap<String, SqliteEngine>,
    /// Least-recently-used first.
    order: Vec<String>,
    capacity: usize,
    limits: Limits,
}

/// Worst-case memory: `DEFAULT_CAPACITY` (8) sessions x `Limits::max_db_bytes`
/// (256 MiB each) = 2 GiB of in-memory databases. There is no global byte budget
/// yet; lower `Limits::max_db_bytes` or the capacity via `Sessions::new` to bound it.
impl Default for Sessions {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY, Limits::default())
    }
}

fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl Sessions {
    pub fn new(capacity: usize, limits: Limits) -> Self {
        Self { engines: HashMap::new(), order: Vec::new(), capacity: capacity.max(1), limits }
    }

    fn touch(&mut self, id: &str) {
        self.order.retain(|s| s != id);
        self.order.push(id.to_string());
    }

    pub fn get_or_create(&mut self, session_id: &str) -> Result<&mut SqliteEngine> {
        if !valid_id(session_id) {
            return Err(EngineError::invalid("invalid sessionId"));
        }
        if !self.engines.contains_key(session_id) {
            while self.engines.len() >= self.capacity && !self.order.is_empty() {
                let oldest = self.order.remove(0);
                self.engines.remove(&oldest);
            }
            self.engines.insert(session_id.to_string(), SqliteEngine::new(self.limits.clone()));
        }
        self.touch(session_id);
        Ok(self.engines.get_mut(session_id).expect("just inserted"))
    }

    pub fn get(&mut self, id: &str) -> Option<&mut SqliteEngine> {
        if !self.engines.contains_key(id) {
            return None;
        }
        self.touch(id);
        self.engines.get_mut(id)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.engines.contains_key(id)
    }

    pub fn close(&mut self, id: &str) -> bool {
        self.order.retain(|s| s != id);
        self.engines.remove(id).is_some()
    }

    pub fn len(&self) -> usize {
        self.engines.len()
    }

    /// Total registered rows across all sessions (diagnostics).
    pub fn total_rows(&self) -> usize {
        self.engines.values().map(|e| e.total_rows()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.engines.is_empty()
    }

    pub fn table_summary(&self, id: &str) -> Option<Vec<(String, usize)>> {
        self.engines.get(id).map(|e| e.tables())
    }
}
