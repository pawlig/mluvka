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
    audio: mpsc::Sender<Message>,
    pending_mute: Option<(bool, bool)>,
}
impl Socket {
    async fn recv(&mut self) -> Option<Result<Message, axum::Error>> {
        self.input.next().await
    }
}
async fn send(ws: &mut Socket, msg: Message) -> Result<(), String> {
    if matches!(msg, Message::Binary(_)) {
        match ws.audio.try_send(msg) {
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
    // Debug pouze nad číselným enumem, nikdy nad chybou s adresou/serverovým textem.
    if let Some(code) = code {
        tracing::warn!(ts_error = %format!("{variant}({code:?})"), code = %format!("0x{:04x}", code as u32), "Chyba TS");
    } else {
        tracing::warn!(ts_error = variant, "Chyba TS");
    }
    match code {
        Some(T::ConnectFailedBanned) => "Server vás odmítl: zákaz přístupu (ban).",
        Some(T::BanFlooding | T::ClientIsFlooding) => "Server dočasně zablokoval připojení z této IP za příliš mnoho pokusů. Zkuste to za pár minut.",
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
// Sdílený limit podle cílové IP a portu (i při různých DNS aliasech).
#[derive(Default)]
struct AttemptBudget {
    times: VecDeque<Instant>,
    blocked_until: Option<Instant>,
}
impl AttemptBudget {
    fn reserve(&mut self, now: Instant) -> Option<Duration> {
        if let Some(until) = self.blocked_until
            && until > now
        {
            return Some(until.duration_since(now));
        }
        while self
            .times
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(30))
        {
            self.times.pop_front();
        }
        if self.times.len() >= 6 {
            return Some(Duration::from_secs(30).saturating_sub(now.duration_since(self.times[0])));
        }
        self.times.push_back(now);
        None
    }
}
fn budgets() -> &'static Mutex<HashMap<SocketAddr, AttemptBudget>> {
    static ALL: OnceLock<Mutex<HashMap<SocketAddr, AttemptBudget>>> = OnceLock::new();
    ALL.get_or_init(Mutex::default)
}
fn block_flood(addr: SocketAddr) {
    budgets()
        .lock()
        .expect("budgets")
        .entry(addr)
        .or_default()
        .blocked_until = Some(Instant::now() + Duration::from_secs(120));
}
async fn connection_budget(addr: SocketAddr) {
    loop {
        let delay = {
            let mut all = budgets().lock().expect("budgets");
            let now = Instant::now();
            all.retain(|_, b| {
                b.blocked_until.is_some_and(|t| t > now)
                    || b.times
                        .back()
                        .is_some_and(|t| now.duration_since(*t) < Duration::from_secs(30))
            });
            all.entry(addr).or_default().reserve(now)
        };
        match delay {
            Some(delay) => tokio::time::sleep(delay).await,
            None => return,
        }
    }
}
async fn wait_budget(ws: &mut Socket, addr: SocketAddr) -> Result<(), String> {
    let budget = connection_budget(addr);
    tokio::pin!(budget);
    let mut heartbeat = interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            _ = &mut budget => return Ok(()),
            _ = heartbeat.tick() => json_send(ws, json!({"type":"pong"})).await?,
            msg = ws.recv() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Err("Webové spojení bylo uzavřeno.".into()),
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
fn error_message(message: &str, fatal: bool) -> Value {
    let code = error_code(message);
    let field = match code {
        _ if message.contains("Přezdívka") => "nickname",
        "bad_password" if message.contains("kanálu") => "channel_password",
        "bad_password" => "password",
        "nickname" => "nickname",
        _ => "server",
    };
    json!({"type":"error", "code":code, "message":message, "fatal":fatal, "field":field})
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
) {
    let (mut sink, input) = ws.split();
    let (control, mut controls) = mpsc::channel(256);
    let (audio, mut frames) = mpsc::channel(16);
    let mut writer = tokio::spawn(async move {
        loop {
            let msg = tokio::select! { biased;
                msg = controls.recv() => match msg { Some(msg) => msg, None => break },
                msg = frames.recv() => match msg { Some(msg) => msg, None => break },
            };
            if !matches!(
                timeout(Duration::from_secs(2), sink.send(msg)).await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
        let _ = timeout(Duration::from_millis(100), sink.close()).await;
    });
    let mut ws = Socket {
        input,
        control,
        audio,
        pending_mute: None,
    };
    if !*shutdown.borrow()
        && let Err(message) = session(&mut ws, allowed, &mut shutdown, &uploads).await
    {
        tracing::warn!(session_end = error_code(&message), "Relace končí chybou");
        let _ = json_send(&mut ws, error_message(&message, true)).await;
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
) -> Result<(), String> {
    let first = timeout(Duration::from_secs(15), ws.recv())
        .await
        .map_err(|_| "Vypršel čas pro zadání připojení.")?
        .ok_or("Spojení bylo uzavřeno.")?
        .map_err(|_| "Webové spojení bylo přerušeno.")?;
    let Message::Text(first) = first else {
        return Err("Nejprve pošlete údaje připojení.".into());
    };
    let Control::Connect {
        nickname,
        server,
        password,
        channel,
        channel_password,
        identity,
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
    let slot = identity_slot(format!("{server}/{}", id.key().to_pub().get_uid()));
    slot.changed
        .send_modify(|version| *version = version.wrapping_add(1));
    let mut superseded = slot.changed.subscribe();
    let _guard = slot.gate.lock().await;
    if superseded.has_changed().unwrap_or(true) {
        return Ok(());
    }
    tokio::select! {
        result = wait_budget(ws, addr) => result?,
        _ = shutdown.changed() => {
            let _ = json_send(ws, json!({"type":"notice", "code":"server_restart", "message":"Mluvka se aktualizuje — připojuji znovu…"})).await;
            return Ok(());
        }
    }
    if *shutdown.borrow() {
        return Ok(());
    }
    let mut con = Connection::build(addr)
        .identity(id.clone())
        .name(nickname.clone())
        .password(password.clone())
        .channel(channel.clone())
        .channel_password(channel_password.clone())
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
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let event = tokio::select! {
            event = next_event(&mut con) => event,
            msg = ws.recv() => {
                match msg {
                    Some(Ok(Message::Ping(p))) => send(ws, Message::Pong(p)).await?,
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
            Some(Ok(StreamItem::BookEvents(_))) => break,
            Some(Ok(StreamItem::IdentityLevelIncreased)) => {
                // Knihovna vytvořila nový handshake future, ale ještě jej nepollovala.
                // I zvýšení identity proto spotřebuje společný limit připojení.
                wait_budget(ws, addr).await?;
                if let Some(id) = con.get_options().get_identity() {
                    json_send(ws, json!({"type":"identity", "identity":identity_text(id),"uid":id.key().to_pub().get_uid().to_string(),"level":id.level()})).await?;
                }
            }
            Some(Err(e)) => {
                if ts_variant(&e).1.is_some_and(|c| matches!(c, tsproto_types::errors::Error::BanFlooding | tsproto_types::errors::Error::ClientIsFlooding)) { block_flood(addr); }
                let _ = ts_error(&e);
                if !renamed && is_nickname_error(&e) {
                    renamed = true;
                    let name = format!("{}1", nickname.chars().take(29).collect::<String>());
                    json_send(ws, json!({"type":"notice", "message":format!("Přezdívka je obsazená, zkouším {name}.")})).await?;
                    wait_budget(ws, addr).await?;
                    con = Connection::build(addr)
                        .identity(id.clone())
                        .name(name)
                        .password(password.clone())
                        .channel(channel.clone())
                        .channel_password(channel_password.clone())
                        .connect()
                        .map_err(|e| ts_error(&e))?;
                } else if retryable_address(&e) && address_index + 1 < addresses.len() {
                    address_index += 1;
                    addr = addresses[address_index];
                    wait_budget(ws, addr).await?;
                    con = Connection::build(addr).identity(id.clone()).name(nickname.clone()).password(password.clone()).channel(channel.clone()).channel_password(channel_password.clone()).connect().map_err(|e| ts_error(&e))?;
                } else { return Err(ts_error(&e)); }
            }
            None => return Err("Server ukončil spojení.".into()),
            _ => {}
        }
    }
    let initial_mute = ws.pending_mute.take().or(initial_mute);
    let upload_lease = uploads.grant();
    json_send(ws, json!({"type":"upload_token", "token":upload_lease.token})).await?;
    connected(ws, &mut con, initial_mute, renamed.then_some(nickname.as_str()), &audio).await
      } => result,
    };
    // I při chybě WS je nutné dokončit UDP odpojení a zahodit identitu v paměti.
    // Po odmítnutí handshake je spojovací future knihovny již dokončená;
    // její další poll by panikoval. UDP disconnect potřebuje jen navázaná TS relace.
    if con.get_state().is_ok()
        && con
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
        let _ = timeout(Duration::from_secs(2), async {
            while con.events().next().await.is_some() {}
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
        json!({"type":"state", "name":book.server.name,"self":book.own_client.0,"channels":channels,"clients":clients}),
    )
}

async fn connected(
    ws: &mut Socket,
    con: &mut Connection,
    initial_mute: Option<(bool, bool)>,
    restore_nickname: Option<&str>,
    options: &AudioOptions,
) -> Result<(), String> {
    let (mut microphone, mut deafen) = initial_mute.unwrap_or_default();
    if initial_mute.is_some() {
        command(
            "clientupdate",
            &[
                ("client_input_muted", u8::from(microphone).to_string()),
                ("client_output_muted", u8::from(deafen).to_string()),
            ],
        )
        .send_with_result(con)
        .map_err(|e| ts_error(&e))?;
    }
    command("channelsubscribeall", &[])
        .send_with_result(con)
        .map_err(|e| ts_error(&e))?;
    json_send(ws, json!({"type":"hello", "audio":{"codec":if options.opus() {"opus"} else {"pcm"}, "version":1, "quality": options.quality}})).await?;
    json_send(ws, snapshot(con)?).await?;
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
    let mut pending = HashMap::new();
    let mut rate_start = Instant::now();
    let (mut control_count, mut audio_count) = (0, 0);
    let mut music = crate::music_bot::MusicBot::default();
    if let Some(ev) = music.update(con.get_state().map_err(|e| ts_error(&e))?) { json_send(ws, ev).await?; }
    loop {
        tokio::select! {
            incoming = ws.recv() => {
                let msg = match incoming { Some(Ok(msg)) => msg, _ => return Ok(()) };
                if rate_start.elapsed() >= Duration::from_secs(1) { rate_start = Instant::now(); control_count = 0; audio_count = 0; }
                match msg {
                    Message::Text(s) => {
                        control_count += 1;
                        if control_count > 40 { return Err("Příliš mnoho řídicích zpráv.".into()); }
                        let ctrl: Control = serde_json::from_str(&s).map_err(|_| "Neplatná řídicí zpráva.")?;
                        let cmd = match ctrl {
                            Control::Move { channel, password } => { audio.reset(); Some(command("clientmove", &[("clid", con.get_state().map_err(|e| ts_error(&e))?.own_client.0.to_string()),("cid",channel.to_string()),("cpw",password_hash(&password))])) },
                            Control::Chat { target, client, text } => {
                                if text.trim().is_empty() || text.len() > 4000 { json_send(ws,error_message("Zpráva musí mít 1–4000 bajtů.", false)).await?; continue; }
                                let target = match target.as_str() { "server" => MessageTarget::Server, "channel" => MessageTarget::Channel, "private" if client.is_some() => MessageTarget::Client(ClientId(client.unwrap())), _ => return Err("Neplatný cíl zprávy.".into()) };
                                if let MessageTarget::Client(id) = &target { music.manual_sent(id.0, &text, Instant::now()); }
                                Some(con.get_state().map_err(|e| ts_error(&e))?.send_message(target, &text))
                            },
                            Control::Mute { microphone: mic, deafen: deaf } => {
                                microphone = mic; deafen = deaf;
                                if deaf { audio.reset(); }
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
                        if let Some(cmd) = cmd { let handle = cmd.send_with_result(con).map_err(|e| ts_error(&e))?; pending.insert(handle, Instant::now()); }
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
            event = next_event(con) => {
                match event {
                    Some(Ok(StreamItem::BookEvents(events))) => {
                        for e in events {
                            if let Event::PropertyRemoved { id: tsclientlib::events::PropertyId::Client(id), ref extra, .. } = e
                                && id == own_client {
                                return Err(ts_departure(extra.reason).into());
                            }
                            if let Event::Message { target, invoker, message } = e {
                                let (kind, client) = match target { MessageTarget::Server => ("server",None), MessageTarget::Channel => ("channel",None), MessageTarget::Client(id) => ("private",Some(id.0)), MessageTarget::Poke(id) => ("poke",Some(id.0)) };
                                let peer = if kind != "private" { None } else if invoker.id == own_client { client } else { Some(invoker.id.0) };
                                let handled = music.on_message(kind == "channel", peer, invoker.id, own_client, &message, Instant::now());
                                if let Some(ev) = handled.event { json_send(ws, ev).await?; }
                                if !handled.show_in_chat { continue; }
                                json_send(ws,json!({"type":if kind == "poke" {"poke"} else {"chat"},"target":kind,"client":client,"from":invoker.id.0,"name":invoker.name,"text":message})).await?;
                            }
                        }
                        json_send(ws, snapshot(con)?).await?;
                        if let Some(ev) = music.update(con.get_state().map_err(|e| ts_error(&e))?) { json_send(ws, ev).await?; }
                    },
                    Some(Ok(StreamItem::Audio(packet))) => {
                        let from = match packet.data().data() { AudioData::S2C { from,.. } => ClientId(*from), _ => continue };
                        let now = Instant::now();
                        if talking.insert(from,now).is_none() { json_send(ws,json!({"type":"talking","client":from.0,"active":true})).await?; }
                        let pref = con.get_state().ok().and_then(|b| b.clients.get(&from)).and_then(|c| c.uid.as_ref()).and_then(|u| peers.get(&u.to_string())).copied().unwrap_or((1.0,false));
                        if !deafen && !pref.1 { let _ = audio.handle_packet(from,packet); if let Some(q) = audio.get_mut_queues().get_mut(&from) { q.volume = pref.0; } }
                    },
                    Some(Ok(StreamItem::MessageResult(handle, result))) => { pending.remove(&handle); if let Err(e) = result { json_send(ws,error_message(&ts_error(&tsclientlib::Error::CommandError(e)), false)).await?; } },
                    Some(Ok(StreamItem::DisconnectedTemporarily(reason))) => {
                        tracing::warn!(ts_event = match reason { tsclientlib::TemporaryDisconnectReason::Timeout(_) => "Timeout", tsclientlib::TemporaryDisconnectReason::Serverstop => "Serverstop" }, "TS spojení přerušeno");
                        return Err(match reason { tsclientlib::TemporaryDisconnectReason::Serverstop => "TS server ukončil spojení.", _ => "Spojení s TS serverem se přerušilo. Připojte se znovu." }.into());
                    },
                    Some(Err(e)) => return Err(ts_error(&e)),
                    None => return Err("TS server ukončil spojení.".into()),
                    _ => {}
                }
            },
            scheduled = tick.tick() => {
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
                    let cmd = con.get_state().map_err(|e| ts_error(&e))?.send_message(MessageTarget::Client(bot), &text);
                    let handle = cmd.send_with_result(con).map_err(|e| ts_error(&e))?;
                    pending.insert(handle, Instant::now());
                }
                if pending.values().any(|t| t.elapsed() > Duration::from_secs(10)) { pending.clear(); json_send(ws,error_message("Server včas nepotvrdil požadavek.", false)).await?; }
            },
            _ = heartbeat.tick() => {
                if last_pong.elapsed() >= BROWSER_TIMEOUT { return Err("Prohlížeč přestal odpovídat.".into()); }
                send(ws,Message::Ping(Vec::new().into())).await?;
                json_send(ws,json!({"type":"pong"})).await?;
                if let Some(name) = restore_nickname {
                    let book = con.get_state().map_err(|e| ts_error(&e))?;
                    if book.clients.get(&book.own_client).is_some_and(|c| c.name == name) {
                        restore_nickname = None;
                    } else if !book.clients.values().any(|c| c.name == name && c.id != book.own_client) {
                        let _ = command("clientupdate", &[("client_nickname",name.to_owned())]).send_with_result(con);
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
    fn backend_budget_and_flood_are_shared_and_bounded() {
        let now = Instant::now();
        let mut budget = AttemptBudget::default();
        for _ in 0..6 {
            assert!(budget.reserve(now).is_none());
        }
        assert_eq!(budget.reserve(now), Some(Duration::from_secs(30)));
        assert!(budget.reserve(now + Duration::from_secs(30)).is_none());
        budget.blocked_until = Some(now + Duration::from_secs(150));
        assert_eq!(
            budget.reserve(now + Duration::from_secs(30)),
            Some(Duration::from_secs(120))
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
            "flood"
        );
        let nested = E::ConnectFailed {
            address: "ban".into(),
            errors: vec![E::ConnectTs(T::BanFlooding)],
        };
        assert_eq!(error_code(&ts_error(&nested)), "flood");
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
        }
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
