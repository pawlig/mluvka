//! Krátkodobá TURN REST autentizace, nikdy statické heslo v prohlížeči.
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::{
    env,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct Config {
    stun: Vec<String>,
    turn: Vec<String>,
    secret: String,
}
fn urls(key: &str, default: &str) -> Vec<String> {
    env::var(key)
        .unwrap_or_else(|_| default.into())
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
impl Config {
    pub fn from_env() -> Self {
        let config = Self {
            stun: urls("STUN_URLS", "stun:stun.l.google.com:19302"),
            turn: urls("TURN_URLS", ""),
            secret: env::var("TURN_SECRET").unwrap_or_default(),
        };
        assert!(
            config.turn.is_empty() || !config.secret.is_empty(),
            "TURN_URLS vyžaduje TURN_SECRET"
        );
        assert!(
            config
                .stun
                .iter()
                .all(|s| s.starts_with("stun:") || s.starts_with("stuns:")),
            "Neplatné STUN_URLS"
        );
        assert!(
            config
                .turn
                .iter()
                .all(|s| s.starts_with("turn:") || s.starts_with("turns:")),
            "Neplatné TURN_URLS"
        );
        config
    }
    fn response(&self, uid: &str, now: u64) -> Value {
        let mut servers = vec![];
        if !self.stun.is_empty() {
            servers.push(json!({"urls":self.stun}));
        }
        if !self.turn.is_empty() {
            let hash = STANDARD
                .encode(Sha1::digest(uid.as_bytes()))
                .replace(['+', '/', '='], "");
            let username = format!("{}:{hash}", now + 12 * 3600);
            let mut mac = Hmac::<Sha1>::new_from_slice(self.secret.as_bytes()).expect("HMAC key");
            mac.update(username.as_bytes());
            servers.push(json!({"urls":self.turn,"username":username,"credential":STANDARD.encode(mac.finalize().into_bytes())}));
        }
        json!({"iceServers":servers,"expiresAt":now + 12 * 3600})
    }
}
pub async fn get(
    State(app): State<crate::App>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let uid = app.shares.ice_uid(token)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Ok((
        [("cache-control", "no-store")],
        Json(app.ice.response(&uid, now)),
    )
        .into_response())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rest_credentials_match_known_hmac_and_expire_in_twelve_hours() {
        let config = Config {
            stun: vec![],
            turn: vec!["turn:example.org:3478?transport=udp".into()],
            secret: "test-key".into(),
        };
        let value = config.response("test-uid", 100);
        let server = &value["iceServers"][0];
        let username = server["username"].as_str().unwrap();
        assert!(username.starts_with("43300:"));
        let mut mac = Hmac::<Sha1>::new_from_slice(b"test-key").unwrap();
        mac.update(username.as_bytes());
        assert!(
            mac.verify_slice(
                &STANDARD
                    .decode(server["credential"].as_str().unwrap())
                    .unwrap()
            )
            .is_ok()
        );
        assert_eq!(value["expiresAt"], 43300);
        assert!(!value.to_string().contains("test-key"));
        let config = Config {
            turn: vec![],
            ..config
        };
        assert_eq!(config.response("uid", 100)["iceServers"], json!([]));
    }
}
