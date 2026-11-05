# Ověření zvuku a producenta — 5. 11. 2026

`npm run e2e`: **196/196 OK, complete: true**, Opus i PCM, oba procesy exit 0. [Strojový report](e2e-vysledky.json), UTC `2026-11-05T06:20:29.436Z`. Frontend `1ee3daa`, worklet `fb765da40022`. Nativní tóny mají výslovně `strictDesktop: true`.

## Build bez gitových metadat

`Dockerfile.build` předá ARG/ENV `VITE_BUILD_COMMIT` do frontendu; oba build kroky Actions dostávají `github.sha`. Proměnná je až za instalací závislostí, aby změna hashe nezrušila její cache. Kořenový Dockerfile a publikační příkazy se nezměnily. `VITE_BUILD_COMMIT=abc1234 npm run build -- --outDir ../tmp-ts3/build-abc` a následné otevření panelu přes `prohlizec` vrátily ve skutečně kopírovaném JSON `{"build":"abc1234","schema":1,"codec":"pcm"}`. Vite přijme platný dodaný hash před pokusem volat git. Docker CLI zde není dostupné, celý image se lokálně nestavěl.

## Desktopová latence a mobilní rezerva

Desktop začíná na 70 ms: 60 ms rezervy + půl 20ms rámce pro střed kolísající fronty. Start čeká na celé rámce (typicky 80 ms) a PI vychází ze skutečného naplnění, aby první sekundy rezervu nerozkmitaly. Mezery a podtečení zvyšují cíl podle skutečně uplynulého času od posledního rámce + 40 ms, nejvýše na **150 ms**: pokryje 120ms špičku s přibližně jedním rámcem rezervy a omezuje trvalou latenci. Mobil začíná na **320 ms**, při podtečení tuto rezervu obnoví. Při trvajícím dávkování (p95 >40 ms) naučený cíl nesnižuje mezi dlouhými mezerami; po zklidnění opět klesá. Pokles o 2 ms/s řídí p95 posledních **10 s**, bez podmínky 30 s bez jediné špičky. Naučený cíl přežije reconnect, vždy se stropem příslušné platformy.

První celý běh se samostatným producentem měl 193/194: PCM nespadlo, ale buffer klesl na 36,30 ms pod limit 40 ms. Proto start vychází ze skutečného naplnění a desktopový střed fronty má půlrámcovou rezervu. Druhý běh potvrdil desktop, ale měl jedno mobilní Opus podtečení; následovalo držení mobilního cíle při trvajícím jitteru a přesné potvrzení hranice měření. Neúspěšné souhrny jsou zachované, limity se nezměkčily.

VM test záměrně vyvolá právě jedno podtečení 120ms špičkou: maximum cíle **150.00 ms**, po 60 s **70.00 ms**, bez zahození. Stejná sada dál ověřuje 60 s mobilního jitteru 50–300 / 400 ms po 15s náběhu a drift ±1 %. Nouzové srovnání s prolnutím zůstává až nad max(800 ms, cíl + 400 ms); krátké opožděné dávky se nezahazují. PLC ve frontendovém dekodéru vzniká pouze pro prokázanou díru v pořadí nebo vadný paket, nikoli při poklesu rezervy pod cíl.

## Kde vzniká mezera producenta

Historické 120–160ms mezery byly již před WS frontou. Instrumentovaný inline běh `0ffe749` ukázal v nejhorším 30s PCM okně bez jediného příchozího TS audio paketu mezeru 82,896 ms, zpoždění termínu 63,876 ms, práci mixu nejvýše 0,751 ms a poll TS nejvýše 4,830 ms. Nezávislý Tokio takt měl maximum 75,795 ms. To dokládá opožděné probouzení/plánování runtime, nikoli čekání na TS audio nebo dávkování writeru. Přesný OS spouštěč historické špičky zpětně určit nelze.

Samostatné OS vlákno už používalo absolutní `deadline += 20 ms`, přesto v následné přejímce stejného běhu taktuje hůř než Tokio interval relace; viz řádky „před / vlákno“ níže. Izolace od uměle blokovaného runtime proto není doklad lepší kadence v E2E.

Výchozí mix se vrací jako první synchronní práce 20ms tiku relace s `MissedTickBehavior::Burst`. Při zpoždění se nevypustí žádný časový rámec; nový Rust test v obou kodecích zablokuje runtime na 110 ms a ověří šest termínů i souvislé pořadí Opus. AudioHandler, Opus PLC, limiter a nastavení enkodéru jsou společné pro oba režimy. Výchozí cesta nemá vstupní mezivláknovou frontu ani její zahazování. Opus uplink se stále nepřekóduje.

