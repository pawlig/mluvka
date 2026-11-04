# Protokol Mluvky v1

Jedno spojení na `/ws` = jeden TS3 klient. WS má stejný origin jako stránka (`ws://` lokálně,
`wss://` přes HTTPS). HTTPS ukončuje Traefik. Žádné cookies ani serverové účty.
Zavření WS odpojí TS a ztráta TS ukončí WS; opětovné připojení vytváří nové spojení.

## Prohlížeč → backend (JSON)

Všechny zprávy jsou objekt s polem `type`:

| `type`       | Pole                                                                                                                                                                                                                   | Význam                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`    | `nickname: string`, `server: string`, `password?: string`, `channel?: string`, `channel_password?: string`, `identity?: string \| null`, `audio?: {codec: "opus" \| "pcm", version: 1, quality?: "high" \| "economy"}` | První zpráva, do 15 s. Server `host[:port]` (9987), IPv6 `[adresa]:port`. Kanál názvem/cestou. Hesla prostým textem uvnitř WSS; TS hash vytvoří backend. |
| `move`       | `channel: number`, `password?: string`                                                                                                                                                                                 | Přesun vlastního klienta podle ID kanálu.                                                                                                                |
| `chat`       | `target: "channel" \| "server" \| "private"`, `client?: number`, `text: string`                                                                                                                                        | Soukromý chat vyžaduje `client`. Text má 1–4000 bajtů UTF-8.                                                                                             |
| `mute`       | `microphone: boolean`, `deafen: boolean`                                                                                                                                                                               | Nastavení obou TS příznaků. Deafen potlačí příjem i vysílání.                                                                                            |
| `peer`       | `uid: string`, `volume: number`, `muted: boolean`                                                                                                                                                                      | Lokální příjem jednoho UID, hlasitost 0–2. Ztlumený hlas se nevloží do mixovací fronty; stará fronta se odstraní.                                        |
| `ping`       | —                                                                                                                                                                                                                      | Aplikační heartbeat každých 10 s po připojení; backend odpoví JSON `pong`.                                                                               |
| `disconnect` | —                                                                                                                                                                                                                      | Ukončení TS i WS.                                                                                                                                        |

```json
{
  "type": "connect",
  "nickname": "Mluvka",
  "server": "ts.example.org",
  "identity": null
}
```

Po prvním `state` klient odešle uložené `mute` a `peer`. TS příkazy se interně potvrzují
pomocí `return_code`; odmítnutí vyvolá `error`, změnu stavu potvrdí `state`.
Checkboxy zapamatování jsou klientské; dodatečná pole backend ignoruje.

## Backend → prohlížeč (JSON)

| `type`     | Pole                                                                                                                   | Význam                                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`    | `audio: {codec: "opus" \| "pcm", version: 1, quality: string}`                                                         | Vyjednaný transport, před prvním `state`. Bez nabídky Opus v1 se použije PCM.                                                                                                         |
| `identity` | `identity: string`, `uid: string`, `level: number`                                                                     | Privátní text `čítačVbase64-klíč` se uloží do `mluvka.identity`. Nová identita má úroveň ≥8. Posílá se znovu i při zvýšení úrovně požadovaném TS serverem. `uid` je veřejná identita. |
| `state`    | `name: string`, `self: number`, `channels: Channel[]`, `clients: Client[]`                                             | Úplný snímek po připojení a změnách TS knihy. První snímek může být bez klientů, další jej doplní.                                                                                    |
| `talking`  | `client: number`, `active: boolean`                                                                                    | Indikátor příchodu hlasových paketů; po 300 ms bez paketu `false`. Lokální mute ho nepotlačí. Vlastní indikátor řídí mikrofon v prohlížeči.                                           |
| `chat`     | `target: "channel" \| "server" \| "private"`, `client: number \| null`, `from: number`, `name: string`, `text: string` | `from` je odesílatel, `client` příjemce soukromé zprávy. Vlastní odeslanou zprávu přidává UI ihned, TS ji nemusí vrátit.                                                              |
| `poke`     | `target: "poke"`, `client: number`, `from: number`, `name: string`, `text: string`                                     | Výrazné upozornění na šťouchnutí.                                                                                                                                                     |
| `notice`   | `message: string`                                                                                                      | Česká informace, například pokus s přezdívkou doplněnou o `1`.                                                                                                                        |
| `pong`     | —                                                                                                                      | Odpověď na JSON `ping`, také každých 10 s spolu s WS pingem.                                                                                                                          |
| `error`    | `code: string`, `message: string`, `fatal: boolean`, `field: string`                                                   | Česká chyba. Odmítnutí příkazu nechá spojení otevřené; chyba připojení, protokolu, limitu nebo výpadek vede k uzavření WS.                                                            |

