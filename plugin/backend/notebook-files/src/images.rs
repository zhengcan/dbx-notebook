use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

pub const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 64_000_000;
pub const SNIFF_LEN: usize = 4096;
const MAX_REL_LEN: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageError {
    InvalidPath,
    NotFound,
    Unsupported,
    TooLarge,
    ReadFailed,
    NeedsSave,
}

impl ImageError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidPath => "invalidPath",
            Self::NotFound => "notFound",
            Self::Unsupported => "unsupported",
            Self::TooLarge => "tooLarge",
            Self::ReadFailed => "readFailed",
            Self::NeedsSave => "needsSave",
        }
    }
}

impl std::fmt::Display for ImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidPath => "invalid image path",
            Self::NotFound => "image not found",
            Self::Unsupported => "unsupported format",
            Self::TooLarge => "image too large",
            Self::ReadFailed => "image could not be read",
            Self::NeedsSave => "save the notebook first",
        })
    }
}

impl std::error::Error for ImageError {}

impl ImageError {
    /// Message for the plugin UI: `[code] text`, never a path.
    pub fn rpc_message(&self) -> String {
        format!("[{}] {}", self.code(), self)
    }
}

#[derive(Debug)]
pub struct ImageData {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
    pub size: u64,
    pub mtime_ms: i64,
    pub width: u32,
    pub height: u32,
}

fn seg_is_dotdot(seg: &str) -> bool {
    seg == ".."
}

/// Windows device names, judged on the part before the first dot after trimming trailing spaces/dots
/// (`CON .png`, `con.tar.png`, `COM\u{b9}`).
fn seg_is_reserved(seg: &str) -> bool {
    let trimmed = seg.trim_end_matches([' ', '.']);
    let stem = trimmed.split('.').next().unwrap_or("").trim_end_matches(' ').to_lowercase();
    if matches!(stem.as_str(), "con" | "prn" | "aux" | "nul") {
        return true;
    }
    let mut chars = stem.chars();
    match (stem.get(..3), chars.nth(3), chars.next()) {
        (Some("com" | "lpt"), Some(d), None) => matches!(d, '1'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}'),
        _ => false,
    }
}

/// Lexical validation of a notebook-relative path; touches no filesystem.
pub(crate) fn check_rel(rel: &str) -> Result<(), ImageError> {
    let bad = ImageError::InvalidPath;
    if rel.is_empty() || rel.len() > MAX_REL_LEN {
        return Err(bad);
    }
    if rel.starts_with(['/', '\\', '~']) {
        return Err(bad);
    }
    if rel.chars().any(|c| c.is_control() || matches!(c, '\\' | '%' | ':' | '?' | '#' | '*' | '<' | '>' | '|' | '"')) {
        return Err(bad);
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg_is_dotdot(seg) {
            return Err(bad);
        }
        if (seg.ends_with('.') && seg != ".") || seg.ends_with(' ') || seg_is_reserved(seg) {
            return Err(bad);
        }
    }
    Ok(())
}

pub fn resolve_rel(notebook_path: &Path, rel: &str) -> Result<PathBuf, ImageError> {
    check_rel(rel)?;
    let root = notebook_root(notebook_path)?;
    let target = fs::canonicalize(root.join(rel)).map_err(|_| ImageError::NotFound)?;
    if target.starts_with(&root) {
        Ok(target)
    } else {
        Err(ImageError::InvalidPath)
    }
}

fn notebook_root(notebook_path: &Path) -> Result<PathBuf, ImageError> {
    if notebook_path.as_os_str().is_empty() {
        return Err(ImageError::NeedsSave);
    }
    let dir = match notebook_path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    fs::canonicalize(dir).map_err(|_| ImageError::NotFound)
}

pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    let b = &bytes[..bytes.len().min(SNIFF_LEN)];
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Reads at most `SNIFF_LEN` bytes from `r`.
pub fn sniff_reader<R: Read>(r: &mut R) -> std::io::Result<Option<&'static str>> {
    let mut buf = Vec::with_capacity(SNIFF_LEN);
    r.take(SNIFF_LEN as u64).read_to_end(&mut buf)?;
    Ok(sniff(&buf))
}

pub fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "",
    }
}

fn ext_agrees(rel: &str, mime: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or("");
    let Some((_, ext)) = name.rsplit_once('.') else { return true };
    let want = match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return true,
    };
    want == mime
}

fn be32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?))
}
fn le16(b: &[u8], i: usize) -> Option<u32> {
    Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?) as u32)
}
fn le24(b: &[u8], i: usize) -> Option<u32> {
    let s = b.get(i..i + 3)?;
    Some(s[0] as u32 | (s[1] as u32) << 8 | (s[2] as u32) << 16)
}

/// Cheap header parse; never decodes pixels. `None` when the header is absent or truncated.
pub fn header_dims(b: &[u8], mime: &str) -> Option<(u32, u32)> {
    match mime {
        "image/png" => {
            if b.get(12..16)? != b"IHDR" {
                return None;
            }
            Some((be32(b, 16)?, be32(b, 20)?))
        }
        "image/gif" => Some((le16(b, 6)?, le16(b, 8)?)),
        "image/webp" => match b.get(12..16)? {
            b"VP8X" => Some((le24(b, 24)? + 1, le24(b, 27)? + 1)),
            b"VP8L" => {
                if *b.get(20)? != 0x2f {
                    return None;
                }
                let bits = u32::from_le_bytes(b.get(21..25)?.try_into().ok()?);
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            b"VP8 " => {
                if b.get(23..26)? != [0x9d, 0x01, 0x2a] {
                    return None;
                }
                Some((le16(b, 26)? & 0x3fff, le16(b, 28)? & 0x3fff))
            }
            _ => None,
        },
        "image/jpeg" => {
            let mut i = 2;
            while i + 4 <= b.len() {
                if b[i] != 0xFF {
                    return None;
                }
                let m = b[i + 1];
                if m == 0xFF {
                    i += 1;
                    continue;
                }
                if m == 0x01 || (0xD0..=0xD8).contains(&m) {
                    i += 2;
                    continue;
                }
                if m == 0xD9 || m == 0xDA {
                    return None;
                }
                let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
                if matches!(m, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
                    return Some((u16::from_be_bytes(b.get(i + 7..i + 9)?.try_into().ok()?) as u32, u16::from_be_bytes(b.get(i + 5..i + 7)?.try_into().ok()?) as u32));
                }
                i += 2 + len.max(2);
            }
            None
        }
        _ => None,
    }
}

#[cfg(unix)]
fn open_nonblocking(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    // O_NONBLOCK is a hard-coded constant (no libc dependency): Linux/Android 0o4000, other unix 0x4;
    // rare architectures such as mips/sparc differ. A wrong flag there is harmless for memory safety: the
    // open still succeeds or fails normally, the handle is re-checked with is_file() and the read is capped
    // by take(MAX_READ_BYTES + 1), so the worst case is a failed read (or a blocking open of a FIFO), never an overrun.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_NONBLOCK: i32 = 0o4000;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    const O_NONBLOCK: i32 = 0x4;
    fs::OpenOptions::new().read(true).custom_flags(O_NONBLOCK).open(path)
}

#[cfg(not(unix))]
fn open_nonblocking(path: &Path) -> std::io::Result<fs::File> {
    fs::File::open(path)
}

/// The opened handle must still be the file the canonical path names (a swap between resolve and open fails).
#[cfg(unix)]
fn same_file_as_path(opened: &fs::Metadata, path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).map(|m| m.dev() == opened.dev() && m.ino() == opened.ino()).unwrap_or(false)
}

#[cfg(not(unix))]
fn same_file_as_path(_opened: &fs::Metadata, _path: &Path) -> bool {
    true
}

pub fn read_image(notebook_path: &Path, rel: &str) -> Result<ImageData, ImageError> {
    let path = resolve_rel(notebook_path, rel)?;
    let file = open_nonblocking(&path).map_err(|_| if path.is_dir() { ImageError::InvalidPath } else { ImageError::ReadFailed })?;
    let meta = file.metadata().map_err(|_| ImageError::ReadFailed)?;
    if !meta.is_file() {
        return Err(ImageError::InvalidPath);
    }
    if !same_file_as_path(&meta, &path) {
        return Err(ImageError::InvalidPath);
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(ImageError::TooLarge);
    }
    let mut bytes = Vec::new();
    file.take(MAX_READ_BYTES + 1).read_to_end(&mut bytes).map_err(|_| ImageError::ReadFailed)?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(ImageError::TooLarge);
    }
    let mime = sniff(&bytes).ok_or(ImageError::Unsupported)?;
    if !ext_agrees(rel, mime) {
        return Err(ImageError::Unsupported);
    }
    let (width, height) = header_dims(&bytes, mime).unwrap_or((0, 0));
    if width as u64 * height as u64 > MAX_PIXELS {
        return Err(ImageError::TooLarge);
    }
    let mtime_ms = meta
        .modified()
        .ok()
        .map(|m| match m.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_millis() as i64,
            Err(e) => -(e.duration().as_millis() as i64),
        })
        .unwrap_or(0);
    Ok(ImageData { mime, size: bytes.len() as u64, bytes, mtime_ms, width, height })
}

