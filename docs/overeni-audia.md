# Ověření oprav přejímky #1291 — 5. 11. 2026

Přejímka není úplně zelená: `npm run e2e` má `complete: false`; konkrétní neúspěchy jsou níže.
Strojový report: [e2e-vysledky.json](e2e-vysledky.json), čas UTC `2026-11-04T23:52:02.273Z`.

## Opravy

- Neznámý příkaz TS vrací `request_failed` a obecnou zprávu; DNS/transport má vlastní mapování. Kick se odvozuje z důvodu odebrání vlastního klienta, ukončení TS spojení má `server_closed`.
- Worklet žádá o dočasné PLC až po skutečném podtečení. Rezerva pod cílem sama PLC nevyvolá; VM kontroluje nulové PLC také při driftu ±1 %.
- Při Burst dohánění dostane writer prostor mezi rámci; audio fronta má 16 rámců a TCP používá `TCP_NODELAY`. TS pollování nečeká na zápis do WS.
- Backend toleruje 45 s bez pong/ping. Frontend rozpoznává síťové ticho po 20 s, ale po pauze JS nechá zpracovat čekající zprávy.
- Původní údaj o odchodu byl bez `reasonid` (test ukazoval `NaN`), nikoli důkaz ping timeoutu. Knihovna bez `.reason(...)` důvod neodesílá. Všechny cesty nyní používají `Reason::Clientdisconnect` (8), včetně restartu a chyb WS.
- Export identity TS používá pevný 32B soukromý skalár. Parser knihovny u starého ASN.1 exportu odmítal klíče začínající nulou. Nový test ověřuje zachování counteru, UID i import dříve platného formátu. Gitová identita se neměnila.

## Buildy a jednotkové kontroly

- `cargo clippy --all-targets -- -D warnings`: exit 0.
- `cargo test`: 11 prošlo, 0 selhalo; obsahuje ChannelInvalidId → request_failed, kick, falešný ban, flood a obnovu identity s počáteční nulou.
- `cargo build --release`: exit 0.
- `npm run typecheck`, `npm run build`: exit 0.
- `prohlizec kontrola http://localhost:3001 docs/kontrola-slouceni`: exit 0; desktop/tmavý/mobil, 0 px přesah, žádné JS ani konzolové chyby. [Souhrn](kontrola-slouceni/souhrn.json).

## Poslední úplný běh

| Transport | Výsledek tónu | Podtečení / PLC | Buffer ms | Max. skok | FFT Hz | RMS rozdíl dB | Max. dolů kb/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| opus | FAIL | 2 / 10 | 66.2–247.9 | 0.01528 | 439.45 | -0.0890 | 103.29 |
| pcm | FAIL | 1 / 0 | 55.1–210.1 | 0.11160 | 439.45 | -0.0435 | 776.32 |

Oba čisté 30s tóny mají stejné asserty: 0 podtečení, 0 PLC, buffer 40–120 ms, skok <0,3, FFT 440±5 Hz a RMS ±1,5 dB. Opus navíc ≤130 kb/s.

| Transport | Síť 1,5 Mb/s / 80 ms: podtečení / PLC | Dolů kb/s | Pauza JS 20 s | SIGTERM |
| --- | --- | --- | --- | --- |
| opus | 2 / 10 | 98.50 | TS spojení zachováno | 4 ms, důvody [8] |
| pcm | 0 / 0 | 783.47 | TS spojení zachováno | 3 ms, důvody [8] |

Ve zhoršené síti je pro Opus vyžadováno 0 podtečení; PCM je srovnání podle zadání G. Čistý PCM tón výjimku nemá.

- VAD opus: začátek 0.121 dB, předběh 100 ms, ztracený začátek 0 ms.
- VAD pcm: začátek -0.043 dB, předběh 60 ms, ztracený začátek 20 ms.
- Drift 1.01, 60 s: 0 podtečení / 0 zahození, korekce 1.028 %.
- Drift 0.99, 60 s: 0 podtečení / 0 zahození, korekce -0.992 %.
- opus: 85/87 kontrol OK.
- pcm: 86/87 kontrol OK.

