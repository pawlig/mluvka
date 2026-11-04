use audiopus::{Application, Channels, SampleRate, coder::Encoder};
use axum::extract::ws::{Message, WebSocket};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};
use tokio::time::{MissedTickBehavior, interval, timeout};
use tsclientlib::{
    ClientId, Connection, DisconnectOptions, Identity, MessageTarget, OutCommandExt, StreamItem,
    audio::AudioHandler, events::Event,
};
use tsproto_packets::packets::{
    AudioData, CodecType, Direction, Flags, OutAudio, OutCommand, PacketType,
};

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

async fn send(ws: &mut WebSocket, msg: Message) -> Result<(), String> {
    timeout(Duration::from_secs(2), ws.send(msg))
        .await
        .map_err(|_| "Prohlížeč přestal přijímat data.")?
        .map_err(|_| "Webové spojení bylo uzavřeno.".into())
}
async fn json_send(ws: &mut WebSocket, value: Value) -> Result<(), String> {
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
    format!("{}V{}", id.counter(), id.key().to_ts())
}

// Vnější text serveru se nevrací ani neloguje: může obsahovat osobní údaje.
fn ts_error(err: &tsclientlib::Error) -> String {
    let text = format!("{err:?}").to_ascii_lowercase();
    if text.contains("password") && text.contains("channel") {
        "Nesprávné heslo kanálu."
    } else if text.contains("password") {
        "Nesprávné heslo serveru."
    } else if text.contains("banned") || text.contains("ban") {
        "Server vás odmítl kvůli zákazu přístupu (ban)."
    } else if text.contains("nickname") || text.contains("nameinuse") {
        "Přezdívka je obsazená nebo není povolená."
    } else if text.contains("kick") {
        "Byli jste vyhozeni ze serveru."
    } else if text.contains("full") || text.contains("maxclients") {
        "Server je plný."
    } else if text.contains("shutdown") || text.contains("serverstop") {
        "TS server ukončil spojení."
    } else if text.contains("timeout") {
        "Vypršel čas připojení. Ověřte adresu a odchozí UDP."
    } else if text.contains("permission") {
        "Server tuto akci nepovolil. Chybí oprávnění."
    } else {
        "Server je nedostupný nebo odmítl spojení či požadavek."
    }
    .into()
}

async fn next_event(con: &mut Connection) -> Option<Result<StreamItem, tsclientlib::Error>> {
    con.events().next().await
}

