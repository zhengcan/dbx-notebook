use dbx_plugin_sdk::{PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, RequestContext};
use notebook_files::dialogs::{pick_folder, pick_save, pick_save_as, require_ext, to_response, Dialogs, SystemDialogs};
use notebook_files::error::{NbError, BAD_PARAMS, IMAGE_ERR, IO};
use pdf_export::BROWSER_MISSING;
use notebook_files::{files, images, opener, out, recent, system};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

struct Plugin {
    engine: std::sync::Mutex<result_engine::Sessions>,
    pdf: pdf_export::PdfJobs,
    exported: opener::ExportRegistry,
}

impl Default for Plugin {
    fn default() -> Self {
        Self { engine: std::sync::Mutex::new(result_engine::Sessions::default()), pdf: pdf_export::PdfJobs::new(), exported: opener::ExportRegistry::new() }
    }
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
            "notebook/read" => {
                let (text, mtime_ms) = files::read(&path_param(&params)?).map_err(nb_err)?;
                Ok(json!({ "text": text, "mtimeMs": mtime_ms }))
            }
            "notebook/exists" => {
                let (exists, mtime_ms) = files::exists(&path_param(&params)?).map_err(nb_err)?;
                Ok(match mtime_ms {
                    Some(m) => json!({ "exists": exists, "mtimeMs": m }),
                    None => json!({ "exists": exists }),
                })
            }
            "notebook/write" => {
                let text = str_param(&params, "text")?;
                let expected = files::parse_expected_mtime(params.get("expectedMtimeMs")).map_err(nb_err)?;
                let mtime_ms = files::write(&path_param(&params)?, text, expected).map_err(nb_err)?;
                Ok(json!({ "mtimeMs": mtime_ms }))
            }
            "notebook/readOut" => Ok(match out::read_out(&path_param(&params)?).map_err(nb_err)? {
                Some((text, mtime_ms)) => json!({ "text": text, "mtimeMs": mtime_ms }),
                None => json!({ "exists": false }),
            }),
            "notebook/writeOut" => {
                let text = str_param(&params, "text")?;
                let mtime_ms = out::write_out(&path_param(&params)?, text).map_err(nb_err)?;
                Ok(json!({ "mtimeMs": mtime_ms }))
            }
            "notebook/deleteOut" => {
                let deleted = out::delete_out(&path_param(&params)?).map_err(nb_err)?;
                Ok(json!({ "deleted": deleted }))
            }
            "notebook/readImage" => {
                let nb = Path::new(str_param(&params, "notebookPath")?);
                images::read_image_json(nb, str_param(&params, "relPath")?)
                    .map_err(|e| PluginError::new(IMAGE_ERR, e.rpc_message()))
            }
            "notebook/saveImage" => {
                let nb = Path::new(str_param(&params, "notebookPath")?);
                let mime = match params.get("mime").and_then(Value::as_str) {
                    Some(m) => m.to_string(),
                    None => match str_param(&params, "ext")?.trim_start_matches('.').to_ascii_lowercase().as_str() {
                        "png" => "image/png".to_string(),
                        "jpg" | "jpeg" => "image/jpeg".to_string(),
                        "gif" => "image/gif".to_string(),
                        "webp" => "image/webp".to_string(),
                        _ => return Err(PluginError::new(IMAGE_ERR, images::ImageError::Unsupported.rpc_message())),
                    },
                };
                let b64 = match params.get("base64").and_then(Value::as_str) {
                    Some(b) => b,
                    None => str_param(&params, "bytesBase64")?,
                };
                let assets = params.get("assetsDirName").and_then(Value::as_str);
                images::save_image_json(nb, assets, &mime, b64, &images::stamp_now())
                    .map_err(|e| PluginError::new(IMAGE_ERR, e.rpc_message()))
            }
            "notebook/copyAssets" => {
                let from = params.get("fromNotebookPath").and_then(Value::as_str).map_or_else(|| str_param(&params, "fromPath"), Ok)?;
                let to = params.get("toNotebookPath").and_then(Value::as_str).map_or_else(|| str_param(&params, "toPath"), Ok)?;
                let rels: Vec<String> = params
                    .get("relPaths")
                    .and_then(Value::as_array)
                    .ok_or_else(|| PluginError::new(BAD_PARAMS, "Missing array param: relPaths"))?
                    .iter()
                    .map(|v| v.as_str().map(str::to_string).ok_or_else(|| PluginError::new(BAD_PARAMS, "relPaths must be strings")))
                    .collect::<Result<_, _>>()?;
                images::copy_assets_json(Path::new(from), Path::new(to), &rels)
                    .map_err(|e| PluginError::new(IMAGE_ERR, e.rpc_message()))
            }
            "notebook/pickOpen" => to_response(SystemDialogs.pick_open()).map_err(nb_err),
            "notebook/pickSave" => {
                let name = str_param(&params, "suggestedName")?;
                to_response(pick_save(&SystemDialogs, name)).map_err(nb_err)
            }
            "export/browserStatus" => {
                let manual = params.get("manualPath").and_then(Value::as_str);
                let s = pdf_export::find_browser(manual, &|k| std::env::var(k).ok(), &|p| p.exists());
                Ok(browser_json(&s))
            }
            "export/pickSave" => {
                let name = str_param(&params, "suggestedName")?;
                let ext = str_param(&params, "ext")?;
                to_response(pick_save_as(&SystemDialogs, name, ext)).map_err(nb_err)
            }
            "export/pickFolder" => to_response(pick_folder(&SystemDialogs, params.get("defaultPath").and_then(Value::as_str))).map_err(nb_err),
            "export/pickBrowser" => to_response(pdf_export::pick_browser(&SystemDialogs, str_param(&params, "kind")?)).map_err(nb_err),
            "export/saveHtml" => {
                let path = path_param(&params)?;
                let html = str_param(&params, "html")?;
                require_ext(&path, "html").map_err(nb_err)?;
                pdf_export::write_export(&path, html.as_bytes(), overwrite_param(&params)).map_err(nb_err)?;
                self.exported.register(&path);
                Ok(json!({ "path": path.display().to_string(), "bytes": html.len() }))
            }
            "export/pdfStart" => {
                let html = str_param(&params, "html")?.to_string();
                let out_path = path_param(&params)?;
                require_ext(&out_path, "pdf").map_err(nb_err)?;
                let orientation = match str_param(&params, "orientation")? {
                    "portrait" => pdf_export::Orientation::Portrait,
                    "landscape" => pdf_export::Orientation::Landscape,
                    o => return Err(PluginError::new(BAD_PARAMS, format!("Bad orientation: {o}"))),
                };
                let manual = params.get("manualBrowserPath").and_then(Value::as_str);
                let status = pdf_export::find_browser(manual, &|k| std::env::var(k).ok(), &|p| p.exists());
                let Some(browser) = status.path else {
                    return Err(nb_err(NbError::new(BROWSER_MISSING, status.reason.unwrap_or_default())));
                };
                let req = pdf_export::PdfRequest { html, out_path, orientation, browser, timeout_secs: 120, overwrite: overwrite_param(&params) };
                let id = self.pdf.start(req, &data_dir()?).map_err(nb_err)?;
                Ok(json!({ "jobId": id }))
            }
            "export/pdfStatus" => Ok(match self.pdf.status(str_param(&params, "jobId")?) {
                None => return Err(PluginError::new(BAD_PARAMS, "Unknown jobId")),
                Some(pdf_export::JobState::Running) => json!({ "state": "running" }),
                Some(pdf_export::JobState::Done { path, bytes }) => {
                    self.exported.register(&path);
                    json!({ "state": "done", "path": path.display().to_string(), "bytes": bytes })
                }
                Some(pdf_export::JobState::Failed { code, message }) => json!({ "state": "failed", "code": code, "message": message }),
                Some(pdf_export::JobState::Cancelled) => json!({ "state": "cancelled", "code": pdf_export::CANCELLED }),
            }),
            "export/pdfCancel" => Ok(json!({ "cancelled": self.pdf.cancel(str_param(&params, "jobId")?) })),
            "export/openFile" => {
                self.exported.open(&path_param(&params)?, &opener::system_open).map_err(nb_err)?;
                Ok(json!({ "opened": true }))
            }
            "system/user" => Ok(json!({ "name": system::current_user() })),
            "notebook/recent" => Ok(json!({ "items": recent::list(&data_dir()?) })),
            "notebook/touchRecent" => {
                let path = str_param(&params, "path")?;
                let title = params.get("title").and_then(Value::as_str).map(str::to_string);
                recent::touch(&data_dir()?, path, title, now_ms()).map_err(nb_err)?;
                Ok(json!({}))
            }
            _ => match result_engine::rpc::dispatch(&self.engine, method, &params) {
                Some(Ok(v)) => Ok(v),
                Some(Err(e)) => Err(PluginError::new(e.code, e.rpc_message())),
                None => Err(PluginError::method_not_found(method)),
            },
        }
    }
}

