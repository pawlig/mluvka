//! Obrázky mají veřejné náhodné URL; oprávnění k zápisu žije pouze po dobu TS relace.
use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    env,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
use tokio::{fs, sync::Mutex as AsyncMutex};

const MAX_IMAGE: usize = 10 * 1024 * 1024;
const MAX_GIF: usize = 8 * 1024 * 1024;
const WINDOW: Duration = Duration::from_secs(300);
#[derive(Default)]
struct UploadSession {
    attempts: VecDeque<Instant>,
    files: Option<tokio::sync::mpsc::Sender<crate::ts_file::Download>>,
}
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, UploadSession>>);
pub struct Lease {
    pub token: String,
    sessions: Arc<Sessions>,
}
impl Sessions {
    pub fn grant(self: &Arc<Self>) -> Lease {
        let token = random_id();
        self.0
            .lock()
            .expect("upload sessions")
            .insert(token.clone(), UploadSession::default());
        Lease {
            token,
            sessions: self.clone(),
        }
    }
    pub fn bind_files(
        &self,
        token: &str,
        files: tokio::sync::mpsc::Sender<crate::ts_file::Download>,
    ) {
        if let Some(session) = self.0.lock().expect("upload sessions").get_mut(token) {
            session.files = Some(files);
        }
    }
    pub fn files(
        &self,
        token: &str,
    ) -> Result<tokio::sync::mpsc::Sender<crate::ts_file::Download>, StatusCode> {
        self.0
            .lock()
            .expect("upload sessions")
            .get(token)
            .and_then(|s| s.files.clone())
            .ok_or(StatusCode::UNAUTHORIZED)
    }
    pub fn check(&self, token: &str, count: bool) -> Result<(), StatusCode> {
        let mut sessions = self.0.lock().expect("upload sessions");
        let attempts = &mut sessions
            .get_mut(token)
            .ok_or(StatusCode::UNAUTHORIZED)?
            .attempts;
        let now = Instant::now();
        attempts.retain(|at| now.duration_since(*at) < WINDOW);
        if count {
            if attempts.len() >= 10 {
                return Err(StatusCode::TOO_MANY_REQUESTS);
            }
            attempts.push_back(now);
        }
        Ok(())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.sessions
            .0
            .lock()
            .expect("upload sessions")
            .remove(&self.token);
    }
}
fn random_id() -> String {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).expect("system random");
    URL_SAFE_NO_PAD.encode(bytes)
}
#[derive(Clone)]
pub struct Uploads {
    pub sessions: Arc<Sessions>,
    dir: PathBuf,
    ttl: Duration,
    max_total: u64,
    max_file: usize,
    public_url: Option<String>,
    gate: Arc<AsyncMutex<()>>,
}
impl Uploads {
    pub async fn from_env() -> Self {
        let value = Self {
            sessions: Arc::default(),
            dir: env::var("UPLOAD_DIR")
                .unwrap_or_else(|_| "/data/uploads".into())
                .into(),
            ttl: Duration::from_secs(env_number("UPLOAD_TTL_DAYS", 7) * 86400),
            max_file: (env_number("UPLOAD_FILE_MAX_MB", 25) * 1024 * 1024) as usize,
            max_total: env_number("UPLOAD_MAX_TOTAL_MB", 1024) * 1024 * 1024,
            public_url: env::var("PUBLIC_URL")
                .ok()
                .filter(|v| !v.is_empty())
                .map(|v| {
                    assert!(valid_base(&v), "Neplatné PUBLIC_URL");
                    v.trim_end_matches('/').to_owned()
                }),
            gate: Arc::default(),
        };
        fs::create_dir_all(&value.dir)
            .await
            .expect("Úložiště obrázků nelze vytvořit");
        value
            .cleanup(0)
            .await
            .expect("Úložiště obrázků nelze uklidit");
        value
    }
    async fn cleanup(&self, reserve: u64) -> std::io::Result<()> {
        let mut entries = fs::read_dir(&self.dir).await?;
        let mut files = Vec::new();
        let now = SystemTime::now();
        let mut total = reserve;
        while let Some(entry) = entries.next_entry().await? {
            if !entry.file_type().await?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(data_name) = name.strip_suffix(".json").filter(|n| stored_name(n)) {
                if !fs::symlink_metadata(self.dir.join(data_name))
                    .await
                    .is_ok_and(|m| m.is_file())
                {
                    remove_if_exists(&entry.path()).await?;
                }
                continue;
            }
            if !stored_name(&name) {
                continue;
            }
            let meta = match entry.metadata().await {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            let metadata_len = match fs::symlink_metadata(metadata_path(&entry.path())).await {
                Ok(meta) if meta.is_file() => meta.len(),
                Ok(_) => 0,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
                Err(e) => return Err(e),
            };
            let len = meta.len().saturating_add(metadata_len);
            let modified = meta.modified()?;
            if now.duration_since(modified).unwrap_or_default() >= self.ttl {
                remove_stored(&entry.path()).await?;
            } else {
                total = total.saturating_add(len);
                files.push((modified, entry.path(), len));
            }
        }
        files.sort_by_key(|f| f.0);
        for (_, path, len) in files {
            if total <= self.max_total {
                break;
            }
            remove_stored(&path).await?;
            total = total.saturating_sub(len);
        }
        Ok(())
    }
    pub fn start_cleanup(&self) {
        let storage = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(3600));
            loop {
                tick.tick().await;
                let _guard = storage.gate.lock().await;
                if storage.cleanup(0).await.is_err() {
                    tracing::warn!("Úklid úložiště obrázků selhal");
                }
            }
        });
    }
}
fn env_number(name: &str, default: u64) -> u64 {
    env::var(name).map_or(default, |v| v.parse().expect("Neplatný limit úložiště"))
}
fn valid_base(base: &str) -> bool {
    base.parse::<axum::http::Uri>().is_ok_and(|uri| {
        matches!(uri.scheme_str(), Some("https" | "http"))
            && uri.authority().is_some()
            && !base.contains(['[', ']', '<', '>', '\\'])
            && uri.query().is_none()
    })
}
fn public_base(storage: &Uploads, headers: &HeaderMap) -> Result<String, StatusCode> {
    if let Some(url) = &storage.public_url {
        return Ok(url.clone());
    }
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .ok_or(StatusCode::BAD_REQUEST)?;
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("http");
    if !matches!(proto, "http" | "https") || host.contains(['/', '?', '#', '@']) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let base = format!("{proto}://{host}");
    if !valid_base(&base) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(base)
}
// Žádná přípona ani Content-Type od klienta nerozhodují o typu souboru.
fn image_type(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("png", "image/png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("gif", "image/gif"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else {
        None
    }
}
fn valid_name(name: &str) -> Option<&'static str> {
    let (id, ext) = name.split_once('.')?;
    if id.len() != 43
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    match ext {
        "png" => Some("image/png"),
        "jpg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}
fn check_size(size: usize, ext: &str) -> Result<(), StatusCode> {
    if size > MAX_IMAGE || (ext == "gif" && size > MAX_GIF) {
        Err(StatusCode::PAYLOAD_TOO_LARGE)
    } else {
        Ok(())
    }
}
pub async fn upload(
    State(app): State<crate::App>,
    request: Request,
) -> Result<Response, StatusCode> {
    let (parts, body) = request.into_parts();
    let token = parts
        .headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let storage = &app.uploads;
    storage.sessions.check(token, true)?;
    let base = public_base(storage, &parts.headers)?;
    let filename = parts
        .headers
        .get("x-file-name")
        .map(|h| {
            let raw = h.to_str().map_err(|_| StatusCode::BAD_REQUEST)?;
            let decoded = url::form_urlencoded::parse(format!("name={raw}").as_bytes())
                .next()
                .map(|(_, v)| v.into_owned())
                .ok_or(StatusCode::BAD_REQUEST)?;
            Ok::<_, StatusCode>(sanitize_filename(&decoded))
        })
        .transpose()?;
    let bytes = to_bytes(
        body,
        if filename.is_some() {
            storage.max_file
        } else {
            MAX_IMAGE
        },
    )
    .await
    .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let ext = if filename.is_some() {
        "bin"
    } else {
        let (ext, _) = image_type(&bytes).ok_or(StatusCode::UNSUPPORTED_MEDIA_TYPE)?;
        check_size(bytes.len(), ext)?;
        ext
    };
    let _guard = storage.gate.lock().await;
    storage.sessions.check(token, false)?;
    let metadata = filename
        .as_ref()
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let reserve = bytes.len() as u64 + metadata.as_ref().map_or(0, |m| m.len() as u64);
    if reserve > storage.max_total {
        return Err(StatusCode::INSUFFICIENT_STORAGE);
    }
    storage.cleanup(reserve).await.map_err(storage_error)?;
    let name = format!("{}.{}", random_id(), ext);
    let path = storage.dir.join(&name);
    write_stored(&path, &bytes, metadata.as_deref())
        .await
        .map_err(storage_error)?;
    let url = if let Some(filename) = &filename {
        format!(
            "{base}/f/{}/{}",
            name.trim_end_matches(".bin"),
            encode_filename(filename)
        )
    } else {
        format!("{base}/img/{name}")
    };
    Ok((
        StatusCode::CREATED,
        [("cache-control", "no-store")],
        Json(json!({"url":url,"name":filename,"size":bytes.len()})),
    )
        .into_response())
}
pub async fn image(
    State(app): State<crate::App>,
    Path(name): Path<String>,
) -> Result<Response, StatusCode> {
    let content_type = valid_name(&name).ok_or(StatusCode::NOT_FOUND)?;
    let path = app.uploads.dir.join(&name);
    let meta = fs::symlink_metadata(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !meta.is_file()
        || SystemTime::now()
            .duration_since(meta.modified().map_err(|_| StatusCode::NOT_FOUND)?)
            .unwrap_or_default()
            >= app.uploads.ttl
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let bytes = fs::read(path).await.map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((
        [
            ("content-type", content_type),
            ("cache-control", "public, max-age=604800, immutable"),
            ("x-content-type-options", "nosniff"),
            ("content-security-policy", "default-src 'none'"),
        ],
        Body::from(bytes),
    )
        .into_response())
}

pub fn sanitize_filename(name: &str) -> String {
    let name: String = name
        .chars()
        .filter(|c| {
            !c.is_control()
                && !r#"/\:*?"<>|[]"#.contains(*c)
                && !matches!(*c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(120)
        .collect();
    let name = name.trim().trim_matches('.');
    if name.is_empty() {
        "soubor".into()
    } else {
        name.into()
    }
}
pub fn encode_filename(name: &str) -> String {
    name.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
pub fn attachment_headers(name: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (key, value) in [
        ("content-type", "application/octet-stream".to_owned()),
        (
            "content-disposition",
            format!(
                "attachment; filename*=UTF-8''{}",
                encode_filename(&sanitize_filename(name))
            ),
        ),
        ("x-content-type-options", "nosniff".into()),
        (
            "content-security-policy",
            "default-src 'none'; sandbox".into(),
        ),
        ("cache-control", "private, max-age=604800".into()),
    ] {
        headers.insert(
            axum::http::HeaderName::from_static(key),
            value.parse().expect("safe attachment header"),
        );
    }
    headers
}
fn valid_id(id: &str) -> bool {
    id.len() == 43
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
fn stored_name(name: &str) -> bool {
    valid_name(name).is_some() || name.strip_suffix(".bin").is_some_and(valid_id)
}
fn metadata_path(path: &std::path::Path) -> PathBuf {
    path.with_file_name(format!(
        "{}.json",
        path.file_name().unwrap().to_string_lossy()
    ))
}
fn storage_error(error: std::io::Error) -> StatusCode {
    if error.kind() == std::io::ErrorKind::StorageFull
        || error.kind() == std::io::ErrorKind::QuotaExceeded
    {
        StatusCode::INSUFFICIENT_STORAGE
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}
async fn write_complete(file: &mut fs::File, bytes: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    file.write_all(bytes).await?;
    // write_all může skončit před zápisem bufferu Tokio na disk.
    file.flush().await?;
    file.sync_all().await
}
async fn write_stored(
    path: &std::path::Path,
    bytes: &[u8],
    metadata: Option<&[u8]>,
) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await?;
    let result = async {
        write_complete(&mut file, bytes).await?;
        if let Some(metadata) = metadata {
            let mut meta = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(metadata_path(path))
                .await?;
            write_complete(&mut meta, metadata).await?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        // I při chybě flush/sync se oba soubory uklidí, odpověď 201 nikdy neodejde.
        let _ = remove_stored(path).await;
    }
    result
}
async fn remove_if_exists(path: &std::path::Path) -> std::io::Result<()> {
    match fs::remove_file(path).await {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}
async fn remove_stored(path: &std::path::Path) -> std::io::Result<()> {
    // Druhý pokus se provede i po chybě prvního mazání.
    let data = remove_if_exists(path).await;
    let metadata = remove_if_exists(&metadata_path(path)).await;
    data.and(metadata)
}
pub async fn file(
    State(app): State<crate::App>,
    Path((id, _name)): Path<(String, String)>,
) -> Result<Response, StatusCode> {
    if !valid_id(&id) {
        return Err(StatusCode::NOT_FOUND);
    }
    let path = app.uploads.dir.join(format!("{id}.bin"));
    let file = fs::File::open(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let meta = file.metadata().await.map_err(|_| StatusCode::NOT_FOUND)?;
    if !meta.is_file()
        || SystemTime::now()
            .duration_since(meta.modified().map_err(|_| StatusCode::NOT_FOUND)?)
            .unwrap_or_default()
            >= app.uploads.ttl
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let name: String = serde_json::from_slice(
        &fs::read(path.with_extension("bin.json"))
            .await
            .map_err(|_| StatusCode::NOT_FOUND)?,
    )
    .map_err(|_| StatusCode::NOT_FOUND)?;
    let mut headers = attachment_headers(&name);
    headers.insert("content-length", meta.len().to_string().parse().unwrap());
    Ok((
        headers,
        Body::from_stream(tokio_util::io::ReaderStream::new(file)),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filename_and_utf8_disposition() {
        assert_eq!(sanitize_filename("../a\\b:c*?\"<>|\r\n.zip"), "abc.zip");
        assert_eq!(sanitize_filename("..."), "soubor");
        assert_eq!(sanitize_filename(&"ž".repeat(200)).chars().count(), 120);
        assert_eq!(
            attachment_headers("žluťoučký.zip")["content-disposition"],
            "attachment; filename*=UTF-8''%C5%BElu%C5%A5ou%C4%8Dk%C3%BD.zip"
        );
    }
    #[test]
    fn magic_bytes_and_rejected_active_content() {
        for (bytes, ext) in [
            (b"\x89PNG\r\n\x1a\n".as_slice(), "png"),
            (b"\xff\xd8\xff", "jpg"),
            (b"GIF89a", "gif"),
            (b"GIF87a", "gif"),
            (b"RIFF1234WEBP", "webp"),
        ] {
            assert_eq!(image_type(bytes).unwrap().0, ext);
        }
        for bytes in [
            b"<svg xmlns='http://www.w3.org/2000/svg'/>".as_slice(),
            b"<!doctype html><script>alert(1)</script>",
            b"RIFF",
            b"",
        ] {
            assert!(image_type(bytes).is_none());
        }
        assert!(valid_name("../../x.png").is_none());
    }
    #[test]
    fn public_origin_uses_config_then_proxy_headers() {
        let mut storage = Uploads {
            sessions: Arc::default(),
            dir: PathBuf::new(),
            ttl: Duration::ZERO,
            max_total: 0,
            max_file: 25 * 1024 * 1024,
            public_url: None,
            gate: Arc::default(),
        };
        let mut headers = HeaderMap::new();
        headers.insert("host", "mluvka.example.org".parse().unwrap());
        assert_eq!(
            public_base(&storage, &headers).unwrap(),
            "http://mluvka.example.org"
        );
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(
            public_base(&storage, &headers).unwrap(),
            "https://mluvka.example.org"
        );
        headers.insert("host", "attacker.example.org/path".parse().unwrap());
        assert_eq!(
            public_base(&storage, &headers),
            Err(StatusCode::BAD_REQUEST)
        );
        storage.public_url = Some("https://configured.example.org".into());
        assert_eq!(
            public_base(&storage, &headers).unwrap(),
            "https://configured.example.org"
        );
        assert!(!valid_base("javascript:alert(1)"));
    }
    #[test]
    fn limits_and_session_revocation() {
        assert!(check_size(MAX_IMAGE, "jpg").is_ok());
        assert_eq!(
            check_size(MAX_IMAGE + 1, "png"),
            Err(StatusCode::PAYLOAD_TOO_LARGE)
        );
        assert_eq!(
            check_size(MAX_GIF + 1, "gif"),
            Err(StatusCode::PAYLOAD_TOO_LARGE)
        );
        let sessions = Arc::new(Sessions::default());
        let lease = sessions.grant();
        let token = lease.token.clone();
        for _ in 0..10 {
            assert!(sessions.check(&token, true).is_ok());
        }
        assert_eq!(
            sessions.check(&token, true),
            Err(StatusCode::TOO_MANY_REQUESTS)
        );
        drop(lease);
        assert_eq!(sessions.check(&token, false), Err(StatusCode::UNAUTHORIZED));
    }
    #[test]
    fn disk_errors_have_distinct_status() {
        use std::io::{Error, ErrorKind};
        for kind in [ErrorKind::StorageFull, ErrorKind::QuotaExceeded] {
            assert_eq!(
                storage_error(Error::from(kind)),
                StatusCode::INSUFFICIENT_STORAGE
            );
        }
        assert_eq!(
            storage_error(Error::from(ErrorKind::PermissionDenied)),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
    #[tokio::test]
    async fn metadata_capacity_orphans_and_failed_write() {
        let dir = env::temp_dir().join(random_id());
        fs::create_dir(&dir).await.unwrap();
        let storage = Uploads {
            sessions: Arc::default(),
            dir: dir.clone(),
            ttl: Duration::from_secs(60),
            max_total: 8,
            max_file: 25 * 1024 * 1024,
            public_url: None,
            gate: Arc::default(),
        };
        let path = dir.join(format!("{}.bin", random_id()));
        write_stored(&path, b"1234", Some(b"\"name\""))
            .await
            .unwrap();
        // Data samotná se vejdou, s metadaty už ne.
        storage.cleanup(0).await.unwrap();
        assert!(!path.exists());
        assert!(!metadata_path(&path).exists());
        fs::write(metadata_path(&path), b"\"orphan\"")
            .await
            .unwrap();
        storage.cleanup(0).await.unwrap();
        assert!(!metadata_path(&path).exists());
        // Chyba při zápisu druhé části nesmí nechat data ani metadata.
        fs::write(metadata_path(&path), b"stale").await.unwrap();
        assert!(
            write_stored(&path, b"data", Some(b"\"name\""))
                .await
                .is_err()
        );
        assert!(!path.exists());
        assert!(!metadata_path(&path).exists());
        // Úspěšný návrat je až po flush a sync_all obou souborů.
        write_stored(&path, b"data", Some(b"\"x\"")).await.unwrap();
        assert_eq!(fs::read(&path).await.unwrap(), b"data");
        assert_eq!(fs::read(metadata_path(&path)).await.unwrap(), b"\"x\"");
        // Rezervace dalšího uploadu počítá i jeho metadata.
        storage.cleanup(2).await.unwrap();
        assert!(!path.exists());
        fs::remove_dir_all(dir).await.unwrap();
    }
    #[tokio::test]
    async fn ttl_and_oldest_first_total_limit() {
        let dir = env::temp_dir().join(random_id());
        fs::create_dir(&dir).await.unwrap();
        let mut storage = Uploads {
            sessions: Arc::default(),
            dir: dir.clone(),
            ttl: Duration::from_secs(60),
            max_total: 5,
            max_file: 25 * 1024 * 1024,
            public_url: None,
            gate: Arc::default(),
        };
        let old = dir.join(format!("{}.png", random_id()));
        let new = dir.join(format!("{}.png", random_id()));
        fs::write(&old, b"1234").await.unwrap();
        let old_file = std::fs::File::open(&old).unwrap();
        old_file
            .set_modified(SystemTime::now() - Duration::from_secs(30))
            .unwrap();
        fs::write(&new, b"5678").await.unwrap();
        storage.cleanup(0).await.unwrap();
        assert!(!old.exists());
        assert!(new.exists());
        storage.ttl = Duration::ZERO;
        storage.cleanup(0).await.unwrap();
        assert!(!new.exists());
        fs::remove_dir_all(dir).await.unwrap();
    }
}
