# Ověření zvuku a producenta — 5. 11. 2026

Předchozí úplný běh před navázáním (5): `npm run e2e` — **196/196 OK, complete: true**, Opus i PCM, oba procesy exit 0. [Strojový report](e2e-vysledky.json), UTC `2026-11-05T04:43:19.902Z`. Frontend `91f5900`, worklet `ce6969f5d146`. Nativní tóny mají výslovně `strictDesktop: true`; naměřený jitter už nemůže přepnout nativní běh na měkčí limit.

## Navázání (5): oprava kadence

Zdroj `1ee3daa` vrací výchozí mix jako první práci tiku relace (`Burst`); WS writer zůstává oddělený. Samostatné vlákno je pouze opt-in `MLUVKA_AUDIO_PRODUCER=thread`. Oba režimy sdílejí AudioHandler, limiter a enkodér. Vstupní ztráty volitelné fronty se logují souhrnně po 10 s. Opraveno i odsazení workletu, jeho chování se nemění.

Clippy všech cílů, 13 Rust testů (nově i dohánění šesti rámců po 110ms prodlevě v obou kodecích), release build, typecheck a frontend build prošly. Celý nový E2E čeká na sdílený TS3 zámek; následující čísla zatím popisují předchozí běhy. Nový guard porovnává mixStart a sessionTick ze stejného běhu, vyžaduje oba limity z přejímky a historický nevyhovující report odmítá.

## Build bez gitových metadat

`Dockerfile.build` předá ARG/ENV `VITE_BUILD_COMMIT` do frontendu; oba build kroky Actions dostávají `github.sha`. Proměnná je až za instalací závislostí, aby změna hashe nezrušila její cache. Kořenový Dockerfile a publikační příkazy se nezměnily. `VITE_BUILD_COMMIT=abc1234 npm run build -- --outDir ../tmp-ts3/build-abc` a následné otevření panelu přes `prohlizec` vrátily ve skutečně kopírovaném JSON `{"build":"abc1234","schema":1,"codec":"pcm"}`. Vite přijme platný dodaný hash před pokusem volat git. Docker CLI zde není dostupné, celý image se lokálně nestavěl.

## Desktopová latence a mobilní rezerva

Desktop začíná na 70 ms: 60 ms rezervy + půl 20ms rámce pro střed kolísající fronty. Start čeká na celé rámce (typicky 80 ms) a PI vychází ze skutečného naplnění, aby první sekundy rezervu nerozkmitaly. Mezery a podtečení zvyšují cíl podle skutečně uplynulého času od posledního rámce + 40 ms, nejvýše na **150 ms**: pokryje 120ms špičku s přibližně jedním rámcem rezervy a omezuje trvalou latenci. Mobil začíná na **320 ms**, při podtečení tuto rezervu obnoví. Při trvajícím dávkování (p95 >40 ms) naučený cíl nesnižuje mezi dlouhými mezerami; po zklidnění opět klesá. Pokles o 2 ms/s řídí p95 posledních **10 s**, bez podmínky 30 s bez jediné špičky. Naučený cíl přežije reconnect, vždy se stropem příslušné platformy.

První celý běh se samostatným producentem měl 193/194: PCM nespadlo, ale buffer klesl na 36,30 ms pod limit 40 ms. Proto start vychází ze skutečného naplnění a desktopový střed fronty má půlrámcovou rezervu. Druhý běh potvrdil desktop, ale měl jedno mobilní Opus podtečení; následovalo držení mobilního cíle při trvajícím jitteru a přesné potvrzení hranice měření. Neúspěšné souhrny jsou zachované, limity se nezměkčily.

VM test záměrně vyvolá právě jedno podtečení 120ms špičkou: maximum cíle **150.00 ms**, po 60 s **70.00 ms**, bez zahození. Stejná sada dál ověřuje 60 s mobilního jitteru 50–300 / 400 ms po 15s náběhu a drift ±1 %. Nouzové srovnání s prolnutím zůstává až nad max(800 ms, cíl + 400 ms); krátké opožděné dávky se nezahazují. PLC ve frontendovém dekodéru vzniká pouze pro prokázanou díru v pořadí nebo vadný paket, nikoli při poklesu rezervy pod cíl.

## Kde vzniká mezera producenta

