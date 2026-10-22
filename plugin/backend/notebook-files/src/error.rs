use std::fmt;

pub const NOT_FOUND: i32 = -32010;
pub const STALE_MTIME: i32 = -32011;
pub const BAD_PARAMS: i32 = -32602;
pub const PARENT_MISSING: i32 = -32012;
pub const IO: i32 = -32013;
/// Export target already exists and the caller did not ask to overwrite it.
pub const TARGET_EXISTS: i32 = -32030;

/// Image RPC failures; the string code (`ImageError::code`) is the message prefix.
pub const IMAGE_ERR: i32 = -32040;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NbError {
    pub code: i32,
    pub message: String,
}

impl NbError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    /// Message for the plugin UI: the host drops the RPC code, so carry it as a prefix.
    pub fn rpc_message(&self) -> String {
        format!("[{}] {}", self.code, self.message)
    }
}

impl fmt::Display for NbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for NbError {}

pub type Result<T> = std::result::Result<T, NbError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_exists_code_is_distinct() {
        assert_eq!(NbError::new(TARGET_EXISTS, "exists").rpc_message(), "[-32030] exists");
        assert!(![NOT_FOUND, STALE_MTIME, BAD_PARAMS, PARENT_MISSING, IO].contains(&TARGET_EXISTS));
    }

    #[test]
    fn rpc_message_prefixes_code() {
        let e = NbError::new(STALE_MTIME, "stale mtime");
        assert_eq!(e.rpc_message(), "[-32011] stale mtime");
        assert_eq!(e.code, -32011);
    }
}
