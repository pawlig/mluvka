use audiopus::{Application, Bitrate, Channels, SampleRate, coder::Encoder};
use axum::extract::ws::{Message, WebSocket};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, watch};
use tokio::time::{MissedTickBehavior, interval, timeout};
use tsclientlib::{
    ClientId, Connection, DisconnectOptions, Identity, MessageTarget, OutCommandExt, StreamItem,
    audio::AudioHandler, events::Event,
};
use tsproto_packets::packets::{
    AudioData, CodecType, Direction, Flags, OutAudio, OutCommand, PacketType,
};

#[derive(Clone, Default, Deserialize, serde::Serialize)]
struct AudioOptions {
    #[serde(default)]
    codec: String,
    #[serde(default)]
    version: u8,
    #[serde(default)]
    quality: String,
}
impl AudioOptions {
    fn opus(&self) -> bool {
        self.codec == "opus" && self.version == 1
    }
    fn bitrate(&self) -> i32 {
        if self.quality == "economy" {
            48000
        } else {
            96000
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Control {
    Connect {
        nickname: String,
        server: String,
        #[serde(default)]
        password: String,
        #[serde(default)]
        channel: String,
        #[serde(default)]
        channel_password: String,
        identity: Option<String>,
        #[serde(default)]
        microphone: bool,
        #[serde(default)]
        deafen: bool,
        #[serde(default)]
        audio: AudioOptions,
    },
    Move {
        channel: u64,
        #[serde(default)]
        password: String,
    },
    Chat {
        target: String,
        client: Option<u16>,
        text: String,
    },
    Mute {
        microphone: bool,
        deafen: bool,
    },
    Peer {
        uid: String,
        volume: f32,
        muted: bool,
    },
    Ping,
    Disconnect,
    Music {
        action: String,
        arg: Option<String>,
    },
}

pub fn normalize_server(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty()
        || input.len() > 255
        || input.contains(['/', '@', '?', '#', '\\'])
        || input.chars().any(char::is_whitespace)
    {
        return Err("Zadejte adresu serveru jako host nebo host:port.".into());
    }
    if let Ok(addr) = input.parse::<SocketAddr>() {
        if addr.port() == 0 {
            return Err("Neplatný port serveru.".into());
        }
        return Ok(addr.to_string());
    }
    let (host, port) = match input.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => {
            (h, p.parse::<u16>().map_err(|_| "Neplatný port serveru.")?)
        }
        None => (input, 9987),
        _ => return Err("IPv6 adresu zadejte ve tvaru [adresa]:port.".into()),
    };
    if host.is_empty()
        || port == 0
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err("Neplatná adresa serveru.".into());
    }
    Ok(format!(
        "{}:{port}",
        host.trim_end_matches('.').to_ascii_lowercase()
    ))
}

// Pouze writer čeká na TCP. Relace nikdy nečeká na plný socket a dál polluje TS.
struct Socket {
    input: futures_util::stream::SplitStream<WebSocket>,
    control: mpsc::Sender<Message>,
    audio: mpsc::Sender<(Message, Instant)>,
    pending_mute: Option<(bool, bool)>,
    ban_seconds: Option<u64>,
    cooldown_until: Option<Instant>,
    ts_departed: bool,
}
impl Socket {
    async fn recv(&mut self) -> Option<Result<Message, axum::Error>> {
        self.input.next().await
    }
}
async fn send(ws: &mut Socket, msg: Message) -> Result<(), String> {
    if matches!(msg, Message::Binary(_)) {
        match ws.audio.try_send((msg, Instant::now())) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                tracing::debug!(ws_audio_drop = true, "Plná fronta zvuku");
                Ok(())
            }
            Err(_) => Err("Webové spojení bylo uzavřeno.".into()),
        }
    } else {
        // Řízení se nikdy tiše nezahodí: zahlcenou relaci čistě odpojíme.
        ws.control
            .try_send(msg)
            .map_err(|_| "Prohlížeč přestal přijímat data.".into())
    }
}
async fn json_send(ws: &mut Socket, value: Value) -> Result<(), String> {
    send(ws, Message::Text(value.to_string().into())).await
}
fn command(name: &str, args: &[(&str, String)]) -> OutCommand {
    let mut cmd = OutCommand::new(Direction::C2S, Flags::empty(), PacketType::Command, name);
    for (key, value) in args {
        cmd.write_arg(key, value);
    }
    cmd
}
fn password_hash(password: &str) -> String {
    if password.is_empty() {
        String::new()
    } else {
        STANDARD.encode(Sha1::digest(password.as_bytes()))
    }
}
fn identity_text(id: &Identity) -> String {
    // ASN.1 import knihovny zkrátí skalár začínající nulou a odmítne ho.
    // Pevný 32B formát importuje přímo; klíč, counter i veřejné UID zůstávají stejné.
    format!("{}V{}", id.counter(), STANDARD.encode(id.key().to_short()))
}