pub fn read_image_json(notebook_path: &Path, rel: &str) -> Result<Value, ImageError> {
    let d = read_image(notebook_path, rel)?;
    Ok(json!({
        "mime": d.mime, "base64": base64_encode(&d.bytes), "size": d.size,
        "mtimeMs": d.mtime_ms, "width": d.width, "height": d.height,
    }))
}

pub fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

pub const MAX_SAVE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_COPY_FILES: usize = 500;
pub const MAX_COPY_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Debug)]
pub struct SavedImage {
    pub rel_path: String,
    pub size: u64,
}

#[derive(Debug, Default)]
pub struct CopyReport {
    /// source relPath -> relPath under the target notebook directory
    pub mapping: Vec<(String, String)>,
    pub failed: Vec<(String, ImageError)>,
}

#[cfg(test)]
thread_local! { static FAIL_INSTALL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

pub fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
        0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
        0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
        0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] =
        [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend(((data.len() as u64) * 8).to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [t1.wrapping_add(t2), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    let mut out = [0u8; 32];
    for (i, x) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&x.to_be_bytes());
    }
    out
}

/// Strict RFC 4648 decoder (standard alphabet, padding optional, no whitespace).
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.as_bytes();
    let body = match s.iter().position(|&c| c == b'=') {
        Some(i) => {
            if !s[i..].iter().all(|&c| c == b'=') || s.len() % 4 != 0 || s.len() - i > 2 {
                return None;
            }
            &s[..i]
        }
        None => s,
    };
    if body.len() % 4 == 1 {
        return None;
    }
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::with_capacity(body.len() / 4 * 3 + 2);
    for c in body.chunks(4) {
        let mut n = 0u32;
        for (i, &ch) in c.iter().enumerate() {
            n |= val(ch)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if c.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if c.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// `YYYYMMDD-HHMMSS` (UTC) for a Unix timestamp.
pub fn stamp_from_secs(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn stamp_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    stamp_from_secs(secs)
}

fn stamp_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 15 && b[8] == b'-' && b.iter().enumerate().all(|(i, c)| i == 8 || c.is_ascii_digit())
}

/// Absolute notebook file path -> (canonical notebook directory, notebook file name).
fn saved_notebook(nb: &Path) -> Result<(PathBuf, String), ImageError> {
    if nb.as_os_str().is_empty() {
        return Err(ImageError::NeedsSave);
    }
    if !nb.is_absolute() {
        return Err(ImageError::InvalidPath);
    }
    let name = nb.file_name().and_then(|n| n.to_str()).ok_or(ImageError::InvalidPath)?.to_string();
    Ok((notebook_root(nb)?, name))
}

/// `<notebook file name>.assets`, made a valid single relative path segment: characters the
/// path rules reject become `_`, trailing dots/spaces are trimmed, reserved names get a `_` prefix.
/// Different notebooks may share a directory; content-hash naming keeps their files apart.
fn derive_assets_dir(file_name: &str) -> String {
    let mut name: String = file_name
        .chars()
        .map(|c| if c.is_control() || matches!(c, '\\' | '/' | '%' | ':' | '?' | '#' | '*' | '<' | '>' | '|' | '"') { '_' } else { c })
        .collect();
    name.truncate(name.trim_end_matches([' ', '.']).len());
    if name.starts_with('~') {
        name.replace_range(..1, "_");
    }
    let mut dir = format!("{name}.assets");
    if name.is_empty() || seg_is_reserved(&dir) {
        dir.insert(0, '_');
    }
    dir
}

pub fn assets_dir_name(nb: &Path) -> Result<String, ImageError> {
    let (_, name) = saved_notebook(nb)?;
    Ok(derive_assets_dir(&name))
}

/// Walks `rel_dir` below `root`, creating missing components one level at a time and
/// requiring every component to resolve (symlinks included) inside `root`.
fn ensure_dir_in_root(root: &Path, rel_dir: &str) -> Result<PathBuf, ImageError> {
    let mut cur = root.to_path_buf();
    for seg in rel_dir.split('/').filter(|s| !s.is_empty() && *s != ".") {
        let next = cur.join(seg);
        match fs::symlink_metadata(&next) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => match fs::create_dir(&next) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(ImageError::ReadFailed),
            },
            Err(_) => return Err(ImageError::ReadFailed),
        }
        let canon = fs::canonicalize(&next).map_err(|_| ImageError::ReadFailed)?;
        if !canon.starts_with(root) {
            return Err(ImageError::InvalidPath);
        }
        if !fs::metadata(&canon).map(|m| m.is_dir()).unwrap_or(false) {
            return Err(ImageError::InvalidPath);
        }
        cur = canon;
    }
    Ok(cur)
}

fn same_content(path: &Path, bytes: &[u8]) -> bool {
    let Ok(m) = fs::symlink_metadata(path) else { return false };
    if !m.is_file() || m.len() != bytes.len() as u64 {
        return false;
    }
    fs::read(path).map(|b| b == bytes).unwrap_or(false)
}

/// Removes its temp file on every exit path, including panics.
struct TmpGuard(PathBuf);

impl Drop for TmpGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Writes `bytes` to `dest` without ever replacing an existing entry: temp file in the
/// same directory, then a hard link (fails if `dest` exists). The temp file is always removed.
fn install(dir: &Path, dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".sqlnb-tmp-{}-{seq}", std::process::id()));
    let _guard = TmpGuard(tmp.clone());
    {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.flush()?;
        drop(f);
        #[cfg(test)]
        if FAIL_INSTALL.with(|f| f.get()) {
            return Err(std::io::Error::other("injected"));
        }
        match fs::hard_link(&tmp, dest) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(e),
            Err(_) => {
                // file systems without hard links: exclusive create, no partial file left behind
                let mut f = fs::OpenOptions::new().write(true).create_new(true).open(dest)?;
                if let Err(e) = f.write_all(bytes).and_then(|_| f.flush()) {
                    drop(f);
                    let _ = fs::remove_file(dest);
                    return Err(e);
                }
                Ok(())
            }
        }
    }
}

/// Stores `bytes` as `dir/<stem><suffix>` (or `<stem>-N<suffix>`), reusing an identical existing file.
fn place(dir: &Path, stem: &str, suffix: &str, bytes: &[u8]) -> Result<String, ImageError> {
    for n in 1..=1000u32 {
        let name = if n == 1 { format!("{stem}{suffix}") } else { format!("{stem}-{n}{suffix}") };
        let dest = dir.join(&name);
        match fs::symlink_metadata(&dest) {
            Ok(_) => {
                if same_content(&dest, bytes) {
                    return Ok(name);
                }
                continue;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(ImageError::ReadFailed),
        }
        match install(dir, &dest, bytes) {
            Ok(()) => return Ok(name),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if same_content(&dest, bytes) {
                    return Ok(name);
                }
            }
            Err(_) => return Err(ImageError::ReadFailed),
        }
    }
    Err(ImageError::ReadFailed)
}

fn mime_allowed(m: &str) -> bool {
    matches!(m, "image/png" | "image/jpeg" | "image/gif" | "image/webp")
}

pub fn save_image(nb: &Path, mime: &str, bytes: &[u8], stamp: &str) -> Result<SavedImage, ImageError> {
    save_image_in(nb, None, mime, bytes, stamp)
}

