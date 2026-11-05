# Ověření sdílení obrazovky

Worktree `mluvka-sdileni`, větev `sdileni`, výchozí commit `81110d7`.

## Lokální kontroly

- `cargo clippy --all-targets -- -D warnings`: exit 0.
- `cargo test`: 14 prošlo, 0 selhalo. Nové testy pokrývají autorizaci a izolaci místností,
  limit šesti diváků, směr signalizace, odmítnutí podvrženého odesílatele, zánik oprávnění
  při přesunu/odpojení a tvorbu TURN REST údajů na 12 hodin.
- `cargo build --release`: exit 0.
- `npm run typecheck`: exit 0.
- `VITE_E2E_SHARING=0 npm run build`: exit 0 po kompletním E2E. Produkční JS neobsahuje `__mluvkaShareTest`; testovací relay přepínač je odstraněný.
- Živý lokální `GET /api/ice` bez Authorization: HTTP 401.
- Lokální coturn úspěšně přijal šablonu `deploy/coturn/turnserver.conf.example`, včetně IPv6
  `denied-peer-ip`; pro tuto kontrolu se hodnoty doplnily pouze do dočasného souboru mimo repozitář.
  Proces i soubor byly odstraněny. Testovací coturn se rovněž úspěšně spustil a ukončil.

## E2E

První úplný pokus na `E2E_PORT=3105` skončil před otevřením frontendu: cizí Node server
naslouchající na `127.0.0.1:3105` přebíral požadavky a vracel 502. Cizí proces nebyl ukončen.
Opakování používá `E2E_PORT=3115`, `TS3_VOICE_PORT=9105`, `TS3_QUERY_PORT=10105`,
`TS3_FT_PORT=30105` a společný mkdir zámek `/Users/paveldvorak/.prace/mluvka-ts3.lock`.

Úplné opakování `E2E_PORT=3115 TS3_VOICE_PORT=9105 TS3_QUERY_PORT=10105 TS3_FT_PORT=30105 npm run e2e`
skončilo s exit 0. Zámek byl držen po celý běh a uvolněn po ukončení TS3; lokální coturn byl ukončen
v `finally`. Při čekání na obsazený TS3 byl interval kontroly zámku zkrácen na 1 s.

- Oba průchody Opus/PCM: exit 0, `complete:true`, celkem 196 kontrol a `errors:[]`.
- Sdílení: 11 scénářů × 2 kodekové průchody = 22 úspěšných kontrol.
- Přímý přenos: rostoucí `framesDecoded` alespoň 5,2 s, 1280×720.
- TURN REST: vynucený `iceTransportPolicy:relay`, skutečný coturn, video i zvuková stopa,
  kandidát `relay`; například PCM naměřilo 9 → 156 dekódovaných snímků při 30 fps.
- Sedmý divák odmítnut českou hláškou po obsazení šesti míst simulovanými WS relacemi.
- Jiný kanál nevidí kartu ani ikonu, nemůže poslat platný `watch`; přenos i karta zanikají do 2 s.
- WS reconnect obnoví sledování; `online` vyvolá ICE restart s novým ufrag a video pokračuje.
- Dva lidé mohou současně sdílet i sledovat; zastavení vlastního vysílání zachová sledování.
- iPhone emulace na šířku přehrává relay video, pinch mění scale videa, stránka zůstává 1.
- Tlačítko i systémové `track.onended` ukončí vysílání a všechny diváky.

Úplný report: `docs/e2e-vysledky.json`; samostatný výpis sdílení: `docs/sdileni-vysledky.json`.
Prohlédnuté screenshoty: `docs/screenshots/sdileni-desktop-sdilejici.png`,
`docs/screenshots/sdileni-desktop-divak.png`, `docs/screenshots/sdileni-mobil-sirka.png`.
Mobilní snímek zachycuje přiblížení 2,3× při celoplošném přehrávání na šířku.

## Mimo lokální ověření

Fyzický mobil přes mobilní data, nativní systémový výběr zdroje obrazovky a samostatné
enginy Firefox/Safari/Edge nebyly dostupné v automatizovaném Chrome testu.
Easypanel ani produkční coturn nebyly měněny nebo testovány.
Pro Martina je přesný seznam DNS, portů a env v `deploy/coturn/README.md`.