// Vnější text serveru se nevrací ani neloguje: může obsahovat osobní údaje.
fn ts_variant(err: &tsclientlib::Error) -> (&'static str, Option<tsproto_types::errors::Error>) {
    use tsclientlib::Error as E;
    match err {
        E::ConnectFailed { errors, .. } => errors
            .iter()
            .map(ts_variant)
            .max_by_key(|(name, code)| {
                if code.is_some() {
                    3
                } else if *name == "IdentityLevel" {
                    2
                } else {
                    1
                }
            })
            .unwrap_or(("ConnectFailed", None)),
        E::ConnectTs(code) => ("ConnectTs", Some(*code)),
        E::ConnectBanned { .. } => (
            "ConnectBanned",
            Some(tsproto_types::errors::Error::ConnectFailedBanned),
        ),
        E::ConnectFloodPrevention => (
            "ConnectFloodPrevention",
            Some(tsproto_types::errors::Error::BanFlooding),
        ),
        E::CommandError(e) => ("CommandError", Some(e.error)),
        E::IdentityLevel(_) => ("IdentityLevel", None),
        E::ResolveAddress(_) => ("ResolveAddress", None),
        E::Io(_) => ("Io", None),
        E::InitserverTimeout => ("InitserverTimeout", None),
        E::Connect(tsproto::client::Error::TsProto(tsproto::Error::Timeout(_))) => {
            ("ConnectTimeout", None)
        }
        E::Connect(_) => ("Connect", None),
        E::ConnectionFailed(tsproto::client::Error::TsProto(tsproto::Error::Timeout(_))) => {
            ("ConnectionTimeout", None)
        }
        E::ConnectionFailed(_) => ("ConnectionFailed", None),
        E::ConnectionGone => ("ConnectionGone", None),
        E::InitserverWait(tsproto::client::Error::TsProto(tsproto::Error::Timeout(_))) => {
            ("InitserverTimeout", None)
        }
        E::InitserverWait(_) => ("InitserverWait", None),
        _ => ("Other", None),
    }
}
fn ts_error(err: &tsclientlib::Error) -> String {
    use tsproto_types::errors::Error as T;
    let (variant, code) = ts_variant(err);
    if variant == "ConnectFloodPrevention" {
        tracing::warn!(
            code = "0x0d03",
            wire_code = "0x0d01",
            "Handshake flood prevention — normalizovaný flood kód"
        );
    }
    // Debug pouze nad číselným enumem, nikdy nad chybou s adresou/serverovým textem.
    if let Some(code) = code {
        tracing::warn!(ts_error = %format!("{variant}({code:?})"), code = %format!("0x{:04x}", code as u32), "Chyba TS");
    } else {
        tracing::warn!(ts_error = variant, "Chyba TS");
    }
    match code {
        Some(T::ConnectFailedBanned) => "Server vás odmítl: zákaz přístupu (ban). Dobu vypršení server neuvedl.",
        Some(T::ClientIsFlooding) => "Server omezuje počet zpráv. Odesílám pomaleji.",
        Some(T::BanFlooding) => "Server dočasně zablokoval připojení z této IP za příliš mnoho pokusů. Zkuste to za pár minut.",
        Some(T::ChannelInvalidPassword) => "Nesprávné heslo kanálu.",
        Some(T::ServerInvalidPassword | T::ClientInvalidPassword) => "Nesprávné heslo serveru.",
        Some(T::ClientNicknameInuse) => "Přezdívka je obsazená nebo není povolená.",
        Some(T::ServerMaxclientsReached | T::ChannelMaxclientsReached) => "Server je plný.",
        Some(T::PermissionsClientInsufficient | T::Permissions | T::PermissionsInsufficientGroupPower | T::PermissionsInsufficientPermissionPower) => "Server tuto akci nepovolil. Chybí oprávnění.",
        _ if matches!(variant, "InitserverTimeout" | "ConnectTimeout" | "ConnectionTimeout") => "Vypršel čas připojení. Ověřte adresu a odchozí UDP.",
        _ if matches!(variant, "ResolveAddress" | "Io" | "Connect" | "ConnectFailed") => "Adresu serveru nelze přeložit nebo není dostupná.",
        _ if matches!(variant, "ConnectionFailed" | "ConnectionGone") => "TS server ukončil spojení.",
        _ => "Server odmítl požadavek. Zkuste akci znovu.",
    }.into()
}
fn ts_departure(reason: Option<tsclientlib::Reason>) -> &'static str {
    use tsclientlib::Reason;
    match reason {
        Some(Reason::KickServer) => "Byli jste vyhozeni ze serveru.",
        Some(Reason::KickServerBan) => "Server vás odmítl: zákaz přístupu (ban).",
        _ => "TS server ukončil spojení.",
    }
}
const BROWSER_TIMEOUT: Duration = Duration::from_secs(45);
fn is_nickname_error(err: &tsclientlib::Error) -> bool {
    ts_variant(err).1 == Some(tsproto_types::errors::Error::ClientNicknameInuse)
}
fn retryable_address(err: &tsclientlib::Error) -> bool {
    ts_variant(err).1.is_none() && ts_variant(err).0 != "IdentityLevel"
}
// Cílová IP a port sjednotí DNS aliasy i všechny relace kontejneru.
fn env_positive(name: &str, fallback: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(fallback)
}
fn env_nonzero(name: &str, fallback: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(fallback)
}
struct AttemptBudget {
    next_connect: Option<Instant>,
    connects: VecDeque<Instant>,
    connects_blocked_until: Option<Instant>,
    commands_after: Option<Instant>,
    tokens: f64,
    updated: Instant,
    counts: HashMap<String, u64>,
}
impl Default for AttemptBudget {
    fn default() -> Self {
        Self {
            next_connect: None,
            connects: VecDeque::new(),
            connects_blocked_until: None,
            commands_after: None,
            tokens: 20.0,
            updated: Instant::now(),
            counts: HashMap::new(),
        }
    }
}
impl AttemptBudget {
    fn pause(&self, now: Instant) -> Option<Duration> {
        self.connects_blocked_until
            .filter(|until| *until > now)
            .map(|until| until.duration_since(now))
    }
    fn reserve(
        &mut self,
        now: Instant,
        spacing: Duration,
        window: Duration,
        burst: usize,
    ) -> Option<Duration> {
        if let Some(delay) = self.pause(now) {
            return Some(delay);
        }
        // Samotný rozestup 3 s na výchozím TS3 nestačí: čtvrtý/pátý handshake
        // z jedné IP dostává 0x0d01 bez záznamu v banlistu. Omezíme i delší dávku.
        while self
            .connects
            .front()
            .is_some_and(|first| now.duration_since(*first) >= window)
        {
            self.connects.pop_front();
        }
        if self.connects.len() >= burst {
            return Some(window.saturating_sub(now.duration_since(self.connects[0])));
        }
        if let Some(next) = self.next_connect.filter(|next| *next > now) {
            return Some(next.duration_since(now));
        }
        self.next_connect = Some(now + spacing);
        self.connects.push_back(now);
        None
    }
    fn command(&mut self, now: Instant, rate: f64) -> bool {
        if self.commands_after.is_some_and(|until| until > now) {
            return false;
        }
        self.tokens = (self.tokens
            + now.saturating_duration_since(self.updated).as_secs_f64() * rate)
            .min(20.0);
        self.updated = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}
fn budgets() -> &'static Mutex<HashMap<SocketAddr, AttemptBudget>> {
    static ALL: OnceLock<Mutex<HashMap<SocketAddr, AttemptBudget>>> = OnceLock::new();
    ALL.get_or_init(Mutex::default)
}
const FLOOD_MESSAGE: &str =
    "Server dočasně zablokoval připojení z této IP za příliš mnoho pokusů. Zkuste to za pár minut.";
fn block_flood(addr: SocketAddr) {
    let mut all = budgets().lock().expect("budgets");
    let budget = all.entry(addr).or_default();
    budget.connects_blocked_until = Some(Instant::now() + Duration::from_secs(120));
    tracing::warn!(server = %addr, pause_seconds = 120, "Antiflood pauza nových připojení; živé TS relace pokračují");
}
// Příkazový flood je odmítnutý příkaz, nikoli ztracené TS spojení.
fn is_flood(error: &tsclientlib::Error) -> bool {
    ts_variant(error).0 != "CommandError"
        && ts_variant(error).1 == Some(tsproto_types::errors::Error::BanFlooding)
}
fn is_command_flood(error: &tsclientlib::Error) -> bool {
    ts_variant(error).0 == "CommandError"
        && ts_variant(error).1.is_some_and(|code| {
            matches!(
                code,
                tsproto_types::errors::Error::ClientIsFlooding
                    | tsproto_types::errors::Error::BanFlooding
            )
        })
}
fn slow_commands(addr: SocketAddr, code: u32) {
    let mut all = budgets().lock().expect("budgets");
    let budget = all.entry(addr).or_default();
    budget.commands_after = Some(Instant::now() + Duration::from_secs(5));
    budget.tokens = 0.0;
    budget.updated = budget.commands_after.expect("command pause");
    tracing::warn!(server = %addr, code = %format!("0x{code:04x}"), pause_seconds = 5, "Zpomalení fronty příkazů, TS relace pokračuje");
}
// TS účtuje body za příkaz, nikoli jen počet paketů. Konzervativní lokální
// rozpočet ponechá rezervu pod výchozími 150 body a rozpouští dlouhé série chatu.
struct CommandPoints {
    available: f64,
    updated: Instant,
}
impl CommandPoints {
    fn new(now: Instant) -> Self {
        Self {
            available: 60.0,
            updated: now,
        }
    }
    fn cost(name: &str) -> f64 {
        match name {
            "channelsubscribeall" | "clientmove" => 25.0,
            "clientupdate" => 5.0,
            _ => 10.0,
        }
    }
    fn ready(&mut self, now: Instant, name: &str) -> bool {
        self.available = (self.available
            + now.saturating_duration_since(self.updated).as_secs_f64() * 5.0)
            .min(60.0);
        self.updated = now;
        self.available >= Self::cost(name)
    }
    fn spend(&mut self, name: &str) {
        self.available -= Self::cost(name);
    }
}
fn flood_deadline(addr: SocketAddr) -> Option<Instant> {
    budgets()
        .lock()
        .expect("budgets")
        .get(&addr)
        .and_then(|budget| budget.connects_blocked_until)
}
fn connections_paused(addr: SocketAddr) -> bool {
    budgets()
        .lock()
        .expect("budgets")
        .get(&addr)
        .is_some_and(|budget| budget.pause(Instant::now()).is_some())
}
fn command_slot(addr: SocketAddr, name: &str, client: ClientId, session_count: u64) -> bool {
    let mut all = budgets().lock().expect("budgets");
    let budget = all.entry(addr).or_default();
    if !budget.command(Instant::now(), env_positive("TS_CMD_RATE", 5.0)) {
        return false;
    }
    let count = budget.counts.entry(name.to_owned()).or_default();
    *count += 1;
    tracing::debug!(server = %addr, client = client.0, ts_command = name, count = *count, session_count, "Odeslaný TS příkaz");
    true
}
async fn connection_budget(addr: SocketAddr) {
    loop {
        let window = Duration::from_millis(u64::from(env_nonzero("TS_CONNECT_WINDOW_MS", 45000)));
        let delay = {
            let mut all = budgets().lock().expect("budgets");
            let now = Instant::now();
            all.retain(|_, budget| {
                budget.pause(now).is_some()
                    || budget
                        .connects
                        .back()
                        .is_some_and(|last| now.saturating_duration_since(*last) < window)
                    || budget.next_connect.is_some_and(|next| {
                        now.saturating_duration_since(next) < Duration::from_secs(120)
                    })
                    || now.saturating_duration_since(budget.updated) < Duration::from_secs(120)
            });
            all.entry(addr).or_default().reserve(
                now,
                Duration::from_secs_f64(env_positive("TS_CONNECT_INTERVAL_MS", 3000.0) / 1000.0),
                window,
                env_nonzero("TS_CONNECT_BURST", 3) as usize,
            )
        };
        match delay {
            Some(delay) => tokio::time::sleep(delay).await,
            None => return,
        }
    }
}
async fn queue_notice(ws: &mut Socket, addr: SocketAddr) -> Result<(), String> {
    let remaining = flood_deadline(addr)
        .map(|until| {
            until
                .saturating_duration_since(Instant::now())
                .as_secs_f64()
                .ceil() as u64
        })
        .unwrap_or(0);
    let message = if remaining > 0 {
        format!(
            "Čekám na volné místo, server omezuje počet připojení… Pauza nových připojení {:02}:{:02}.",
            remaining / 60,
            remaining % 60
        )
    } else {
        "Čekám na volné místo, server omezuje počet připojení…".to_owned()
    };
    json_send(
        ws,
        json!({"type":"notice", "code":"connect_queue", "message":message}),
    )
    .await
}
async fn wait_budget(ws: &mut Socket, addr: SocketAddr) -> Result<(), String> {
    let budget = connection_budget(addr);
    tokio::pin!(budget);
    let mut heartbeat = interval(Duration::from_secs(1));
    let notice_after = tokio::time::sleep(Duration::from_millis(300));
    tokio::pin!(notice_after);
    let mut show_notice = false;
    loop {
        tokio::select! {
            biased;
            _ = &mut budget => return Ok(()),
            _ = &mut notice_after, if !show_notice => {
                show_notice = true;
                queue_notice(ws, addr).await?;
            },
            _ = heartbeat.tick() => {
                json_send(ws, json!({"type":"pong"})).await?;
                if show_notice { queue_notice(ws, addr).await?; }
            },
            msg = ws.recv() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Err("Webové spojení bylo uzavřeno.".into()),
                Some(Ok(Message::Text(text))) if text.len() > 16 * 1024 => return Err("Příliš velká řídicí zpráva.".into()),
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<Control>(&text) {
                Ok(Control::Disconnect) => return Err("Webové spojení bylo uzavřeno.".into()),
                Ok(Control::Mute { microphone, deafen }) => ws.pending_mute = Some((microphone, deafen)),
                _ => {},
            },
                _ => {},
            }
        }
    }
}

