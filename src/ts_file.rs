//! Přenos patří výhradně existující TS relaci; URL nikdy neurčuje cíl TCP spojení.
use axum::{
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::{
    io,
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, sync::oneshot};
use tsclientlib::{ChannelId, Connection, FileDownloadResult};

#[derive(Debug)]
pub struct FileLink {
    pub server: String,
    pub uid: Option<String>,
    pub channel: u64,
    pub path: String,
    pub name: String,
}
impl FileLink {
    pub fn parse(raw: &str) -> Result<Self, &'static str> {
        if raw.len() > 4096 {
            return Err("Odkaz na soubor je příliš dlouhý.");
        }
        let url = url::Url::parse(raw).map_err(|_| "Neplatný odkaz na soubor.")?;
        if url.scheme() != "ts3file"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !matches!(url.path(), "" | "/")
        {
            return Err("Neplatný odkaz na soubor.");
        }
        let mut params = std::collections::HashMap::new();
        for (key, value) in url.query_pairs() {
            if params
                .insert(key.into_owned(), value.into_owned())
                .is_some()
            {
                return Err("Opakovaný parametr odkazu.");
            }
        }
        let value = |key: &str| {
            params
                .get(key)
                .map(String::as_str)
                .ok_or("Neúplný odkaz na soubor.")
        };
        let channel = value("channel")?
            .parse::<u64>()
            .map_err(|_| "Neplatný kanál souboru.")?;
        if channel == 0 || params.get("isDir").is_some_and(|v| v != "0") {
            return Err("Odkaz nevede na soubor kanálu.");
        }
        let path = value("path")?;
        let name = value("filename")?;
        if !path.starts_with('/')
            || path.len() > 1024
            || name.is_empty()
            || name.len() > 512
            || path.split('/').any(|p| matches!(p, ".." | "."))
            || name.contains(['/', '\\'])
            || matches!(name, ".." | ".")
            || path
                .chars()
                .chain(name.chars())
                .any(|c| c.is_control() || c == '\\')
        {
            return Err("Neplatná cesta k souboru.");
        }
        let host = url.host_str().ok_or("Chybí server souboru.")?;
        let port = params
            .get("port")
            .map(|v| v.parse::<u16>())
            .transpose()
            .map_err(|_| "Neplatný port serveru.")?
            .or(url.port())
            .unwrap_or(9987);
        if port == 0 {
            return Err("Neplatný port serveru.");
        }
        let server = crate::session::normalize_server(&format!("{host}:{port}"))
            .map_err(|_| "Neplatný server souboru.")?;
        Ok(Self {
            server,
            uid: params.get("serverUID").cloned(),
            channel,
            path: format!("{}/{name}", path.trim_end_matches('/')),
            name: name.into(),
        })
    }
}
pub struct Download {
    pub link: FileLink,
    pub reply: oneshot::Sender<Result<FileDownloadResult, String>>,
}
fn same_server(link: &FileLink, server: &str, uid: &str) -> bool {
    match &link.uid {
        Some(link_uid) => link_uid == uid,
        None => link.server == server,
    }
}
pub fn start(
    con: &mut Connection,
    link: &FileLink,
    server: &str,
    passwords: &std::collections::HashMap<u64, String>,
) -> Result<tsclientlib::FiletransferHandle, String> {
    let book = con.get_state().map_err(|_| "Relace TS serveru skončila.")?;
    if !same_server(link, server, &book.server.public_key.get_uid()) {
        return Err("Soubor je z jiného serveru.".into());
    }
    let channel = book
        .channels
        .get(&ChannelId(link.channel))
        .ok_or("Kanál souboru už neexistuje.")?;
    let password = passwords.get(&link.channel);
    if channel.has_password.unwrap_or(false) && password.is_none() {
        return Err("Soubor je v kanálu s heslem".into());
    }
    con.download_file(
        ChannelId(link.channel),
        &link.path,
        password.map(String::as_str),
        None,
    )
    .map_err(|e| transfer_error(&e))
}
pub fn transfer_error(error: &tsclientlib::Error) -> String {
    match error {
        tsclientlib::Error::CommandError(e) => {
            let text = format!("{e:?}").to_ascii_lowercase();
            if text.contains("password") { "Soubor je v kanálu s heslem" }
            else if text.contains("notfound") || text.contains("not_found") { "Soubor na TS serveru neexistuje." }
            else { "TS server nepovolil stažení souboru. Chybí oprávnění k přenosu nebo potřebná síla pro stahování." }
        },
        _ => "Přenos souboru z TS serveru se nezdařil. Zkontroluj dostupnost TCP portu souborového přenosu (obvykle 30033).",
    }.into()
}
#[derive(Deserialize)]
pub struct DownloadQuery {
    url: String,
}
pub async fn download(
    State(app): State<crate::App>,
    headers: HeaderMap,
    Query(query): Query<DownloadQuery>,
) -> Response {
    match prepare(app, headers, query).await {
        Ok(r) => r,
        Err((status, error)) => (status, [("cache-control", "no-store")], error).into_response(),
    }
}
async fn prepare(
    app: crate::App,
    headers: HeaderMap,
    query: DownloadQuery,
) -> Result<Response, (StatusCode, String)> {
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "Připojení vypršelo. Připoj se znovu.".into(),
        ))?;
    app.uploads
        .sessions
        .check(token, true)
        .map_err(|s| (s, "Připojení vypršelo nebo stahuješ příliš rychle.".into()))?;
    let sender = app
        .uploads
        .sessions
        .files(token)
        .map_err(|s| (s, "Relace skončila.".into()))?;
    let link = FileLink::parse(&query.url).map_err(|e| (StatusCode::BAD_REQUEST, e.into()))?;
    let name = crate::upload::sanitize_filename(&link.name);
    let (reply, received) = oneshot::channel();
    sender.try_send(Download { link, reply }).map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "Probíhá příliš mnoho přenosů. Zkus to za chvíli.".into(),
        )
    })?;
    let result = tokio::time::timeout(Duration::from_secs(20), received)
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                "TS server neodpověděl. Zkontroluj TCP port souborového přenosu (obvykle 30033)."
                    .into(),
            )
        })?
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Relace skončila.".into()))?
        .map_err(|e| (StatusCode::FORBIDDEN, e))?;
    let limit = std::env::var("TS_FILE_MAX_MB")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(200)
        .saturating_mul(1024 * 1024);
    if result.size > limit {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "Soubor překračuje povolenou velikost pro stahování z TS.".into(),
        ));
    }
    app.uploads
        .sessions
        .check(token, false)
        .map_err(|s| (s, "Relace skončila.".into()))?;
    let mut response_headers = crate::upload::attachment_headers(&name);
    response_headers.insert("content-length", result.size.to_string().parse().unwrap());
    response_headers.insert("cache-control", "no-store".parse().unwrap());
    // Pevný celkový deadline, omezení na serverem oznámenou velikost, nejvýš 64 KiB v paměti.
    let stream = futures_util::stream::try_unfold(
        (result.stream, result.size, Instant::now()),
        |(mut tcp, remaining, started)| async move {
            if remaining == 0 {
                return Ok(None);
            }
            let timeout = Duration::from_secs(180)
                .checked_sub(started.elapsed())
                .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "Vypršel čas přenosu"))?;
            let mut buffer = vec![0u8; remaining.min(65536) as usize];
            let count = tokio::time::timeout(timeout, tcp.read(&mut buffer))
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Vypršel čas přenosu"))??;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Neúplný soubor",
                ));
            }
            buffer.truncate(count);
            Ok(Some((buffer, (tcp, remaining - count as u64, started))))
        },
    );
    Ok((response_headers, Body::from_stream(stream)).into_response())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uid_is_authoritative_but_address_is_required_without_uid() {
        let mut link =
            FileLink::parse("ts3file://example.org?channel=1&path=/&filename=x.zip&serverUID=abc")
                .unwrap();
        assert!(same_server(&link, "127.0.0.1:9987", "abc"));
        assert!(!same_server(&link, "example.org:9987", "different"));
        link.uid = None;
        assert!(!same_server(&link, "127.0.0.1:9987", "abc"));
        assert!(same_server(&link, "example.org:9987", "abc"));
    }
    #[test]
    fn ts3_client_url_and_traversal() {
        let base = "ts3file://example.org?port=9987&serverUID=abc%3D&channel=12&path=%2Ffotky%2F&filename=%C5%BElu%C5%A5ou%C4%8Dk%C3%BD.zip&isDir=0&size=111303&fileDateTime=0";
        let parsed = FileLink::parse(base).unwrap();
        assert_eq!(parsed.path, "/fotky/žluťoučký.zip");
        assert_eq!(parsed.server, "example.org:9987");
        assert_eq!(parsed.uid.as_deref(), Some("abc="));
        for path in ["/../x", "/a/../../", "/./", "/a\\b", "/%00"] {
            assert!(FileLink::parse(&base.replace("%2Ffotky%2F", path)).is_err());
        }
        for name in ["..", "a/b", "a%5Cb", "%0D%0A"] {
            assert!(
                FileLink::parse(&base.replace("%C5%BElu%C5%A5ou%C4%8Dk%C3%BD.zip", name)).is_err()
            );
        }
        assert!(FileLink::parse(&format!("{base}&channel=1")).is_err());
    }
}