Experimentální izolace zůstává pouze přes `MLUVKA_AUDIO_PRODUCER=thread`. Její vstupní ztráty se počítají a logují souhrnně nejvýše jednou za 10 s, nikoli každý paket. Řízení při přetížení vede k čistému odpojení; Drop zastavuje vlákno i bez dalšího paketu. Zachovaný jednotkový test izolace ověřuje pokračování této volitelné varianty při 140ms blokaci jediného Tokio workeru, netvrdí lepší časování produkčního režimu.

WS writer zůstává samostatný async úkol s omezenou výstupní frontou 16 rámců. `TCP_NODELAY` už byl zapnutý a `SinkExt::send` flushuje každý rámec. Mix nemá aplikační zámek a nečeká na WS síťový zápis.

## Histogramy před / po

Každý pár **mixStart vs sessionTick** pochází ze stejného běhu a stejných relací. „Před“ je uložený report z přejímky na `1315ecc`, „po“ je finální úplný běh uvedený v záhlaví. P95 je maximum p95 jednotlivých 30s oken, nikoli percentil spojené distribuce. Počty 25–50 ms jsou součty všech těchto oken.

| Kodek / režim | mixStart p95 ms | sessionTick p95 ms | mix 25–50 ms | relace 25–50 ms | mix tickDelay p95 ms | relace tickDelay p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| opus před / vlákno | 28.60 | 23.90 | 2130 | 230 | 9.75 | 6.36 |
| opus po / inline | 21.83 | 21.83 | 9 | 9 | 3.55 | 3.55 |
| pcm před / vlákno | 27.19 | 21.95 | 1756 | 29 | 8.92 | 3.72 |
| pcm po / inline | 22.04 | 22.04 | 13 | 13 | 3.93 | 3.93 |

V režimu inline začíná mix přímo na vstupu do větve tiku relace: obě značky označují stejnou událost a používají stejnou hranici reportovacího okna. Shodné řady jsou důsledkem jednoho časovače, nejsou dokladem izolace od zpoždění runtime. Výpočet mixu se měří zvlášť; `sessionWork` nyní zahrnuje také mix. E2E vyžaduje mix p95 ≤ sessionTick p95 a počet mezer 25–50 ms ≤ počet u relace pro oba kodeky; historický nevyhovující report tento guard odmítne.

Anonymní histogram celého finálního běhu; meze v ms:

| Kodek / místo | ≤25 | 25–50 | 50–100 | 100–200 | 200–300 | 300–400 | >400 | max p95 okna | maximum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| opus / TS API | 16165 | 19 | 0 | 0 | 0 | 0 | 0 | 21.96 | 33.43 |
| opus / sessionTick | 31503 | 9 | 0 | 0 | 0 | 0 | 0 | 21.83 | 32.08 |
| opus / mixStart | 31503 | 9 | 0 | 0 | 0 | 0 | 0 | 21.83 | 32.08 |
| opus / WS zápis | 31406 | 14 | 0 | 0 | 0 | 0 | 0 | 21.94 | 32.24 |
| pcm / TS API | 16100 | 7 | 0 | 0 | 0 | 0 | 0 | 23.01 | 36.10 |
| pcm / sessionTick | 31501 | 13 | 0 | 0 | 0 | 0 | 0 | 22.04 | 33.51 |
| pcm / mixStart | 31501 | 13 | 0 | 0 | 0 | 0 | 0 | 22.04 | 33.51 |
| pcm / WS zápis | 31486 | 17 | 0 | 0 | 0 | 0 | 0 | 22.26 | 33.49 |

| Kodek | max mixWork ms | max poll TS ms | max obsluha události ms | max WS vstup ms | max mezera Tokio ms | max čekání WS ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| opus | 12.24 | 2.14 | 0.41 | 0.74 | 33.06 | 1.82 |
| pcm | 5.00 | 2.69 | 1.41 | 5.53 | 32.62 | 3.93 |

Časy práce jsou uplynulý čas včetně případného přerušení OS, nikoli thread CPU time. Srovnání různých běhů není řízené A/B. Nový výchozí režim odstraňuje prokázanou dodatečnou nepravidelnost OS vlákna; neodstraňuje omezení plánovače Tokio/OS.

`audio_timing` obsahuje i TS příjem po mluvčích, `tickDelay`, celý poll/obsluhu událostí a monotónní `maxAtMs`. Neobsahuje adresy, přezdívky, UID, hesla ani obsah paketů. Jednotlivá okna jsou pouze v ignorovaném `tmp-ts3/audio-timing-*.json`; report uchovává souhrny a výsledek porovnání.

## Tóny 30 s přes nativní WS

