# Ověření mobilního zvuku — 5. 11. 2026

`npm run e2e`: **192/192 OK, complete: true**, oba transporty, chyby konzole/JS prázdné. [Strojový report](e2e-vysledky.json), UTC `2026-11-05T01:50:40.013Z`. Frontend byl sestaven z `0e5ae08`, skutečný worklet `298f3ce00c5c` odpovídá očekávanému hashi.

## Diagnostika v aplikaci

Nastavení → Diagnostika zvuku → Zkopírovat diagnostiku poskytuje výslovný seznam technických údajů. Obsahuje buffer/cíl, podtečení za poslední minutu a celkem, PLC/ztráty/zahození, p95/max/histogram mezer za 30 s, průměr/max dekódování, dlouhé úlohy JS (kde je API dostupné), vzorkování, latence, render quantum, kodek, výstupní cestu, effectiveType, zkrácenou UA a verzi buildu i workletu. Neexportuje celý interní stav s UID. E2E kontroluje schránku, technická pole, shodu hashů a nepřítomnost adresy, přezdívek i testovacího hesla.

Build bez `.git` přijme `VITE_BUILD_COMMIT`; jinak zobrazí `unknown`. Hash workletu je dostupný i bez gitových metadat.

## Kde vznikaly mezery

`TCP_NODELAY` byl zapnutý již v 81110d7. Writer používá `SinkExt::send` s flushem po každém rámci a běží mimo pollování TS; mix používá Burst. V prvním 30s okně s Opus tónem měl producent mezeru **120,108 ms**, WS writer **120,071 ms** a klient **120,20 ms**. Dekódování mělo průměr 0,14 ms / maximum 7,10 ms; dlouhé úlohy JS se v tomto okně neobjevily. V tomto konkrétním případě proto prodleva vznikla již před zařazením do WS fronty, nikoli čekáním na flush nebo pomalým dekodérem. Měření nerozlišuje plánování OS od práce uvnitř relace. Přetížený lokální počítač není měření produkčního CPU. [Původní data](audio-prvni-mereni.json).

PWA měla navíc samostatné riziko: navigace bere nový index ze sítě, zatímco stávající SW vrací konstantní `/audio-worklet.js` ze staré cache. Nový klient tak mohl použít starý přehrávač. Worklet se nyní načítá z `/audio-worklet.js?v=<hash obsahu>`; SW přednačte i tento klíč a diagnostika uvádí skutečný i očekávaný hash. E2E vloží neplatný starý skript do neversionované cache, ověří jeho přítomnost a přesto spustí nový worklet. U Pavlova fyzického telefonu tato příčina zatím potvrzena není.

