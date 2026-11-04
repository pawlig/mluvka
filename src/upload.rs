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
pub struct Sessions(Mutex<HashMap<String, VecDeque<Instant>>>);
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
            .insert(token.clone(), VecDeque::new());
        Lease {
            token,
            sessions: self.clone(),
        }
    }
    fn check(&self, token: &str, count: bool) -> Result<(), StatusCode> {
        let mut sessions = self.0.lock().expect("upload sessions");
        let attempts = sessions.get_mut(token).ok_or(StatusCode::UNAUTHORIZED)?;
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
            if !entry.file_type().await?.is_file()
                || valid_name(&entry.file_name().to_string_lossy()).is_none()
            {
                continue;
            }
            let meta = entry.metadata().await?;
            let modified = meta.modified()?;
            if now.duration_since(modified).unwrap_or_default() >= self.ttl {
                fs::remove_file(entry.path()).await?;
            } else {
                total = total.saturating_add(meta.len());
                files.push((modified, entry.path(), meta.len()));
            }
        }
        files.sort_by_key(|f| f.0);
        for (_, path, len) in files {
            if total <= self.max_total {
                break;
            }
            fs::remove_file(path).await?;
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
    let bytes = to_bytes(body, MAX_IMAGE)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let (ext, _) = image_type(&bytes).ok_or(StatusCode::UNSUPPORTED_MEDIA_TYPE)?;
    check_size(bytes.len(), ext)?;
    let _guard = storage.gate.lock().await;
    storage.sessions.check(token, false)?;
    if bytes.len() as u64 > storage.max_total {
        return Err(StatusCode::INSUFFICIENT_STORAGE);
    }
    storage
        .cleanup(bytes.len() as u64)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let name = format!("{}.{}", random_id(), ext);
    let path = storage.dir.join(&name);
    use tokio::io::AsyncWriteExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if file.write_all(&bytes).await.is_err() {
        let _ = fs::remove_file(&path).await;
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    Ok((
        StatusCode::CREATED,
        [("cache-control", "no-store")],
        Json(json!({"url":format!("{base}/img/{name}")})),
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

#[cfg(test)]
mod tests {
    use super::*;
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
        headers.insert("host", "attacker.example/path".parse().unwrap());
        assert_eq!(
            public_base(&storage, &headers),
            Err(StatusCode::BAD_REQUEST)
        );
        storage.public_url = Some("https://configured.example".into());
        assert_eq!(
            public_base(&storage, &headers).unwrap(),
            "https://configured.example"
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
    #[tokio::test]
    async fn ttl_and_oldest_first_total_limit() {
        let dir = env::temp_dir().join(random_id());
        fs::create_dir(&dir).await.unwrap();
        let mut storage = Uploads {
            sessions: Arc::default(),
            dir: dir.clone(),
            ttl: Duration::from_secs(60),
            max_total: 5,
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