`Channel`: `{id: number, parent: number, order: number, name: string, password: boolean, topic: string | null}`.
`parent: 0` = kořen; `order` = ID předchozího sourozence (0 = první), nikoli pořadové číslo.

`Client`: `{id: number, channel: number, uid: string | null, name: string, microphone: boolean, deafen: boolean, away: boolean}`.
Příznaky mikrofonu/výstupu znamenají ztlumení či nedostupný hardware. Bez UID se lokální
nastavení neukládá; nikdy se nenahrazuje přezdívkou. Rozsah viditelnosti podléhá TS oprávněním.

## Binární audio

Všechny rámce nesou mono 48 kHz, 20 ms (960 vzorků). První bajt je typ:

| Typ    | Směr         | Zbytek rámce                                                  |
| ------ | ------------ | ------------------------------------------------------------- |
| `0x01` | nahoru, PCM  | 1920 B signed Int16 LE (celkem 1921 B)                        |
| `0x02` | dolů, PCM    | 1920 B signed Int16 LE (celkem 1921 B)                        |
| `0x03` | nahoru, Opus | jeden raw Opus paket (bez Ogg/WebM), nejvýše 1275 B           |
| `0x04` | dolů, Opus   | uint32 LE pořadí rámce + jeden raw Opus paket, nejvýše 1275 B |

Klient načte WASM Worker teprve při připojování a nabídne
`audio: {codec: "opus", version: 1, quality: "high"}`. Backend potvrdí `hello.audio`.
Bez nabídky, při jiné verzi nebo při selhání WASM se použije PCM. Při selhání Workeru
za běhu klient obnoví spojení s PCM nabídkou. Starší backend bez `hello` dostává PCM.
Volba `quality: "economy"` znamená 32 kb/s nahoru a 48 kb/s dolů, jinak 64/96 kb/s.
Oba enkodéry používají VBR, complexity 10, FEC a očekávanou ztrátovost 10 %, bez DTX.
Nahoru `Voip`, dolů `Audio`. Uplink Opus paket backend validuje (20 ms mono) a posílá
beze změny jako TS `OpusVoice`; PCM zálohu backend kóduje.

AudioWorklet převzorkuje vstupní frekvenci na 48 kHz a příjem zpět. Mikrofon měří
VAD před kompresorem; kompresor má práh −18 dBFS, poměr 4:1, attack 5 ms, release
150 ms, předstih limiteru 5 ms a měkké omezení špiček. VAD má 100 ms předběh, 400 ms hold, první/poslední
rámec má 10 ms rampu; jeden rámec se drží pro doznění. Test nic nevysílá.
Vstupní rámec starší než 100 ms se po zdržení hlavního vlákna nezpracovává. Odchozí
dávka má nejvýše 8 rámců a doplňuje se rychlostí 50 rámců/s, v Opus i PCM režimu.

TS `AudioHandler` řadí pakety podle jejich ID a při chybějícím paketu volá Opus PLC
(`decode_float(None, …)`), případně FEC; po třech ztrátách ukončí daný hlas. Mix se
průměruje ze sterea a měkce omezuje až nad 0,8. Každý 20ms tick se odbaví (`Burst`); mezi doháněnými rámci dostane writer prostor vyprázdnit frontu.
Pořadí `0x04` umožňuje Workeru doplnit zahozené WS rámce pomocí PLC. Worklet žádá o dočasné PLC
až po skutečném podtečení, nikoli při poklesu rezervy. PCM se vrací přes přímý MessagePort,
nezávisle na hlavním vlákně; opožděný skutečný rámec obnoví stav dekodéru. Doplnění pro deadline neposouvá
pořadí na drátu: falešně pozdní pakety se nesmějí trvale odmítat. Po delším výpadku se doplňuje nejvýše 10 rámců.

