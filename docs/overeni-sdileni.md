# Ověření oprav sdílení po přejímce #1301

Větev `sdileni`, navázání na `b3330c3`. Výsledky níže patří poslednímu úplnému běhu po opravách.

## Příkazy a výsledky

- `cargo clippy --all-targets -- -D warnings`: exit 0.
- `cargo test`: 16 prošlo, 0 selhalo.
- `cargo build --release`: exit 0; binární soubor byl sestaven před závěrečným E2E.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0; znovu se spouští i ve `finally` E2E bez proměnné `VITE_E2E_SHARING`.
- `node e2e/sdileni-controller.mjs`: exit 0, tři kontrakty (pozdní snapshot/ack, timeout bez TURN, nejvýše tři pokusy s TURN).
- `E2E_PORT=3115 TS3_VOICE_PORT=9105 TS3_QUERY_PORT=10105 TS3_FT_PORT=30105 npm run e2e`: exit 0.
  Celý příkaz běžel pod atomickým mkdir zámkem `/Users/paveldvorak/.prace/mluvka-ts3.lock`.
  Zámek byl po dokončení uvolněn, vlastní TS3 a coturn ukončeny; porty 3115, 3116 a 3479 zůstaly volné.
- Úplný [report](e2e-vysledky.json): `complete:true`, Opus 104 OK + PCM 104 OK, `errors:[]`.
  [Výpis sdílení](sdileni-vysledky.json): 17 scénářů v každém kodeku, celkem 34 OK.
- Kontrola všech JS v `dist/assets` po E2E: `__mluvkaShareTest` nenalezen.
  Vite ukládá produkční frontend do kořenového `dist`.
- `prohlizec kontrola http://localhost:3115 /tmp/mluvka-sdileni-kontrola-oprav`: exit 0,
  desktop/tmavý/mobil bez výjimek, chyb konzole a vodorovného přesahu. Tato kontrola pokrývá přihlášení;
  přihlášené sdílení pokrývají E2E a čtyři snímky níže. Výstup kontroly je mimo repozitář.
- `test ! -e docs/kontrola-sdileni`: exit 0.

## Doklady jednotlivých oprav

| Pozorované chování | Implementace a kontrola |
| --- | --- |
| Ze 120 přepnutí se přijme 5; soused dostane 5 seznamů, jiný TS server žádný; shodný seznam se neopakuje. | `src/signal.rs:44`, `src/signal.rs:208`, test `src/signal.rs:384`. |
| Po burstu 500 zpráv přijde nefatální chyba, pong a další hlasové rámce. | `src/session.rs:736`, `e2e/sdileni.mjs:202`. |
| Starší snapshot zachová capture do potvrzení; pozdní ack po zrušení odešle stop; plná fronta nezveřejní sdílení. | `frontend/src/sdileni/controller.ts:191`, `src/signal.rs:361`, `e2e/sdileni-controller.mjs`. |
| Backend bez ICE serverů přenese video přes host kandidáta; zablokovaný offer skončí po 10 s chybou a uvolní místo. | `e2e/sdileni.mjs:625`, `frontend/src/sdileni/controller.ts:526`. |
| Klepnutí na jméno otevře uživatele; tlačítko panelu i ikona spustí video. | `frontend/src/App.tsx:1114`, `frontend/src/App.tsx:2188`, `e2e/sdileni.mjs:297`. |
| Přítomnost Mluvky je SVG bez samostatného textového písmene. | `frontend/src/App.tsx:1122`, `frontend/src/sdileni/Sdileni.tsx:22`, `e2e/sdileni.mjs:289`. |
| Lišta zůstane v jednom řádku; okna 1440/1024/768 px nemají přesah. | `frontend/src/sdileni/Sdileni.tsx:67`, `e2e/sdileni.mjs:325`. |
| Produkční build se obnoví i po chybě testů. | `e2e/all.mjs:131`; ověřeno také po neúspěšných pracovních bězích a finálně po úspěšném běhu. |

## Prohlédnuté snímky

- [Desktop sdílející](screenshots/sdileni-desktop-sdilejici.png): 1440 × 900, stav s jedním divákem v původní liště.
- [Desktop divák](screenshots/sdileni-desktop-divak.png): 1440 × 900, video, karta a lišta v jednom řádku.
- [Mobil na šířku](screenshots/sdileni-mobil-sirka.png): 852 × 393, relay přenos a přiblížení videa 2,3×; stránka scale 1.
- [Mobilní lišta](screenshots/sdileni-mobil-lista.png): 393 × 852, bez přesahu a bez dalšího řádku pro sdílení.

## Mimo lokální ověření

Fyzický telefon přes mobilní data a přepnutí Wi-Fi ↔ mobilní síť, nativní Safari/iOS fullscreen,
reálný systémový výběr obrazovky a zvuku ani samostatné enginy Firefox/Edge/Safari nebyly ověřeny:
E2E používá čistý headless Chrome, mobilní emulaci a canvas náhradu capture.
Easypanel a produkční TURN nebyly měněny ani testovány. Provozní DNS/porty/env pro Martina jsou
v [návodu coturn](../deploy/coturn/README.md).

## Lokální commity implementace a testů

- `55d86ea` — MLU-3 - omezení změn sdílení a seznamů na stejný server.
- `9957594` — MLU-3 - zahlcení signalizace zachová TS spojení a hlas.
- `14968fc` — MLU-3 - potvrzení startu ochrání stream před opožděným seznamem.
- `f1b48cd` — MLU-3 - odstranění nadbytečných snímků přihlášení.
- `fd3a176` — MLU-3 - konečný stav bez TURN a ověření přímého přenosu.
- `a3a3fe5` — MLU-3 - sledování z panelu uživatele a ikony ve stromu.
- `33fe28e` — MLU-3 - nenápadná ikona připojení přes Mluvku.
- `7e16343` — MLU-3 - sdílení v jediném tlačítku lišty s podrobným panelem.
- `fc5df4b` — MLU-3 - po každém E2E obnovit produkční frontend.
- `29bb791` — MLU-3 - oddělení zátěžového burstu od dalšího sledování.
- `3bfb516` — MLU-3 - ověření lišty i v užším desktopovém okně.
- `d3c4e98` — MLU-3 - popis obnov spojení a ověřená dostupnost TURN.
- `0c34318` — MLU-3 - samostatný test pozdních potvrzení a konečných obnov.
- `c4713fa` — MLU-3 - stabilní snímky lišty a samostatné spuštění testu řízení.
- `5355cf8` — MLU-3 - vrácení mobilního pohledu po testu sledování z panelu.
- `e828ace` — MLU-3 - odmítnuté potvrzení startu nezanechá aktivní sdílení.
- `d48f28c` — MLU-3 - test ztlumení rozliší stavové ikony od značky Mluvky.