async fn next_event(con: &mut Connection) -> Option<Result<StreamItem, tsclientlib::Error>> {
    con.events().next().await
}

fn error_code(message: &str) -> &'static str {
    let text = message.to_lowercase();
    if text.contains("příliš mnoho pokusů") {
        "flood"
    } else if text.contains("heslo") {
        "bad_password"
    } else if text.contains("ban") {
        "banned"
    } else if text.contains("seznamu povolených") || text.contains("oprávnění") {
        "not_allowed"
    } else if text.contains("přezdívka musí") || text.contains("zpráva musí") {
        "invalid"
    } else if text.contains("přezdívka") {
        "nickname"
    } else if text.contains("vyhozeni") {
        "kicked"
    } else if text.contains("plný") {
        "full"
    } else if text.contains("ukončil") {
        "server_closed"
    } else if text.contains("vypršel")
        || text.contains("včas")
        || text.contains("přestal odpovídat")
    {
        "timeout"
    } else if text.contains("neplatn")
        || text.contains("zadejte")
        || text.contains("očekávám")
        || text.contains("nejprve")
        || text.contains("identita není")
    {
        "invalid"
    } else if text.contains("adresu serveru nelze")
        || text.contains("nedostupný")
        || text.contains("přerušilo")
    {
        "unreachable"
    } else {
        "request_failed"
    }
}
fn retryable_code(code: &str) -> bool {
    !matches!(
        code,
        "bad_password" | "banned" | "not_allowed" | "invalid" | "kicked"
    )
}
fn error_message(message: &str, fatal: bool) -> Value {
    let code = error_code(message);
    let field = match code {
        _ if message.contains("Přezdívka") => "nickname",
        "bad_password" if message.contains("kanálu") => "channel_password",
        "bad_password" => "password",
        "nickname" => "nickname",
        _ => "server",
    };
    json!({"type":"error", "code":code, "message":message, "fatal":fatal, "retryable":fatal && retryable_code(code), "field":field})
}
// Nové spojení stejné identity převezme relaci teprve po UDP odpojení staré.
// Weak záznamy neuchovávají klíče ani relace po odpojení.
struct IdentitySlot {
    gate: tokio::sync::Mutex<()>,
    changed: tokio::sync::watch::Sender<u64>,
}
fn identity_slot(key: String) -> Arc<IdentitySlot> {
    static SLOTS: OnceLock<Mutex<HashMap<String, Weak<IdentitySlot>>>> = OnceLock::new();
    let mut slots = SLOTS
        .get_or_init(Mutex::default)
        .lock()
        .expect("identity slots");
    slots.retain(|_, slot| slot.strong_count() > 0);
    if let Some(slot) = slots.get(&key).and_then(Weak::upgrade) {
        return slot;
    }
    let slot = Arc::new(IdentitySlot {
        gate: tokio::sync::Mutex::new(()),
        changed: tokio::sync::watch::channel(0).0,
    });
    slots.insert(key, Arc::downgrade(&slot));
    slot
}

pub async fn run(
    ws: WebSocket,
    allowed: &[String],
    mut shutdown: watch::Receiver<bool>,
    uploads: Arc<crate::upload::Sessions>,
    shares: Arc<crate::signal::Registry>,
) {
    let (mut sink, input) = ws.split();
    let (control, mut controls) = mpsc::channel(256);
    let (audio, mut frames) = mpsc::channel::<(Message, Instant)>(16);
    let mut writer = tokio::spawn(async move {
        let mut produced = None;
        let mut written = None;
        let mut producer_gaps = Vec::with_capacity(1600);
        let mut writer_gaps = Vec::with_capacity(1600);
        let mut queue_max_ms = 0.0_f64;
        let mut bytes = 0_usize;
        let mut frames_count = 0_usize;
        let mut report_at = Instant::now();
        loop {
            let (msg, queued_at) = tokio::select! { biased;
                msg = controls.recv() => match msg { Some(msg) => (msg, None), None => break },
                msg = frames.recv() => match msg { Some((msg, at)) => (msg, Some(at)), None => break },
            };
            if let Some(at) = queued_at {
                if let Some(previous) = produced {
                    producer_gaps.push(at.duration_since(previous).as_secs_f64() * 1000.0);
                }
                produced = Some(at);
                queue_max_ms = queue_max_ms.max(at.elapsed().as_secs_f64() * 1000.0);
                if let Message::Binary(ref data) = msg {
                    bytes += data.len();
                }
                frames_count += 1;
            }
            // SinkExt::send flushuje každý rámec; žádná 200ms dávka v aplikaci.
            if !matches!(
                timeout(Duration::from_secs(2), sink.send(msg)).await,
                Ok(Ok(()))
            ) {
                break;
            }
            if queued_at.is_some() {
                let now = Instant::now();
                if let Some(previous) = written {
                    writer_gaps.push(now.duration_since(previous).as_secs_f64() * 1000.0);
                }
                written = Some(now);
            }
            if frames_count > 0 && report_at.elapsed() >= Duration::from_secs(30) {
                producer_gaps.sort_by(f64::total_cmp);
                writer_gaps.sort_by(f64::total_cmp);
                let summary = |values: &[f64]| {
                    let limits = [25.0, 50.0, 100.0, 200.0, 300.0, 400.0, f64::INFINITY];
                    json!({"p95Ms": values.get(values.len().saturating_mul(95) / 100).copied().unwrap_or(0.0),
                        "maxMs": values.last().copied().unwrap_or(0.0),
                        "histogram": limits.iter().enumerate().map(|(i, upper)| values.iter().filter(|v| **v <= *upper && (i == 0 || **v > limits[i - 1])).count()).collect::<Vec<_>>()})
                };
                // Jen agregovaná čísla, žádná adresa, text TS ani identita.
                let timing = json!({"producer":summary(&producer_gaps), "writer":summary(&writer_gaps),
                    "queueMaxMs":queue_max_ms, "averageFrameBytes":bytes / frames_count});
                tracing::info!(audio_timing = %timing, "Časování zvuku za 30 s");
                producer_gaps.clear();
                writer_gaps.clear();
                bytes = 0;
                frames_count = 0;
                queue_max_ms = 0.0;
                report_at = Instant::now();
            }
        }
        let _ = timeout(Duration::from_millis(100), sink.close()).await;
    });
    let mut ws = Socket {
        input,
        control,
        audio,
        pending_mute: None,
        ban_seconds: None,
        cooldown_until: None,
        ts_departed: false,
    };
    if !*shutdown.borrow()
        && let Err(message) = session(&mut ws, allowed, &mut shutdown, &uploads, &shares).await
    {
        tracing::warn!(session_end = error_code(&message), "Relace končí chybou");
        let mut error = error_message(&message, true);
        if let Some(seconds) = ws.ban_seconds {
            error["ban_seconds"] = seconds.into();
        }
        if let Some(until) = ws.cooldown_until {
            error["cooldown_seconds"] = (until
                .saturating_duration_since(Instant::now())
                .as_secs_f64()
                .ceil() as u64)
                .into();
        }
        let _ = json_send(&mut ws, error).await;
    }
    drop(ws);
    if timeout(Duration::from_millis(300), &mut writer)
        .await
        .is_err()
    {
        writer.abort();
    }
}

