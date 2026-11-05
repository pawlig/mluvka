# Navázání přejímky #1298 (3)

Hotovo podle automatických podmínek: **204/204 E2E kroků**, Opus 102 a PCM 102,
oba procesy exit 0, `complete: true`, `errors: []`. Východisko `8027840`, větev `mobil`.

## Co se změnilo a proč

- Společný `blocked_until` blokoval příkazy a kontrola v živé TS smyčce ukončovala
  relace po floodu cizího handshake. `connects_blocked_until` nyní omezuje pouze
  připojování; živé relace pokračují, včetně čistého ručního odpojení.
  Odmítnutý příkaz má vlastní krátké zpomalení a opakování.
  Doklad: `src/session.rs:341`, `src/session.rs:364`, nativní E2E níže.
- `TS_CONNECT_WINDOW_MS` a `TS_CONNECT_BURST` mají zachované výchozí hodnoty
  45000 ms a 3. Rozpočet uchová historii i při nastavení delšího okna.
  Unit test pokrývá jiné okno/dávku a povolené příkazy během pauzy připojování.
  Hláška fronty čeká 300 ms, ochranný odpočet se potom aktualizuje každou sekundu.
  Doklad: `src/session.rs:314`, `src/session.rs:451`, `src/session.rs:503`.
- Výstup přes `<audio>` vybírá výhradně `pointer: coarse`. Samotné dotykové body
  desktop nepřesměrují. Odmítnuté `play()` nebo zastavené hodiny přehrávače přes
  přicházející hlas aktivují přímou AudioContext destination. Přehrávač je během
  fallbacku ztlumený; po obnovení se přímá cesta odpojí a přehrávač odtlumí.
  Výběr zařízení platí pro obě cesty. Tichá místnost sama fallback nespustí.
  Doklad: `frontend/src/audio.ts:163`, `frontend/src/audio.ts:570`, E2E obou kodeků.
- Cleanup efektu podle `connected` při výpadku nastavil `audioSession=auto`.
  Efekt nyní sleduje záměr zůstat v hovoru; reconnect drží `play-and-record`.
  Ukončení hovoru session uvolní přes `audio.close()`.
  Doklad: `frontend/src/App.tsx:975`; E2E zaznamenává všechny změny typu session.
- Tři staré 40s připojovací timeouty v audio E2E byly kratší než platné 45s okno.
  Jsou sjednocené na 90 s. Zvukové prahy a kontrola živosti v popředí se neměnily.

## Ověření

- `cargo test`: **14/14**; `cargo clippy --all-targets -- -D warnings`: exit 0.
- `npm run typecheck`, `npm run build`: exit 0.
- `cargo build --release`: exit 0. Runner backend sám nesestavuje; před platným
  E2E byla binárka explicitně sestavená a ověřená jako novější než `session.rs`.
- `node --test e2e/reconnect.test.mjs`: 1/1; `codecRecoveryCheck`: exit 0.
- Cílený `E2E_REGRESSION_ONLY=1 E2E_FLOOD_ONLY=1 E2E_CODEC=opus node e2e/run.mjs`:
  **6/6**, exit 0, pod zámkem TS3.
- Celé `E2E_PORT=3104 TS3_VOICE_PORT=9104 TS3_QUERY_PORT=10104 TS3_FT_PORT=30104 npm run e2e`
  pod zámkem `/Users/paveldvorak/.prace/mluvka-ts3.lock`: **204/204**, exit 0.
  Strojový výsledek: [e2e-vysledky.json](e2e-vysledky.json).

| Kontrola | Opus | PCM |
| --- | ---: | ---: |
| Přijaté/dekódované rámce za 60 s na pozadí | 3002 | 3002 |
| Návrat po zmrazení včetně celé 5s milosti (ms) | 5016 | 5027 |
| Návrat čekajících po handshake pauze (ms) | 123203 | 123170 |

Při nativním handshake floodu `wire_code=0x0d01`, normalizovaném `0x0d03`,
měli Flood-0/1 po celou pauzu stejný WS i `clid`, doručovali chat a přehrávali hlas
s kladným RMS a rostoucím počtem rámců. Další klient čekal na stejném WS s měnícím
se odpočtem; po pauze se připojil. Na výchozím antifloodu šestice v obou kodecích
odeslala přesně 6× `channelsubscribeall`, 6× `clientmove`, 6× `sendtextmessage`.
Opakovaný stejný mute nepřidal příkaz. Běžné připojení nadále potřebuje po
`clientinit` jediný aplikační příkaz `channelsubscribeall`; předchozí srovnání
je v [historickém dokladu](overeni-mobil-1298.md).

`prohlizec kontrola http://127.0.0.1:3114 tmp-ts3/kontrola-1298-3 --zaklad docs/kontrola-1298`:
exit 0, bez JS chyb a vodorovného přesahu, strom +0/−0. Rozdíl úvodní vlny je animace.
[Souhrn](kontrola-1298-3/souhrn.json), vizuálně prohlédnutý [mobilní snímek](kontrola-1298-3/mobil.png).

## Co vyžaduje fyzický telefon

Chromium emulace neověří nativní audio session iOS při zamčení, systémovém hovoru
nebo uspání PWA, skutečný reproduktor/Bluetooth a přepínání vybraného výstupu.
Detekce zastaveného přehrávače sleduje jeho hodiny a signál před výstupem;
neumí měřit fyzický zvuk reproduktoru při jinak běžících hodinách.
Na Androidu Chrome/PWA a iOS Safari/PWA zbývá ověřit slyšitelný hlas při zamčení
a během reconnectu, fallback a jeho návrat i `audioSession=auto` po ručním odpojení.
V E2E bylo rozhraní `audioSession` podvržené pro kontrolu přechodů.

## Lokální commity od `8027840`

| Commit | Změna |
| --- | --- |
| `703a9a3` | Handshake flood omezuje nová připojení, živé relace zůstávají; konfigurovatelné okno a pozdější hláška fronty. |
| `a0e971a` | Coarse výstup, přímý fallback a zachovaná audio session při reconnectu. |
| `d1ecbe7` | Nativní regrese hlasu a odpočtu během handshake pauzy. |
| `b2afb8d` | Obnova odmítnutého přehrávače v testu skutečným gestem. |
| `cd04c49` | Průběžné doklady výstupu a audio session. |
| `2e2b0c6` | Doklad úspěšného nativního flood testu na novém backendu. |
| `b1aeba5` | Připojovací E2E timeout respektuje celé sdílené okno. |