Původní 120,108ms producent / 120,071ms writer / 120,20ms klient a pozdější 159,19ms producent byly doloženy již před tímto navázáním. Samy nerozlišovaly práci relace od plánování. Nový výchozí běh s instrumentací inline producenta (`0ffe749`) prošel 194 kontrolami, ale stále naměřil **57,76 ms Opus / 82,89 ms PCM před WS frontou**.

V nejhorším 30s PCM okně nebyl **žádný příchozí TS audio paket**: mezera začátků mixu **82,896 ms**, zpoždění termínu **63,876 ms**, vlastní práce mixu nejvýše **0,751 ms**, poll TS nejvýše **4,830 ms**. Nezávislý Tokio takt měl maximum **75,795 ms**. Prodlevu tedy nezpůsobilo čekání na TS audio, dekódování Opus ani dávkování WS writeru. Jde o opožděné probouzení/plánování runtime; konkrétní OS spouštěč historické 120–160ms špičky zpětně určit nelze. TS API může vykázat současnou mezeru také proto, že se ve stejném runtime opožděně polluje. To samo nedokazuje zpoždění TS serveru nebo sítě.

V předchozím režimu mix vlastnilo samostatné vlákno na relaci. Absolutní `deadline += 20 ms` už používalo, ale ve skutečném E2E bylo jitterovější než takt relace. Výchozí režim se proto vrací inline do stejného tiku jako údržba relace. Značky mixStart a sessionTick nyní označují stejný vstup do této větve a reportují stejné 30s okno; výpočet mixu se měří zvlášť. Tento návrat neizoluje od opožděného plánování Tokio. Volitelnou izolaci stále ověřuje test blokace runtime; nelze ho vydávat za lepší kadenci běžného provozu.

`TCP_NODELAY` již byl zapnutý, `SinkExt::send` flushuje každý rámec. Tyto mechanismy se neměnily. `Application::Audio`, bitrate, VBR, FEC a complexity 10 zůstávají stejné; uplink Opus se stále nepřekóduje.

## Histogramy před / po

Přejímka výchozího stavu `1315ecc`, každý pár ze stejného běhu. P95 je největší p95 jednoho 30s okna; 25–50 ms je součet počtů v této třídě, nikoli percentil.

| Kodek před opravou | mixStart p95 ms | sessionTick p95 ms | mix 25–50 ms | relace 25–50 ms | mix tickDelay p95 ms | relace tickDelay p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| opus | 28.60 | 23.90 | 2130 | 230 | 9.75 | 6.36 |
| pcm | 27.19 | 21.95 | 1756 | 29 | 8.92 | 3.72 |

Vlákno tedy v obou kodecích nesplňuje požadavek kadence vůči souběžnému Tokio taktu. Níže je ještě historické srovnání dvou starších, různě zatížených běhů; jeho maxima nejsou maxima tohoto páru z přejímky. Finální měření opraveného režimu se doplní po získání TS3.

Součet 30s oken celého běhu, mezery v ms. Počet rámců se liší délkou relací, tichem a prodloužením mobilní zátěže na 120 s; **max p95 je největší p95 jednotlivého okna**, ne percentil spojené distribuce. Výchozí TS API měřilo mezery událostí; nové měření je po mluvčích a vynechává explicitně ukončené proudy. Různě zatížené E2E běhy nejsou řízené A/B; následující jednotkový test ověřuje pouze izolaci při umělé blokaci runtime.

| Transport / místo | ≤25 | 25–50 | 50–100 | 100–200 | 200–300 | 300–400 | >400 | max p95 okna | maximum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| opus / TS API před | 10254 | 16 | 1 | 0 | 0 | 0 | 0 | 21.86 | 58.63 |
| opus / mix před | 23606 | 55 | 2 | 0 | 0 | 0 | 0 | 22.29 | 57.76 |
| opus / TS API po | 15567 | 556 | 9 | 0 | 0 | 0 | 0 | 28.94 | 58.03 |
| opus / mix po | 27811 | 2163 | 3 | 0 | 0 | 0 | 0 | 28.69 | 93.03 |
| opus / writer po | 27693 | 2279 | 5 | 0 | 0 | 0 | 0 | 29.11 | 93.47 |
| pcm / TS API před | 10341 | 35 | 1 | 0 | 0 | 0 | 0 | 23.29 | 83.45 |
| pcm / mix před | 20693 | 21 | 3 | 0 | 0 | 0 | 0 | 21.96 | 82.89 |
| pcm / TS API po | 15005 | 1207 | 0 | 0 | 0 | 0 | 0 | 30.63 | 48.14 |
| pcm / mix po | 29621 | 1757 | 0 | 0 | 0 | 0 | 0 | 27.19 | 37.16 |
| pcm / writer po | 29595 | 1783 | 0 | 0 | 0 | 0 | 0 | 27.25 | 41.12 |