async fn session(
    ws: &mut Socket,
    allowed: &[String],
    shutdown: &mut watch::Receiver<bool>,
    uploads: &Arc<crate::upload::Sessions>,
    shares: &Arc<crate::signal::Registry>,
) -> Result<(), String> {
    let first = timeout(Duration::from_secs(15), ws.recv())
        .await
        .map_err(|_| "Vypršel čas pro zadání připojení.")?
        .ok_or("Spojení bylo uzavřeno.")?
        .map_err(|_| "Webové spojení bylo přerušeno.")?;
    let Message::Text(first) = first else {
        return Err("Nejprve pošlete údaje připojení.".into());
    };
    if first.len() > 16 * 1024 {
        return Err("Příliš velká řídicí zpráva.".into());
    }
    let Control::Connect {
        nickname,
        server,
        password,
        channel,
        channel_password,
        identity,
        microphone,
        deafen,
        audio,
    } = serde_json::from_str(&first).map_err(|_| "Neplatné údaje připojení.")?
    else {
        return Err("Očekávám údaje připojení.".into());
    };
    let server = normalize_server(&server)?;
    if !allowed.is_empty() && !allowed.contains(&server) {
        return Err("Tento server není v seznamu povolených serverů.".into());
    }
    if nickname.trim().is_empty() || nickname.len() > 64 {
        return Err("Přezdívka musí mít 1–64 bajtů.".into());
    }
    // Cílová IP je po ověření hostu pevná. Knihovna už nesmí následovat TS přesměrování/SRV.
    let addresses: Vec<_> = timeout(Duration::from_secs(5), tokio::net::lookup_host(&server))
        .await
        .map_err(|_| {
            tracing::warn!(ts_error = "ResolveTimeout", "Chyba připojení");
            "Vypršel čas hledání serveru."
        })?
        .map_err(|_| {
            tracing::warn!(ts_error = "ResolveAddress", "Chyba připojení");
            "Adresu serveru nelze přeložit nebo není dostupná."
        })?
        .collect();
    let mut address_index = 0;
    let mut addr = *addresses
        .first()
        .ok_or("Server nemá dostupnou IP adresu.")?;
    let id = tokio::task::spawn_blocking(move || {
        let mut id = match identity {
            Some(s) => Identity::new_from_str(s.trim()).map_err(|_| "Identita není platná.")?,
            None => Identity::create(),
        };
        if id.level() < 8 {
            id.upgrade_level(8);
        }
        Ok::<_, String>(id)
    })
    .await
    .map_err(|_| "Identitu se nepodařilo vytvořit.")??;
    json_send(ws, json!({"type":"identity", "identity":identity_text(&id), "uid":id.key().to_pub().get_uid().to_string(), "level":id.level()})).await?;
    let slot = identity_slot(format!("{addr}/{}", id.key().to_pub().get_uid()));
    slot.changed
        .send_modify(|version| *version = version.wrapping_add(1));
    let mut superseded = slot.changed.subscribe();
    let _guard = slot.gate.lock().await;
    if superseded.has_changed().unwrap_or(true) {
        json_send(ws, json!({"type":"notice", "code":"session_replaced", "message":"Spojení převzalo jiné okno Mluvky."})).await?;
        return Ok(());
    }
    tokio::select! {
        result = wait_budget(ws, addr) => result?,
        _ = superseded.changed() => {
            json_send(ws, json!({"type":"notice", "code":"session_replaced", "message":"Spojení převzalo jiné okno Mluvky."})).await?;
            return Ok(());
        },
        _ = shutdown.changed() => {
            let _ = json_send(ws, json!({"type":"notice", "code":"server_restart", "message":"Mluvka se aktualizuje — připojuji znovu…"})).await;
            return Ok(());
        }
    }
    if *shutdown.borrow() {
        return Ok(());
    }
    let (connect_mic, connect_deaf) = ws.pending_mute.unwrap_or((microphone, deafen));
    let mut con = Connection::build(addr)
        .identity(id.clone())
        .name(nickname.clone())
        .password(password.clone())
        .channel(channel.clone())
        .channel_password(channel_password.clone())
        .input_muted(connect_mic)
        .output_muted(connect_deaf)
        .connect()
        .map_err(|e| ts_error(&e))?;
    let result = tokio::select! {
      _ = shutdown.changed() => {
          let _ = json_send(ws, json!({"type":"notice", "code":"server_restart", "message":"Mluvka se aktualizuje — připojuji znovu…"})).await;
          Ok(())
      },
      _ = superseded.changed() => {
          let _ = json_send(ws, json!({"type":"notice", "code":"session_replaced", "message":"Spojení převzalo jiné okno Mluvky."})).await;
          Ok(())
      },
      result = async {
    let mut renamed = false;
    let mut initial_mute = ws.pending_mute.take();
    let mut deadline = Instant::now() + Duration::from_secs(25);
    let mut flood_check = interval(Duration::from_millis(100));
    loop {
        let event = tokio::select! {
            event = next_event(&mut con) => event,
            _ = flood_check.tick() => {
                if connections_paused(addr) {
                    ws.cooldown_until = flood_deadline(addr);
                    return Err(FLOOD_MESSAGE.into());
                }
                continue;
            },
            msg = ws.recv() => {
                match msg {
                    Some(Ok(Message::Ping(p))) => send(ws, Message::Pong(p)).await?,
                    Some(Ok(Message::Text(s))) if s.len() > 16 * 1024 => return Err("Příliš velká řídicí zpráva.".into()),
                    Some(Ok(Message::Text(s))) => match serde_json::from_str::<Control>(&s) {
                        Ok(Control::Mute { microphone, deafen }) => initial_mute = Some((microphone, deafen)),
                        Ok(Control::Disconnect) => return Ok(()),
                        Ok(Control::Ping) => json_send(ws, json!({"type":"pong"})).await?,
                        _ => {},
                    },
                    // Během navazování nemá audio ani ostatní řízení příjemce.
                    Some(Ok(Message::Binary(_) | Message::Pong(_))) => {},
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Err(_)) => return Err("Webové spojení bylo přerušeno.".into()),
                }
                continue;
            }
            _ = tokio::time::sleep_until(deadline.into()) => { tracing::warn!(ts_error = "ConnectTimeout", "Chyba připojení"); return Err("Vypršel čas připojení. Server neodpovídá.".into()); },
        };
        match event {
            Some(Ok(StreamItem::BookEvents(_))) => {
                // Initserver nejprve vytvoří prázdnou TS knihu. Registr místností
                // smí vzniknout až po notifycliententerview vlastního klienta.
                let book = con.get_state().map_err(|e| ts_error(&e))?;
                if book.clients.contains_key(&book.own_client) { break; }
            },
            Some(Ok(StreamItem::IdentityLevelIncreased)) => {
                // Knihovna vytvořila nový handshake future, ale ještě jej nepollovala.
                // I zvýšení identity proto spotřebuje společný limit připojení.
                wait_budget(ws, addr).await?;
                deadline = Instant::now() + Duration::from_secs(25);
                if let Some(id) = con.get_options().get_identity() {
                    json_send(ws, json!({"type":"identity", "identity":identity_text(id),"uid":id.key().to_pub().get_uid().to_string(),"level":id.level()})).await?;
                }
            }
            Some(Err(e)) => {
                if is_flood(&e) { block_flood(addr); ws.cooldown_until = flood_deadline(addr); }
                if let tsclientlib::Error::ConnectBanned { retry_after_seconds } = &e { ws.ban_seconds = Some(*retry_after_seconds); }
                let _ = ts_error(&e);
                if !renamed && is_nickname_error(&e) {
                    renamed = true;
                    let name = format!("{}1", nickname.chars().take(29).collect::<String>());
                    json_send(ws, json!({"type":"notice", "message":format!("Přezdívka je obsazená, zkouším {name}.")})).await?;
                    wait_budget(ws, addr).await?;
                    deadline = Instant::now() + Duration::from_secs(25);
                    con = Connection::build(addr)
                        .identity(id.clone())
                        .name(name)
                        .password(password.clone())
                        .channel(channel.clone())
                        .channel_password(channel_password.clone())
                        .input_muted(initial_mute.unwrap_or((connect_mic, connect_deaf)).0)
                        .output_muted(initial_mute.unwrap_or((connect_mic, connect_deaf)).1)
                        .connect()
                        .map_err(|e| ts_error(&e))?;
                } else if retryable_address(&e) && address_index + 1 < addresses.len() {
                    address_index += 1;
                    addr = addresses[address_index];
                    wait_budget(ws, addr).await?;
                    deadline = Instant::now() + Duration::from_secs(25);
                    con = Connection::build(addr).identity(id.clone()).name(nickname.clone()).password(password.clone()).channel(channel.clone()).channel_password(channel_password.clone()).input_muted(initial_mute.unwrap_or((connect_mic, connect_deaf)).0).output_muted(initial_mute.unwrap_or((connect_mic, connect_deaf)).1).connect().map_err(|e| ts_error(&e))?;
                } else { return Err(if ws.ban_seconds.is_some() { "Server vás odmítl: zákaz přístupu (ban).".into() } else { ts_error(&e) }); }
            }
            None => return Err("Server ukončil spojení.".into()),
            _ => {}
        }
    }
    let initial_mute = ws.pending_mute.take().or(initial_mute);
    let upload_lease = uploads.grant();
    let (file_sender, mut files) = mpsc::channel(4);
    uploads.bind_files(&upload_lease.token, file_sender);
    let mut file_context = FileContext { server: server.clone(), passwords: HashMap::new(), files: &mut files };
    if !channel_password.is_empty() {
        let book = con.get_state().map_err(|e| ts_error(&e))?;
        if let Some(client) = book.clients.get(&book.own_client) { file_context.passwords.insert(client.channel.0, channel_password.clone()); }
    }
    json_send(ws, json!({"type":"upload_token", "token":upload_lease.token})).await?;
    let sharing = shares.join(server.clone(), &snapshot(&con)?, ws.control.clone());
    json_send(ws, json!({"type":"share_session","v":1,"session":sharing.id,"token":sharing.token})).await?;
    sharing.publish();
    connected(ws, &mut con, addr, initial_mute, renamed.then_some(nickname.as_str()), &audio, &mut file_context, &sharing).await
      } => result,
    };
    // I při chybě WS je nutné dokončit UDP odpojení a zahodit identitu v paměti.
    // Po odmítnutí handshake je spojovací future knihovny již dokončená;
    // její další poll by panikoval. UDP disconnect potřebuje jen navázaná TS relace.
    // Server už potvrdil odchod (kick/ban/ukončení); další disconnect by
    // jen čekal na neexistujícího klienta a oddaloval oznámení chyby prohlížeči.
    if !ws.ts_departed
        && let Ok(book) = con.get_state()
    {
        let client = book.own_client;
        // Ruční odpojení musí přečkat i krátké zpomalení příkazů. Nová relace
        // stejného UID stále čeká na gate; při shutdown platí společný 3s deadline.
        let disconnect_deadline = Duration::from_secs(if *shutdown.borrow() { 2 } else { 10 });
        let _ = timeout(disconnect_deadline, async {
            loop {
                if command_slot(addr, "clientdisconnect", client, 1) {
                    break;
                }
                // Čekání na token nesmí zastavit pollování TS.
                tokio::select! {
                    event = next_event(&mut con) => if !matches!(event, Some(Ok(_))) { return; },
                    _ = tokio::time::sleep(Duration::from_millis(20)) => {},
                }
            }
            if con
                .disconnect(
                    DisconnectOptions::new()
                        .reason(tsclientlib::Reason::Clientdisconnect)
                        .message(if *shutdown.borrow() {
                            "Mluvka se aktualizuje"
                        } else {
                            "Odpojení z Mluvky"
                        }),
                )
                .is_ok()
            {
                while con.events().next().await.is_some() {}
            }
        })
        .await;
    }
    result
}

