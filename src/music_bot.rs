//! Hudební bot v kanálu: rozpoznání, fronta příkazů a parser jeho odpovědí.
//!
//! Bot je obyčejný TS klient ovládaný textovými příkazy (`/now`, `/play …`).
//! Mluvka mu posílá jen soukromé zprávy, odpovědi spáruje s příkazem a místo
//! do chatu je posílá frontendu jako strukturované události.

use serde::Serialize;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tsclientlib::ClientId;
use tsclientlib::data::Connection as Book;

/// Bot hlídá 1 s na identitu; necháváme si rezervu.
const SEND_GAP: Duration = Duration::from_millis(1100);
/// Po „Please wait a second" zkusíme příkaz ještě jednou.
const RETRY_DELAY: Duration = Duration::from_millis(1500);
/// Odpověď, která nepřijde do 8 s, už k příkazu nepatří.
const REPLY_TIMEOUT: Duration = Duration::from_secs(8);
/// Ozvěnu vlastní soukromé zprávy server vrací hned; déle ji nehlídáme.
const ECHO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_QUEUE: usize = 8;

struct Config {
    names: Vec<String>,
    uids: Vec<String>,
}

fn list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn config() -> &'static Config {
    static CONFIG: OnceLock<Config> = OnceLock::new();
    CONFIG.get_or_init(|| Config {
        names: list(&std::env::var("MUSIC_BOT_NAMES").unwrap_or_else(|_| "Spotify Bot".into()))
            .into_iter()
            .map(|n| n.to_lowercase())
            .collect(),
        uids: list(&std::env::var("MUSIC_BOT_UIDS").unwrap_or_default()),
    })
}

fn matches_bot(cfg: &Config, name: &str, uid: Option<&str>) -> bool {
    cfg.names.iter().any(|n| *n == name.trim().to_lowercase())
        || uid.is_some_and(|u| cfg.uids.iter().any(|x| x == u))
}

// ---------------------------------------------------------------- parser

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Track {
    pub title: String,
    pub artist: String,
}