fn error_code(message: &str) -> &'static str {
    let text = message.to_lowercase();
    if text.contains("heslo") {
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
    } else {
        "unreachable"
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

pub async fn run(mut ws: WebSocket, allowed: &[String]) {
    if let Err(message) = session(&mut ws, allowed).await {
        let _ = json_send(&mut ws, error_message(&message, true)).await;
    }
    let _ = timeout(Duration::from_secs(1), ws.close()).await;
}

async fn session(ws: &mut WebSocket, allowed: &[String]) -> Result<(), String> {
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
    let addr = timeout(Duration::from_secs(5), tokio::net::lookup_host(&server))
        .await
        .map_err(|_| "Vypršel čas hledání serveru.")?
        .map_err(|_| "Adresu serveru se nepodařilo najít.")?
        .next()
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
    let mut con = Connection::build(addr)
        .identity(id.clone())
        .name(nickname.clone())
        .password(password.clone())
        .channel(channel.clone())
        .channel_password(channel_password.clone())
        .connect()
        .map_err(|e| ts_error(&e))?;
    let result = tokio::select! {
      _ = superseded.changed() => {
          let _ = json_send(ws, json!({"type":"notice", "code":"session_replaced", "message":"Spojení převzalo jiné okno Mluvky."})).await;
          Ok(())
      },
      result = async {
    let mut renamed = false;
    let mut initial_mute = None;
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
            _ = tokio::time::sleep_until(deadline.into()) => return Err("Vypršel čas připojení. Server neodpovídá.".into()),
        };
        match event {
            Some(Ok(StreamItem::BookEvents(_))) => break,
            Some(Ok(StreamItem::IdentityLevelIncreased)) => {
                if let Some(id) = con.get_options().get_identity() {
                    json_send(ws, json!({"type":"identity", "identity":identity_text(id),"uid":id.key().to_pub().get_uid().to_string(),"level":id.level()})).await?;
                }
            }
            Some(Err(e)) => {
                let detail = format!("{e:?}").to_ascii_lowercase();
                if !renamed && detail.contains("nameinuse") {
                    renamed = true;
                    let name = format!("{}1", nickname.chars().take(29).collect::<String>());
                    json_send(ws, json!({"type":"notice", "message":format!("Přezdívka je obsazená, zkouším {name}.")})).await?;
                    con = Connection::build(addr)
                        .identity(id.clone())
                        .name(name)
                        .password(password.clone())
                        .channel(channel.clone())
                        .channel_password(channel_password.clone())
                        .connect()
                        .map_err(|e| ts_error(&e))?;
                } else {
                    return Err(ts_error(&e));
                }
            }
            None => return Err("Server ukončil spojení.".into()),
            _ => {}
        }
    }
    connected(ws, &mut con, initial_mute, renamed.then_some(nickname.as_str())).await
      } => result,
    };
    // I při chybě WS je nutné dokončit UDP odpojení a zahodit identitu v paměti.
    // Po odmítnutí handshake je spojovací future knihovny již dokončená;
    // její další poll by panikoval. UDP disconnect potřebuje jen navázaná TS relace.
    if con.get_state().is_ok() && con.disconnect(DisconnectOptions::new()).is_ok() {
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
    ws: &mut WebSocket,
    con: &mut Connection,
    initial_mute: Option<(bool, bool)>,
    restore_nickname: Option<&str>,
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
    json_send(ws, snapshot(con)?).await?;
    let mut audio = AudioHandler::<ClientId>::new();
    let encoder = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)
        .map_err(|_| "Opus enkodér nelze spustit.")?;
    let mut peers: HashMap<String, (f32, bool)> = HashMap::new();
    let mut talking: HashMap<ClientId, Instant> = HashMap::new();
    let mut was_sending = false;
    let mut last_up = Instant::now();
    let mut tick = interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut heartbeat = interval(Duration::from_secs(10));
    let mut last_pong = Instant::now();
    let mut restore_nickname = restore_nickname;
    let mut pending = HashMap::new();
    let mut rate_start = Instant::now();
    let (mut control_count, mut audio_count) = (0, 0);
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
                            Control::Connect { .. } => return Err("Spojení už je připojené.".into()),
                        };
                        if let Some(cmd) = cmd { let handle = cmd.send_with_result(con).map_err(|e| ts_error(&e))?; pending.insert(handle, Instant::now()); }
                    },
                    Message::Binary(data) => {
                        audio_count += 1;
                        if audio_count > 100 || data.len() != 1921 || data[0] != 1 { return Err("Neplatný nebo příliš rychlý audio proud.".into()); }
                        if !microphone && !deafen && con.can_send_audio() {
                            let samples: Vec<i16> = data[1..].as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes([b[0],b[1]])).collect();
                            let mut encoded = [0u8; 4000];
                            let len = encoder.encode(&samples, &mut encoded).map_err(|_| "Chyba kódování hlasu.")?;
                            con.send_audio(OutAudio::new(&AudioData::C2S { id:0,codec:CodecType::OpusVoice,data:&encoded[..len] })).map_err(|e| ts_error(&e))?;
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
                            if let Event::Message { target, invoker, message } = e {
                                let (kind, client) = match target { MessageTarget::Server => ("server",None), MessageTarget::Channel => ("channel",None), MessageTarget::Client(id) => ("private",Some(id.0)), MessageTarget::Poke(id) => ("poke",Some(id.0)) };
                                json_send(ws,json!({"type":if kind == "poke" {"poke"} else {"chat"},"target":kind,"client":client,"from":invoker.id.0,"name":invoker.name,"text":message})).await?;
                            }
                        }
                        json_send(ws, snapshot(con)?).await?;
                    },
                    Some(Ok(StreamItem::Audio(packet))) => {
                        let from = match packet.data().data() { AudioData::S2C { from,.. } => ClientId(*from), _ => continue };
                        let now = Instant::now();
                        if talking.insert(from,now).is_none() { json_send(ws,json!({"type":"talking","client":from.0,"active":true})).await?; }
                        let pref = con.get_state().ok().and_then(|b| b.clients.get(&from)).and_then(|c| c.uid.as_ref()).and_then(|u| peers.get(&u.to_string())).copied().unwrap_or((1.0,false));
                        if !deafen && !pref.1 { let _ = audio.handle_packet(from,packet); if let Some(q) = audio.get_mut_queues().get_mut(&from) { q.volume = pref.0; } }
                    },
                    Some(Ok(StreamItem::MessageResult(handle, result))) => { pending.remove(&handle); if let Err(e) = result { json_send(ws,error_message(&ts_error(&tsclientlib::Error::CommandError(e)), false)).await?; } },
                    Some(Ok(StreamItem::DisconnectedTemporarily(_))) => return Err("Spojení s TS serverem se přerušilo. Připojte se znovu.".into()),
                    Some(Err(e)) => return Err(ts_error(&e)),
                    None => return Err("TS server ukončil spojení.".into()),
                    _ => {}
                }
            },
            _ = tick.tick() => {
                // Nezávislý limit i při nepřesném načasování 10s heartbeat ticku.
                if last_pong.elapsed() >= Duration::from_secs(25) { return Err("Prohlížeč přestal odpovídat.".into()); }
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
                let mut frame = Vec::with_capacity(1921); frame.push(2);
                for lr in stereo.as_chunks::<2>().0 { let sample = (((lr[0]+lr[1])*0.5).clamp(-1.0,1.0)*32767.0) as i16; frame.extend_from_slice(&sample.to_le_bytes()); }
                send(ws,Message::Binary(frame.into())).await?;
                if pending.values().any(|t| t.elapsed() > Duration::from_secs(10)) { pending.clear(); json_send(ws,error_message("Server včas nepotvrdil požadavek.", false)).await?; }
            },
            _ = heartbeat.tick() => {
                if last_pong.elapsed() >= Duration::from_secs(20) { return Err("Prohlížeč přestal odpovídat.".into()); }
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

#[cfg(test)]
mod tests {
    use super::*;
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