Lokálně nebylo vyjednáno permessage-deflate. Produkční konfiguraci Easypanelu nemáme. [Traefik v3.8](https://doc.traefik.io/traefik/v3.8/reference/routing-configuration/http/middlewares/buffering/) popisuje vynechání bufferingu po WS upgradu; nejde o kontrolu nasazené verze a middleware.

## Buffer a výstup

Desktop začíná na 60 ms, mobil na 320 ms (přibližně 300 ms + jeden 20ms rámec). P95 mezer za 30 s + 40 ms a jednotlivé špičky zvyšují cíl, při podtečení se doplní plná rezerva. Po 30 s klidu cíl klesá nejvýše o 2 ms/s; naučený cíl přežije reconnect. Čistý desktop ve VM má 61,33 ms; čistý reálný Opus v tomto běhu měl cíl 61.33 ms. Pokud před měřením vznikl jitter, vyšší naučený cíl může přetrvávat i během následného zklidnění.

PI regulátor se při naplnění resetuje vůči novému cíli s půlrámcovým odhadem a má anti-windup. Drift opravuje lineární interpolace do ±1,05 %. Nouzové srovnání s prolnutím nastává až nad větší z mezí 800 ms a cíl + 400 ms, aby krátká opožděná dávka neshodila rezervu. Zahození se počítá v ekvivalentech 20ms rámců. Jednotková kontrola ověřuje 600ms dávku bez zahození a správný počet 25 rámců při srovnání jednosekundové dávky.

Pouhé zpoždění TCP nevyvolává PLC; dekodér je použije pouze pro díru v pořadí nebo neplatný paket. Doručené pakety dekóduje ihned ve Workeru a PCM posílá přímým MessagePortem do zásoby workletu. Mobil používá nativní frekvenci AudioContextu a latencyHint playback, desktop interactive / 48 kHz. Cesta MediaStreamDestination → audio element zůstává pro mobilní mediální relaci. Její skutečnou hardwarovou latenci Chrome emulace nezměří.

## Měření před a po

Histogram mezer klienta za posledních 30 s. Jde o různě zatížené běhy, nikoli důkaz snížení jitteru backendu samotnou změnou bufferu.

| Transport / běh | ≤25 ms | 25–50 | 50–100 | 100–200 | 200–300 | 300–400 | >400 | p95 ms | max ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| opus před PI | 1472 | 21 | 5 | 2 | 0 | 0 | 0 | 22.20 | 120.20 |
| opus poslední | 1497 | 3 | 0 | 0 | 0 | 0 | 0 | 22.00 | 31.90 |
| pcm před PI | 1476 | 23 | 0 | 0 | 0 | 0 | 0 | 22.00 | 34.20 |
| pcm poslední | 1498 | 2 | 0 | 0 | 0 | 0 | 0 | 21.40 | 27.50 |

A/B nad stejným FIFO průběhem je v [audio-buffer-porovnani.json](audio-buffer-porovnani.json): starý worklet 81110d7 vs nový, 15 s náběh + 60 s, náhodné mezery 50–300 ms a každá 17. 400 ms. Starý: 88 podtečení, 33 srovnání fronty, 464 žádostí o PLC. Nový: 0/0/0, cíl 320 ms. Žádosti starého workletu nejsou počet dekódovaných PLC rámců; VM neobsahuje dekodér. Oba mají stejný histogram mezer: ≤100 ms 72, 100–200 ms 145, 200–300 ms 154, 300–400 ms 23, p95/max 400/400 ms.

### Poslední 30s tóny přes nativní WS

| Kodek | Podtečení | PLC | Buffer min–max ms | Cíl ms | Max mezera ms | Max skok | FFT Hz | RMS rozdíl dB | Max dolů kb/s |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| opus | 0 | 0 | 56.28–62.41 | 61.33 | 31.90 | 0.01163 | 439.45 | 0.0067 | 90.77 |
| pcm | 0 | 0 | 56.84–78.83 | 72.67 | 27.30 | 0.01792 | 439.45 | 0.0015 | 776.61 |

Rozsah bufferu pochází ze sekundových statistik; podtečení a skoky počítá worklet po vzorcích. Stejné nulové podtečení/PLC a limity FFT/RMS platí pro Opus i PCM. U čistého desktopu zůstává rozsah 40–120 ms a cíl ≤90 ms; při naměřeném jitteru nebo dříve naučeném vyšším cíli test dovoluje adaptivní rezervu (nulové podtečení stále vyžaduje). Bitrate je binární WS payload včetně typu/pořadí, bez TCP/TLS a textových řídicích zpráv.

### Mobilní emulace, CPU 4×, 60 s

Skutečný TCP shaper dávkuje celé WS rámce, náhodné mezery 50–300 ms a každou 17. 400 ms; měření začíná po 15s náběhu. Mobilní fáze nemá další omezení bitrate; samostatná 30s kontrola obou transportů používá CDP i TCP shaper 1,5 Mb/s / 80 ms. Shaper má vlastní test 300 rámců se záměrným dělením těla mezi TCP zápisy, kontrolou pořadí a ≥390ms mezerou. Debugger.pause 20 s je samostatná kontrola.

| Kodek | Podtečení | PLC | Ztráty WS | Zahození | Max vstup shaperu ms | Max výstup shaperu ms | p95 klienta ms | Dekódování průměr/max ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| opus | 0 | 0 | 0 | 0 | 160.42 | 403.04 | 192.00 | 0.07/0.60 |
| pcm | 0 | 0 | 0 | 0 | 23.01 | 402.58 | 192.70 | 0.00/0.00 |

Backend každých 30 s loguje pouze číselné histogramy producenta/writeru, čekání ve frontě a průměrnou velikost rámce. Souhrn všech oken posledního běhu (zahrnuje i ostatní regresní kroky):

| Kodek | Oken | Max producent ms | Max writer ms | Max čekání ve frontě ms |
| --- | ---: | ---: | ---: | ---: |
| opus | 15 | 159.19 | 161.89 | 2.89 |
| pcm | 15 | 36.42 | 36.12 | 10.07 |

Předchozí zatížený běh [audio-zatez-600ms.json](audio-zatez-600ms.json) měl 187/188 OK: mobilní Opus při vstupní mezeře 612 ms a výstupní 625 ms podtekl 5× a nouzově srovnal frontu 4×. Není nahrazen ani vydáván za úspěch. Následovala oprava nouzové meze a opakování stejných řízených podmínek. Cíl 320 ms nemůže obecně garantovat nepřerušený hlas při libovolně dlouhé pauze zdroje; skutečné produkční mezery musí doložit diagnostika telefonu a anonymní backend log.

## Další audio regrese

| Drift za 60 s | Podtečení | Zahození | Korekce % |
| --- | ---: | ---: | ---: |
| 1.01 | 0 | 0 | 1.0166 |
| 0.99 | 0 | 0 | -1.0116 |

PLC zůstává v obou driftech nulové. Pauza JS 20 s ponechala TS spojení aktivní v obou transportech.

| Kodek | Začátek VAD vůči ustálení dB | Slabý předběh ms | Ztracený začátek ms | SIGTERM odpojení ms |
| --- | ---: | ---: | ---: | ---: |
| opus | -0.1877 | 80 | 0 | 52 |
| pcm | 0.0994 | 80 | 0 | 3 |

Všechny zaznamenané důvody odpojení při SIGTERM byly clientdisconnect (8); přezdívka, UID a kanál se obnovily.

## Kontroly a omezení

- `cargo clippy --all-targets -- -D warnings`: exit 0.
- `cargo test`: 11 prošlo, 0 selhalo.
- `cargo build --release`: exit 0.
- `npm run typecheck`, `npm run build`: exit 0.
- `npm run e2e` pod společným zámkem: 192/192, oba transporty, complete true. Zámek držen pouze při běhu.
- Drift ±1 % po 60 s: bez podtečení, zahození a PLC; předběh/začátek VAD, PCM fallback, SIGTERM a obnovení hovoru prošly.
- Upozornění, pozvánky, rich chat, obrázky i upload mají samostatné úspěšné kroky v obou transportech.
- `prohlizec kontrola http://localhost:3187 docs/kontrola-diagnostiky`: exit 0, tři varianty, 0 px přesah a žádné JS/konzolové chyby. Nadpis i hodnoty panelu mají ověřených 16 px. [Souhrn](kontrola-diagnostiky/souhrn.json).

Neověřeno: postižený fyzický telefon (iOS/Android, PWA, Bluetooth a skutečný audio výstup), Martinův klient a produkční Easypanel. Zde běžel lokální TS3 3.13.7 a izolovaný Chrome. Docker build podle zadání nebyl spuštěn. Před nasazením mimo gitový strom musí orchestrátor předat hash buildu, pokud má kopie uvádět i přesný commit celé aplikace. Jen lokální commity na vyvoj, bez pushe.