impl Track {
    /// Bot skládá „titul — interpret"; interpret může chybět.
    fn parse(label: &str) -> Self {
        let label = label.trim();
        match label.rsplit_once(" — ") {
            Some((t, a)) => Track { title: t.trim().into(), artist: a.trim().into() },
            None => match label.strip_suffix(" —") {
                Some(t) => Track { title: t.trim().into(), artist: String::new() },
                None => Track { title: label.into(), artist: String::new() },
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reply {
    Now {
        track: Option<Track>,
        requested_by: Option<String>,
        last_queued: Option<String>,
    },
    Upnext {
        track: Option<Track>,
        /// Spotify další skladbu ještě nenačetl.
        pending: bool,
    },
    Queue {
        total: u32,
        items: Vec<Track>,
        more: u32,
        /// Položky se ještě načítají.
        pending: bool,
    },
    Volume {
        volume: u8,
    },
    Ack {
        action: String,
    },
    Search {
        query: Option<String>,
        link: bool,
    },
    Error {
        code: String,
        text: String,
    },
    Unknown {
        text: String,
    },
}

fn error(code: &str, text: &str) -> Reply {
    Reply::Error { code: code.into(), text: text.into() }
}

/// Rozparsuje soukromou odpověď bota. Tolerantní k přidaným větám na konci.
pub fn parse_reply(text: &str) -> Reply {
    let text = text.trim();
    let first = text.lines().next().unwrap_or("").trim();
    if let Some(rest) = first.strip_prefix("Now:") {
        let (rest, last_queued) = split_field(rest, " | Last queued:");
        let (rest, requested_by) = split_field(&rest, " | Requested by:");
        return Reply::Now { track: Some(Track::parse(&rest)), requested_by, last_queued };
    }
    if first.starts_with("Spotify has no current track") {
        let (_, last_queued) = split_field(first, " | Last queued:");
        return Reply::Now { track: None, requested_by: None, last_queued };
    }
    if let Some(rest) = first.strip_prefix("Next:") {
        let rest = rest.trim();
        let none = rest.trim_end_matches('.').eq_ignore_ascii_case("nothing queued");
        return Reply::Upnext { track: (!none).then(|| Track::parse(rest)), pending: false };
    }
    if first.starts_with("Spotify has not loaded the next track") {
        return Reply::Upnext { track: None, pending: true };
    }
    if first.starts_with("Queue: no user requests") {
        return Reply::Queue { total: 0, items: vec![], more: 0, pending: false };
    }
    if first.starts_with("Spotify has not loaded the waiting tracks") {
        return Reply::Queue { total: 0, items: vec![], more: 0, pending: true };
    }
    if let Some(rest) = first.strip_prefix("Queue (")
        && let Some((n, _)) = rest.split_once(' ')
        && let Ok(total) = n.parse::<u32>()
    {
        let mut items = Vec::new();
        let mut more = 0;
        for line in text.lines().skip(1).map(str::trim) {
            if let Some(k) = line.strip_prefix('+').and_then(|l| l.strip_suffix(" more")) {
                more = k.trim().parse().unwrap_or(0);
            } else if let Some((num, label)) = line.split_once(". ")
                && num.chars().all(|c| c.is_ascii_digit())
                && !num.is_empty()
            {
                items.push(Track::parse(label));
            }
        }
        return Reply::Queue { total, items, more, pending: false };
    }
    if let Some(rest) = first.strip_prefix("Bot output volume:")
        && let Ok(v) = rest.trim().trim_end_matches('%').trim().parse::<u8>()
    {
        return Reply::Volume { volume: v.min(100) };
    }
    for (prefix, action) in [
        ("Pause requested", "pause"),
        ("Resume requested", "resume"),
        ("Skip requested", "next"),
        ("Previous track requested", "prev"),
        ("Forward seek requested", "seek"),
        ("Rewind requested", "seek"),
        ("Rewind to the start requested", "seek"),
    ] {
        if first.starts_with(prefix) {
            return Reply::Ack { action: action.into() };
        }
    }
    if let Some(rest) = first.strip_prefix("Searching Spotify for:") {
        let query = rest.split(". Use /now").next().unwrap_or(rest).trim();
        return Reply::Search { query: Some(query.into()), link: false };
    }
    if first.starts_with("Opening Spotify link") {
        return Reply::Search { query: None, link: true };
    }
    if let Some(rest) = first.strip_prefix("Spotify search in progress:") {
        let query = rest.split(". Please wait").next().unwrap_or(rest).trim();
        return Reply::Search { query: Some(query.into()), link: false };
    }
    if let Some(rest) = first.strip_prefix("Last search:") {
        return error("search_failed", rest.trim());
    }
    let codes = [
        ("Please wait a second", "rate_limited"),
        ("You are not allowed", "forbidden"),
        ("A Spotify search is already in progress", "search_busy"),
        ("Usage:", "usage"),
        ("Unknown command", "usage"),
        ("Keep ", "too_long"),
        ("Only ", "seek_end"),
        ("Spotify does not allow seeking", "seek_unavailable"),
        ("Spotify's current track position", "seek_unavailable"),
        ("Spotify queue", "queue_unavailable"),
        ("Spotify request timed out", "timeout"),
        ("Spotify search", "search_failed"),
        ("Could not post the channel report", "unavailable"),
        ("The bot changed channels", "unavailable"),
        ("Spotify is not ready", "unavailable"),
        ("Expected one Spotify player", "unavailable"),
        ("Playback control is unavailable", "unavailable"),
    ];
    for (prefix, code) in codes {
        if first.starts_with(prefix) {
            return error(code, first);
        }
    }
    Reply::Unknown { text: text.chars().take(500).collect() }
}

fn split_field(text: &str, marker: &str) -> (String, Option<String>) {
    match text.rsplit_once(marker) {
        Some((head, value)) => (head.trim().into(), Some(value.trim().to_owned()).filter(|v| !v.is_empty())),
        None => (text.trim().into(), None),
    }
}

/// Kanálové oznámení „Now playing: …\nRequested by: …\nNext: …".
pub fn parse_announcement(text: &str) -> Option<Value> {
    let mut lines = text.trim().lines();
    let track = Track::parse(lines.next()?.trim().strip_prefix("Now playing:")?);
    let (mut requested_by, mut next) = (None, None);
    for line in lines.map(str::trim) {
        if let Some(r) = line.strip_prefix("Requested by:") {
            requested_by = Some(r.trim().to_owned());
        } else if let Some(n) = line.strip_prefix("Next:") {
            next = Some(Track::parse(n));
        }
    }
    Some(json!({"kind":"announce","track":track,"requested_by":requested_by,"next":next}))
}

/// Text příkazu z akce frontendu. Vstupy se ověřují stejně jako u bota.
pub fn command_text(action: &str, arg: Option<&str>) -> Result<String, &'static str> {
    let arg = arg.map(str::trim).filter(|a| !a.is_empty());
    let plain = |c: &str| if arg.is_none() { Ok(c.to_owned()) } else { Err("Příkaz nemá parametr.") };
    match action {
        "now" => plain("/now"),
        "queue" => plain("/queue"),
        "upnext" => plain("/upnext"),
        "pause" => plain("/pause"),
        "resume" => plain("/play"),
        "next" => plain("/next"),
        "prev" => plain("/prev"),
        "seek" => match arg.and_then(|a| a.parse::<i32>().ok()) {
            Some(s) if (1..=86400).contains(&s.abs()) => Ok(format!("/skip {s:+}")),
            _ => Err("Posun musí být 1–86400 s."),
        },
        "volume" => match arg.and_then(|a| a.parse::<u8>().ok()) {
            Some(v) if v <= 100 => Ok(format!("/volume {v}")),
            _ => Err("Hlasitost musí být 0–100."),
        },
        "play" | "playnow" => {
            let q = arg.ok_or("Zadejte skladbu nebo odkaz.")?;
            if q.chars().any(char::is_control) {
                return Err("Hledání nesmí obsahovat zalomení řádku.");
            }
            let link = q.starts_with("https://") || q.starts_with("spotify:");
            let limit = if link { 2048 } else { 300 };
            if q.len() > limit {
                return Err("Hledání je příliš dlouhé.");
            }
            Ok(format!("/{action} {q}"))
        }
        _ => Err("Neznámý příkaz přehrávače."),
    }
}

// ----------------------------------------------------------- fronta příkazů

/// Stejný filtr jako plugin bota: první slovo (bez ohledu na velikost) musí
/// být známý příkaz, jinak bot zprávu ignoruje a neodpoví.
pub fn is_bot_command(text: &str) -> bool {
    const COMMANDS: [&str; 14] = [
        "/play", "/playnow", "/resume", "/pause", "/stop", "/skip", "/next", "/previous", "/prev", "/now",
        "/upnext", "/queue", "/volume", "/help",
    ];
    let word = text.split([' ', '\t', '\r', '\n']).next().unwrap_or("");
    COMMANDS.iter().any(|c| c.eq_ignore_ascii_case(word))
}

#[derive(Debug, Clone, PartialEq)]
enum Expect {
    /// Odpověď na příkaz Mluvky — do chatu nepatří.
    Mluvka { text: String, retried: bool },
    /// Uživatel psal botovi ručně — odpověď zůstává v chatu.
    Manual,
}

/// Fronta příkazů pro jedno spojení a párování odpovědí v pořadí odeslání.
#[derive(Default)]
pub struct Commander {
    queue: VecDeque<(String, bool)>,
    not_before: Option<Instant>,
    last_sent: Option<Instant>,
    outstanding: VecDeque<(Expect, Instant)>,
    echoes: VecDeque<(String, Instant)>,
}

#[derive(Debug, PartialEq)]
pub enum Paired {
    /// Zpráva k příkazu Mluvky nepatří — ukázat v chatu.
    NotOurs,
    /// Odpověď na příkaz; `None` = spolkli jsme ji kvůli opakování.
    Ours(Option<(String, Reply)>),
}

impl Commander {
    pub fn push(&mut self, text: String) -> bool {
        let busy = self.outstanding.iter().any(|(e, _)| matches!(e, Expect::Mluvka { text: t, .. } if *t == text));
        if self.queue.iter().any(|(t, _)| *t == text) || (busy && !text.starts_with("/play")) {
            return true; // Stejný dotaz už čeká; bot ušetříme.
        }
        if self.queue.len() >= MAX_QUEUE {
            return false;
        }
        self.queue.push_back((text, false));
        true
    }

    /// Ruční zpráva botovi. Odpověď čekáme jen na příkaz, který plugin bota
    /// přijme; na „ahoj" bot mlčí a nic se nepáruje.
    pub fn manual_sent(&mut self, text: &str, now: Instant) {
        if !is_bot_command(text) {
            return;
        }
        self.last_sent = Some(now);
        self.outstanding.push_back((Expect::Manual, now));
    }

    /// Další příkaz k odeslání, pokud to dovolí limit bota.
    pub fn next_send(&mut self, now: Instant) -> Option<String> {
        if self.outstanding.iter().any(|(e, _)| matches!(e, Expect::Mluvka { .. }))
            || self.last_sent.is_some_and(|t| now < t + SEND_GAP)
            || self.not_before.is_some_and(|t| now < t)
        {
            return None;
        }
        let (text, retried) = self.queue.pop_front()?;
        self.not_before = None;
        self.last_sent = Some(now);
        self.outstanding.push_back((Expect::Mluvka { text: text.clone(), retried }, now));
        self.echoes.push_back((text.clone(), now));
        Some(text)
    }

    /// Odpovědi, které nepřišly včas. Vrací texty příkazů Mluvky.
    pub fn expire(&mut self, now: Instant) -> Vec<String> {
        let mut out = Vec::new();
        while let Some((e, t)) = self.outstanding.front() {
            if now.duration_since(*t) < REPLY_TIMEOUT {
                break;
            }
            if let Expect::Mluvka { text, .. } = e {
                out.push(text.clone());
            }
            self.outstanding.pop_front();
        }
        self.echoes.retain(|(_, t)| now.duration_since(*t) < ECHO_TIMEOUT);
        out
    }

    /// Ozvěna vlastního příkazu od serveru — nezobrazovat.
    pub fn is_echo(&mut self, text: &str) -> bool {
        match self.echoes.iter().position(|(t, _)| t == text) {
            Some(i) => {
                self.echoes.remove(i);
                true
            }
            None => false,
        }
    }

    /// Soukromá zpráva od bota: spáruje ji s nejstarším čekajícím příkazem.
    pub fn on_reply(&mut self, text: &str, now: Instant) -> Paired {
        self.expire(now);
        match self.outstanding.pop_front() {
            None | Some((Expect::Manual, _)) => Paired::NotOurs,
            Some((Expect::Mluvka { text: cmd, retried }, _)) => {
                let reply = parse_reply(text);
                if matches!(&reply, Reply::Error { code, .. } if code == "rate_limited") && !retried {
                    self.queue.push_front((cmd, true));
                    self.not_before = Some(now + RETRY_DELAY);
                    return Paired::Ours(None);
                }
                Paired::Ours(Some((cmd, reply)))
            }
        }
    }

    pub fn clear(&mut self) {
        *self = Self { last_sent: self.last_sent, ..Self::default() };
    }
}

// ---------------------------------------------------------- stav spojení

/// Co má relace udělat s příchozí zprávou.
pub struct Handled {
    pub show_in_chat: bool,
    pub event: Option<Value>,
}

#[derive(Default)]
pub struct MusicBot {
    bot: Option<(ClientId, String)>,
    commander: Commander,
}

impl MusicBot {
    pub fn bot(&self) -> Option<ClientId> {
        self.bot.as_ref().map(|b| b.0)
    }

    /// Najde bota v kanálu uživatele; při změně vrátí událost pro frontend.
    pub fn update(&mut self, book: &Book) -> Option<Value> {
        let own = book.own_client;
        let channel = book.clients.get(&own).map(|c| c.channel);
        let cfg = config();
        let found = book
            .clients
            .values()
            .filter(|c| c.id != own && Some(c.channel) == channel)
            .filter(|c| {
                let uid = c.uid.as_ref().map(|u| u.as_ref().to_string());
                matches_bot(cfg, &c.name, uid.as_deref())
            })
            .min_by_key(|c| c.id.0)
            .map(|c| (c.id, c.name.clone()));
        if found == self.bot {
            return None;
        }
        if found.as_ref().map(|b| b.0) != self.bot() {
            self.commander.clear();
        }
        self.bot = found;
        Some(match &self.bot {
            Some((id, name)) => json!({"type":"music","event":"bot","present":true,"client":id.0,"name":name}),
            None => json!({"type":"music","event":"bot","present":false}),
        })
    }

    /// Požadavek z frontendu. Vrací chybovou událost, pokud ho nelze přijmout.
    pub fn request(&mut self, action: &str, arg: Option<&str>) -> Option<Value> {
        if self.bot.is_none() {
            return Some(json!({"type":"music","event":"error","code":"no_bot"}));
        }
        match command_text(action, arg) {
            Err(e) => Some(json!({"type":"music","event":"error","code":"invalid","text":e})),
            Ok(text) => {
                if self.commander.push(text) {
                    None
                } else {
                    Some(json!({"type":"music","event":"error","code":"busy"}))
                }
            }
        }
    }

    pub fn manual_sent(&mut self, client: u16, text: &str, now: Instant) {
        if self.bot().is_some_and(|b| b.0 == client) {
            self.commander.manual_sent(text, now);
        }
    }

    /// Takt relace: příkaz k odeslání a události vypršených odpovědí.
    pub fn tick(&mut self, now: Instant) -> (Option<(ClientId, String)>, Vec<Value>) {
        let events = self
            .commander
            .expire(now)
            .into_iter()
            .map(|c| json!({"type":"music","event":"timeout","command":c}))
            .collect();
        let send = match self.bot() {
            Some(id) => self.commander.next_send(now).map(|t| (id, t)),
            None => None,
        };
        (send, events)
    }

    /// Příchozí textová zpráva. `private_peer` je protějšek soukromé zprávy.
    pub fn on_message(
        &mut self,
        channel: bool,
        private_peer: Option<u16>,
        from: ClientId,
        own: ClientId,
        text: &str,
        now: Instant,
    ) -> Handled {
        let shown = Handled { show_in_chat: true, event: None };
        let Some(bot) = self.bot() else { return shown };
        if channel && from == bot {
            return Handled {
                show_in_chat: true,
                event: parse_announcement(text).map(|r| json!({"type":"music","event":"reply","command":null,"reply":r})),
            };
        }
        if from == own && private_peer == Some(bot.0) && self.commander.is_echo(text) {
            return Handled { show_in_chat: false, event: None };
        }
        if from == bot && private_peer.is_some() {
            return match self.commander.on_reply(text, now) {
                Paired::NotOurs => shown,
                Paired::Ours(None) => Handled { show_in_chat: false, event: None },
                Paired::Ours(Some((cmd, reply))) => Handled {
                    show_in_chat: false,
                    event: Some(json!({"type":"music","event":"reply","command":cmd,"reply":reply})),
                },
            };
        }
        shown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(title: &str, artist: &str) -> Track {
        Track { title: title.into(), artist: artist.into() }
    }

    #[test]
    fn now_variants() {
        assert_eq!(
            parse_reply("Now: Song — Artist"),
            Reply::Now { track: Some(t("Song", "Artist")), requested_by: None, last_queued: None }
        );
        assert_eq!(
            parse_reply("Now: A — B — Artist | Requested by: Pavel | Last queued: X — Y"),
            Reply::Now {
                track: Some(t("A — B", "Artist")),
                requested_by: Some("Pavel".into()),
                last_queued: Some("X — Y".into())
            }
        );
        assert_eq!(
            parse_reply("Now: Instrumental — "),
            Reply::Now { track: Some(t("Instrumental", "")), requested_by: None, last_queued: None }
        );
        assert_eq!(
            parse_reply("Spotify has no current track. | Last queued: Q"),
            Reply::Now { track: None, requested_by: None, last_queued: Some("Q".into()) }
        );
    }

    #[test]
    fn upnext_and_queue() {
        assert_eq!(parse_reply("Next: S — A"), Reply::Upnext { track: Some(t("S", "A")), pending: false });
        assert_eq!(parse_reply("Next: nothing queued."), Reply::Upnext { track: None, pending: false });
        assert_eq!(
            parse_reply("Spotify has not loaded the next track yet."),
            Reply::Upnext { track: None, pending: true }
        );
        assert_eq!(
            parse_reply("Queue: no user requests."),
            Reply::Queue { total: 0, items: vec![], more: 0, pending: false }
        );
        let q = "Queue (7 waiting):\n1. One — A\n2. Two — B\n3. Three\n4. Four — D\n5. Five — E\n+2 more";
        assert_eq!(
            parse_reply(q),
            Reply::Queue {
                total: 7,
                items: vec![t("One", "A"), t("Two", "B"), t("Three", ""), t("Four", "D"), t("Five", "E")],
                more: 2,
                pending: false
            }
        );
        assert_eq!(
            parse_reply("Queue (1 waiting):\n1. Solo — X"),
            Reply::Queue { total: 1, items: vec![t("Solo", "X")], more: 0, pending: false }
        );
    }

    #[test]
    fn acks_volume_search_errors() {
        assert_eq!(parse_reply("Bot output volume: 42%"), Reply::Volume { volume: 42 });
        for (s, a) in [
            ("Pause requested.", "pause"),
            ("Resume requested.", "resume"),
            ("Skip requested.", "next"),
            ("Previous track requested.", "prev"),
            ("Forward seek requested: 30 seconds.", "seek"),
            ("Rewind requested: 15 seconds.", "seek"),
            ("Rewind to the start requested.", "seek"),
        ] {
            assert_eq!(parse_reply(s), Reply::Ack { action: a.into() }, "{s}");
        }
        assert_eq!(
            parse_reply("Searching Spotify for: daft punk. Use /now to check the result."),
            Reply::Search { query: Some("daft punk".into()), link: false }
        );
        assert_eq!(
            parse_reply("Opening Spotify link. Use /now to check the result."),
            Reply::Search { query: None, link: true }
        );
        let code = |s: &str| match parse_reply(s) {
            Reply::Error { code, .. } => code,
            other => panic!("{other:?}"),
        };
        assert_eq!(code("Last search: Spotify search returned no track."), "search_failed");
        assert_eq!(code("Please wait a second between commands."), "rate_limited");
        assert_eq!(code("You are not allowed to control this bot."), "forbidden");
        assert_eq!(code("Usage: /volume 0-100"), "usage");
        assert_eq!(code("Only 3 seconds remain. Use /skip to skip the whole song."), "seek_end");
        assert_eq!(code("Spotify is not ready. Start a song once."), "unavailable");
        assert_eq!(
            parse_reply("Something brand new."),
            Reply::Unknown { text: "Something brand new.".into() }
        );
        // Bot může doplnit další věty — první zůstává rozpoznaná.
        assert_eq!(parse_reply("Pause requested. Enjoy the silence."), Reply::Ack { action: "pause".into() });
    }

    #[test]
    fn announcement() {
        let v = parse_announcement("Now playing: Song — Artist\nRequested by: Eva\nNext: Other — B").unwrap();
        assert_eq!(v["track"]["title"], "Song");
        assert_eq!(v["requested_by"], "Eva");
        assert_eq!(v["next"]["artist"], "B");
        assert!(parse_announcement("Ahoj všichni").is_none());
    }

    #[test]
    fn commands() {
        assert_eq!(command_text("resume", None).unwrap(), "/play");
        assert_eq!(command_text("seek", Some("-15")).unwrap(), "/skip -15");
        assert_eq!(command_text("seek", Some("30")).unwrap(), "/skip +30");
        assert!(command_text("seek", Some("0")).is_err());
        assert_eq!(command_text("volume", Some("100")).unwrap(), "/volume 100");
        assert!(command_text("volume", Some("101")).is_err());
        assert_eq!(command_text("playnow", Some(" song ")).unwrap(), "/playnow song");
        assert!(command_text("play", Some("a\nb")).is_err());
        assert!(command_text("play", Some(&"x".repeat(301))).is_err());
        assert!(command_text("now", Some("x")).is_err());
        assert!(command_text("help", None).is_err());
    }

    #[test]
    fn pairing_rate_and_timeout() {
        let start = Instant::now();
        let mut c = Commander::default();
        assert!(c.push("/now".into()));
        assert!(c.push("/now".into())); // duplicita se neřadí
        assert!(c.push("/queue".into()));
        assert_eq!(c.next_send(start).as_deref(), Some("/now"));
        // Druhý příkaz čeká na odpověď i na 1,1 s.
        assert_eq!(c.next_send(start + Duration::from_secs(2)), None);
        assert!(c.is_echo("/now"));
        assert!(!c.is_echo("/now"));
        match c.on_reply("Now: S — A", start + Duration::from_millis(300)) {
            Paired::Ours(Some((cmd, Reply::Now { .. }))) => assert_eq!(cmd, "/now"),
            other => panic!("{other:?}"),
        }
        assert_eq!(c.next_send(start + Duration::from_millis(500)), None);
        let t1 = start + Duration::from_millis(1100);
        assert_eq!(c.next_send(t1).as_deref(), Some("/queue"));
        // Rate limit → spolknout a zopakovat jednou po 1,5 s.
        assert_eq!(c.on_reply("Please wait a second between commands.", t1), Paired::Ours(None));
        assert_eq!(c.next_send(t1 + Duration::from_millis(1400)), None);
        let t2 = t1 + Duration::from_millis(1500);
        assert_eq!(c.next_send(t2).as_deref(), Some("/queue"));
        match c.on_reply("Please wait a second between commands.", t2) {
            Paired::Ours(Some((_, Reply::Error { code, .. }))) => assert_eq!(code, "rate_limited"),
            other => panic!("{other:?}"),
        }
        // Bez čekajícího příkazu patří zpráva do chatu.
        assert_eq!(c.on_reply("Hello", t2), Paired::NotOurs);
        // Timeout: odpověď po 8 s už se nepáruje.
        c.push("/upnext".into());
        let t3 = t2 + Duration::from_secs(2);
        assert_eq!(c.next_send(t3).as_deref(), Some("/upnext"));
        assert_eq!(c.expire(t3 + Duration::from_secs(7)), Vec::<String>::new());
        assert_eq!(c.expire(t3 + Duration::from_secs(8)), vec!["/upnext".to_string()]);
        assert_eq!(c.on_reply("Next: S — A", t3 + Duration::from_secs(9)), Paired::NotOurs);
    }

    #[test]
    fn manual_messages_stay_in_chat() {
        let start = Instant::now();
        let mut c = Commander::default();
        c.manual_sent("/help", start);
        c.push("/now".into());
        assert_eq!(c.next_send(start + Duration::from_millis(500)), None);
        let t1 = start + Duration::from_millis(1100);
        assert_eq!(c.next_send(t1).as_deref(), Some("/now"));
        assert_eq!(c.on_reply("Help text", t1), Paired::NotOurs);
        assert!(matches!(c.on_reply("Now: X — Y", t1), Paired::Ours(Some(_))));
    }

    #[test]
    fn plugin_command_filter() {
        assert!(is_bot_command("/now"));
        assert!(is_bot_command("/PLAY daft punk"));
        assert!(is_bot_command("/previous"));
        assert!(!is_bot_command("ahoj"));
        assert!(!is_bot_command(" /now"));
        assert!(!is_bot_command("/nowx"));
        assert!(!is_bot_command("/foo bar"));
    }

    #[test]
    fn manual_chat_does_not_steal_reply() {
        // Ruční „ahoj" botovi → automatický `/now` → odpověď je naše a skrytá.
        let start = Instant::now();
        let (own, bot) = (ClientId(1), ClientId(5));
        let mut m = MusicBot { bot: Some((bot, "Spotify Bot".into())), commander: Commander::default() };
        m.manual_sent(bot.0, "ahoj", start);
        assert!(m.request("now", None).is_none());
        let (send, events) = m.tick(start);
        assert!(events.is_empty());
        assert_eq!(send, Some((bot, "/now".to_string())));
        // Ozvěna ručního „ahoj" zůstává v chatu, ozvěna `/now` ne.
        assert!(m.on_message(false, Some(bot.0), own, own, "ahoj", start).show_in_chat);
        assert!(!m.on_message(false, Some(bot.0), own, own, "/now", start).show_in_chat);
        let reply = m.on_message(false, Some(own.0), bot, own, "Now: S — A", start + Duration::from_millis(200));
        assert!(!reply.show_in_chat);
        let event = reply.event.expect("událost přehrávače");
        assert_eq!(event["command"], "/now");
        assert_eq!(event["reply"]["kind"], "now");
        // Po vypršení se „ahoj" nehlásí jako nezodpovězený příkaz.
        assert!(m.tick(start + Duration::from_secs(9)).1.is_empty());
    }

    #[test]
    fn bot_names() {
        let cfg = Config { names: vec!["spotify bot".into()], uids: vec!["abc=".into()] };
        assert!(matches_bot(&cfg, "Spotify BOT", None));
        assert!(matches_bot(&cfg, "Jiné jméno", Some("abc=")));
        assert!(!matches_bot(&cfg, "Spotify Bot1", None));
    }
}
