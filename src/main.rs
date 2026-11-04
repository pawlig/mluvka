mod session;

use axum::{
    Router,
    extract::{State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::get,
};
use std::{env, sync::Arc};
use tokio::sync::Semaphore;
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

#[derive(Clone)]
struct App {
    slots: Arc<Semaphore>,
    allowed: Arc<Vec<String>>,
}

#[tokio::main]
async fn main() {
    // Závislosti nesmějí vypsat TS pakety s přihlašovacími údaji ani při RUST_LOG=trace.
    let filter = format!(
        "{},tsclientlib=off,tsproto=off,ts_bookkeeping=off,tsproto_packets=off",
        env::var("RUST_LOG").unwrap_or_else(|_| "mluvka=info".into())
    );
    tracing_subscriber::fmt().with_env_filter(filter).init();
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
    let state = App {
        slots: Arc::new(Semaphore::new(max)),
        allowed: Arc::new(allowed),
    };
    let dist = env::var("STATIC_DIR").unwrap_or_else(|_| "dist".into());
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/ws", get(upgrade))
        .fallback_service(ServeDir::new(dist))
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
        .expect("Port nelze otevřít");
    tracing::info!(port, "Mluvka naslouchá");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("HTTP server skončil chybou");
}

async fn upgrade(
    State(app): State<App>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
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
            session::run(socket, &app.allowed).await;
        })
        .into_response()
}
