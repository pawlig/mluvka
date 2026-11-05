# Ověření souborů v chatu (5. 11. 2026)

Samostatný worktree `mluvka-soubory`, větev `soubory`. Bez pushování a bez změn zvukového řetězce.

- `cargo clippy --all-targets -- -D warnings`: exit 0.
- `cargo test`: exit 0, 12 testů; včetně jména, UTF-8 Content-Disposition, ts3file a traversal.
- `cargo build --release`: exit 0.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0 (stávající upozornění bundleru na node:module v libopus-wasm).
- `prohlizec kontrola http://127.0.0.1:3104 /tmp/mluvka-soubory-prohlizec`: exit 0,
  desktop/tmavý/mobil 0 px přesahu, bez chyb konzole; přihlašovací stránka.
  [Strojový výsledek](screenshots/soubory-ui-kontrola.json). Připojený chat kontroluje E2E.

Tvar nativního odkazu a primární zdroj jsou v [protokolu](protokol.md#přílohy-a-nativní-přenos-ts).
Backend používá `Connection::download_file` a výsledkové události, tedy stejnou implementaci
jako synchronní handle tsclientlib. Smyčka připojení a výsledky ostatních TS příkazů zůstávají zachované.

Skutečný desktopový TS3 ani TS5/6 klient nebyl spuštěn. Nativní přenos testuje místní TS3 server
přes ServerQuery a TCP FT. Nebyl simulován firewall blokující port 30033 ani testován skutečný
mobilní výběr systémových Soubory/Fotky; mobilní rozložení a filechooser ověřuje emulovaný Chrome.
Volitelné posílání přímo do úložiště TS kanálu není implementované.

Samostatný zamčený `E2E_FOCUS=files E2E_PORT=3103 TS3_VOICE_PORT=9103 TS3_QUERY_PORT=10103 TS3_FT_PORT=30103 npm run e2e`
skončil **exit 0 pro Opus i PCM**, 20 výsledků OK, bez chyb konzole.
[Strojový výsledek souborů](e2e-soubory.json) má `scope: "files"`; původní
[e2e-vysledky.json](e2e-vysledky.json) zachovává neúspěšný úplný běh.
Ověřeny vlastní přílohy, skutečný FT včetně hesla, české chyby (i poškozený obrázek),
privátní žádost o odkaz i všechny screenshoty. Ověření nadlimitního uploadu
používá chunked HTTP tělo bez Content-Length, tedy kontroluje i limit během čtení.
ServerQuery FT klíč se dekóduje z TS escapování; upload používá `proto=1` a server potvrdí
velikost přes `ftgetfileinfo`, následné stažení se porovná SHA-256.

Všech šest screenshotů bylo vizuálně prohlédnuto: názvy a velikosti jsou čitelné,
ovládání zůstává uvnitř karty, dlouhý název TS5/6 se na mobilu zalamuje.

| Druh | Desktop | Mobil 390 × 844 |
| --- | --- | --- |
| Mluvka | [karta](screenshots/soubory-mluvka-desktop.png) | [karta](screenshots/soubory-mluvka-mobil.png) |
| TS3 kanál | [karta](screenshots/soubory-ts3-desktop.png) | [karta](screenshots/soubory-ts3-mobil.png) |
| TS5/6 | [karta](screenshots/soubory-ts56-desktop.png) | [karta](screenshots/soubory-ts56-mobil.png) |


## Nesplněný bod celé přejímky

Celý zamčený `npm run e2e` na portech 3103/9103/10103/30103 skončil **exit 1** v Opus
měření tónu, `e2e/audio.mjs:260`: `plcFrames` mělo být 0, bylo **26**; současně 7 podtečení,
1 zahozený rámec a mezera vstupu/výstupu 308 ms. Velké souborové scénáře v tomto opakování
ještě neběžely. Předchozí průchod měřil 14 PLC. Limity ani zvukový řetězec se neupravovaly.
[Strojový doklad selhání](soubory-cely-beh-selhani.json). Celý PCM průchod se kvůli zastavení
na prvním selhání v `e2e/all.mjs` nespustil. Přejímka podle všech bodů zadání proto není hotová.
Orchestrátor musí vyřešit zvukové měření a zopakovat celý běh po sloučení zvukových oprav.
