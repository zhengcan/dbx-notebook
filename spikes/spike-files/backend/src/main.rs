use std::collections::HashSet;
use std::sync::Mutex;

use dbx_plugin_sdk::{PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, RequestContext};
use serde_json::{json, Value};

#[derive(Default)]
struct Plugin {
    connections: Mutex<HashSet<String>>,
}

impl PluginHandler for Plugin {
    fn handle(
        &self,
        _context: RequestContext,
        method: &str,
        params: Value,
        _emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        match method {
            "connection/test" => {
                let connection = params.get("connection").cloned().unwrap_or_default();
                Ok(json!({
                    "success": true,
                    "message": format!(
                        "Spike Files is ready for {}:{}.",
                        connection.get("host").and_then(Value::as_str).unwrap_or("localhost"),
                        connection.get("port").and_then(Value::as_u64).unwrap_or(0)
                    )
                }))
            }
            "connection/connect" => {
                let connection_id = connection_id(&params)?;
                self.connections
                    .lock()
                    .map_err(|_| PluginError::new(-32000, "Connection registry is poisoned"))?
                    .insert(connection_id.to_string());
                Ok(json!({ "success": true }))
            }
            "connection/disconnect" => {
                let connection_id = connection_id(&params)?;
                self.connections
                    .lock()
                    .map_err(|_| PluginError::new(-32000, "Connection registry is poisoned"))?
                    .remove(connection_id);
                Ok(json!({ "success": true }))
            }
            "spike-files/ping" => Ok(json!({
                "ok": true,
                "plugin": "io.github.zhengcan.spike-files",
                "language": "rust",
                "connectionId": params.get("connectionId").cloned().unwrap_or(Value::Null)
            })),
            "spike/pickOpen" => Ok(json!({ "path": pick_open().map(|p| p.display().to_string()) })),
            "spike/pickSave" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("spike.txt");
                Ok(json!({ "path": pick_save(name).map(|p| p.display().to_string()) }))
            }
            "spike/pickOpenOsascript" => Ok(json!({ "path": osascript_pick(false, "spike.txt") })),
            "spike/pickSaveOsascript" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("spike.txt");
                Ok(json!({ "path": osascript_pick(true, name) }))
            }
            "spike/read" => {
                let path = str_param(&params, "path")?;
                read_text(path).map(|text| json!({ "text": text })).map_err(|e| PluginError::new(-32000, e))
            }
            "spike/write" => {
                let path = str_param(&params, "path")?;
                let text = str_param(&params, "text")?;
                write_text(path, text)
                    .map(|n| json!({ "written": n }))
                    .map_err(|e| PluginError::new(-32000, e))
            }
            _ => Err(PluginError::method_not_found(method)),
        }
    }
}

fn connection_id(params: &Value) -> Result<&str, PluginError> {
    params
        .get("connection")
        .and_then(|connection| connection.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| PluginError::new(-32602, "Missing connection id"))
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str, PluginError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| PluginError::new(-32602, format!("Missing {key}")))
}

fn read_text(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))
}

fn write_text(path: &str, text: &str) -> Result<usize, String> {
    std::fs::write(path, text).map_err(|e| format!("write {path}: {e}"))?;
    Ok(text.len())
}

fn pick_open() -> Option<std::path::PathBuf> {
    rfd::FileDialog::new().set_title("Spike: open").pick_file()
}

fn pick_save(name: &str) -> Option<std::path::PathBuf> {
    rfd::FileDialog::new().set_title("Spike: save").set_file_name(name).save_file()
}

/// Fallback that avoids the main-thread requirement of AppKit dialogs.
fn osascript_pick(save: bool, name: &str) -> Option<String> {
    let script = if save {
        format!("POSIX path of (choose file name default name \"{}\")", name.replace('"', ""))
    } else {
        "POSIX path of (choose file)".to_string()
    };
    let out = std::process::Command::new("osascript").arg("-e").arg(script).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_roundtrip() {
        let path = std::env::temp_dir().join("dbx-spike-files-test.txt");
        let path = path.to_str().unwrap();
        assert_eq!(write_text(path, "héllo").unwrap(), "héllo".len());
        assert_eq!(read_text(path).unwrap(), "héllo");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn read_missing_is_error() {
        assert!(read_text("/nonexistent/dbx-spike").is_err());
    }
}

fn main() -> std::io::Result<()> {
    let metadata = PluginMetadata::new("io.github.zhengcan.spike-files", env!("CARGO_PKG_VERSION")).with_capability("connections");
    PluginServer::new(metadata, Plugin::default()).serve()
}