Přehrávání začíná po 60 ms; při měřeném jitteru roste cíl nejvýše na 100 ms. PI regulátor mění lineární interpolaci nejvýše ±1,05 %,
aby zvládl i testovaný drift ±1 %; žádné celé rámce se běžně nezahazují. Při >300 ms
se buffer nouzově srovná na 60 ms s prolnutím. Podtečení i obnovení mají 5 ms rampu.

Diagnostika v Nastavení a `window.__mluvkaStats`: `receivedFrames`, `sentFrames`,
`rms` (dekódovaný příjem před hlasitostí), `micRms` (před kompresorem), `underruns`,
`droppedFrames` (nouzové srovnání), `droppedCaptureFrames` (starý vstup / překročená odchozí dávka), `bufferMs`, `targetBufferMs`, `driftCorrection` (procenta), `maxJump`
(maximum rozdílu sousedních výstupních vzorků), `upKbps`, `downKbps` (binární WS
payload včetně typů/pořadí, bez TCP/TLS), `plcFrames` (včetně dočasného doplnění po podtečení), `lostFrames` (skutečné mezery
pořadí na WS), `codec`, `uid`, `sampleRate`. TS ztráty se řeší uvnitř `AudioHandler`;
tyto dva PLC čítače je nezahrnují.

## Limity

- WS rámec i zpráva ≤16 KiB; binární PCM 1921 B, Opus nahoru ≤1276 B a dolů ≤1280 B.
- Nejvýše 40 řídicích a 100 audio zpráv/s/relaci; překročení ukončí spojení.
- `MAX_SESSIONS` (20) zahrnuje čekající WS; vyčerpání → HTTP 503.
- Neshodný `Origin` a `Host` → HTTP 403. Vite proxy origin přepisuje.
- WS ping a JSON pong po 10 s; společný limit bez WS pong / JSON ping je 45 s,
  UDP disconnect trvá nejvýše další 2 s. Browser WS pong posílá sám i při pozastaveném JS.
  Frontend rozpozná síťové ticho po 20 s; po zjištěné pauze hlavního vlákna nejdřív nechá doručit čekající zprávy.
- DNS 5 s, připojení TS 25 s, potvrzení příkazu 10 s, WS zápis 2 s v samostatném úkolu. Řídicí fronta 256 zpráv, audio 16 rámců; plná audio fronta rámce zahazuje (příjemce doplní PLC). Plné řízení nebo chyba writeru relaci čistě odpojí.
- `ALLOWED_SERVERS` se porovnává po normalizaci hostu/portu. Poté se předá pevná IP;
  TS nickname a SRV přesměrování se nepoužívá.
- Identity a hesla se neukládají na backendu; TS paketové logování je vypnuté i při `RUST_LOG=trace`.

## Chyby a obnovení

`code` je strojový kód, text `message` je český a neobsahuje původní text TS paketu.
`field` určuje vstup formuláře (`server`, `password`, `channel_password`, `nickname`) pro fokus.
`fatal: true` znamená ukončení relace; `fatal: false` odmítnutý příkaz v běžícím spojení.

| `code`          | Význam                                | Opakování připojení po ukončení |
| --------------- | ------------------------------------- | ------------------------------- |
| `bad_password`  | Heslo serveru nebo kanálu             | ne                              |
| `banned`        | TS `ConnectFailedBanned` (0x0d01)     | ne                              |
| `flood`         | TS `BanFlooding` / `ClientIsFlooding` | nejdříve za 120 s               |
| `not_allowed`   | Nepovolený server / oprávnění         | ne                              |
| `invalid`       | Neplatné údaje či protokol            | ne                              |
| `nickname`      | Obsazená či odmítnutá přezdívka       | ano                             |
| `request_failed` | Odmítnutý požadavek / jiná chyba | běžící relaci nepřerušuje |
| `unreachable`   | Nedostupný server / transport         | ano                             |
| `timeout`       | Vypršel čas                           | ano                             |
| `kicked`        | Vyhození ze serveru                   | ano                             |
| `server_closed` | TS server ukončil spojení             | ano                             |
| `full`          | Plný server                           | ano                             |

Po nečekaném ukončení frontend používá prodlevy 1 → 2 → 4 → 8 → 15 s, dále 15 s.
Na pozadí nové pokusy nespouští; při `online` a návratu do popředí pokus uspíší.
Ruční odpojení/zrušení vypne opakování i auto-start po reloadu stejného tabu (`sessionStorage`).
Trvalá chyba připojení vrátí formulář. Odmítnutí přesunu/chatového příkazu běžící hovor neruší.