pub fn save_image_in(
    nb: &Path,
    assets_name: Option<&str>,
    declared_mime: &str,
    bytes: &[u8],
    stamp: &str,
) -> Result<SavedImage, ImageError> {
    if !stamp_ok(stamp) {
        return Err(ImageError::InvalidPath);
    }
    let (root, file_name) = saved_notebook(nb)?;
    let assets = match assets_name {
        Some(a) => a.to_string(),
        None => derive_assets_dir(&file_name),
    };
    if assets.contains('/') {
        return Err(ImageError::InvalidPath);
    }
    check_rel(&assets)?;
    if bytes.len() as u64 > MAX_SAVE_BYTES {
        return Err(ImageError::TooLarge);
    }
    if !mime_allowed(declared_mime) {
        return Err(ImageError::Unsupported);
    }
    let mime = sniff(bytes).ok_or(ImageError::Unsupported)?;
    if mime != declared_mime {
        return Err(ImageError::Unsupported);
    }
    let (w, h) = header_dims(bytes, mime).unwrap_or((0, 0));
    if w as u64 * h as u64 > MAX_PIXELS {
        return Err(ImageError::TooLarge);
    }
    let dir = ensure_dir_in_root(&root, &assets)?;
    let hash: String = sha256(bytes)[..4].iter().map(|b| format!("{b:02x}")).collect();
    let suffix = format!(".{}", ext_for(mime));
    // identical content saved earlier (any stamp) is reused
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with("image-") && n.ends_with(&suffix) && n.contains(&format!("-{hash}")) && same_content(&e.path(), bytes) {
                return Ok(SavedImage { rel_path: format!("{assets}/{n}"), size: bytes.len() as u64 });
            }
        }
    }
    let name = place(&dir, &format!("image-{stamp}-{hash}"), &suffix, bytes)?;
    Ok(SavedImage { rel_path: format!("{assets}/{name}"), size: bytes.len() as u64 })
}

pub fn save_image_json(
    nb: &Path,
    assets_name: Option<&str>,
    mime: &str,
    b64: &str,
    stamp: &str,
) -> Result<Value, ImageError> {
    if b64.len() as u64 > MAX_SAVE_BYTES * 4 / 3 + 8 {
        return Err(ImageError::TooLarge);
    }
    let bytes = base64_decode(b64).ok_or(ImageError::Unsupported)?;
    let s = save_image_in(nb, assets_name, mime, &bytes, stamp)?;
    Ok(json!({ "relPath": s.rel_path, "size": s.size }))
}

pub fn copy_assets(from: &Path, to: &Path, rels: &[String]) -> Result<CopyReport, ImageError> {
    copy_assets_with_limits(from, to, rels, MAX_COPY_FILES, MAX_COPY_BYTES)
}

pub fn copy_assets_with_limits(
    from: &Path,
    to: &Path,
    rels: &[String],
    max_files: usize,
    max_bytes: u64,
) -> Result<CopyReport, ImageError> {
    let (_, from_name) = saved_notebook(from)?;
    let (to_root, to_name) = saved_notebook(to)?;
    if rels.len() > max_files {
        return Err(ImageError::TooLarge);
    }
    let same_dir = notebook_root(from)? == to_root;
    let old_prefix = format!("{}/", derive_assets_dir(&from_name));
    let new_prefix = format!("{}/", derive_assets_dir(&to_name));
    let mut report = CopyReport::default();
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    for rel in rels {
        if !seen.insert(rel.as_str()) {
            continue;
        }
        let mut fail = |e: ImageError| report.failed.push((rel.clone(), e));
        let len = match resolve_rel(from, rel).and_then(|p| fs::metadata(p).map_err(|_| ImageError::NotFound)) {
            Ok(m) => m.len(),
            Err(e) => {
                fail(e);
                continue;
            }
        };
        if total.saturating_add(len) > max_bytes {
            fail(ImageError::TooLarge);
            continue;
        }
        let data = match read_image(from, rel) {
            Ok(d) => d,
            Err(e) => {
                fail(e);
                continue;
            }
        };
        let norm = rel.split('/').filter(|s| *s != ".").collect::<Vec<_>>().join("/");
        let dest_rel = match norm.strip_prefix(&old_prefix) {
            Some(rest) => format!("{new_prefix}{rest}"),
            None => norm.clone(),
        };
        if same_dir && dest_rel == norm {
            report.mapping.push((rel.clone(), norm));
            continue;
        }
        if check_rel(&dest_rel).is_err() {
            fail(ImageError::InvalidPath);
            continue;
        }
        total += data.size;
        if total > max_bytes {
            fail(ImageError::TooLarge);
            continue;
        }
        let (dir_part, file) = dest_rel.rsplit_once('/').unwrap_or(("", &dest_rel));
        let (stem, suffix) = match file.rfind('.') {
            Some(i) if i > 0 => (&file[..i], &file[i..]),
            _ => (file, ""),
        };
        let placed = ensure_dir_in_root(&to_root, dir_part).and_then(|dir| place(&dir, stem, suffix, &data.bytes));
        match placed {
            Ok(name) => {
                let out = if dir_part.is_empty() { name } else { format!("{dir_part}/{name}") };
                report.mapping.push((rel.clone(), out));
            }
            Err(e) => fail(e),
        }
    }
    Ok(report)
}