fn snapshot(con: &Connection) -> Result<Value, String> {
    let book = con.get_state().map_err(|e| ts_error(&e))?;
    let channels: Vec<_> = book.channels.values().map(|c| json!({"id":c.id.0,"parent":c.parent.0,"order":c.order.0,"name":c.name,"password":c.has_password.unwrap_or(false),"topic":c.topic})).collect();
    let clients: Vec<_> = book.clients.values().map(|c| json!({"id":c.id.0,"channel":c.channel.0,"uid":c.uid.as_ref().map(|u| u.as_ref().to_string()),"name":c.name,"microphone":c.input_muted || !c.input_hardware_enabled,"deafen":c.output_muted || !c.output_hardware_enabled,"away":c.away_message.is_some()})).collect();
    Ok(
        json!({"type":"state", "name":book.server.name,"server_uid":book.server.public_key.get_uid(),"self":book.own_client.0,"channels":channels,"clients":clients}),
    )
}

struct FileContext<'a> {
    server: String,
    passwords: HashMap<u64, String>,
    files: &'a mut mpsc::Receiver<crate::ts_file::Download>,
}

#[allow(clippy::too_many_arguments)]
async fn connected(
    ws: &mut Socket,
    con: &mut Connection,
    addr: SocketAddr,
    initial_mute: Option<(bool, bool)>,
    restore_nickname: Option<&str>,
    options: &AudioOptions,
    file_context: &mut FileContext<'_>,
    sharing: &crate::signal::Lease,
) -> Result<(), String> {
    let book = con.get_state().map_err(|e| ts_error(&e))?;
    // První BookEvents mohou obsahovat jen server. Vlastní klient přijde později.
    let server_mute = book
        .clients
        .get(&book.own_client)
        .map(|own| (own.input_muted, own.output_muted))
        .unwrap_or_else(|| {
            (
                con.get_options().get_input_muted(),
                con.get_options().get_output_muted(),
            )
        });
    let (mut microphone, mut deafen) = initial_mute.unwrap_or(server_mute);
    let mut commands = VecDeque::new();
    if (microphone, deafen) != server_mute {
        commands.push_back(command(
            "clientupdate",
            &[
                ("client_input_muted", u8::from(microphone).to_string()),
                ("client_output_muted", u8::from(deafen).to_string()),
            ],
        ));
    }
    commands.push_back(command("channelsubscribeall", &[]));
    json_send(ws, json!({"type":"hello", "audio":{"codec":if options.opus() {"opus"} else {"pcm"}, "version":1, "quality": options.quality}})).await?;
    json_send(ws, sharing.snapshot(snapshot(con)?)).await?;
    let mut audio = AudioHandler::<ClientId>::new();
    let encoder = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)
        .map_err(|_| "Opus enkodér nelze spustit.")?;
    let mut down_encoder = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Audio)
        .map_err(|_| "Opus enkodér nelze spustit.")?;
    down_encoder
        .set_bitrate(Bitrate::BitsPerSecond(options.bitrate()))
        .map_err(|_| "Chyba nastavení Opus.")?;
    down_encoder
        .set_complexity(10)
        .map_err(|_| "Chyba nastavení Opus.")?;
    down_encoder
        .set_vbr(true)
        .map_err(|_| "Chyba nastavení Opus.")?;
    down_encoder
        .set_inband_fec(true)
        .map_err(|_| "Chyba nastavení Opus.")?;
    down_encoder
        .set_packet_loss_perc(10)
        .map_err(|_| "Chyba nastavení Opus.")?;
    let mut down_sequence = 0u32;
    let mut peers: HashMap<String, (f32, bool)> = HashMap::new();
    let mut talking: HashMap<ClientId, Instant> = HashMap::new();
    let mut was_sending = false;
    let mut last_up = Instant::now();
    let mut tick = interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(MissedTickBehavior::Burst);
    let mut heartbeat = interval(Duration::from_secs(10));
    let mut last_pong = Instant::now();
    let own_client = con.get_state().map_err(|e| ts_error(&e))?.own_client;
    let mut restore_nickname = restore_nickname;
    let mut nickname_attempts = 0u32;
    let mut nickname_after = Instant::now() + Duration::from_secs(10);
    let mut pending: HashMap<_, (Instant, OutCommand)> = HashMap::new();
    let mut points = CommandPoints::new(Instant::now());
    let mut slowing = false;
    let mut mute_unconfirmed = false;
    let mut command_counts = HashMap::new();
    let mut downloads: HashMap<
        tsclientlib::FiletransferHandle,
        tokio::sync::oneshot::Sender<Result<tsclientlib::FileDownloadResult, String>>,
    > = HashMap::new();
    let mut rate_start = Instant::now();
    let (mut control_count, mut audio_count, mut signal_count) = (0, 0, 0);
    let mut music = crate::music_bot::MusicBot::default();
    if let Some(ev) = music.update(con.get_state().map_err(|e| ts_error(&e))?) { json_send(ws, ev).await?; }
    loop {
        tokio::select! {
            incoming = ws.recv() => {
                let msg = match incoming { Some(Ok(msg)) => msg, _ => return Ok(()) };
                if rate_start.elapsed() >= Duration::from_secs(1) { rate_start = Instant::now(); control_count = 0; audio_count = 0; signal_count = 0; }
                match msg {
                    Message::Text(s) => {
                        let value: Value = serde_json::from_str(&s).map_err(|_| "Neplatná řídicí zpráva.")?;
                        if crate::signal::is_signal(value["type"].as_str().unwrap_or("")) {
                            signal_count = u32::saturating_add(signal_count, 1);
                            if signal_count > 120 {
                                // Odpověď jen při prvním překročení; zahlcení nesmí shodit TS ani zaplnit frontu chybami.
                                if signal_count == 121 {
                                    json_send(ws, json!({"type":"share_error","v":1,"message":"Signalizaci posíláte příliš rychle.","request":value["type"]})).await?;
                                }
                                continue;
                            }
                            if let Err(message) = sharing.handle(&value, s.len()) {
                                json_send(ws, json!({"type":"share_error","v":1,"message":message,"request":value["type"]})).await?;
                            }
                            continue;
                        }
                        if s.len() > 16 * 1024 { return Err("Příliš velká řídicí zpráva.".into()); }
                        control_count += 1;
                        if control_count > 40 { return Err("Příliš mnoho řídicích zpráv.".into()); }
                        let ctrl: Control = serde_json::from_str(&s).map_err(|_| "Neplatná řídicí zpráva.")?;
                        let cmd = match ctrl {
                            Control::Move { channel, password } => {
                                let book = con.get_state().map_err(|e| ts_error(&e))?;
                                if book.clients.get(&book.own_client).is_some_and(|c| c.channel.0 == channel) { continue; }
                                if !password.is_empty() { file_context.passwords.insert(channel, password.clone()); }
                                audio.reset(); Some(command("clientmove", &[("clid", con.get_state().map_err(|e| ts_error(&e))?.own_client.0.to_string()),("cid",channel.to_string()),("cpw",password_hash(&password))])) },
                            Control::Chat { target, client, text } => {
                                if text.trim().is_empty() || text.len() > 4000 { json_send(ws,error_message("Zpráva musí mít 1–4000 bajtů.", false)).await?; continue; }
                                let target = match target.as_str() { "server" => MessageTarget::Server, "channel" => MessageTarget::Channel, "private" if client.is_some() => MessageTarget::Client(ClientId(client.unwrap())), _ => return Err("Neplatný cíl zprávy.".into()) };
                                if let MessageTarget::Client(id) = &target { music.manual_sent(id.0, &text, Instant::now()); }
                                Some(con.get_state().map_err(|e| ts_error(&e))?.send_message(target, &text))
                            },
                            Control::Mute { microphone: mic, deafen: deaf } => {
                                microphone = mic; deafen = deaf;
                                if deaf { audio.reset(); }
                                // Sloučit čekající změny mikrofonu, neposílat mezistavy bez změny.
                                commands.retain(|cmd| !cmd.0.content().starts_with(b"clientupdate client_input_muted="));
                                let book = con.get_state().map_err(|e| ts_error(&e))?;
                                if book.clients.get(&book.own_client).map(|client| (client.input_muted, client.output_muted)).unwrap_or_else(|| (con.get_options().get_input_muted(), con.get_options().get_output_muted())) == (mic, deaf) && !mute_unconfirmed { continue; }
                                Some(command("clientupdate", &[("client_input_muted",u8::from(mic).to_string()),("client_output_muted",u8::from(deaf).to_string())]))
                            },
                            Control::Peer { uid, volume, muted } => {
                                if !volume.is_finite() || !(0.0..=2.0).contains(&volume) || uid.len() > 128 || peers.len() >= 2048 && !peers.contains_key(&uid) { return Err("Neplatná hlasitost nebo identita klienta.".into()); }
                                if muted && let Ok(book) = con.get_state() { for c in book.clients.values().filter(|c| c.uid.as_ref().map(|u| u.as_ref().to_string()).as_deref() == Some(&uid)) { audio.get_mut_queues().remove(&c.id); } }
                                peers.insert(uid,(volume,muted)); None
                            },
                            Control::Ping => { last_pong = Instant::now(); json_send(ws, json!({"type":"pong"})).await?; None },
                            Control::Disconnect => return Ok(()),
                            Control::Music { action, arg } => { if let Some(ev) = music.request(&action, arg.as_deref()) { json_send(ws, ev).await?; } None },
                            Control::Connect { .. } => return Err("Spojení už je připojené.".into()),
                        };
                        if let Some(cmd) = cmd {
                            if commands.len() >= 128 { json_send(ws,error_message("Fronta požadavků je plná. Zkuste to později.", false)).await?; }
                            else { commands.push_back(cmd); }
                        }
                    },
                    Message::Binary(data) => {
                        audio_count += 1;
                        if audio_count > 100 || !(data.len() == 1921 && data[0] == 1 || options.opus() && (4..=1276).contains(&data.len()) && data[0] == 3) { return Err("Neplatný nebo příliš rychlý audio proud.".into()); }
                        if !microphone && !deafen && con.can_send_audio() {
                            if data[0] == 3 {
                                // Ověříme 20 ms mono paket, ale nedekódujeme ani nepřekódujeme.
                                let packet = (&data[1..]).try_into().map_err(|_| "Neplatný Opus paket.")?;
                                if audiopus::packet::nb_samples(packet, SampleRate::Hz48000).map_err(|_| "Neplatný Opus paket.")? != 960 || audiopus::packet::nb_channels((&data[1..]).try_into().map_err(|_| "Neplatný Opus paket.")?).map_err(|_| "Neplatný Opus paket.")? != Channels::Mono { return Err("Neplatný Opus rámec.".into()); }
                                con.send_audio(OutAudio::new(&AudioData::C2S { id:0, codec:CodecType::OpusVoice, data:&data[1..] })).map_err(|e| ts_error(&e))?;
                            } else {
                            let samples: Vec<i16> = data[1..].as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes([b[0],b[1]])).collect();
                            let mut encoded = [0u8; 4000];
                            let len = encoder.encode(&samples, &mut encoded).map_err(|_| "Chyba kódování hlasu.")?;
                            con.send_audio(OutAudio::new(&AudioData::C2S { id:0,codec:CodecType::OpusVoice,data:&encoded[..len] })).map_err(|e| ts_error(&e))?;
                            }
                            was_sending = true; last_up = Instant::now();
                        }
                    },
                    Message::Ping(p) => send(ws, Message::Pong(p)).await?,
                    Message::Pong(_) => last_pong = Instant::now(),
                    Message::Close(_) => return Ok(()),
                }
            },
            Some(request) = file_context.files.recv() => {
                downloads.retain(|_, reply| !reply.is_closed());
                if downloads.len() >= 4 { let _ = request.reply.send(Err("Probíhá příliš mnoho přenosů.".into())); continue; }
                match crate::ts_file::start(con, &request.link, &file_context.server, &file_context.passwords) {
                    Ok(handle) => { downloads.insert(handle, request.reply); },
                    Err(error) => { let _ = request.reply.send(Err(error)); },
                }
            },
            event = next_event(con) => {
                match event {
                    Some(Ok(StreamItem::BookEvents(events))) => {
                        for e in events {
                            if let Event::PropertyRemoved { id: tsclientlib::events::PropertyId::Client(id), ref extra, .. } = e
                                && id == own_client {
                                ws.ts_departed = true;
                                return Err(ts_departure(extra.reason).into());
                            }
                            if let Event::Message { target, invoker, message } = e {
                                let (kind, client) = match target { MessageTarget::Server => ("server",None), MessageTarget::Channel => ("channel",None), MessageTarget::Client(id) => ("private",Some(id.0)), MessageTarget::Poke(id) => ("poke",Some(id.0)) };
                                let peer = if kind != "private" { None } else if invoker.id == own_client { client } else { Some(invoker.id.0) };
                                let handled = music.on_message(kind == "channel", peer, invoker.id, own_client, &message, Instant::now());
                                if let Some(ev) = handled.event { json_send(ws, ev).await?; }
                                if !handled.show_in_chat { continue; }
                                json_send(ws,json!({"type":if kind == "poke" {"poke"} else {"chat"},"target":kind,"client":client,"from":invoker.id.0,"uid":invoker.uid.map(|u| u.to_string()),"name":invoker.name,"text":message})).await?;
                            }
                        }
                        json_send(ws, sharing.snapshot(snapshot(con)?)).await?;
                        if let Some(ev) = music.update(con.get_state().map_err(|e| ts_error(&e))?) { json_send(ws, ev).await?; }
                    },
                    Some(Ok(StreamItem::FileDownload(handle, result))) => { if let Some(reply) = downloads.remove(&handle) { let _ = reply.send(Ok(result)); } },
                    Some(Ok(StreamItem::FiletransferFailed(handle, error))) => { if let Some(reply) = downloads.remove(&handle) { let _ = reply.send(Err(crate::ts_file::transfer_error(&error))); } },
                    Some(Ok(StreamItem::Audio(packet))) => {
                        let from = match packet.data().data() { AudioData::S2C { from,.. } => ClientId(*from), _ => continue };
                        let now = Instant::now();
                        if talking.insert(from,now).is_none() { json_send(ws,json!({"type":"talking","client":from.0,"active":true})).await?; }
                        let pref = con.get_state().ok().and_then(|b| b.clients.get(&from)).and_then(|c| c.uid.as_ref()).and_then(|u| peers.get(&u.to_string())).copied().unwrap_or((1.0,false));
                        if !deafen && !pref.1 { let _ = audio.handle_packet(from,packet); if let Some(q) = audio.get_mut_queues().get_mut(&from) { q.volume = pref.0; } }
                    },
                    Some(Ok(StreamItem::MessageResult(handle, result))) => {
                        let sent = pending.remove(&handle);
                        // Knihovna mění lokální mute optimisticky už při odeslání.
                        // Odmítnutí proto nesmí deduplikací zrušit potřebný retry.
                        if sent.as_ref().is_some_and(|(_, cmd)| cmd.0.content().starts_with(b"clientupdate client_input_muted=")) {
                            mute_unconfirmed = result.is_err();
                        }
                        if let Err(e) = result {
                            let error = tsclientlib::Error::CommandError(e);
                            if is_command_flood(&error) {
                                let _ = ts_error(&error);
                                slow_commands(addr, ts_variant(&error).1.expect("command flood") as u32);
                                points.available = 0.0;
                                if let Some((_, cmd)) = sent { commands.push_front(cmd); }
                                slowing = true;
                                json_send(ws,json!({"type":"notice", "code":"command_slow", "message":"Odesílám pomaleji, server omezuje počet zpráv"})).await?;
                            } else { json_send(ws,error_message(&ts_error(&error), false)).await?; }
                        } else if slowing && commands.is_empty() {
                            slowing = false;
                            json_send(ws,json!({"type":"notice", "code":"command_ready", "message":"Zprávy byly odeslány."})).await?;
                        }
                    },
                    Some(Ok(StreamItem::DisconnectedTemporarily(reason))) => {
                        tracing::warn!(ts_event = match reason { tsclientlib::TemporaryDisconnectReason::Timeout(_) => "Timeout", tsclientlib::TemporaryDisconnectReason::Serverstop => "Serverstop" }, "TS spojení přerušeno");
                        return Err(match reason { tsclientlib::TemporaryDisconnectReason::Serverstop => "TS server ukončil spojení.", _ => "Spojení s TS serverem se přerušilo. Připojte se znovu." }.into());
                    },
                    Some(Err(e)) => {
                        if is_command_flood(&e) {
                            let _ = ts_error(&e);
                            slow_commands(addr, ts_variant(&e).1.expect("command flood") as u32);
                            points.available = 0.0;
                            // TS někdy chybu vrátí bez return_code. Díky jednomu
                            // čekajícímu potvrzení víme, který příkaz opakovat.
                            if let Some((_, (_, cmd))) = pending.drain().next() {
                                mute_unconfirmed |= cmd.0.content().starts_with(b"clientupdate client_input_muted=");
                                commands.push_front(cmd);
                            }
                            slowing = true;
                            json_send(ws,json!({"type":"notice", "code":"command_slow", "message":"Odesílám pomaleji, server omezuje počet zpráv"})).await?;
                        } else {
                            if is_flood(&e) { block_flood(addr); ws.cooldown_until = flood_deadline(addr); }
                            return Err(ts_error(&e));
                        }
                    },
                    None => return Err("TS server ukončil spojení.".into()),
                    _ => {}
                }
            },
            scheduled = tick.tick() => {
                if pending.is_empty() && let Some(cmd) = commands.front() {
                    let name = String::from_utf8_lossy(cmd.0.content()).split(' ').next().unwrap_or("unknown").to_owned();
                    let count = command_counts.get(&name).copied().unwrap_or(0) + 1;
                    if points.ready(Instant::now(), &name) && command_slot(addr, &name, own_client, count) {
                        points.spend(&name);
                        command_counts.insert(name, count);
                        let cmd = commands.pop_front().expect("queued command");
                        let retry = OutCommand(cmd.0.clone());
                        let handle = cmd.send_with_result(con).map_err(|e| ts_error(&e))?;
                        pending.insert(handle, (Instant::now(), retry));
                    }
                }
                let lateness = scheduled.elapsed();
                if lateness > Duration::from_millis(80) {
                    tracing::debug!(tick_delay_ms = lateness.as_millis(), "Zpožděný takt zvuku");
                }
                // Native WS pong běží i bez JS stránky; delší síťové ticho tolerujeme 45 s.
                if last_pong.elapsed() >= BROWSER_TIMEOUT { return Err("Prohlížeč přestal odpovídat.".into()); }
                if was_sending && (last_up.elapsed() > Duration::from_millis(100) || microphone || deafen) {
                    let _ = con.send_audio(OutAudio::new(&AudioData::C2S { id:0,codec:CodecType::OpusVoice,data:&[] })); was_sending = false;
                }
                let stopped: Vec<_> = talking.iter().filter(|(_,t)| t.elapsed() > Duration::from_millis(300)).map(|(id,_)| *id).collect();
                for id in stopped { talking.remove(&id); json_send(ws,json!({"type":"talking","client":id.0,"active":false})).await?; }
                for (id,q) in audio.get_mut_queues() {
                    let pref = con.get_state().ok().and_then(|b| b.clients.get(id)).and_then(|c| c.uid.as_ref()).and_then(|u| peers.get(&u.to_string())).copied().unwrap_or((1.0,false));
                    q.volume = if pref.1 {0.0} else {pref.0};
                }
                let mut stereo = [0.0f32;1920];
                if !deafen && con.can_receive_audio() { audio.fill_buffer(&mut stereo); }
                let mono: Vec<f32> = stereo.as_chunks::<2>().0.iter().map(|lr| soft_limit((lr[0]+lr[1])*0.5)).collect();
                let mut frame = Vec::with_capacity(1921);
                if options.opus() {
                    frame.push(4);
                    frame.extend_from_slice(&down_sequence.to_le_bytes());
                    down_sequence = down_sequence.wrapping_add(1);
                    let mut encoded = [0u8; 1275];
                    let len = down_encoder.encode_float(&mono, &mut encoded).map_err(|_| "Chyba kódování mixu.")?;
                    frame.extend_from_slice(&encoded[..len]);
                } else {
                    frame.push(2);
                    for sample in mono { frame.extend_from_slice(&((sample*32767.0) as i16).to_le_bytes()); }
                }
                send(ws,Message::Binary(frame.into())).await?;
                // Burst musí pustit writer mezi doháněnými rámci. Jinak plní
                // vlastní lokální frontu rychleji, než může proběhnout její čtenář.
                if lateness >= Duration::from_millis(20) { tokio::task::yield_now().await; }
                let (music_send, music_events) = music.tick(Instant::now());
                for ev in music_events { json_send(ws, ev).await?; }
                if let Some((bot, text)) = music_send {
                    // Přes stejnou frontu jako ostatní příkazy, aby platilo omezení rychlosti serveru.
                    let cmd = con.get_state().map_err(|e| ts_error(&e))?.send_message(MessageTarget::Client(bot), &text);
                    if commands.len() < 128 { commands.push_back(cmd); }
                }
                if pending.values().any(|(t, _)| t.elapsed() > Duration::from_secs(10)) { mute_unconfirmed |= pending.values().any(|(_, cmd)| cmd.0.content().starts_with(b"clientupdate client_input_muted=")); pending.clear(); json_send(ws,error_message("Server včas nepotvrdil požadavek.", false)).await?; }
            },
            _ = heartbeat.tick() => {
                if last_pong.elapsed() >= BROWSER_TIMEOUT { return Err("Prohlížeč přestal odpovídat.".into()); }
                send(ws,Message::Ping(Vec::new().into())).await?;
                json_send(ws,json!({"type":"pong"})).await?;
                if let Some(name) = restore_nickname {
                    let book = con.get_state().map_err(|e| ts_error(&e))?;
                    if book.clients.get(&book.own_client).is_some_and(|c| c.name == name) {
                        restore_nickname = None;
                    } else if nickname_attempts < 3 && Instant::now() >= nickname_after
                        && !book.clients.values().any(|c| c.name == name && c.id != book.own_client) {
                        commands.push_back(command("clientupdate", &[("client_nickname",name.to_owned())]));
                        nickname_attempts += 1;
                        nickname_after = Instant::now() + Duration::from_secs(10 * 2u64.pow(nickname_attempts));
                    }
                }
            }
        }
    }
}

