# Ověření zvuku 4. 11. 2026

Implementace, buildy, jednotkové testy a UI jsou ověřené. **Úplná přejímka není hotová**:
poslední `npm run e2e` skončilo před testy, protože jiný pracovní strom používal lokální TS3.
V jeho logu je `local accounting reports an already running instance`.
Výsledek aktuálního pokusu má `complete: false` v [E2E reportu](e2e-vysledky.json).

- `cargo clippy -- -D warnings`, `cargo test` (5/5), `cargo build --release`: prošly.
- `npm run typecheck`, `npm run build`: prošly.
- Skutečný zdroj AudioWorkletu ve VM: 30 s běžný takt a 60 s drift ±1 %, vždy 0 podtečení / 0 zahození;
  korekce +1,028 % / −0,992 %. Fade-out maximální skok 0,002084.
  [Strojový výsledek](audio-jednotkove.json) obsahuje i PLC obnovu a limit odchozích dávek.
- `node e2e/flood.mjs http://localhost:3001`: prošlo. Virtuální čas ověřil ≥120 s pro flood
  a ≥3 s pro restart, včetně návratu skrytého tabu. [Výsledek](flood-vysledky.json).
- `prohlizec kontrola http://localhost:3001 docs/kontrola-audio-ui`: tři varianty bez JS chyb,
  konzolových chyb a přesahu. [Souhrn](kontrola-audio-ui/souhrn.json).
  [Dotyk](kontrola-audio-ui/dotyk.json): 390×844, scale 1, všechny vstupy 16 px,
  jeden prst povolen, dva blokované, posuvný panel se posunul o 933 px.

## Dřívější dílčí E2E měření

Tato čísla pocházejí z běhu **před poslední změnou horního cíle bufferu ze 100 na 90 ms**.
Nejsou potvrzením celé současné verze. [Surová data](audio-dilci-vysledky.json).

| Tón 30 s | Podtečení | Max. skok |  Buffer ms | FFT Hz | RMS rozdíl dB | Max. dolů kb/s |
| -------- | --------: | --------: | ---------: | -----: | ------------: | -------------: |
| Opus     |         0 |   0,01143 | 95,8–118,3 | 439,45 |       +0,0063 |          91,27 |
| PCM      |         1 |   0,01801 | 60,0–130,5 | 439,45 |       −0,0030 |         776,55 |

Druhé 30s okno při 1,5 Mb/s / 80 ms: oba transporty 0 podtečení, Opus 90,30 kb/s,
PCM 776,62 kb/s (8,6× více). VAD: první 200 ms −0,15 dB proti ustálenému signálu,
slabý předběh 80 ms, ztracený začátek 0 ms. Dřívější Opus sada prošla i restartem,
PWA, mobilní emulací a 44,1kHz obousměrným hlasem.

## Metodika a zbývající ověření

E2E má vlastní izolované Chrome profily a lokální TS3 3.13.7. Mikrofon je WAV 440 Hz;
RMS reference je signál za kompresorem. Výstupní RMS se integruje přes vzorky workletu,
FFT výkon se sčítá během 30 s přes AnalyserNode. Chrome má testovací audio výstup,
nepoužívá fyzické reproduktory. CDP síť doplňuje skutečné zpoždění/pacing binárních WS rámců.
Drift se simuluje nezávislými hodinami příjmu/renderu ve skutečném kódu workletu.

Orchestrátor musí vyhradit TS3 jedinému běhu a spustit `npm run e2e` až do
`complete: true` pro Opus i PCM. Rozšířená kontrola ServerQuery nyní připouští
setrvání B i jeho čisté odpojení a návrat; důvod odchodu musí být 8 (`clientdisconnect`).
Aktuální 90ms horní cíl ještě potřebuje toto úplné E2E ověření.

Neověřeno: skutečný klient Martina, fyzický iOS Safari/Android, Bluetooth a provoz na Easypanelu.
Docker build nebyl podle zadání spouštěn. Nic nebylo pushnuto.