Neúspěšné kontroly:
- opus: TS3 tón 440 Hz / opus, 30 s bez podtečení — {"test": "TS3 tón 440 Hz / opus, 30 s bez podtečení", "result": "FAIL", "underruns": 2, "plcFrames": 10, "lostFrames": 0, "binaryGapMs": 328.59999990463257, "path": "native", "maxJump": 0.015282787382602692, "minBufferMs": 66.18176411126237, "maxBufferMs": 247.92074006251642, "dominantHz": 439.453125, "rmsDifferenceDb": -0.08904654023132486, "maxDownKbps": 103.29084132212084, "runCodec": "opus"}
- opus: CDP síť 1,5 Mb/s / 80 ms, opus, 30 s — {"test": "CDP síť 1,5 Mb/s / 80 ms, opus, 30 s", "result": "FAIL", "underruns": 2, "downKbps": 98.49688086999367, "plcFrames": 10, "lostFrames": 0, "inputGapMs": 185.77549999999974, "outputGapMs": 141.7732079999987, "comparisonOnly": false, "note": "CDP a samostatný TCP shaper 1,5 Mb/s / 80 ms; PCM je srovnávací měření.", "runCodec": "opus"}
- pcm: TS3 tón 440 Hz / pcm, 30 s bez podtečení — {"test": "TS3 tón 440 Hz / pcm, 30 s bez podtečení", "result": "FAIL", "underruns": 1, "plcFrames": 0, "lostFrames": 0, "binaryGapMs": 204.09999990463257, "path": "native", "maxJump": 0.11160468682646751, "minBufferMs": 55.0680907733719, "maxBufferMs": 210.13556705106748, "dominantHz": 439.453125, "rmsDifferenceDb": -0.04353433209497332, "maxDownKbps": 776.3153724980539, "runCodec": "pcm"}

## Metodika a omezení

Čistý tón běží přes nativní WebSocket bez testovacího prostředníka. Síťová fáze naváže nové WS přes samostatný TCP proces (`e2e/ws-shaper.mjs`) a zapne CDP emulaci. Proxy má FIFO, byte pacing a zachová data před FIN; vlastní zkouška přenáší 12 000 B s latencí ≥70 ms a dobou přenosu ≥55 ms. Playwright tak neřídí časování každého hlasového rámce svými RPC.
RMS reference je mikrofonní signál za kompresorem. Výstupní RMS integruje worklet, FFT se sčítá během 30 s z AnalyserNode. Zbytečný přenos 16 384 vzorků přes Playwright byl odstraněn. Žádný assert čistého tónu nebyl změkčen. Selhání měření se uloží jako FAIL a zůstane exit 1; nezávislé další kontroly i druhý kodek přesto doběhnou. Diagnostické režimy nemohou vyrobit complete: true.
Nejdelší mezera doručení v posledním čistém tónu byla 328.6 ms. Při požadavku nejvýše 120 ms rezervy nelze delší pauzu zaručeně překlenout bez náhrady zvuku. Dřívější [diagnostika](audio-jitter-diagnostika.json) ukazuje další 178ms pauzu. Rozlišení příčiny (backend/OS proti doručení na hlavní vlákno prohlížeče) není dokončené. Výsledky výše popisují konkrétní běh.
Upozornění, nepřečtené, pozvánky, rich chat a upload mají v reportu samostatné kontroly v obou transportech. Mobilní emulace ověřuje scale 1, fonty ≥16 px, dotykové PTT, layout a obnovu hovoru.

Neověřeno: Martinův skutečný TS klient, fyzický iOS/Android, Bluetooth a Easypanel. Docker build podle zadání nebyl spuštěn. Práce zůstává v lokálních commitech větve vyvoj.