`mluvka.login` drží volby `remember`, `passwords`, `auto`, přezdívku, server a cestu posledního
kanálu (jména od kořene oddělená `/`). Přesun se ukládá až po potvrzení v `state`;
heslo pouze při `passwords`, v paměti aktuálního spuštění se zachová i pro reconnect.

Nová relace stejného UID a normalizovaného serveru zruší starou a počká na její UDP disconnect.
Předchozí okno dostane `notice` s `code: "session_replaced"` a přestane se samo připojovat,
aby se dvě viditelná okna nepřetahovala o stejné UID. Registr žije jen v paměti procesu a uchovává slabé odkazy.
Po pádu celého backendu se může starý klient dočasně držet na TS; odmítne-li TS duplicitní UID,
reconnect vyčká na jeho timeout. Při obsazené přezdívce se použije přípona `1` a každých 10 s se po
uvolnění původního jména zkusí přejmenovat zpět. Nová identita se kvůli výpadku nevytváří.

Backend sdílí limit 6 nových TS handshake za 30 s na cílovou IP/port napříč relacemi,
včetně opakování po změně identity/přezdívky a další DNS adresy. Flood chyba navíc
blokuje všechny pokusy na daný cíl na 120 s. DNS se projde přes všechny vrácené IP;
TS odmítnutí (heslo/ban) se na jiné IP neopakuje. Loguje se jen název varianty a
číselný TS kód, bez adresy, textu serveru, identity, přezdívky nebo hesla.

SIGINT i SIGTERM rozešlou `notice` s `code: "server_restart"`, poté UDP
`clientdisconnect` s důvodem „Mluvka se aktualizuje“. Na dokončení se čeká nejvýše
3 s. Klient obnovuje stejnou identitu, přezdívku a kanál po 3 → 6 → 12 → 15 s;
aktualizace se nepočítá jako trvalá chyba. Čekání na WS zápis nikdy neblokuje pollování
TS událostí ani ping/ACK.
## Obrázky přes HTTP

Po úspěšném přihlášení k TS přijde jednou na WS `{"type":"upload_token","token":"…"}`.
Token (256 náhodných bitů) žije jen v paměti po dobu této relace, není identitou TS ani
uloženým přihlášením. Odpojení, převzetí identity nebo restart jej zruší. Frontend ho neukládá.

`POST /api/upload` přijímá **syrové bajty obrázku** s `Authorization: Bearer <token>`
a `Content-Type` obrázku, nikoli multipart ani jméno souboru. Autoritativní jsou magické
bajty PNG/JPEG/GIF/WebP. SVG/HTML → 415, přes 10 MiB (GIF 8 MiB) → 413, chybějící/neplatný
nebo zrušený token → 401, jedenáctý pokus v klouzavých 5 minutách → 429. Pokusy o upload
se počítají včetně odmítnutých formátů/velikostí. Nedostatečná kapacita pro jediný soubor → 507.
Úspěch: HTTP 201, `Cache-Control: no-store`, JSON `{"url":"https://host/img/<id>.webp"}`.
`id` má 256 náhodných bitů v base64url, příponu volí backend. Jména/obsah ani TS cíl se nelogují.

Klient před uploadem provede orientaci, resize a nové zakódování přes canvas bez EXIF/GPS;
GIF posílá beze změny. Přímé API kontroluje typ a velikost, metadata samo neodstraňuje.
URL pak odešle běžnou zprávou `chat` jako `[IMG]https://host/img/<id>.webp[/IMG]`, případně
s textem před značkou. TS3 a Mluvka zobrazí náhled, chování nativních TS5/TS6 nebylo ověřeno.

`GET /img/<id>.<ext>` je veřejný, po expiraci/odstranění vrací 404. Hlavičky:
`Content-Type: image/png|image/jpeg|image/gif|image/webp`,
`Cache-Control: public, max-age=604800, immutable`, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'`. URL z `PUBLIC_URL`, jinak `Host` a důvěryhodné
`X-Forwarded-Proto` (http/https). Produkční proxy musí tyto hlavičky přepisovat.
Úklid je při startu a každou hodinu; před zápisem se také hlídá celková kapacita.