| Kodek | strictDesktop | Podtečení/PLC | Buffer min–max ms | Cíl ms | Max skok | FFT Hz | RMS rozdíl dB | Max dolů kb/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| opus | true | 0/0 | 56.74–77.65 | 72.00 | 0.01499 | 439.45 | 0.0016 | 91.14 |
| pcm | true | 0/0 | 56.74–79.55 | 72.00 | 0.03302 | 439.45 | 0.0023 | 776.39 |

Rozsah bufferu jsou sekundové statistiky; podtečení a skok počítá worklet po vzorcích. Stejné limity pro oba kodeky: nula podtečení/PLC, buffer 40–120 ms, cíl ≤90 ms. Bitrate je binární WS payload včetně typu/pořadí.

## Mobilní emulace, CPU 4×, jitter 120 s

TCP shaper dávkuje celé WS rámce, mezery 50–300 ms a každou 17. 400 ms; měří se 120 s po 15s náběhu. Hranici potvrzuje worklet přes FIFO. Samostatný test ověřuje pořadí 300 rámců při dělení mezi TCP zápisy. Další krok používá 1,5 Mb/s / 80 ms; Debugger.pause 20 s je samostatná kontrola.

| Kodek | Podtečení/PLC/ztráty/zahození | Max mezera vstup/výstup shaperu ms | p95 klienta ms | Dekódování průměr/max ms | Cíl ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| opus | 0/0/0/0 | 27.71/402.91 | 200.10 | 0.06/0.90 | 320.00 |
| pcm | 0/0/0/0 | 24.02/402.70 | 200.60 | 0.00/0.00 | 320.00 |

Mobilní výstup zůstává MediaStreamDestination → audio element, nativní vzorkování a latencyHint playback; desktop má přímý výstup. Worker dekóduje ihned a předává PCM přímým portem do zásoby workletu. E2E ověřuje panel, JSON schránky, hashe i nepřítomnost adresy, přezdívek a hesla. Přehrávací algoritmus se v tomto navázání nemění.

Stopa potvrzuje běžící přehrávač na začátku i přibližně 120 s renderování. Rezerva před příchodem = naměřená fronta po příchodu minus 20ms rámec. Časová stopa bez audio vzorků je jen v ignorovaném tmp-ts3; nula v počítadle sama o sobě nestačí.

| Kodek | PCM rámce | Rozsah renderovacího taktu ms | Max mezera ve workletu ms | Min rezerva před příchodem ms | Podtečení |
| --- | ---: | ---: | ---: | ---: | ---: |
| opus | 6002 | 119914.67 | 405.33 | 12.12 | 0 |
| pcm | 6000 | 119872.00 | 426.67 | 0.85 | 0 |

## Regrese a doklady

| Kodek | VAD začátek vůči ustálení dB | Předběh ms | Ztracený začátek ms | SIGTERM odpojení ms | reasonid |
| --- | ---: | ---: | ---: | ---: | ---: |
| opus | -0.0701 | 80 | 0 | 4 | [8] |
| pcm | 0.2114 | 100 | 0 | 2 | [8] |

- `cargo clippy --all-targets -- -D warnings`: exit 0; `cargo test`: **13 prošlo, 0 selhalo**, včetně dohánění inline rámců i volitelné izolace.
- `cargo build --release`, `npm run typecheck`, `npm run build`: exit 0.
- Celé `npm run e2e`: 196/196, oba kodeky exit 0, complete true; společný zámek jen po dobu běhu, porty 3102/9102/10102/30102. Report zahrnuje upozornění, pozvánky, chat/upload, mute/deafen/PTT, 16/44,1/48/96 kHz, drift ±1 %, AGC migraci, PCM fallback, pauzu stránky a obnovení identity/kanálu po restartu.
- [Souhrn kontroly UI](kontrola-diagnostiky/souhrn.json), [desktopový panel](kontrola-diagnostiky/panel-desktop.png), [mobilní panel](kontrola-diagnostiky/panel-mobil.png); aktuální diagnostika [Opus](screenshots/diagnostika-mobil-opus.png) / [PCM](screenshots/diagnostika-mobil-pcm.png). UI se neměnilo.
- [Historické souhrny](audio-historie-souhrn.json) a [starší VM A/B](audio-buffer-porovnani.json) zůstávají označené jako historické. Surové JSON a duplicitní PNG se nevracejí do repa.

Neověřeno: postižený fyzický telefon, Martinův klient, produkční Easypanel/Traefik a Docker image (Docker CLI zde není). Běžel lokální TS3 3.13.7 a izolovaný Chrome. Linuxová kadence může být jiná než macOS; tento doklad se vztahuje k uvedenému lokálnímu běhu. Jen lokální commity na vyvoj, bez pushe.