fn soft_limit(x: f32) -> f32 {
    if x.abs() <= 0.8 {
        x
    } else {
        x.signum() * (0.8 + 0.2 * ((x.abs() - 0.8) / 0.2).tanh())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_roundtrip_preserves_leading_zero_key_and_uid() {
        for first in [0, 1] {
            let mut bytes = [0u8; 32];
            bytes[0] = first;
            bytes[31] = 1;
            let id = Identity::new(
                tsproto_types::crypto::EccKeyPrivP256::from_short(&bytes).unwrap(),
                42,
            );
            let restored = Identity::new_from_str(&identity_text(&id)).unwrap();
            assert_eq!(restored.counter(), id.counter());
            assert_eq!(
                restored.key().to_pub().get_uid(),
                id.key().to_pub().get_uid()
            );
            if first != 0 {
                let legacy = format!("{}V{}", id.counter(), id.key().to_ts());
                assert_eq!(
                    Identity::new_from_str(&legacy)
                        .unwrap()
                        .key()
                        .to_pub()
                        .get_uid(),
                    id.key().to_pub().get_uid()
                );
            }
        }
    }
    #[test]
    fn command_flood_does_not_disconnect_and_points_limit_bursts() {
        let err = tsclientlib::Error::CommandError(tsclientlib::CommandError {
            error: tsproto_types::errors::Error::ClientIsFlooding,
            missing_permission: None,
        });
        assert!(!is_flood(&err));
        assert!(is_command_flood(&err));
        assert_ne!(error_code(&ts_error(&err)), "flood");
        let now = Instant::now();
        let mut points = CommandPoints::new(now);
        for _ in 0..6 {
            assert!(points.ready(now, "sendtextmessage"));
            points.spend("sendtextmessage");
        }
        assert!(!points.ready(now, "sendtextmessage"));
        assert!(points.ready(now + Duration::from_secs(2), "sendtextmessage"));
    }
    #[test]
    fn backend_budget_and_flood_are_shared_and_bounded() {
        let now = Instant::now();
        let mut budget = AttemptBudget::default();
        let spacing = Duration::from_secs(3);
        let window = Duration::from_secs(45);
        assert!(budget.reserve(now, spacing, window, 3).is_none());
        assert_eq!(budget.reserve(now, spacing, window, 3), Some(spacing));
        assert!(budget.reserve(now + spacing, spacing, window, 3).is_none());
        assert!(
            budget
                .reserve(now + spacing * 2, spacing, window, 3)
                .is_none()
        );
        assert_eq!(
            budget.reserve(now + spacing * 3, spacing, window, 3),
            Some(Duration::from_secs(36))
        );
        assert!(
            budget
                .reserve(now + Duration::from_secs(45), spacing, window, 3)
                .is_none()
        );
        for _ in 0..20 {
            assert!(budget.command(now, 5.0));
        }
        assert!(!budget.command(now, 5.0));
        assert!(budget.command(now + Duration::from_millis(200), 5.0));
        budget.connects_blocked_until = Some(now + Duration::from_secs(150));
        assert_eq!(
            budget.reserve(now + Duration::from_secs(30), spacing, window, 3),
            Some(Duration::from_secs(120))
        );
        assert!(budget.command(now + Duration::from_secs(30), 5.0));
    }
    #[test]
    fn connection_window_and_burst_are_configurable() {
        let now = Instant::now();
        let mut budget = AttemptBudget::default();
        let spacing = Duration::from_millis(10);
        let window = Duration::from_secs(10);
        assert!(budget.reserve(now, spacing, window, 1).is_none());
        assert_eq!(
            budget.reserve(now + spacing, spacing, window, 1),
            Some(window - spacing)
        );
        assert!(budget.reserve(now + window, spacing, window, 1).is_none());
        let mut budget = AttemptBudget::default();
        for i in 0..5 {
            assert!(
                budget
                    .reserve(now + spacing * i, spacing, window, 5)
                    .is_none()
            );
        }
        assert!(
            budget
                .reserve(now + spacing * 5, spacing, window, 5)
                .is_some()
        );
    }
    #[test]
    fn connection_errors_do_not_inspect_addresses() {
        use tsclientlib::Error as E;
        use tsproto_types::errors::Error as T;
        let timeout = E::ConnectFailed {
            address: "ts.urban-ban.example".into(),
            errors: vec![E::InitserverTimeout],
        };
        assert_ne!(error_code(&ts_error(&timeout)), "banned");
        assert_eq!(
            error_code(&ts_error(&E::ConnectTs(T::ConnectFailedBanned))),
            "banned"
        );
        assert_eq!(
            error_code(&ts_error(&E::ConnectTs(T::BanFlooding))),
            "flood"
        );
        assert_eq!(
            error_code(&ts_error(&E::ConnectTs(T::ClientIsFlooding))),
            "request_failed"
        );
        let nested = E::ConnectFailed {
            address: "ban".into(),
            errors: vec![E::ConnectTs(T::BanFlooding)],
        };
        assert_eq!(error_code(&ts_error(&nested)), "flood");
        assert_eq!(error_code(&ts_error(&E::ConnectFloodPrevention)), "flood");
        assert!(is_flood(&E::ConnectFloodPrevention));
    }
    #[test]
    fn runtime_errors_and_kicks_have_specific_messages() {
        let command = tsclientlib::Error::CommandError(tsclientlib::CommandError {
            error: tsproto_types::errors::Error::ChannelInvalidId,
            missing_permission: None,
        });
        assert_eq!(error_code(&ts_error(&command)), "request_failed");
        assert!(ts_error(&command).starts_with("Server odmítl požadavek"));
        assert_eq!(
            error_code(ts_departure(Some(tsclientlib::Reason::KickServer))),
            "kicked"
        );
        assert_eq!(
            error_code(ts_departure(Some(tsclientlib::Reason::Serverstop))),
            "server_closed"
        );
        assert_eq!(
            error_code(&ts_error(&tsclientlib::Error::ConnectionGone)),
            "server_closed"
        );
        assert!(BROWSER_TIMEOUT >= Duration::from_secs(30));
    }
    #[test]
    fn limiter_is_continuous_and_preserves_quiet_audio() {
        assert_eq!(soft_limit(0.5), 0.5);
        assert!((soft_limit(0.800001) - 0.8).abs() < 0.00001);
        assert!(soft_limit(4.0) <= 1.0);
        assert_eq!(soft_limit(-0.9), -soft_limit(0.9));
    }
    #[test]
    fn machine_error_codes_cover_reconnect_policy() {
        for (message, code) in [
            ("Nesprávné heslo kanálu.", "bad_password"),
            ("Zákaz přístupu (ban).", "banned"),
            (
                "Tento server není v seznamu povolených serverů.",
                "not_allowed",
            ),
            ("Neplatné údaje připojení.", "invalid"),
            ("Přezdívka je obsazená.", "nickname"),
            ("Server je nedostupný.", "unreachable"),
            ("Vypršel čas připojení.", "timeout"),
            ("Byli jste vyhozeni ze serveru.", "kicked"),
            ("TS server ukončil spojení.", "server_closed"),
            ("Server je plný.", "full"),
        ] {
            assert_eq!(error_code(message), code);
            assert_eq!(
                error_message(message, true)["retryable"],
                !["bad_password", "banned", "not_allowed", "invalid", "kicked"].contains(&code)
            );
            assert_eq!(error_message(message, false)["retryable"], false);
        }
        assert_eq!(
            error_message("Byli jste vyhozeni ze serveru.", true)["code"],
            "kicked"
        );
        assert_eq!(
            error_message("Nesprávné heslo kanálu.", true)["field"],
            "channel_password"
        );
    }
    #[test]
    fn addresses_are_normalized_without_urls() {
        assert_eq!(normalize_server("Example.ORG").unwrap(), "example.org:9987");
        assert_eq!(
            normalize_server("localhost:9999").unwrap(),
            "localhost:9999"
        );
        for invalid in [
            "",
            "https://example.org",
            "host:0",
            "host:99999",
            "user@host",
            "host/path",
        ] {
            assert!(normalize_server(invalid).is_err());
        }
    }
}