pub fn copy_assets_json(from: &Path, to: &Path, rels: &[String]) -> Result<Value, ImageError> {
    let r = copy_assets(from, to, rels)?;
    let mapping: serde_json::Map<String, Value> = r.mapping.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    let errors: serde_json::Map<String, Value> = r.failed.iter().map(|(k, e)| (k.clone(), json!(e.code()))).collect();
    Ok(json!({
        "mapping": mapping,
        "copied": r.mapping.iter().map(|(k, _)| k).collect::<Vec<_>>(),
        "failed": r.failed.iter().map(|(k, _)| k).collect::<Vec<_>>(),
        "errors": errors,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Read;

    pub(super) fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("img-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    pub(super) fn png(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        v.extend(w.to_be_bytes());
        v.extend(h.to_be_bytes());
        v.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
        v
    }
    pub(super) fn jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 11, 8];
        v.extend(h.to_be_bytes());
        v.extend(w.to_be_bytes());
        v.extend([1, 1, 0x11, 0]);
        v
    }
    pub(super) fn gif(w: u16, h: u16) -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend(w.to_le_bytes());
        v.extend(h.to_le_bytes());
        v.extend([0, 0, 0]);
        v
    }
    pub(super) fn webp_vp8x(w: u32, h: u32) -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend(22u32.to_le_bytes());
        v.extend(b"WEBPVP8X");
        v.extend(10u32.to_le_bytes());
        v.extend([0, 0, 0, 0]);
        v.extend(&(w - 1).to_le_bytes()[..3]);
        v.extend(&(h - 1).to_le_bytes()[..3]);
        v
    }
    fn webp_vp8l(w: u32, h: u32) -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend(18u32.to_le_bytes());
        v.extend(b"WEBPVP8L");
        v.extend(5u32.to_le_bytes());
        v.push(0x2f);
        let bits = (w - 1) | ((h - 1) << 14);
        v.extend(bits.to_le_bytes());
        v
    }
    fn webp_vp8(w: u16, h: u16) -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend(30u32.to_le_bytes());
        v.extend(b"WEBPVP8 ");
        v.extend(10u32.to_le_bytes());
        v.extend([0, 0, 0, 0x9d, 0x01, 0x2a]);
        v.extend(w.to_le_bytes());
        v.extend(h.to_le_bytes());
        v
    }
    pub(super) fn avif() -> Vec<u8> {
        let mut v = vec![0, 0, 0, 0x1c];
        v.extend(b"ftypavif\0\0\0\0avifmif1");
        v
    }
    fn heic() -> Vec<u8> {
        let mut v = vec![0, 0, 0, 0x18];
        v.extend(b"ftypheic\0\0\0\0mif1heic");
        v
    }
    fn isom() -> Vec<u8> {
        let mut v = vec![0, 0, 0, 0x18];
        v.extend(b"ftypisom\0\0\0\0isomiso2");
        v
    }

    /// Notebook dir with a notebook path inside it.
    pub(super) fn nb(name: &str) -> (PathBuf, PathBuf) {
        let d = tmp(name);
        let n = d.join("book.sqlnb");
        fs::write(&n, "x").unwrap();
        (d, n)
    }

    pub(super) fn code_of<T: std::fmt::Debug>(r: Result<T, ImageError>) -> &'static str {
        r.unwrap_err().code()
    }

    #[test]
    fn resolve_rel_rejects_hostile() {
        let (_d, n) = nb("hostile");
        let bad = [
            "", "../a.png", "a/../../b.png", "/etc/hosts", "\\\\server\\share\\x.png", "C:\\x.png", "C:/x.png",
            "file:///etc/hosts", "http://h/x.png", "data:image/png;base64,AAAA", "a\\b.png", "%2e%2e/a.png",
            "a%2fb.png", "%2E%2E%2Fa.png", "CON.png", "dir/NUL", "a.png.", "a.png ", "a\0.png", "~/x.png",
            "//host/x.png", "a/../b.png", "..", "a//b.png", "a.png?x", "a.png#f", "a.png:stream", "com1.txt",
            "dir/lpt9", "a\n.png",
        ];
        for b in bad {
            assert_eq!(code_of(resolve_rel(&n, b)), "invalidPath", "should reject {b:?}");
        }
        let long = "a/".repeat(600) + "x.png";
        assert_eq!(code_of(resolve_rel(&n, &long)), "invalidPath");
    }

    #[test]
    fn dotdot_segment_rule_stands_alone() {
        assert!(seg_is_dotdot(".."));
        assert!(!seg_is_dotdot("."));
        assert!(!seg_is_dotdot("..a"));
        for b in ["..", "../a.png", "a/../b.png", "a/.."] {
            assert_eq!(check_rel(b), Err(ImageError::InvalidPath), "{b}");
        }
    }

    #[test]
    fn windows_reserved_names_after_trimming() {
        for b in [
            "CON .png", "con.tar.png", "COM1.", "COM\u{b9}", "COM\u{b2}.png", "COM\u{b3}", "LPT\u{b9}", "lpt\u{b2}.x",
            "aux .txt", "dir/nul .png", "dir/Nul.tar.gz", "Prn  .png",
        ] {
            assert_eq!(check_rel(b), Err(ImageError::InvalidPath), "{b:?}");
        }
        for ok in ["conf.png", "console.png", "com10.png", "a.con.png", "lpt0.png", "COM.png"] {
            assert_eq!(check_rel(ok), Ok(()), "{ok:?}");
        }
    }

    #[test]
    fn jpeg_magic_needs_three_bytes() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0x00, 0xE0]), None);
        assert_eq!(sniff(&[0xFF, 0xD8]), None);
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFE]), None);
    }

    #[test]
    fn resolve_rel_accepts_good() {
        let (d, n) = nb("good");
        for ok in ["./pic.png", "assets/pic.png", "book.sqlnb.assets/a.png", "图 片/é a b.png", "A.PNG"] {
            let f = d.join(ok);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(&f, b"x").unwrap();
            let p = resolve_rel(&n, ok).unwrap();
            assert!(p.starts_with(fs::canonicalize(&d).unwrap()), "{ok}");
        }
    }

    #[test]
    fn reads_each_format_by_magic_regardless_of_ext() {
        let (d, n) = nb("formats");
        let cases: Vec<(Vec<u8>, &str, u32, u32)> = vec![
            (png(3, 2), "image/png", 3, 2),
            (jpeg(5, 4), "image/jpeg", 5, 4),
            (gif(7, 6), "image/gif", 7, 6),
            (webp_vp8x(9, 8), "image/webp", 9, 8),
            (webp_vp8l(11, 10), "image/webp", 11, 10),
            (webp_vp8(13, 12), "image/webp", 13, 12),
        ];
        for (i, (b, mime, w, h)) in cases.iter().enumerate() {
            fs::write(d.join(format!("f{i}.dat")), b).unwrap();
            let r = read_image(&n, &format!("f{i}.dat")).unwrap();
            assert_eq!(r.mime, *mime);
            assert_eq!((r.width, r.height), (*w, *h), "case {i}");
            assert_eq!(r.size, b.len() as u64);
            assert_eq!(r.bytes, *b);
            assert!(r.mtime_ms > 0);
            assert_eq!(header_dims(b, mime), Some((*w, *h)));
        }
    }

    #[test]
    fn matching_extensions_and_case_ok() {
        let (d, n) = nb("ext");
        fs::write(d.join("a.PNG"), png(1, 1)).unwrap();
        fs::write(d.join("b.jpg"), jpeg(1, 1)).unwrap();
        fs::write(d.join("c.jpeg"), jpeg(1, 1)).unwrap();
        fs::write(d.join("d.Gif"), gif(1, 1)).unwrap();
        fs::write(d.join("e.webp"), webp_vp8x(1, 1)).unwrap();
        fs::write(d.join("sp ace é.png"), png(1, 1)).unwrap();
        for f in ["a.PNG", "b.jpg", "c.jpeg", "d.Gif", "e.webp", "sp ace é.png"] {
            assert!(read_image(&n, f).is_ok(), "{f}");
        }
    }

    #[test]
    fn ext_mime_disagreement_unsupported() {
        let (d, n) = nb("disagree");
        fs::write(d.join("a.png"), jpeg(1, 1)).unwrap();
        fs::write(d.join("b.jpg"), png(1, 1)).unwrap();
        assert_eq!(code_of(read_image(&n, "a.png")), "unsupported");
        assert_eq!(code_of(read_image(&n, "b.jpg")), "unsupported");
    }

    #[test]
    fn non_images_unsupported_without_path_in_message() {
        let (d, n) = nb("nonimg");
        let svg = b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"><script>1</script></svg>".to_vec();
        let mut jxl_container = vec![0, 0, 0, 0x0c];
        jxl_container.extend(b"JXL \r\n\x87\n");
        let fixtures: Vec<Vec<u8>> = vec![
            b"just text".to_vec(), b"<html><script>alert(1)</script></html>".to_vec(), svg, avif(), heic(), isom(),
            vec![0xFF, 0x0A, 1, 2, 3], jxl_container, vec![],
        ];
        for (i, b) in fixtures.iter().enumerate() {
            fs::write(d.join(format!("x{i}.png")), b).unwrap();
            let e = read_image(&n, &format!("x{i}.png")).unwrap_err();
            assert_eq!(e.code(), "unsupported", "fixture {i}");
            let msg = e.to_string();
            assert!(msg.contains("unsupported format"));
            assert!(!msg.contains(d.to_str().unwrap()) && !msg.contains("x0.png"));
            assert_eq!(sniff(b), None, "fixture {i}");
        }
    }

    #[test]
    fn truncated_headers_never_panic() {
        let (d, n) = nb("trunc");
        let full: Vec<(Vec<u8>, &str)> = vec![
            (png(3, 2), "image/png"), (jpeg(5, 4), "image/jpeg"), (gif(7, 6), "image/gif"),
            (webp_vp8x(9, 8), "image/webp"), (webp_vp8l(9, 8), "image/webp"), (webp_vp8(9, 8), "image/webp"),
        ];
        for (b, mime) in &full {
            for cut in 0..b.len() {
                let t = &b[..cut];
                let _ = sniff(t);
                let _ = header_dims(t, mime);
            }
            // a recognisable magic with a cut header still reads (dims unknown) or is refused, never panics
            fs::write(d.join("t.dat"), &b[..4.min(b.len())]).unwrap();
            let _ = read_image(&n, "t.dat");
        }
        fs::write(d.join("short.png"), &png(1, 1)[..5]).unwrap();
        assert_eq!(code_of(read_image(&n, "short.png")), "unsupported");
        fs::write(d.join("magic_only.png"), &png(1, 1)[..8]).unwrap();
        let r = read_image(&n, "magic_only.png").unwrap();
        assert_eq!((r.width, r.height), (0, 0));
    }

    #[test]
    fn zero_byte_and_missing_and_dir() {
        let (d, n) = nb("misc");
        fs::write(d.join("z.png"), b"").unwrap();
        assert_eq!(code_of(read_image(&n, "z.png")), "unsupported");
        assert_eq!(code_of(read_image(&n, "nope.png")), "notFound");
        assert_eq!(code_of(read_image(&n, "nodir/nope.png")), "notFound");
        fs::create_dir(d.join("sub.png")).unwrap();
        assert_eq!(code_of(read_image(&n, "sub.png")), "invalidPath");
    }

    #[test]
    fn size_cap_from_metadata() {
        let (d, n) = nb("cap");
        let mut ok = png(1, 1);
        ok.resize(MAX_READ_BYTES as usize, 0);
        fs::write(d.join("ok.png"), &ok).unwrap();
        assert!(read_image(&n, "ok.png").is_ok());
        ok.push(0);
        fs::write(d.join("big.png"), &ok).unwrap();
        assert_eq!(code_of(read_image(&n, "big.png")), "tooLarge");
        // size is judged before magic: even non-image bytes over the cap are tooLarge
        fs::write(d.join("bigtxt.png"), vec![b'a'; MAX_READ_BYTES as usize + 1]).unwrap();
        assert_eq!(code_of(read_image(&n, "bigtxt.png")), "tooLarge");
    }

    #[test]
    fn pixel_cap() {
        let (d, n) = nb("px");
        fs::write(d.join("huge.png"), png(10000, 10000)).unwrap();
        assert_eq!(code_of(read_image(&n, "huge.png")), "tooLarge");
        fs::write(d.join("edge.png"), png(8000, 8000)).unwrap();
        assert!(read_image(&n, "edge.png").is_ok());
        fs::write(d.join("over.png"), png(8001, 8000)).unwrap();
        assert_eq!(code_of(read_image(&n, "over.png")), "tooLarge");
    }

    #[test]
    fn sniff_reader_reads_at_most_4096() {
        struct Guard(usize);
        impl Read for Guard {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                assert!(self.0 + buf.len() <= SNIFF_LEN, "read past 4096");
                let src = png(1, 1);
                let n = buf.len().min(src.len().saturating_sub(self.0)).max(0);
                let n = if self.0 < src.len() { n } else { buf.len() };
                for (i, b) in buf.iter_mut().take(n).enumerate() {
                    *b = *src.get(self.0 + i).unwrap_or(&0);
                }
                self.0 += n;
                Ok(n)
            }
        }
        assert_eq!(sniff_reader(&mut Guard(0)).unwrap(), Some("image/png"));
        let mut long = png(1, 1);
        long.resize(10_000, 0);
        assert_eq!(sniff(&long), Some("image/png"));
        // magic placed after 4096 bytes is not seen
        let mut late = vec![0u8; 4096];
        late.extend(png(1, 1));
        assert_eq!(sniff(&late), None);
    }

    #[test]
    fn errors_never_contain_paths() {
        let (d, n) = nb("nopath");
        let root = d.to_str().unwrap().to_string();
        let leaf = d.file_name().unwrap().to_str().unwrap().to_string();
        for rel in ["nope.png", "../x.png", "", "/etc/hosts"] {
            let e = read_image(&n, rel).unwrap_err();
            for s in [e.to_string(), format!("{e:?}"), e.code().to_string()] {
                assert!(!s.contains(&root) && !s.contains(&leaf), "{s}");
            }
        }
    }

    #[test]
    fn missing_notebook_dir_is_not_found() {
        let (d, _n) = nb("nodirnb");
        assert_eq!(code_of(read_image(&d.join("gone").join("b.sqlnb"), "a.png")), "notFound");
    }

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(&[0xfb, 0xff, 0xbf]), "+/+/");
    }

    #[test]
    fn rpc_json_shape() {
        let (d, n) = nb("rpc");
        fs::write(d.join("a.png"), png(3, 2)).unwrap();
        let v = read_image_json(&n, "a.png").unwrap();
        assert_eq!(v["mime"], "image/png");
        assert_eq!(v["base64"], base64_encode(&png(3, 2)));
        assert_eq!(v["width"], 3);
        assert_eq!(v["height"], 2);
        assert!(v["mtimeMs"].as_i64().unwrap() > 0);
        assert_eq!(v["size"], png(3, 2).len());
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::os::unix::fs::symlink;

        #[test]
        fn symlink_file_outside_is_invalid() {
            let (d, n) = nb("symout");
            let outside = tmp("symout-target");
            fs::write(outside.join("secret.png"), png(1, 1)).unwrap();
            symlink(outside.join("secret.png"), d.join("a.png")).unwrap();
            symlink("/etc/hosts", d.join("hosts.png")).unwrap();
            assert_eq!(code_of(read_image(&n, "a.png")), "invalidPath");
            assert_eq!(code_of(read_image(&n, "hosts.png")), "invalidPath");
        }

        #[test]
        fn symlink_dir_outside_is_invalid() {
            let (d, n) = nb("symdir");
            let outside = tmp("symdir-target");
            fs::write(outside.join("s.png"), png(1, 1)).unwrap();
            symlink(&outside, d.join("link")).unwrap();
            assert_eq!(code_of(read_image(&n, "link/s.png")), "invalidPath");
        }

        #[test]
        fn symlink_inside_root_is_allowed() {
            let (d, n) = nb("syminside");
            fs::create_dir(d.join("real")).unwrap();
            fs::write(d.join("real/p.png"), png(1, 1)).unwrap();
            symlink(d.join("real/p.png"), d.join("alias.png")).unwrap();
            symlink("real", d.join("linkdir")).unwrap();
            assert!(read_image(&n, "alias.png").is_ok());
            assert!(read_image(&n, "linkdir/p.png").is_ok());
        }

        #[test]
        fn symlinked_notebook_dir_reads_inside() {
            let real = tmp("realnb");
            fs::write(real.join("book.sqlnb"), "x").unwrap();
            fs::write(real.join("p.png"), png(1, 1)).unwrap();
            let link = std::env::temp_dir().join(format!("img-linknb-{}", std::process::id()));
            let _ = fs::remove_file(&link);
            symlink(&real, &link).unwrap();
            assert!(read_image(&link.join("book.sqlnb"), "p.png").is_ok());
            fs::write(tmp("realnb-out").join("o.png"), png(1, 1)).unwrap();
        }

        #[test]
        fn dangling_symlink_not_found() {
            let (d, n) = nb("dangling");
            symlink(d.join("missing.png"), d.join("d.png")).unwrap();
            assert_eq!(code_of(read_image(&n, "d.png")), "notFound");
        }

        #[test]
        fn fifo_is_refused_without_blocking() {
            let (d, n) = nb("fifo");
            let p = d.join("pipe.png");
            let ok = std::process::Command::new("mkfifo").arg(&p).status().map(|s| s.success()).unwrap_or(false);
            if !ok {
                eprintln!("SKIPPED fifo_is_refused_without_blocking: mkfifo unavailable");
                return;
            }
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(read_image(&n, "pipe.png").map(|_| ()).unwrap_err().code());
            });
            let got = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("read_image blocked on a FIFO");
            assert_eq!(got, "invalidPath");
        }
    }
}