Nový anonymní `audio_timing` rozlišuje TS API, celý poll/obsluhu událostí, WS vstup, údržbu relace, nezávislý Tokio takt, začátky/výpočet mixu, zařazení do WS a dokončený zápis. `maxAtMs` umožňuje korelaci maxim na monotónní ose daného procesu. Neobsahuje adresy, přezdívky, UID, hesla ani obsah paketů. E2E ukládá jen souhrny; jednotlivá okna jsou v ignorovaném `tmp-ts3/audio-timing-*.json`.

| Kodek po opravě | max výpočet mixu ms | max poll TS ms | max obsluha události ms | max WS vstup ms | max mezera Tokio ms | max čekání WS ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| opus | 29.52 | 6.43 | 2.11 | 2.16 | 43.07 | 31.60 |
| pcm | 2.00 | 4.56 | 1.03 | 6.96 | 32.69 | 14.70 |

Časy výpočtů jsou skutečný uplynulý čas včetně případného přerušení OS, nikoli thread CPU time. Celý nový běh stále obsahuje Opus mezeru producenta 93,03 ms (oproti 57,76 ms ve výchozím běhu), PCM 37,16 ms (oproti 82,89 ms). Samostatný producent tedy není záruka menších OS špiček; doložené zlepšení je izolace od blokovaného Tokio v řízeném testu. Přesný spouštěč zbývající 93ms špičky bez plánovacího profilu neurčujeme.

### Řízené zablokování runtime — pouze volitelná větev

`cargo test producer_keeps_ticking -- --nocapture`: jediný Tokio worker se zablokuje na 140 ms. Původní inline interval Burst čeká, nový skutečný producent pokračuje. Histogram má stejné meze jako tabulka výše. Nejde o simulaci TS serveru nebo produkční měření.

| Kodek | inline max ms | samostatný producent max ms | vytvořené intervaly během blokace | inline histogram | producent histogram |
| --- | ---: | ---: | ---: | --- | --- |
| pcm | 142.44 | 25.64 | 7 | [0, 0, 0, 1, 0, 0, 0] | [6, 1, 0, 0, 0, 0, 0] |
| opus | 146.08 | 27.38 | 7 | [0, 0, 0, 1, 0, 0, 0] | [5, 2, 0, 0, 0, 0, 0] |

## Tóny 30 s přes nativní WS

| Kodek | strictDesktop | Podtečení/PLC | Buffer min–max ms | Cíl ms | Max skok | FFT Hz | RMS rozdíl dB | Max dolů kb/s |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| opus | true | 0/0 | 66.24–69.52 | 70.00 | 0.01125 | 439.45 | 0.0064 | 90.74 |
| pcm | true | 0/0 | 55.46–93.83 | 72.00 | 0.01163 | 439.45 | 0.0029 | 783.69 |

Rozsah bufferu jsou sekundové statistiky; podtečení a max skok počítá worklet po vzorcích. Stejné limity platí pro Opus i PCM: nulové podtečení/PLC, buffer 40–120 ms a cíl ≤90 ms. Bitrate je binární WS payload včetně typu/pořadí, bez TCP/TLS a textových řídicích zpráv.

## Mobilní emulace, CPU 4×, jitter 120 s

TCP shaper dávkuje celé WS rámce, náhodné mezery 50–300 ms a každou 17. 400 ms; měření trvá 120 s po 15s náběhu. Začátek potvrzuje worklet přes FIFO portu, takže do něj nevstupují opožděné události náběhu. Anonymní časová stopa v ignorovaném tmp-ts3 obsahuje stav regulátoru, příchody PCM a časy podtečení, žádné audio vzorky. Samostatný test ověřuje pořadí 300 rámců i při dělení rámce mezi TCP zápisy. Další 30s krok používá CDP i TCP shaper 1,5 Mb/s / 80 ms. Debugger.pause 20 s je samostatná kontrola.