fn browser_json(s: &pdf_export::BrowserStatus) -> Value {
    let mut v = json!({ "found": s.found, "source": s.source });
    if let Some(p) = &s.path {
        v["path"] = json!(p.display().to_string());
    }
    if let Some(r) = &s.reason {
        v["reason"] = json!(r);
    }
    if let Some(c) = s.code {
        v["code"] = json!(c);
    }
    v
}

fn nb_err(e: NbError) -> PluginError {
    PluginError::new(e.code, e.rpc_message())
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str, PluginError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| PluginError::new(BAD_PARAMS, format!("Missing string param: {key}")))
}

fn overwrite_param(params: &Value) -> bool {
    params.get("overwrite").and_then(Value::as_bool).unwrap_or(false)
}

fn path_param(params: &Value) -> Result<PathBuf, PluginError> {
    Ok(Path::new(str_param(params, "path")?).to_path_buf())
}

fn data_dir() -> Result<PathBuf, PluginError> {
    std::env::var_os("DBX_PLUGIN_DATA_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| PluginError::new(IO, "DBX_PLUGIN_DATA_DIR is not set"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn main() -> std::io::Result<()> {
    if let Ok(dir) = data_dir() {
        pdf_export::sweep_stale_profiles(&dir, &pdf_export::SysProcs);
    }
    let metadata = PluginMetadata::new("io.github.zhengcan.dbx-notebook", env!("CARGO_PKG_VERSION")).with_capability("connections");
    PluginServer::new(metadata, Plugin::default()).serve()
}
