# Navázání přejímky #1298 (3)

Východisko: `8027840`; práce pouze ve worktree `mluvka-mobil`, větev `mobil`.
Úplné ověření nového backendu zatím čeká na uvolnění TS3. Historické výsledky k východisku jsou v
[overeni-mobil-1298.md](overeni-mobil-1298.md).

## Oprava příčin

- Společný `blocked_until` blokoval příkazy a kontrola v živé TS smyčce ukončovala
  všechny relace po floodu nového handshake. Nyní `connects_blocked_until` omezuje
  pouze připojování; živé relace pokračují, včetně čistého ručního odpojení.
  Odmítnutý příkaz má nadále vlastní krátké zpomalení a opakování.
- Okno a dávku lze nastavit přes `TS_CONNECT_WINDOW_MS` a `TS_CONNECT_BURST`.
  Výchozí hodnoty zůstaly 45000 ms a 3. Rozpočet uchová i historii delšího
  nastaveného okna. Unit test pokrývá odlišné okno/dávku a povolené příkazy během
  pauzy připojování. Čekání kratší než 300 ms nezobrazuje hlášku fronty;
  za ochranné pauzy se zbývající čas ve frontě aktualizuje každou sekundu.
- Mobilní výstup vybírá výhradně `pointer: coarse`. Samotné dotykové body
  desktop nepřesměrují přes MediaStream. Při odmítnutém `play()` nebo zastaveném
  čase přehrávače přes přicházející hlas připojí záložní AudioContext destination.
  MediaStream zůstává připravený, jeho přehrávač je během fallbacku ztlumený;
  po obnovení se přímá cesta odpojí a přehrávač odtlumí. Výběr výstupu platí
  pro obě cesty. Tichá místnost sama o sobě fallback nespustí.
- Efekt audio session sledoval `connected` a jeho cleanup při výpadku nastavil
  `auto`. Nyní sleduje záměr zůstat v hovoru; reconnect nepřeruší
  `play-and-record`. Ukončení hovoru session uvolní přes `audio.close()`.

## Dosavadní doklady

E2E runner sám backend nesestavuje. Před novým ověřením byl explicitně
spuštěn `cargo build --release` (exit 0); binárka obsahuje novou flood hlášku
a je novější než `src/session.rs`.


- `cargo test`: 14/14, `cargo clippy --all-targets -- -D warnings`: exit 0.
- `npm run typecheck`, `npm run build`: exit 0.
- Nové frontendové kontroly v cíleném běhu prošly: desktop s dotykem a jemným
  ukazatelem, odmítnuté `play()`, zastavený přehrávač, obnova po gestu,
  reconnect bez `audioSession=auto`. Backend tohoto pokusu ještě vycházel
  ze starého release, takže výsledek nelze vydávat za doklad opravy handshake floodu.
- `node --test e2e/reconnect.test.mjs`: 1/1; `codecRecoveryCheck`: exit 0.
- `prohlizec kontrola http://127.0.0.1:3114 tmp-ts3/kontrola-1298-3 --zaklad docs/kontrola-1298`:
  exit 0, bez JS chyb a vodorovného přesahu, strom +0/−0. Rozdíl úvodní vlny
  je časová animace. Souhrn je v [kontrola-1298-3/souhrn.json](kontrola-1298-3/souhrn.json),
  vizuálně prohlédnutý [mobilní snímek](kontrola-1298-3/mobil.png).

## Fyzický telefon

Chromium emulace neověří audiosession iOS při zamčení, systémovém hovoru nebo
uspání PWA, skutečný reproduktor/Bluetooth a přepínání vybraného výstupu.
Detekce zastaveného přehrávače sleduje jeho hodiny a signál před výstupem;
neumí měřit fyzický zvuk reproduktoru při jinak běžících hodinách.
Na Androidu Chrome/PWA a iOS Safari/PWA je proto třeba ověřit slyšitelný hlas
při zamčení a během reconnectu, fallback po poruše přehrávání a jeho návrat,
i přechod `audioSession` na `auto` po ručním odpojení.
