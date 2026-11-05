mod session;
mod upload;

use axum::{
    Router,
    extract::Request,
    extract::{State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    response::Response,
    routing::{get, post},
    serve::ListenerExt,
};
use std::{env, future::IntoFuture, sync::Arc};
use tokio::sync::{Semaphore, watch};
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

#[derive(Clone)]
struct App {
    uploads: upload::Uploads,
    slots: Arc<Semaphore>,
    allowed: Arc<Vec<String>>,
    shutdown: watch::Sender<bool>,
}

#[tokio::main]
async fn main() {
    // Závislosti nesmějí vypsat TS pakety s přihlašovacími údaji ani při RUST_LOG=trace.
    let filter = format!(
        "{},tsclientlib=off,tsproto=off,ts_bookkeeping=off,tsproto_packets=off",
        env::var("RUST_LOG").unwrap_or_else(|_| "mluvka=info".into())
    );
    tracing_subscriber::fmt().with_env_filter(filter).init();
    session::start_audio_clock_probe();
    let allowed = env::var("ALLOWED_SERVERS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(session::normalize_server)
        .collect::<Result<Vec<_>, _>>()
        .expect("Neplatné ALLOWED_SERVERS");
    let max = env::var("MAX_SESSIONS")
        .unwrap_or_else(|_| "20".into())
        .parse::<usize>()
        .expect("Neplatné MAX_SESSIONS");
    let (shutdown, _) = watch::channel(false);
    let slots = Arc::new(Semaphore::new(max));
    let uploads = upload::Uploads::from_env().await;
    uploads.start_cleanup();
    let state = App {
        uploads,
        slots: slots.clone(),
        allowed: Arc::new(allowed),
        shutdown: shutdown.clone(),
    };
    let dist = env::var("STATIC_DIR").unwrap_or_else(|_| "dist".into());
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/ws", get(upgrade))
        .route("/api/upload", post(upload::upload))
        .route("/img/{name}", get(upload::image))
        .fallback_service(ServeDir::new(dist))
        .layer(middleware::from_fn(static_headers))
        .layer(SetResponseHeaderLayer::if_not_present(
            axum::http::header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            axum::http::header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .with_state(state);
    let port = env::var("PORT")
        .unwrap_or_else(|_| "3000".into())
        .parse::<u16>()
        .expect("Neplatný PORT");
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port))
        .await
        .expect("Port nelze otevřít")
        .tap_io(|stream| {
            // Malé 20ms Opus pakety nesmějí čekat na Nagle / delayed ACK.
            if stream.set_nodelay(true).is_err() {
                tracing::warn!("TCP_NODELAY nelze zapnout");
            }
        });
    tracing::info!(port, "Mluvka naslouchá");
    let mut exiting = shutdown.subscribe();
    let signal = async move {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        shutdown.send_replace(true);
    };
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(signal)
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => {
            result.expect("HTTP server skončil chybou");
            if *exiting.borrow() {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(3), slots.acquire_many(max as u32)).await;
            }
        },
        _ = exiting.changed() => {
            // Stejný společný deadline pro HTTP i UDP; Upgrade úlohy nejsou součástí HTTP shutdown.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                let (_, result) = tokio::join!(slots.acquire_many(max as u32), &mut server);
                result.expect("HTTP server skončil chybou");
            }).await;
        }
    }
}

async fn upgrade(
    State(app): State<App>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if *app.shutdown.borrow() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    // Chrání před připojením cizího webu ke zdejšímu backendu. CLI bez Origin je povolené.
    if let Some(origin) = headers.get("origin").and_then(|h| h.to_str().ok()) {
        let host = headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if origin != format!("https://{host}") && origin != format!("http://{host}") {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    let Ok(permit) = app.slots.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    ws.max_message_size(16 * 1024)
        .max_frame_size(16 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            session::run(
                socket,
                &app.allowed,
                app.shutdown.subscribe(),
                app.uploads.sessions,
            )
            .await;
        })
        .into_response()
}

async fn static_headers(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    if matches!(
        path.as_str(),
        "/" | "/index.html" | "/sw.js" | "/audio-worklet.js"
    ) {
        headers.insert(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        );
    } else if path.starts_with("/assets/") {
        headers.insert(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    if path == "/manifest.webmanifest" {
        headers.insert(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_static("application/manifest+json"),
        );
    }
    response
}