#[cfg(test)]
mod write_tests {
    use super::tests::{avif, code_of, gif, jpeg, nb, png, tmp, webp_vp8x};
    use super::*;
    use std::fs;

    const STAMP: &str = "20260101-120000";

    fn h8(b: &[u8]) -> String {
        sha256(b)[..4].iter().map(|x| format!("{x:02x}")).collect()
    }
    fn files_in(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
    fn html() -> Vec<u8> {
        b"<html><script>alert(1)</script></html>".to_vec()
    }

    #[test]
    fn sha256_vectors() {
        let hex = |b: [u8; 32]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert_eq!(hex(sha256(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(hex(sha256(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let long = vec![b'a'; 1000];
        assert_eq!(hex(sha256(&long)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    }

    #[test]
    fn base64_decode_strict() {
        assert_eq!(base64_decode("").unwrap(), b"");
        assert_eq!(base64_decode("Zm9vYg==").unwrap(), b"foob");
        assert_eq!(base64_decode("Zm9vYg").unwrap(), b"foob");
        assert_eq!(base64_decode("+/+/").unwrap(), vec![0xfb, 0xff, 0xbf]);
        for bad in ["Zm9v!", "Zm9vY", "Z", "=Zm9", "Zg==Zg==", "Zm 9v", "data:image/png;base64,AA=="] {
            assert!(base64_decode(bad).is_none(), "{bad}");
        }
        let b = png(5, 5);
        assert_eq!(base64_decode(&base64_encode(&b)).unwrap(), b);
    }

    #[test]
    fn stamp_vectors() {
        assert_eq!(stamp_from_secs(0), "19700101-000000");
        assert_eq!(stamp_from_secs(1_000_000_000), "20010909-014640");
        assert_eq!(stamp_from_secs(1_782_907_200), "20260701-120000");
        assert_eq!(stamp_now().len(), 15);
    }

    #[test]
    fn save_each_format_round_trips_through_read_image() {
        let (d, n) = nb("save-fmt");
        let cases: Vec<(Vec<u8>, &str, &str)> = vec![
            (png(2, 2), "image/png", "png"),
            (jpeg(2, 2), "image/jpeg", "jpg"),
            (gif(2, 2), "image/gif", "gif"),
            (webp_vp8x(2, 2), "image/webp", "webp"),
        ];
        for (b, mime, ext) in cases {
            let s = save_image(&n, mime, &b, STAMP).unwrap();
            assert_eq!(s.rel_path, format!("book.sqlnb.assets/image-{STAMP}-{}.{ext}", h8(&b)));
            assert_eq!(s.size, b.len() as u64);
            assert_eq!(fs::read(d.join(&s.rel_path)).unwrap(), b);
            let r = read_image(&n, &s.rel_path).unwrap();
            assert_eq!(r.mime, mime);
            assert_eq!(r.bytes, b);
            assert!(s.rel_path.chars().all(|c| c.is_ascii_alphanumeric() || "./-_".contains(c)));
        }
        assert_eq!(assets_dir_name(&n).unwrap(), "book.sqlnb.assets");
        // only final files remain
        assert_eq!(files_in(&d.join("book.sqlnb.assets")).len(), 4);
    }

    #[test]
    fn same_bytes_twice_is_deduplicated_even_with_new_stamp() {
        let (d, n) = nb("save-dedupe");
        let a = save_image(&n, "image/png", &png(3, 3), STAMP).unwrap();
        let b = save_image(&n, "image/png", &png(3, 3), "20260202-000000").unwrap();
        assert_eq!(a.rel_path, b.rel_path);
        assert_eq!(files_in(&d.join("book.sqlnb.assets")).len(), 1);
    }

    #[test]
    fn name_collision_with_other_content_gets_suffix_and_never_overwrites() {
        let (d, n) = nb("save-collide");
        let b = png(4, 4);
        let adir = d.join("book.sqlnb.assets");
        fs::create_dir(&adir).unwrap();
        let taken = adir.join(format!("image-{STAMP}-{}.png", h8(&b)));
        fs::write(&taken, b"precious").unwrap();
        let s = save_image(&n, "image/png", &b, STAMP).unwrap();
        assert!(s.rel_path.ends_with("-2.png"), "{}", s.rel_path);
        assert_eq!(fs::read(&taken).unwrap(), b"precious");
        assert_eq!(fs::read(d.join(&s.rel_path)).unwrap(), b);
        // a symlink squatting on the name is not written through either
        #[cfg(unix)]
        {
            let victim = tmp("save-collide-victim").join("v.png");
            fs::write(&victim, b"victim").unwrap();
            let b2 = png(6, 6);
            std::os::unix::fs::symlink(&victim, adir.join(format!("image-{STAMP}-{}.png", h8(&b2)))).unwrap();
            let s2 = save_image(&n, "image/png", &b2, STAMP).unwrap();
            assert!(s2.rel_path.ends_with("-2.png"));
            assert_eq!(fs::read(&victim).unwrap(), b"victim");
        }
    }

    #[test]
    fn concurrent_saves_never_overwrite() {
        let (d, n) = nb("save-conc");
        let n = std::sync::Arc::new(n);
        let mut hs = vec![];
        for t in 0..4u32 {
            let n = n.clone();
            hs.push(std::thread::spawn(move || {
                let mut out = vec![];
                for i in 0..10u32 {
                    // half the images are shared between threads, half unique
                    let b = if i % 2 == 0 { png(10 + i, 1) } else { png(100 + t * 10 + i, 1) };
                    out.push((save_image(&n, "image/png", &b, STAMP).unwrap().rel_path, b));
                }
                out
            }));
        }
        let mut distinct = std::collections::HashSet::new();
        for h in hs {
            for (rel, b) in h.join().unwrap() {
                assert_eq!(fs::read(d.join(&rel)).unwrap(), b, "{rel} was overwritten");
                distinct.insert(rel);
            }
        }
        let files = files_in(&d.join("book.sqlnb.assets"));
        assert_eq!(files.len(), distinct.len());
        assert_eq!(files.len(), 5 + 20);
    }

    #[test]
    fn same_stamp_same_hash_prefix_is_still_safe_for_threads() {
        let (d, n) = nb("save-conc2");
        let n = std::sync::Arc::new(n);
        let hs: Vec<_> = (0..2)
            .map(|_| {
                let n = n.clone();
                std::thread::spawn(move || save_image(&n, "image/png", &png(7, 7), STAMP).unwrap().rel_path)
            })
            .collect();
        let rels: Vec<String> = hs.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(rels[0], rels[1]);
        assert_eq!(files_in(&d.join("book.sqlnb.assets")).len(), 1);
    }

    #[test]
    fn assets_path_that_is_a_file_is_invalid_path() {
        let (d, n) = nb("save-file");
        fs::write(d.join("book.sqlnb.assets"), b"i am a file").unwrap();
        assert_eq!(code_of(save_image(&n, "image/png", &png(1, 1), STAMP)), "invalidPath");
        assert_eq!(fs::read(d.join("book.sqlnb.assets")).unwrap(), b"i am a file");
    }

    #[cfg(unix)]
    #[test]
    fn assets_symlink_outside_is_refused_inside_is_allowed() {
        let (d, n) = nb("save-sym");
        let outside = tmp("save-sym-out");
        std::os::unix::fs::symlink(&outside, d.join("book.sqlnb.assets")).unwrap();
        assert_eq!(code_of(save_image(&n, "image/png", &png(1, 1), STAMP)), "invalidPath");
        assert!(files_in(&outside).is_empty());

        let (d2, n2) = nb("save-sym-in");
        fs::create_dir(d2.join("real")).unwrap();
        std::os::unix::fs::symlink("real", d2.join("book.sqlnb.assets")).unwrap();
        let s = save_image(&n2, "image/png", &png(1, 1), STAMP).unwrap();
        assert!(d2.join("real").join(s.rel_path.rsplit('/').next().unwrap()).exists());
    }

    #[test]
    fn assets_dir_name_traversal_refused() {
        let (d, n) = nb("save-trav");
        let outside = d.parent().unwrap().join(format!("x-{}", std::process::id()));
        for bad in ["../x", "..", "/abs", "a/b", "", "a\\b", "C:", "%2e%2e", "CON", "x."] {
            assert_eq!(code_of(save_image_in(&n, Some(bad), "image/png", &png(1, 1), STAMP)), "invalidPath", "{bad:?}");
        }
        assert!(!outside.exists());
        assert_eq!(files_in(&d), vec!["book.sqlnb"]);
        assert!(save_image_in(&n, Some("pics"), "image/png", &png(1, 1), STAMP).unwrap().rel_path.starts_with("pics/"));
    }

    #[test]
    fn unsaved_or_relative_notebook_path() {
        assert_eq!(code_of(save_image(Path::new(""), "image/png", &png(1, 1), STAMP)), "needsSave");
        assert_eq!(code_of(save_image(Path::new("book.sqlnb"), "image/png", &png(1, 1), STAMP)), "invalidPath");
        assert_eq!(code_of(save_image(Path::new("rel/dir/book.sqlnb"), "image/png", &png(1, 1), STAMP)), "invalidPath");
        let (d, _n) = nb("save-nodir");
        assert_eq!(code_of(save_image(&d.join("gone/book.sqlnb"), "image/png", &png(1, 1), STAMP)), "notFound");
    }

    #[test]
    fn size_cap_refused_without_writing() {
        let (d, n) = nb("save-big");
        let mut b = png(1, 1);
        b.resize(MAX_SAVE_BYTES as usize + 1, 0);
        assert_eq!(code_of(save_image(&n, "image/png", &b, STAMP)), "tooLarge");
        assert!(!d.join("book.sqlnb.assets").exists());
        b.pop();
        assert!(save_image(&n, "image/png", &b, STAMP).is_ok());
        // an over-long base64 string is refused before decoding
        let huge = "A".repeat((MAX_SAVE_BYTES as usize) * 4 / 3 + 100);
        assert_eq!(code_of(save_image_json(&n, None, "image/png", &huge, STAMP)), "tooLarge");
    }

    #[test]
    fn wrong_magic_refused_without_writing() {
        let (d, n) = nb("save-magic");
        let mut jxl = vec![0, 0, 0, 0x0c];
        jxl.extend(b"JXL \r\n\x87\n");
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec();
        let mut heic = vec![0, 0, 0, 0x18];
        heic.extend(b"ftypheic\0\0\0\0mif1heic");
        for b in [html(), avif(), heic, jxl, vec![0xFF, 0x0A, 1], svg, vec![], b"x".to_vec()] {
            assert_eq!(code_of(save_image(&n, "image/png", &b, STAMP)), "unsupported");
        }
        assert!(!d.join("book.sqlnb.assets").exists());
    }

    #[test]
    fn declared_mime_must_be_allowed_and_agree() {
        let (d, n) = nb("save-mime");
        for m in ["image/avif", "image/svg+xml", "image/jxl", "image/heic", "text/html", "", "image/jpg", "IMAGE/PNG "] {
            assert_eq!(code_of(save_image(&n, m, &png(1, 1), STAMP)), "unsupported", "{m:?}");
        }
        assert_eq!(code_of(save_image(&n, "image/png", &jpeg(1, 1), STAMP)), "unsupported");
        assert_eq!(code_of(save_image(&n, "image/jpeg", &png(1, 1), STAMP)), "unsupported");
        assert!(!d.join("book.sqlnb.assets").exists());
    }

    #[test]
    fn pixel_cap_and_bad_stamp() {
        let (d, n) = nb("save-px");
        assert_eq!(code_of(save_image(&n, "image/png", &png(10000, 10000), STAMP)), "tooLarge");
        for st in ["", "../x", "2026-01-01", "20260101-12000", "20260101_120000", "20260101-120000/x"] {
            assert_eq!(code_of(save_image(&n, "image/png", &png(1, 1), st)), "invalidPath", "{st:?}");
        }
        assert!(!d.join("book.sqlnb.assets").exists());
    }

    #[test]
    fn unicode_and_space_notebook_names_round_trip() {
        let d = tmp("save-uni");
        let n = d.join("我的 book é.sqlnb");
        fs::write(&n, "x").unwrap();
        let s = save_image(&n, "image/png", &png(2, 2), STAMP).unwrap();
        assert!(s.rel_path.starts_with("我的 book é.sqlnb.assets/image-"));
        assert_eq!(read_image(&n, &s.rel_path).unwrap().bytes, png(2, 2));
    }

    #[test]
    fn awkward_notebook_names_get_a_sanitised_assets_dir_and_round_trip() {
        let d = tmp("save-badname");
        let cases = [
            ("Q3 report #2.sqlnb", "Q3 report _2.sqlnb.assets"),
            ("x%y.sqlnb", "x_y.sqlnb.assets"),
            ("a:b.sqlnb", "a_b.sqlnb.assets"),
            ("nul.sqlnb", "_nul.sqlnb.assets"),
            ("我的 book é.sqlnb", "我的 book é.sqlnb.assets"),
            ("trailing dot..sqlnb", "trailing dot..sqlnb.assets"),
            ("~home.sqlnb", "_home.sqlnb.assets"),
            ("a?b*c<d>e|f\"g.sqlnb", "a_b_c_d_e_f_g.sqlnb.assets"),
        ];
        for (name, dir) in cases {
            let n = d.join(name);
            fs::write(&n, "x").unwrap();
            assert_eq!(assets_dir_name(&n).unwrap(), dir, "{name}");
            let s = save_image(&n, "image/png", &png(2, 2), STAMP).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(s.rel_path.starts_with(&format!("{dir}/image-")), "{}", s.rel_path);
            assert_eq!(read_image(&n, &s.rel_path).unwrap().bytes, png(2, 2), "{name}");
        }
    }

    #[test]
    fn notebooks_sanitising_to_the_same_dir_never_overwrite_each_other() {
        let d = tmp("save-samedir");
        let n1 = d.join("a#b.sqlnb");
        let n2 = d.join("a%b.sqlnb");
        assert_eq!(assets_dir_name(&n1).unwrap(), assets_dir_name(&n2).unwrap());
        let s1 = save_image(&n1, "image/png", &png(2, 2), STAMP).unwrap();
        let s2 = save_image(&n2, "image/png", &png(3, 3), STAMP).unwrap();
        assert_ne!(s1.rel_path, s2.rel_path);
        assert_eq!(fs::read(d.join(&s1.rel_path)).unwrap(), png(2, 2));
        assert_eq!(fs::read(d.join(&s2.rel_path)).unwrap(), png(3, 3));
    }

    #[test]
    fn save_as_between_awkward_names_maps_sanitised_prefixes() {
        let d = tmp("copy-awkward");
        let from = d.join("a#b.sqlnb");
        let to = d.join("c:d.sqlnb");
        fs::create_dir(d.join("a_b.sqlnb.assets")).unwrap();
        fs::write(d.join("a_b.sqlnb.assets/x.png"), png(1, 1)).unwrap();
        let r = copy_assets(&from, &to, &["a_b.sqlnb.assets/x.png".to_string()]).unwrap();
        assert!(r.failed.is_empty(), "{:?}", r.failed);
        assert_eq!(r.mapping, vec![("a_b.sqlnb.assets/x.png".to_string(), "c_d.sqlnb.assets/x.png".to_string())]);
        assert_eq!(read_image(&to, "c_d.sqlnb.assets/x.png").unwrap().bytes, png(1, 1));
    }

    #[test]
    fn explicit_assets_dir_name_is_not_sanitised() {
        let (_d, n) = nb("save-explicit");
        assert_eq!(code_of(save_image_in(&n, Some("a#b"), "image/png", &png(1, 1), STAMP)), "invalidPath");
    }

    #[test]
    fn tmp_guard_removes_file_on_drop_and_on_panic() {
        let d = tmp("tmpguard");
        let p = d.join("t1");
        fs::write(&p, b"x").unwrap();
        drop(TmpGuard(p.clone()));
        assert!(!p.exists());
        let p2 = d.join("t2");
        let p2c = p2.clone();
        let r = std::panic::catch_unwind(move || {
            fs::write(&p2c, b"x").unwrap();
            let _g = TmpGuard(p2c.clone());
            panic!("boom");
        });
        assert!(r.is_err());
        assert!(!p2.exists());
    }

    #[test]
    fn copy_budget_is_checked_from_metadata_before_reading() {
        let (a, _b, na, nn) = two_notebooks("copy-budget");
        fs::write(a.join("one.png"), png(1, 1)).unwrap();
        // not an image: if it were read it would be `unsupported`; the budget must win
        fs::write(a.join("two.png"), vec![b'x'; 4096]).unwrap();
        let r = copy_assets_with_limits(&na, &nn, &s(&["one.png", "two.png"]), 10, png(1, 1).len() as u64 + 10).unwrap();
        assert_eq!(r.failed, vec![("two.png".to_string(), ImageError::TooLarge)]);
    }

    #[test]
    fn temp_file_cleaned_when_install_fails() {
        let (d, n) = nb("save-tmp");
        FAIL_INSTALL.with(|f| f.set(true));
        let r = save_image(&n, "image/png", &png(1, 1), STAMP);
        FAIL_INSTALL.with(|f| f.set(false));
        assert_eq!(code_of(r), "readFailed");
        assert!(files_in(&d.join("book.sqlnb.assets")).is_empty(), "leftover temp file");
        assert!(save_image(&n, "image/png", &png(1, 1), STAMP).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn read_only_assets_dir_fails_cleanly() {
        use std::os::unix::fs::PermissionsExt;
        let (d, n) = nb("save-ro");
        let a = d.join("book.sqlnb.assets");
        fs::create_dir(&a).unwrap();
        fs::set_permissions(&a, fs::Permissions::from_mode(0o555)).unwrap();
        if fs::write(a.join("probe"), b"x").is_ok() {
            eprintln!("SKIPPED read_only_assets_dir_fails_cleanly: running with write access to read-only dirs");
            fs::set_permissions(&a, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }
        let r = save_image(&n, "image/png", &png(1, 1), STAMP);
        fs::set_permissions(&a, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(code_of(r), "readFailed");
        assert!(files_in(&a).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_has_default_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (d, n) = nb("save-perm");
        let s = save_image(&n, "image/png", &png(1, 1), STAMP).unwrap();
        let mode = fs::metadata(d.join(&s.rel_path)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode & 0o600, 0o600);
        assert_eq!(mode & 0o111, 0, "must not be executable");
    }

    #[test]
    fn save_json_shape_and_errors() {
        let (_d, n) = nb("save-json");
        let b = png(2, 2);
        let v = save_image_json(&n, None, "image/png", &base64_encode(&b), STAMP).unwrap();
        assert_eq!(v["size"], b.len());
        assert!(v["relPath"].as_str().unwrap().starts_with("book.sqlnb.assets/image-"));
        assert_eq!(code_of(save_image_json(&n, None, "image/png", "not base64!!", STAMP)), "unsupported");
        let msg = save_image_json(&n, None, "image/png", "!!", STAMP).unwrap_err().rpc_message();
        assert!(!msg.contains(std::env::temp_dir().to_str().unwrap()));
    }

    // ---- copy_assets ----

    fn two_notebooks(name: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let base = tmp(name);
        let a = base.join("a");
        let b = base.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let na = a.join("old.sqlnb");
        let nb2 = b.join("new.sqlnb");
        fs::write(&na, "x").unwrap();
        fs::write(&nb2, "x").unwrap();
        (a, b, na, nb2)
    }
    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn copy_maps_assets_folder_and_keeps_subpaths() {
        let (a, b, na, nn) = two_notebooks("copy-ok");
        fs::create_dir_all(a.join("old.sqlnb.assets")).unwrap();
        fs::create_dir_all(a.join("pics/deep")).unwrap();
        fs::write(a.join("old.sqlnb.assets/x.png"), png(1, 1)).unwrap();
        fs::write(a.join("pics/deep/y.jpg"), jpeg(1, 1)).unwrap();
        fs::write(a.join("z.gif"), gif(1, 1)).unwrap();
        let r = copy_assets(&na, &nn, &s(&["old.sqlnb.assets/x.png", "pics/deep/y.jpg", "./z.gif", "z.gif", "z.gif"])).unwrap_or_else(|e| panic!("{e}"));
        let m: std::collections::HashMap<_, _> = r.mapping.iter().cloned().collect();
        assert!(r.failed.is_empty(), "{:?}", r.failed);
        assert_eq!(m["old.sqlnb.assets/x.png"], "new.sqlnb.assets/x.png");
        assert_eq!(m["pics/deep/y.jpg"], "pics/deep/y.jpg");
        assert_eq!(m["z.gif"], "z.gif");
        assert_eq!(fs::read(b.join("new.sqlnb.assets/x.png")).unwrap(), png(1, 1));
        assert_eq!(fs::read(b.join("pics/deep/y.jpg")).unwrap(), jpeg(1, 1));
        assert_eq!(fs::read(b.join("z.gif")).unwrap(), gif(1, 1));
        assert!(read_image(&nn, &m["old.sqlnb.assets/x.png"]).is_ok());
        // sources untouched, duplicate rels collapsed
        assert!(a.join("old.sqlnb.assets/x.png").exists());
        assert_eq!(m["./z.gif"], "z.gif");
        assert_eq!(r.mapping.len(), 4, "duplicate rels are collapsed");
    }

    #[test]
    fn copy_reports_partial_failures_per_file() {
        let (a, b, na, nn) = two_notebooks("copy-partial");
        fs::write(a.join("ok.png"), png(1, 1)).unwrap();
        fs::write(a.join("text.png"), b"hello").unwrap();
        let r = copy_assets(&na, &nn, &s(&["ok.png", "missing.png", "text.png", "../secret.png", "/etc/hosts", "C:\\x.png", "file:///etc/hosts"])).unwrap();
        assert_eq!(r.mapping, vec![("ok.png".to_string(), "ok.png".to_string())]);
        let f: std::collections::HashMap<_, _> = r.failed.iter().map(|(k, e)| (k.as_str(), e.code())).collect();
        assert_eq!(f["missing.png"], "notFound");
        assert_eq!(f["text.png"], "unsupported");
        for bad in ["../secret.png", "/etc/hosts", "C:\\x.png", "file:///etc/hosts"] {
            assert_eq!(f[bad], "invalidPath", "{bad}");
        }
        assert!(b.join("ok.png").exists());
        assert!(!b.join("text.png").exists());
    }

    #[cfg(unix)]
    #[test]
    fn copy_never_follows_source_symlinks_out_or_into_outside_dest() {
        let (a, b, na, nn) = two_notebooks("copy-sym");
        let outside = tmp("copy-sym-out");
        fs::write(outside.join("s.png"), png(1, 1)).unwrap();
        std::os::unix::fs::symlink(outside.join("s.png"), a.join("leak.png")).unwrap();
        std::os::unix::fs::symlink(&outside, a.join("linkdir")).unwrap();
        fs::write(a.join("fine.png"), png(2, 2)).unwrap();
        // destination side: a symlinked directory pointing outside must not be written through
        std::os::unix::fs::symlink(&outside, b.join("pics")).unwrap();
        fs::create_dir(a.join("pics")).unwrap();
        fs::write(a.join("pics/p.png"), png(3, 3)).unwrap();
        let r = copy_assets(&na, &nn, &s(&["leak.png", "linkdir/s.png", "fine.png", "pics/p.png"])).unwrap();
        let f: std::collections::HashMap<_, _> = r.failed.iter().map(|(k, e)| (k.as_str(), e.code())).collect();
        assert_eq!(f["leak.png"], "invalidPath");
        assert_eq!(f["linkdir/s.png"], "invalidPath");
        assert_eq!(f["pics/p.png"], "invalidPath");
        assert_eq!(r.mapping.len(), 1);
        assert_eq!(files_in(&outside), vec!["s.png"]);
    }

    #[test]
    fn copy_limits() {
        let (a, b, na, nn) = two_notebooks("copy-cap");
        for i in 0..3u32 {
            fs::write(a.join(format!("i{i}.png")), png(1 + i, 1)).unwrap();
        }
        let size = png(1, 1).len() as u64;
        let r = copy_assets_with_limits(&na, &nn, &s(&["i0.png", "i1.png", "i2.png"]), 10, size * 2).unwrap();
        assert_eq!(r.mapping.len(), 2);
        assert_eq!(r.failed.len(), 1);
        assert_eq!(r.failed[0], ("i2.png".to_string(), ImageError::TooLarge));
        assert!(!b.join("i2.png").exists());
        let rels: Vec<String> = (0..=MAX_COPY_FILES).map(|i| format!("n{i}.png")).collect();
        assert_eq!(copy_assets(&na, &nn, &rels).unwrap_err(), ImageError::TooLarge);
        assert_eq!(copy_assets_with_limits(&na, &nn, &s(&["i0.png", "i1.png"]), 1, u64::MAX).unwrap_err(), ImageError::TooLarge);
    }

    #[test]
    fn copy_collisions_on_target() {
        let (a, b, na, nn) = two_notebooks("copy-coll");
        fs::write(a.join("same.png"), png(1, 1)).unwrap();
        fs::write(a.join("diff.png"), png(2, 2)).unwrap();
        fs::write(b.join("same.png"), png(1, 1)).unwrap();
        fs::write(b.join("diff.png"), b"mine").unwrap();
        fs::write(b.join("diff-2.png"), b"mine too").unwrap();
        let r = copy_assets(&na, &nn, &s(&["same.png", "diff.png"])).unwrap();
        let m: std::collections::HashMap<_, _> = r.mapping.iter().cloned().collect();
        assert_eq!(m["same.png"], "same.png");
        assert_eq!(m["diff.png"], "diff-3.png");
        assert_eq!(fs::read(b.join("diff.png")).unwrap(), b"mine");
        assert_eq!(fs::read(b.join("diff-2.png")).unwrap(), b"mine too");
        assert_eq!(fs::read(b.join("diff-3.png")).unwrap(), png(2, 2));
        assert_eq!(files_in(&b).iter().filter(|f| f.starts_with("same")).count(), 1);
    }

    #[test]
    fn copy_into_same_directory() {
        let (a, _b, na, _nn) = two_notebooks("copy-same");
        fs::write(a.join("p.png"), png(1, 1)).unwrap();
        let r = copy_assets(&na, &na, &s(&["p.png"])).unwrap();
        assert_eq!(r.mapping, vec![("p.png".to_string(), "p.png".to_string())]);
        assert_eq!(files_in(&a), vec!["old.sqlnb", "p.png"]);
        // renamed notebook in the same directory: assets folder is copied under the new name
        fs::create_dir(a.join("old.sqlnb.assets")).unwrap();
        fs::write(a.join("old.sqlnb.assets/q.png"), png(2, 2)).unwrap();
        let other = a.join("renamed.sqlnb");
        fs::write(&other, "x").unwrap();
        let r = copy_assets(&na, &other, &s(&["old.sqlnb.assets/q.png", "p.png"])).unwrap();
        let m: std::collections::HashMap<_, _> = r.mapping.iter().cloned().collect();
        assert_eq!(m["old.sqlnb.assets/q.png"], "renamed.sqlnb.assets/q.png");
        assert_eq!(m["p.png"], "p.png");
        assert!(a.join("renamed.sqlnb.assets/q.png").exists());
    }

    #[test]
    fn copy_requires_saved_notebooks_and_json_shape() {
        let (a, _b, na, nn) = two_notebooks("copy-json");
        assert_eq!(copy_assets(Path::new(""), &nn, &s(&["a.png"])).unwrap_err(), ImageError::NeedsSave);
        assert_eq!(copy_assets(&na, Path::new("rel.sqlnb"), &s(&["a.png"])).unwrap_err(), ImageError::InvalidPath);
        fs::write(a.join("p.png"), png(1, 1)).unwrap();
        let v = copy_assets_json(&na, &nn, &s(&["p.png", "nope.png"])).unwrap();
        assert_eq!(v["mapping"]["p.png"], "p.png");
        assert_eq!(v["copied"], serde_json::json!(["p.png"]));
        assert_eq!(v["failed"], serde_json::json!(["nope.png"]));
        assert_eq!(v["errors"]["nope.png"], "notFound");
    }
}
