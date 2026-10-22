use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub struct EngineError {
    pub code: i32,
    pub message: String,
}

pub type Result<T> = std::result::Result<T, EngineError>;

impl EngineError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(-32602, message)
    }
    pub fn rpc_message(&self) -> String {
        format!("[{}] {}", self.code, self.message)
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.rpc_message())
    }
}

impl std::error::Error for EngineError {}

impl From<rusqlite::Error> for EngineError {
    fn from(e: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(f, _) = &e {
            if f.code == rusqlite::ErrorCode::DiskFull {
                return Self::new(-32021, "engine session is full: in-memory database size limit reached");
            }
        }
        Self::invalid(e.to_string())
    }
}