| Kodek | Podtečení/PLC/ztráty/zahození | Max mezera vstup/výstup shaperu ms | p95 klienta ms | Dekódování průměr/max ms | Cíl ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| opus | 0/0/0/0 | 80.39/406.13 | 201.90 | 0.07/0.40 | 320.00 |
| pcm | 0/0/0/0 | 31.59/402.85 | 200.60 | 0.00/0.00 | 320.00 |

Mobilní cesta zůstává MediaStreamDestination → audio element, nativní vzorkování a latencyHint playback; desktop používá přímý výstup. Dekodér zpracovává pakety ihned ve Workeru a předává PCM přímým MessagePortem do zásoby workletu. Kopírovaný JSON je výslovný seznam technických polí; E2E ověřuje panel, schránku, hashe a nepřítomnost adresy, přezdívek i testovacího hesla. Stará neversionovaná PWA cache je v E2E záměrně otrávená a nový worklet se přesto načte z URL s hashem.

Časová stopa navíc potvrzuje běžící přehrávač na začátku a přibližně 120 s skutečného renderování; samotná nula v počítadle by u zastaveného AudioContextu nestačila. Nejmenší rezerva je těsně před přidáním dalšího 20ms rámce, nikoli průměr fronty. Zkouška pokrývá uvedenou stopu, negarantuje libovolně dlouhou pauzu zařízení nebo sítě.

| Kodek | Přijaté PCM rámce | Rozsah renderovacího taktu ms | Max mezera ve workletu ms | Min rezerva před příchodem ms | Podtečení |
| --- | ---: | ---: | ---: | ---: | ---: |
| opus | 5999 | 119850.67 | 426.67 | 0.88 | 0 |
| pcm | 5999 | 119850.67 | 426.67 | 3.61 | 0 |

## Regrese a doklady

| Kodek | VAD začátek vůči ustálení dB | Předběh ms | Ztracený začátek ms | SIGTERM odpojení ms | reasonid |
| --- | ---: | ---: | ---: | ---: | --- |
| opus | 0.1912 | 80 | 0 | 4 | [8] |
| pcm | 0.1536 | 100 | 0 | 3 | [8] |

Úplný report dále obsahuje upozornění, pozvánky, rich chat, obrázky/upload, mute/deafen/PTT, přehrávání 16/44,1/48/96 kHz, drift ±1 %, migraci AGC, PCM fallback, běh při pauze stránky a obnovení přezdívky/identity/kanálu po restartu.

- `cargo clippy --all-targets -- -D warnings`: exit 0.
- `cargo test`: 12 prošlo, 0 selhalo, včetně skutečného producenta obou kodeků při blokaci runtime.
- `cargo build --release`, `npm run typecheck`, `npm run build`: exit 0.
- Celé `npm run e2e`: 196/196, oba transporty, complete true. Společný zámek držen jen během běhu; porty 3102/9102/10102/30102.
- TS3 má pro celý běh vlastní dočasnou databázi: jinak by stará DB ignorovala `default_voice_port` a test se připojoval na jiný port.
- [Souhrn kontroly UI](kontrola-diagnostiky/souhrn.json), [desktopový panel](kontrola-diagnostiky/panel-desktop.png), [mobilní panel](kontrola-diagnostiky/panel-mobil.png), aktuální živá diagnostika [Opus](screenshots/diagnostika-mobil-opus.png) / [PCM](screenshots/diagnostika-mobil-pcm.png). UI se v tomto navázání neměnilo.
- [Historické souhrny](audio-historie-souhrn.json) zachovávají i neúspěšný běh s pěti podtečeními při >600ms mezeře; původní velké JSON a duplicitní PNG jsou odstraněné. [Starší VM A/B](audio-buffer-porovnani.json) porovnává worklet 81110d7 s první mobilní opravou, není vydáván za nové měření producenta.

Neověřeno: postižený fyzický telefon (iOS/Android, PWA, Bluetooth a skutečná hardwarová latence), Martinův klient, produkční Easypanel/Traefik a Docker image (Docker CLI není dostupné). Zde běžel lokální TS3 3.13.7 a izolovaný Chrome. Konkrétní historickou 120–160ms OS prodlevu nelze zpětně přiřadit; mechanismus blokace runtime i jeho izolace jsou reprodukované. Jen lokální commity na vyvoj, bez pushe.
