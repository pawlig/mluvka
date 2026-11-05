//! Místnosti jsou svázané s ověřenou TS relací; klient nikdy neurčuje server ani kanál.
use axum::extract::ws::Message;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, Member>>);
struct Member {
    server: String,
    channel: u64,
    client: u16,
    uid: String,
    name: String,
    token: String,
    sharing: bool,
    watching: Option<String>,
    ice_requests: Vec<Instant>,
    changes: VecDeque<Instant>,
    last_list: Option<Value>,
    tx: mpsc::Sender<Message>,
}
pub struct Lease {
    pub id: String,
    pub token: String,
    registry: Arc<Registry>,
}
fn random_id() -> String {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).expect("system random");
    URL_SAFE_NO_PAD.encode(bytes)
}
fn emit(member: &Member, value: Value) -> Result<(), &'static str> {
    member
        .tx
        .try_send(Message::Text(value.to_string().into()))
        .map_err(|_| "Příjemce přestal přijímat signalizaci.")
}
fn lists(members: &mut HashMap<String, Member>, server: &str) {
    // Stabilní pořadí je nutné pro porovnání seznamů mezi příchody/odchody relací.
    let mut ids: Vec<_> = members
        .iter()
        .filter(|(_, p)| p.server == server)
        .map(|(id, _)| id.clone())
        .collect();
    ids.sort();
    let updates: Vec<_> = ids.iter().map(|id| {
        let me = &members[id];
        let clients: Vec<_> = ids.iter().map(|id| {
            let p = &members[id];
            json!({"session":id,"client":p.client,"uid":p.uid,"mluvka":true,"sharing":p.sharing && p.channel == me.channel})
        }).collect();
        let shares: Vec<_> = ids.iter().filter_map(|id| {
            let p = &members[id];
            (p.channel == me.channel && p.sharing).then(|| json!({"session":id,"client":p.client,"uid":p.uid,"name":p.name,"kind":"screen"}))
        }).collect();
        let viewers = members.values().filter(|p| p.watching.as_ref() == Some(id)).count();
        (id.clone(), json!({"type":"share_list","v":1,"self":id,"sharing":me.sharing,"viewers":viewers,"shares":shares,"clients":clients}))
    }).collect();
    for (id, value) in updates {
        let me = members.get_mut(&id).unwrap();
        if me.last_list.as_ref() != Some(&value) && emit(me, value.clone()).is_ok() {
            me.last_list = Some(value);
        }
    }
}
// Ukončí obě strany všech vazeb člena, ještě před zveřejněním nové místnosti.
fn detach(members: &mut HashMap<String, Member>, id: &str) {
    let watching = members.get_mut(id).and_then(|p| {
        p.sharing = false;
        p.watching.take()
    });
    if let Some(to) = watching.as_ref().and_then(|to| members.get(to)) {
        let _ = emit(
            to,
            json!({"type":"unwatch","v":1,"kind":"screen","from":id,"to":watching}),
        );
    }
    for (viewer, p) in members.iter_mut() {
        if p.watching.as_deref() == Some(id) {
            p.watching = None;
            let _ = emit(
                p,
                json!({"type":"share_stop","v":1,"kind":"screen","from":id,"to":viewer}),
            );
        }
    }
}
impl Registry {
    pub fn join(
        self: &Arc<Self>,
        server: String,
        state: &Value,
        tx: mpsc::Sender<Message>,
    ) -> Lease {
        let id = random_id();
        let token = random_id();
        let client = state["self"].as_u64().expect("TS client") as u16;
        let me = state["clients"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"].as_u64() == Some(client as u64))
            .expect("own TS client");
        self.0.lock().unwrap().insert(
            id.clone(),
            Member {
                server,
                channel: me["channel"].as_u64().unwrap(),
                client,
                uid: me["uid"].as_str().unwrap_or("").into(),
                name: me["name"].as_str().unwrap_or("").into(),
                token: token.clone(),
                sharing: false,
                watching: None,
                ice_requests: vec![],
                changes: VecDeque::new(),
                last_list: None,
                tx,
            },
        );
        Lease {
            id,
            token,
            registry: self.clone(),
        }
    }
    pub fn ice_uid(&self, token: &str) -> Result<String, axum::http::StatusCode> {
        use axum::http::StatusCode;
        let mut members = self.0.lock().unwrap();
        let p = members
            .values_mut()
            .find(|p| p.token == token)
            .ok_or(StatusCode::UNAUTHORIZED)?;
        p.ice_requests
            .retain(|at| at.elapsed() < Duration::from_secs(60));
        if p.ice_requests.len() >= 30 {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        p.ice_requests.push(Instant::now());
        Ok(p.uid.clone())
    }
}
impl Lease {
    pub fn snapshot(&self, mut state: Value) -> Value {
        let mut members = self.registry.0.lock().unwrap();
        let me = state["clients"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"].as_u64() == state["self"].as_u64())
            .unwrap();
        let channel = me["channel"].as_u64().unwrap();
        let name = me["name"].as_str().unwrap_or("").to_owned();
        let changed = members
            .get(&self.id)
            .is_some_and(|p| p.channel != channel || p.name != name);
        if members.get(&self.id).is_some_and(|p| p.channel != channel) {
            detach(&mut members, &self.id);
        }
        let own = members.get_mut(&self.id).unwrap();
        own.channel = channel;
        own.name = name;
        let server = own.server.clone();
        for client in state["clients"].as_array_mut().unwrap() {
            let p = members.values().find(|p| {
                p.server == server
                    && Some(p.client as u64) == client["id"].as_u64()
                    && Some(p.uid.as_str()) == client["uid"].as_str()
            });
            client["mluvka"] = json!(p.is_some());
            client["sharing"] = json!(p.is_some_and(|p| p.sharing && p.channel == channel));
        }
        if changed {
            lists(&mut members, &server);
        }
        state
    }
    pub fn publish(&self) {
        let mut members = self.registry.0.lock().unwrap();
        let server = members[&self.id].server.clone();
        lists(&mut members, &server);
    }
    pub fn handle(&self, msg: &Value, bytes: usize) -> Result<(), &'static str> {
        let kind = msg["type"].as_str().unwrap_or("");
        let limit = match kind {
            "rtc_offer" | "rtc_answer" => 32 * 1024,
            "rtc_ice" => 4096,
            _ => 1024,
        };
        if bytes > limit || msg["v"] != 1 || msg["kind"] != "screen" {
            return Err("Neplatná verze, druh nebo velikost signalizace.");
        }
        let mut members = self.registry.0.lock().unwrap();
        let me = members
            .get_mut(&self.id)
            .ok_or("Relace už není připojená.")?;
        let server = me.server.clone();
        if matches!(kind, "share_start" | "share_stop" | "watch" | "unwatch") {
            let now = Instant::now();
            me.changes
                .retain(|at| now.duration_since(*at) < Duration::from_secs(1));
            if me.changes.len() >= 5 {
                return Err("Změny sdílení posíláte příliš rychle. Zkuste to za chvíli.");
            }
            me.changes.push_back(now);
        }
        let me = &members[&self.id];
        if kind == "share_start" {
            members.get_mut(&self.id).unwrap().sharing = true;
            emit(
                &members[&self.id],
                json!({"type":"share_started","v":1,"request":msg["request"]}),
            )?;
        } else if kind == "share_stop" {
            // Zastavení vlastního vysílání neruší sledování jiného člověka.
            members.get_mut(&self.id).unwrap().sharing = false;
            for (viewer, p) in members.iter_mut() {
                if p.watching.as_deref() == Some(&self.id) {
                    p.watching = None;
                    let _ = emit(
                        p,
                        json!({"type":"share_stop","v":1,"kind":"screen","from":self.id,"to":viewer}),
                    );
                }
            }
        } else {
            let to = msg["to"]
                .as_str()
                .filter(|s| *s != self.id)
                .ok_or("Neplatný příjemce sdílení.")?;
            let target = members.get(to).ok_or("Sdílení už není dostupné.")?;
            if target.server != me.server || target.channel != me.channel {
                return Err("Sdílení lze sledovat jen ve stejném kanálu a na stejném serveru.");
            }
            match kind {
                "watch" => {
                    if !target.sharing {
                        return Err("Sdílení už skončilo.");
                    }
                    let count = members
                        .values()
                        .filter(|p| p.watching.as_deref() == Some(to))
                        .count();
                    if me.watching.as_deref() != Some(to) && count >= 6 {
                        return Err("Sdílení může sledovat nejvýše 6 diváků.");
                    }
                    if let Some(old) = me
                        .watching
                        .as_ref()
                        .filter(|old| old.as_str() != to)
                        .and_then(|old| members.get(old))
                    {
                        emit(
                            old,
                            json!({"type":"unwatch","v":1,"kind":"screen","from":self.id,"to":me.watching}),
                        )?;
                    }
                    emit(
                        target,
                        json!({"type":"watch","v":1,"kind":"screen","from":self.id,"to":to}),
                    )?;
                    members.get_mut(&self.id).unwrap().watching = Some(to.into());
                }
                "unwatch" => {
                    if me.watching.as_deref() != Some(to) {
                        return Err("Toto sdílení nesledujete.");
                    }
                    emit(
                        target,
                        json!({"type":"unwatch","v":1,"kind":"screen","from":self.id,"to":to}),
                    )?;
                    members.get_mut(&self.id).unwrap().watching = None;
                }
                "rtc_offer" | "rtc_answer" | "rtc_ice" => {
                    let sending = me.sharing && target.watching.as_deref() == Some(&self.id);
                    let receiving = target.sharing && me.watching.as_deref() == Some(to);
                    if !(match kind {
                        "rtc_offer" => sending,
                        "rtc_answer" => receiving,
                        _ => sending || receiving,
                    }) {
                        return Err("Toto spojení nebylo vyžádáno.");
                    }
                    let call = msg["call"]
                        .as_str()
                        .filter(|s| !s.is_empty() && s.len() <= 64)
                        .ok_or("Neplatné spojení.")?;
                    let mut forwarded = json!({"type":kind,"v":1,"kind":"screen","from":self.id,"to":to,"call":call});
                    if kind == "rtc_ice" {
                        let c = &msg["candidate"];
                        if !c.is_null()
                            && (!c.is_object()
                                || c["candidate"].as_str().is_none_or(|s| s.len() > 2048))
                        {
                            return Err("Neplatný ICE kandidát.");
                        }
                        forwarded["candidate"] = c.clone();
                    } else {
                        let sdp = &msg["sdp"];
                        let expected = if kind == "rtc_offer" {
                            "offer"
                        } else {
                            "answer"
                        };
                        if sdp["type"] != expected
                            || sdp["sdp"].as_str().is_none_or(|s| s.len() > 30 * 1024)
                        {
                            return Err("Neplatný popis spojení.");
                        }
                        forwarded["sdp"] = sdp.clone();
                    }
                    emit(target, forwarded)?;
                    return Ok(());
                }
                _ => return Err("Neznámá signalizace."),
            }
        }
        lists(&mut members, &server);
        Ok(())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut members = self.registry.0.lock().unwrap();
        let server = members[&self.id].server.clone();
        detach(&mut members, &self.id);
        members.remove(&self.id);
        lists(&mut members, &server);
    }
}
pub fn is_signal(kind: &str) -> bool {
    matches!(
        kind,
        "share_start" | "share_stop" | "watch" | "unwatch" | "rtc_offer" | "rtc_answer" | "rtc_ice"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn join(
        registry: &Arc<Registry>,
        server: &str,
        client: u16,
        channel: u64,
    ) -> (Lease, mpsc::Receiver<Message>) {
        let (tx, rx) = mpsc::channel(256);
        let state = json!({"self":client,"clients":[{"id":client,"channel":channel,"uid":format!("uid-{client}"),"name":format!("Uživatel {client}")}]});
        (registry.join(server.into(), &state, tx), rx)
    }
    fn signal(lease: &Lease, kind: &str, to: &str) -> Result<(), &'static str> {
        lease.handle(&json!({"type":kind,"v":1,"kind":"screen","to":to}), 100)
    }
    #[test]
    fn state_flood_is_limited_scoped_and_unchanged_lists_are_suppressed() {
        let registry = Arc::new(Registry::default());
        let (a, _a_rx) = join(&registry, "example.org:9987", 1, 1);
        let (_b, mut b_rx) = join(&registry, "example.org:9987", 2, 1);
        let (_foreign, mut foreign_rx) = join(&registry, "other.example.org:9987", 3, 1);
        a.publish();
        assert!(b_rx.try_recv().is_ok());
        a.publish();
        assert!(b_rx.try_recv().is_err());
        let mut accepted = 0;
        for i in 0..120 {
            match signal(
                &a,
                if i % 2 == 0 {
                    "share_start"
                } else {
                    "share_stop"
                },
                "",
            ) {
                Ok(()) => accepted += 1,
                Err(message) => assert!(message.contains("příliš rychle")),
            }
        }
        assert_eq!(accepted, 5);
        let mut lists = 0;
        while let Ok(Message::Text(s)) = b_rx.try_recv() {
            assert_eq!(
                serde_json::from_str::<Value>(&s).unwrap()["type"],
                "share_list"
            );
            lists += 1;
        }
        assert_eq!(lists, 5);
        assert!(foreign_rx.try_recv().is_err());
    }
    #[test]
    fn room_isolation_limit_switch_and_disconnect_revoke_permissions() {
        let registry = Arc::new(Registry::default());
        let (a, _a_rx) = join(&registry, "example.org:9987", 1, 1);
        signal(&a, "share_start", "").unwrap();
        let (other_channel, _rx) = join(&registry, "example.org:9987", 2, 2);
        let (other_server, _rx2) = join(&registry, "other.example.org:9987", 3, 1);
        assert!(signal(&other_channel, "watch", &a.id).is_err());
        assert!(signal(&other_server, "watch", &a.id).is_err());
        let hidden = other_channel.snapshot(json!({"self":2,"clients":[
            {"id":1,"channel":1,"uid":"uid-1","name":"A"},
            {"id":2,"channel":2,"uid":"uid-2","name":"B"}
        ]}));
        assert_eq!(hidden["clients"][0]["mluvka"], true);
        assert_eq!(hidden["clients"][0]["sharing"], false);

        let viewers: Vec<_> = (10..17)
            .map(|id| join(&registry, "example.org:9987", id, 1))
            .collect();
        for (viewer, _) in &viewers[..6] {
            signal(viewer, "watch", &a.id).unwrap();
        }
        assert_eq!(
            signal(&viewers[6].0, "watch", &a.id),
            Err("Sdílení může sledovat nejvýše 6 diváků.")
        );
        signal(&viewers[0].0, "watch", &a.id).unwrap(); // ICE restart nerezervuje další místo.
        signal(&viewers[0].0, "unwatch", &a.id).unwrap();
        signal(&viewers[6].0, "watch", &a.id).unwrap();
        let token = a.token.clone();
        assert!(registry.ice_uid(&token).is_ok());
        assert_eq!(
            registry.ice_uid(&a.id),
            Err(axum::http::StatusCode::UNAUTHORIZED)
        );
        a.snapshot(json!({"self":1,"clients":[{"id":1,"channel":2,"uid":"uid-1","name":"A"}]}));
        assert!(
            registry
                .0
                .lock()
                .unwrap()
                .values()
                .all(|m| m.watching.is_none())
        );
        assert!(signal(&viewers[0].0, "watch", &a.id).is_err());
        drop(a);
        assert_eq!(
            registry.ice_uid(&token),
            Err(axum::http::StatusCode::UNAUTHORIZED)
        );
    }
    #[test]
    fn forwarding_binds_sender_and_requires_requested_direction() {
        let registry = Arc::new(Registry::default());
        let (a, _a_rx) = join(&registry, "example.org:9987", 1, 1);
        let (b, mut b_rx) = join(&registry, "example.org:9987", 2, 1);
        signal(&a, "share_start", "").unwrap();
        let mut offer = json!({"type":"rtc_offer","v":1,"kind":"screen","to":b.id,"from":"forged","call":"one","sdp":{"type":"offer","sdp":"v=0"}});
        assert!(a.handle(&offer, 100).is_err());
        signal(&b, "watch", &a.id).unwrap();
        a.handle(&offer, 20000).unwrap();
        let mut forwarded = None;
        while let Ok(Message::Text(s)) = b_rx.try_recv() {
            let value: Value = serde_json::from_str(&s).unwrap();
            if value["type"] == "rtc_offer" {
                forwarded = Some(value);
            }
        }
        assert_eq!(forwarded.unwrap()["from"], a.id);
        assert!(a.handle(&offer, 33000).is_err());
        offer["v"] = json!(2);
        assert!(a.handle(&offer, 100).is_err());
        assert!(
            a.handle(&json!({"type":"share_start","kind":"control","v":1}), 100)
                .is_err()
        );
        signal(&a, "share_stop", "").unwrap();
        offer["v"] = json!(1);
        assert!(a.handle(&offer, 100).is_err());
    }
}
