# Protokol Mluvky v1

Jedno spojení na `/ws` = jeden TS3 klient. WS má stejný origin jako stránka (`ws://` lokálně,
`wss://` přes HTTPS). HTTPS ukončuje Traefik. Žádné cookies ani serverové účty.
Zavření WS odpojí TS a ztráta TS ukončí WS; opětovné připojení vytváří nové spojení.

## Prohlížeč → backend (JSON)

Všechny zprávy jsou objekt s polem `type`:

| `type` | Pole | Význam |
| --- | --- | --- |
| `connect` | `nickname: string`, `server: string`, `password?: string`, `channel?: string`, `channel_password?: string`, `identity?: string \| null` | První zpráva, do 15 s. Server `host[:port]` (9987), IPv6 `[adresa]:port`. Kanál názvem/cestou. Hesla prostým textem uvnitř WSS; TS hash vytvoří backend. |
| `move` | `channel: number`, `password?: string` | Přesun vlastního klienta podle ID kanálu. |
| `chat` | `target: "channel" \| "server" \| "private"`, `client?: number`, `text: string` | Soukromý chat vyžaduje `client`. Text má 1–4000 bajtů UTF-8. |
| `mute` | `microphone: boolean`, `deafen: boolean` | Nastavení obou TS příznaků. Deafen potlačí příjem i vysílání. |
| `peer` | `uid: string`, `volume: number`, `muted: boolean` | Lokální příjem jednoho UID, hlasitost 0–2. Ztlumený hlas se nevloží do mixovací fronty; stará fronta se odstraní. |
| `disconnect` | — | Ukončení TS i WS. |

```json
{"type":"connect","nickname":"Mluvka","server":"ts.example.org","identity":null}
```

Po prvním `state` klient odešle uložené `mute` a `peer`. TS příkazy se interně potvrzují
pomocí `return_code`; odmítnutí vyvolá `error`, změnu stavu potvrdí `state`.
Checkboxy zapamatování jsou klientské; dodatečná pole backend ignoruje.

## Backend → prohlížeč (JSON)

| `type` | Pole | Význam |
| --- | --- | --- |
| `identity` | `identity: string`, `uid: string`, `level: number` | Privátní text `čítačVbase64-klíč` se uloží do `mluvka.identity`. Nová identita má úroveň ≥8. Posílá se znovu i při zvýšení úrovně požadovaném TS serverem. `uid` je veřejná identita. |
| `state` | `name: string`, `self: number`, `channels: Channel[]`, `clients: Client[]` | Úplný snímek po připojení a změnách TS knihy. První snímek může být bez klientů, další jej doplní. |
| `talking` | `client: number`, `active: boolean` | Indikátor příchodu hlasových paketů; po 300 ms bez paketu `false`. Lokální mute ho nepotlačí. Vlastní indikátor řídí mikrofon v prohlížeči. |
| `chat` | `target: "channel" \| "server" \| "private"`, `client: number \| null`, `from: number`, `name: string`, `text: string` | `from` je odesílatel, `client` příjemce soukromé zprávy. Vlastní odeslanou zprávu přidává UI ihned, TS ji nemusí vrátit. |
| `poke` | `target: "poke"`, `client: number`, `from: number`, `name: string`, `text: string` | Výrazné upozornění na šťouchnutí. |
| `notice` | `message: string` | Česká informace, například pokus s přezdívkou doplněnou o `1`. |
| `error` | `message: string` | Česká chyba. Odmítnutí příkazu nechá spojení otevřené; chyba připojení, protokolu, limitu nebo výpadek vede k uzavření WS. |

`Channel`: `{id: number, parent: number, order: number, name: string, password: boolean, topic: string | null}`.
`parent: 0` = kořen; `order` = ID předchozího sourozence (0 = první), nikoli pořadové číslo.

`Client`: `{id: number, channel: number, uid: string | null, name: string, microphone: boolean, deafen: boolean, away: boolean}`.
Příznaky mikrofonu/výstupu znamenají ztlumení či nedostupný hardware. Bez UID se lokální
nastavení neukládá; nikdy se nenahrazuje přezdívkou. Rozsah viditelnosti podléhá TS oprávněním.

## Binární audio

Přesně **1921 bajtů**, v obou směrech:

| Pozice | Délka | Obsah |
| --- | --- | --- |
| 0 | 1 B | `0x01` mikrofon → backend; `0x02` backend → reproduktory |
| 1 | 1920 B | 960 vzorků signed Int16 LE, mono, 48 000 Hz, 20 ms |

AudioWorklet snímá 48 kHz; jiná frekvence se odmítne. Vstupní zesílení se omezí do −1 až 1.
PTT/VAD/always brána běží v klientovi, VAD drží 300 ms po překročení prahu. Test mikrofonu
přehrává lokální vstup a po dobu testu nic nevysílá. Backend ještě kontroluje mute/deafen
a TS oprávnění k vysílání.

Backend kóduje mono OpusVoice, `AudioHandler` dekóduje a mixuje ve stereu; výsledek se
průměruje do mono a omezí proti přetečení. Dolů se posílá 50 rámců/s včetně ticha.
Přehrávání začne po 4 rámcích (80 ms); při výpadku znovu předbufferuje, při více než 8 rámcích
zkrátí frontu na 4. TS `AudioHandler` má navíc vlastní adaptivní jitter buffer.

`window.__mluvkaStats`: `receivedFrames`, `sentFrames`, `rms` (poslední přijatý rámec před hlavní
hlasitostí), `micRms`, `underruns`, `droppedFrames`, `uid`, `sampleRate`. Jde o diagnostiku
skutečného audio toku, nikoli generátor testovacích dat.

## Limity

- WS rámec i zpráva ≤16 KiB; binární audio přesně 1921 B.
- Nejvýše 40 řídicích a 100 audio zpráv/s/relaci; překročení ukončí spojení.
- `MAX_SESSIONS` (20) zahrnuje čekající WS; vyčerpání → HTTP 503.
- Neshodný `Origin` a `Host` → HTTP 403. Vite proxy origin přepisuje.
- WS ping po 10 s, bez pong déle než 30 s konec. Browser pong posílá sám.
- DNS 5 s, připojení TS 25 s, potvrzení příkazu 10 s, WS zápis 2 s.
- `ALLOWED_SERVERS` se porovnává po normalizaci hostu/portu. Poté se předá pevná IP;
  TS nickname a SRV přesměrování se nepoužívá.
- Identity a hesla se neukládají na backendu; TS paketové logování je vypnuté i při `RUST_LOG=trace`.
