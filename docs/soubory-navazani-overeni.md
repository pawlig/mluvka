# Navázání souborové přejímky #1299 (5. 11. 2026)

Větev `soubory`, samostatný worktree `mluvka-soubory`, pouze lokální commit.

## Příkazy a výsledky

- `cargo clippy --all-targets -- -D warnings`: exit 0.
- `cargo test`: exit 0, 15 testů. Nové testy: autoritativní UID, kapacita včetně JSON,
  osiřelá metadata, úklid po I/O chybě a rozlišení disk/kvóta 507 od ostatních chyb 500.
- `cargo build --release`: exit 0.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0; stávající upozornění bundleru na `node:module` v libopus-wasm.
- Celý `npm run e2e`: exit 0, Opus i PCM, **188 OK**, `scope: "all"`, `complete: true`,
  žádná chyba JS/konzole. [Strojový report](e2e-vysledky.json).
  Běh držel sdílený zámek `/Users/paveldvorak/.prace/mluvka-ts3.lock` přes oba transporty;
  `E2E_PORT=3103 TS3_VOICE_PORT=9103 TS3_QUERY_PORT=10103 TS3_FT_PORT=30103`.

Známé přísné zvukové kontroly PLC/podtečení/zahozených rámců v tomto běhu **prošly**
pro oba transporty. Prošla také síť a VAD; `knownAudioFailures: []`.
Limity zůstaly zachované. E2E při případné chybě tónu/sítě/VAD zapíše `KNOWN_AUDIO_FAILURE`
a pokračuje dalšími scénáři. Chyby chatu, souborů a konzole jsou dál fatální.
Historický neúspěch před navázáním zůstává v [původním dokladu](soubory-cely-beh-selhani.json).

## Nové pokrytí

- ServerQuery `notifytextmessage` zachytil skutečný odchozí text: holé `/img/*.jpg|png`,
  žádné `[IMG]`; u příjemce načtené náhledy. Fotografie JPEG, průhlednost a malá paleta PNG.
  PNG s EXIF/GPS po canvasu bez metadat, GIF bajtově zachovaný, starší příjem `[IMG]` funguje.
- PětimiB ZIP odeslaný composerem: holá URL a text jména/velikosti bez `[URL]`,
  karta v Mluvce zachová i velikost; download a SHA-256 shodné. Hlavičky attachment,
  octet-stream, nosniff a CSP. HTML se stáhne jako příloha. Limity 413 a autentizace 401.
- Skutečný TS3 FT včetně kanálu s heslem: SHA-256 shodné. Stejné serverUID dovolí
  jiný host i port v odkazu, bez síťového připojování na tento alias. Cizí UID/host odmítnuty.
  Oprávnění TS serveru rozhodují i při stahování z jiného kanálu aktuálního serveru.
- Native download: zrušený čekající fetch, žádná chybová hláška; řízený stream 25 %
  a dokončené bajty. Mobil odmítne >50 MiB z odkazu i z Content-Length. Implementace
  kontroluje limit rovněž za běhu čtení, i bez Content-Length.
- Skloňování composeru ověřené pro 1, 2 a 5 souborů; výběr více souborů zpracován postupně.
- TS5/6 ZIP: 108,7 kB, vysvětlení myTeamSpeak, žádný surový JSON; soukromá žádost doručena.
- Mobilní karty bez vodorovného přesahu, picker bez `accept`; externí příloha bez fetch.

Aktuální tvar `ts3file://`, primární zdroj a bezpečnost API jsou v [protokolu](protokol.md#přílohy-a-nativní-přenos-ts).
V `App.tsx` a `session.rs` je změna pouze v předání veřejného UID serveru pro kartu.
Zvukový řetězec ani reconnect se neměnily.

## Vizuální kontrola

`prohlizec kontrola http://127.0.0.1:3193 /tmp/mluvka-soubory-navazani-ui-vlastni`: exit 0,
desktop/tmavý/mobil bez přesahu, chyb JS a konzole. [Výsledek](screenshots/soubory-ui-kontrola.json).
Snímky vlastního backendu i všech šest výsledných karet byly vizuálně prohlédnuty:
čitelné názvy, velikosti, ovládání uvnitř karet a zalomený text TS5/6 na mobilu.

| Karta | Desktop | Mobil |
| --- | --- | --- |
| Mluvka | [snímek](screenshots/soubory-mluvka-desktop.png) | [snímek](screenshots/soubory-mluvka-mobil.png) |
| TS3 | [snímek](screenshots/soubory-ts3-desktop.png) | [snímek](screenshots/soubory-ts3-mobil.png) |
| TS5/6 | [snímek](screenshots/soubory-ts56-desktop.png) | [snímek](screenshots/soubory-ts56-mobil.png) |

## Neověřené prostředí

Nativní desktopový TS3 ani TS5/6 klient není k dispozici; ověřená je skutečná zpráva
na TS3 serveru, FT a dva emulované prohlížeče. Skutečný mobilní systémový picker nebyl
spuštěn, výběr souborů a rozložení kontroluje Chrome emulace. Disk nebyl fyzicky zaplněn;
chybový návrat a úklid ověřují unit testy. Port 30033 nebyl blokován firewallem.
Volitelné posílání přímo do úložiště TS kanálu zůstává mimo tuto implementaci.
