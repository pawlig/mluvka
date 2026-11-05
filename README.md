# Mluvka

Český webový hlasový klient pro TeamSpeak. Přezdívka, adresa, případně heslo a jste mezi
ostatními. Backend zastupuje každého uživatele samostatným TS3 připojením. Jeden kontejner,
jeden HTTP port, žádná databáze aplikace.

![Mluvka v připojeném stavu](docs/screenshots/desktop.png)

## Co umí

Strom kanálů s podkanály a živými změnami, přesuny včetně hesla, PTT s nastavitelnou klávesou
a dotykovým tlačítkem, hlasovou aktivaci a trvalé vysílání. Mute mikrofonu a deafen jsou vidět
na TS. Zařízení, vstupní zesílení, hlavní i lokální hlasitost 0–200 %, lokální mute podle UID,
lokální test mikrofonu, serverový, kanálový a soukromý chat, upozornění na poke a vypnutelné
pípnutí při příchodu/odchodu z kanálu. Mobil má záložky kanálů a chatu.

TS identita (úroveň ≥8) zůstává v prohlížeči, lze ji exportovat/importovat jako text. Údaje
připojení i hesla se pamatují podle voleb na formuláři (výchozí zapnuté).

## Obrázky a odkazy v chatu

Odkazy HTTP/HTTPS a `www.` jsou klikatelné, `ts3server://` otevře TS klienta. Chat rozumí TS3
BBCode URL, IMG, B, I, U, S a bezpečným pojmenovaným/hex barvám s upraveným kontrastem.
Obrázky mají náhled a prohlížeč přes celé okno (klepnutí, tažení dolů nebo Esc zavírá,
přiblížení dvěma prsty či kolečkem probíhá uvnitř prohlížeče).

Tlačítkem 📎 vyberte obrázek z galerie či fotoaparátu, vložte jej ze schránky nebo přetáhněte
do chatu. Před odesláním lze připsat text nebo obrázek zrušit. Prohlížeč zmenší delší stranu
na 2048 px a přes canvas vytvoří WebP/JPEG bez EXIF včetně GPS. GIF zůstane beze změny
kvůli animaci (nejvýše 8 MiB); ostatní výstupy nejvýše 10 MiB, vstup nejvýše 50 MiB.
Přílohy z myTeamSpeak (TS5/TS6) ukážou název a velikost: prohlížejte je v TeamSpeak klientu.
Mluvka se k myTeamSpeak nepřihlašuje.

Nahrané obrázky mají veřejnou náhodnou URL sdílenou do TS chatu, kdokoli s odkazem je může
otevřít. Výchozí uchování je 7 dní; při vyčerpání kapacity zmizí nejstarší soubory i dříve.
Kopie již uložená v cache příjemce může přežít smazání na serveru. Chat není archiv.

## Na mobilu / instalace na plochu

- **iPhone:** otevřete Mluvku v **Safari → Sdílet → Přidat na plochu**. Nápovědu na přihlášení
  lze zavřít; zavření se pamatuje. Ikona spouští samostatné okno bez adresního řádku.
- **Android:** otevřete v **Chrome → Nainstalovat aplikaci** nebo použijte **Přidat na plochu**
  na přihlášení, jakmile Chrome nabídne instalaci. Vyžaduje HTTPS (lokálně stačí localhost).
- Po spuštění se Mluvka připojí na uložený server a do posledního úspěšně navštíveného kanálu.
  Připojování lze zrušit. **Připojit automaticky po spuštění** vypnete na přihlašovacím formuláři;
  změna se ukládá hned. Po ručním **Odpojit** se tentýž tab nepřipojí ani po reloadu, nové okno ano.
- **Zapamatovat připojení**, **Zapamatovat i hesla na tomto zařízení** a automatické připojení
  jsou ve výchozím stavu zapnuté. V `localStorage` tohoto zařízení a originu jsou údaje serveru,
  přezdívka, cesta posledního kanálu, volby, nastavení zvuku, hlasitosti lidí a TS identita (stejné UID).
  Heslo serveru i kanálu se ukládá **jen při zapnuté volbě hesel**. Vypnutí zapamatování uložené
  přihlášení odstraní; identitu zachová. Hesla nejsou šifrovaná. Na sdíleném zařízení volby vypněte.
  Příznak ručního odpojení je v `sessionStorage`; vypnutá hesla zůstávají pouze v paměti probíhajícího
  spuštění, aby bylo možné obnovit výpadek. Chat se neukládá.
- Při ztrátě sítě se opakují pokusy po 1, 2, 4, 8 a dále 15 sekundách, pouze v popředí.
  Návrat do aplikace nebo připojení sítě vyvolá okamžitý pokus. Špatné heslo, ban, nepovolený server
  a neplatné údaje vrátí formulář bez dalších automatických pokusů. Po tvrdém pádu backendu může
  obnovení čekat na timeout starého klienta na TS serveru; identita ani přezdívka se tím nemění.
- **Klepni pro zapnutí zvuku** odblokuje zvuk po automatickém připojení nebo po přerušení hovorem.
  TS spojení běží i při zablokovaném zvuku. Odpojený mikrofon aplikace zkusí znovu otevřít;
  při zmizení sluchátek použije výchozí vstup. Potlačení ozvěny je zapnuté.
- Držte **Drž a mluv** pro PTT; puštění či zrušení dotyku vysílání zastaví. Podržení člověka
  půl sekundy otevře spodní panel s hlasitostí, lokálním ztlumením a zprávou. Zavře ho klepnutí mimo,
  křížek nebo tažení panelu dolů. V Nastavení lze zapnout **Nezhasínat displej** (výchozí vypnuto).
- Na mobilu vede poslech přes `<audio>` a `MediaStreamAudioDestinationNode`; Media Session ukazuje
  kanál a play/pause zapne/ztlumí mikrofon. Desktop používá přímý výstup kvůli latenci. Pokud mobilní
  přehrávač cestu odmítne jako nepodporovanou, použije se také přímý výstup. Zákaz autoplay vyžaduje
  klepnutí. Vliv na latenci konkrétních sluchátek není změřený.
- **iOS při zamčeném displeji / na pozadí může uspat webovou aplikaci:** zvuk se přeruší,
  po návratu Mluvka obnoví zvuk a sama se připojí. Android může omezit běh úsporným režimem.
  Screen Wake Lock ani Media Session nezaručují nepřerušený hovor. **Fyzický iPhone/Android nebyl ověřen**;
  E2E používá Chromium s emulací iPhonu a Pixelu, nikoli skutečný Safari/OS, Bluetooth, Siri nebo telefonní hovor.

Skořápka aplikace je dostupná offline; TS hovor potřebuje síť. Index se načítá nejdřív ze sítě,
verzované assety z cache. Aktualizace SW čeká na odpojení všech otevřených oken, neobnovuje stránku během hovoru.
Ikony vznikají z `frontend/public/favicon.svg`: `node scripts/ikony.mjs` (Playwright Chromium/Chrome,
volitelně `CHROME_PATH`). PNG včetně neprůhledné Apple ikony jsou součástí repa; motiv maskable je uvnitř
bezpečné středové oblasti 80 %.

## Lokální spuštění

Potřebujete Rust **1.99**, Node **26**, npm, CMake, pkg-config a Opus. Na macOS:

```sh
brew install rust cmake opus pkg-config
npm ci
npm run build
cargo build --release --locked
UPLOAD_DIR=./tmp-ts3/uploads ./target/release/mluvka
```

Na Debianu/Ubuntu jsou stavební závislosti `build-essential cmake pkg-config libopus-dev`.
Otevřete <http://localhost:3000>, `/healthz` vrací `ok`. Mikrofon vyžaduje HTTPS nebo localhost
a oprávnění prohlížeče. Produkční frontend servíruje axum ze složky `dist/`.

Vývoj ve dvou terminálech:

```sh
UPLOAD_DIR=./tmp-ts3/uploads cargo run
```

```sh
npm run dev
```

Vite vypíše adresu a přesměruje `/ws`, `/healthz`, `/api` a `/img` na backend na portu 3000.

## Nastavení provozu

| Proměnná | Výchozí | Význam |
| --- | --- | --- |
| `PORT` | `3000` | Jediný HTTP/WS port. |
| `ALLOWED_SERVERS` | prázdné | Čárkami oddělené `host[:port]`. Prázdné (výchozí) povolí libovolný server — tak se Mluvka zatím nasazuje. Omezení lze kdykoliv zapnout. |
| `MAX_SESSIONS` | `20` | Současná spojení včetně WS čekajících na přihlášení. |
| `RUST_LOG` | `mluvka=info` | Úroveň logů aplikace. TS paketové logy jsou kvůli přihlašovacím údajům vždy vypnuté. |
| `STATIC_DIR` | `dist` | Cesta k frontendu. |
| `UPLOAD_DIR` | `/data/uploads` | Adresář obrázků, zapisovatelný UID 10001. |
| `UPLOAD_TTL_DAYS` | `7` | Doba uchování; úklid při startu a každou hodinu. |
| `UPLOAD_MAX_TOTAL_MB` | `1024` | Kapacita v MiB, při překročení se mažou nejstarší obrázky. |
| `PUBLIC_URL` | z HTTP hlaviček | Doporučená veřejná HTTPS adresa Mluvky bez koncového lomítka. Jinak `Host` + `X-Forwarded-Proto` od Traefiku (lokálně HTTP). |


Ilustrační příklad: `ALLOWED_SERVERS=ts.example.org:9987,voice.example.net:9990`.
Port se porovnává přesně, hostname bez rozlišení velikosti písmen. `host` znamená port 9987.
IPv6 zadávejte jako `[adresa]:port`. TS nickname a DNS SRV lookup nejsou podporované;
při nedostupnosti první IP se zkusí i další vrácené DNS adresy.

Hesla ani identity se na backendu neukládají a nelogují. Limity chrání počty relací, velikosti
zpráv, tempo vstupu i síťové čekání. Každý návštěvník obsadí TS slot a komunikuje z IP kontejneru;
TS správce může sdílenou IP omezit. Používejte povolené servery, kterým důvěřujete.

## Nasazení na Easypanel

Image se **nestaví na Easypanelu** (Rust build tam padal na paměti). Staví ho GitHub Actions
z `Dockerfile.build` a při každém pushi do `main` ho publikuje jako `ghcr.io/pawlig/mluvka:latest`
(a `:sha-<commit>`), jen `linux/amd64`. Easypanel hotový image jen stáhne.

1. Přidejte **App** a jako zdroj zvolte **Docker Image** `ghcr.io/pawlig/mluvka:latest`
   (image je veřejný, přihlášení k registru netřeba).
   _Jde i zdroj GitHub `pawlig/mluvka` + build Dockerfile — kořenový `Dockerfile` obsahuje jen
   `FROM ghcr.io/pawlig/mluvka:latest`, takže se nic nepřekládá. Automatické nasazení po pushi ale pak
   vypněte, jinak Easypanel stáhne image dřív, než ho CI stihne postavit._
2. Nastavte port **3000**. Kontejner běží jako UID 10001. Připojte trvalý **volume na `/data`**, zapisovatelný tímto UID; bez volume se obrázky po redeployi ztratí. Databázi nepotřebuje.
3. Proměnné jsou volitelné: `ALLOWED_SERVERS` zatím nenastavujte (povolí se všechny servery), nastavte `PUBLIC_URL=https://vase-domena` a případně `MAX_SESSIONS`, `RUST_LOG`, `UPLOAD_TTL_DAYS`, `UPLOAD_MAX_TOTAL_MB`. `UPLOAD_DIR` ponechte `/data/uploads`.

4. Přidejte doménu s **HTTPS** a nasaďte. WSS jede na stejné doméně přes `/ws`; Traefik předává upgrade.
5. **Automatické nasazení po buildu:** v Easypanelu zkopírujte _Deploy Webhook_ aplikace a uložte ho
   na GitHubu jako secret `EASYPANEL_DEPLOY_WEBHOOK`
   (`gh secret set EASYPANEL_DEPLOY_WEBHOOK --repo pawlig/mluvka`). CI ho zavolá až po publikaci image.
   Bez secretu se nasazuje ručně tlačítkem Deploy.
6. Ověřte `/healthz`, připojení a hlas dvou relací. Host musí dosáhnout na **odchozí UDP port TS**
   (obvykle 9987). Příchozí UDP pro aplikaci se nepublikuje.

`Dockerfile.build` staví frontend v Node, backend v Rustu a kopíruje je do ne-root `debian:bookworm-slim`.
CI na PR jen staví a ověří HTTP i UID; na push do `main` navíc publikuje do GHCR:
[běhy Docker CI](https://github.com/pawlig/mluvka/actions/workflows/docker.yml).
Lokální build celého image: `docker build -f Dockerfile.build -t mluvka .`

## Ověření

```sh
cargo build --release --locked
cargo clippy -- -D warnings
cargo test
npm run typecheck
npm run build
npm run e2e
```

E2E používá Playwright s vlastním headless Chrome, dvěma prázdnými kontexty a falešným mikrofonem.
Běhy různých pracovních stromů na stejném počítači spouštějte sériově: místní TS3
bez licence odmítá další instanci přes local accounting.
Na Macu použije `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, jinde Playwright
Chromium (`npx playwright install chromium`). Cestu lze přepsat přes `CHROME_PATH`.
Spojitý testovací tón putuje skutečným workletem přes PCM, Opus a TS. Hesla testů vznikají
náhodně v paměti; snímky pozvánek obsahují jen tyto dočasné testovací údaje.

Lokální TS3 stáhněte před testem:

```sh
mkdir -p tmp-ts3
curl --fail --location https://files.teamspeak-services.com/releases/server/3.13.7/teamspeak3-server_mac-3.13.7.zip -o tmp-ts3/server.zip
unzip -q tmp-ts3/server.zip -d tmp-ts3
```

TS3 je x86_64 a na Apple Silicon vyžaduje Rosettu. Skript spustí TS3 s přijatou licencí,
backend i prohlížeč a na konci je ukončí. Potřebuje volné porty 9987/UDP, 10011/TCP,
30033/TCP a 3000/TCP. `TS3_DIR` může ukazovat i na rozbalený Linux TS3 server.
Porty jdou přepsat proměnnými `E2E_PORT`, `TS3_VOICE_PORT`, `TS3_QUERY_PORT` a `TS3_FT_PORT`. Každý pracovní
strom potřebuje vlastní porty a kopii TS3 (`TS3_DIR`, bez `ts3server.sqlitedb*`, aby se virtuální server
založil na nových portech):

```sh
E2E_PORT=3101 TS3_VOICE_PORT=9101 TS3_QUERY_PORT=10101 TS3_FT_PORT=30101 npm run e2e
```

Allowlist testovacího backendu používá stejnou adresu i port TS3. Pokud TS3 hlásí
`local accounting reports an already running instance`, spouštějte celé E2E běhy
postupně: samostatné porty tento limit počtu instancí neodstraní.
E2E vytváří dočasný `UPLOAD_DIR` a po skončení jej odstraní; výchozí `/data` nepoužívá.

`E2E_URL` dovoluje připojit již běžící backend; úplná sada včetně restartu vyžaduje lokální backend bez této volby.

**Používejte jen vyhrazený testovací TS server:** skript přenastaví jeho jméno a heslo,
odstraní ostatní kanály a vytvoří testovací strom. Nepouštějte ho nad osobním TS serverem.

Testy ověřují také seznam povolených serverů, limit relací/zpráv, kontrolu Origin, obsazenou
přezdívku a živé změny kanálů. Pokrývají chybná hesla, dvě relace, přesun s heslem, všechny tři chaty, nenulové audio,
lokální mute (RMS ~0), mikrofon/deafen, test mikrofonu, PTT, hlasovou aktivaci, stejné UID po
obnovení a TS odpojení po zavření prohlížeče. Výsledky: `docs/e2e-vysledky.json`.
Nové kontroly pokrývají PWA/HTTP cache, instalovatelnost CDP, offline skořápku, automatické připojení,
trvalou chybu bez opakování, sessionStorage, výpadek sítě/restart a dotyk iPhone/Pixel. Skutečný audio tok
běží také při AudioContext 44,1 kHz; `node e2e/resampling.mjs` samostatně ověří délky rámců workletu.
Screenshoty připojeného klienta: `docs/screenshots/`. Audio statistiky: `window.__mluvkaStats`.

## Proč takhle

Prohlížeč neumí TS3 UDP protokol a kryptografii. Rust používá
[ReSpeak/tsclientlib](https://github.com/ReSpeak/tsclientlib) s pevným rev
`ee3bc6f45a7137db7793ba5593a321df400d53e5`, ostatní závislosti fixuje Cargo.lock.
`AudioHandler` dekóduje, bufferuje a mixuje hlasy. Vstupní Opus má mono 48 kHz, 20 ms,
OpusVoice; frontend zpracovává zvuk v AudioWorkletu s adaptivním přehrávacím bufferem (na čistém desktopu přibližně 60 ms, při jitteru až 320 ms).
Záložní C# varianta nebyla potřeba. [Úplný WS protokol](docs/protokol.md).

## Známá omezení

- Záložní PCM po WS spotřebuje asi **770 kb/s v každém směru** při vysílání; výchozí Opus používá 64/96 kb/s. Příjem teče i s tichem.
  TCP a dva jitter buffery přidávají latenci proti nativnímu klientovi.
- Výběr výstupu závisí na `AudioContext.setSinkId` a oprávnění prohlížeče. Kde chybí
  (např. některé verze Safari/Firefox), volba se skryje s poznámkou o systémovém výstupu.
- PTT funguje při aktivní stránce a mimo textová pole. Mobil může na pozadí či při zhasnutí
  displeje přerušit audio i spojení.
- Příjem podporuje **OpusVoice a OpusMusic**, nikoli staré kanály Speex/CELT. Na TS nastavte
  Opus; aplikace kodek cizího kanálu nemění.
- Pohyb, odběr všech kanálů a serverový chat podléhají TS oprávněním. Nepřístupní klienti
  nemusí být vidět, odmítnutí se zobrazí česky.
- Po síťovém výpadku se spojení obnovuje automaticky. Po novém spuštění bez uložených hesel je nutné hesla doplnit.
- Identita a případně zapamatovaná hesla jsou v localStorage daného originu. Export obsahuje
  privátní klíč. Zálohujte ho soukromě; vymazání dat webu bez zálohy znamená novou identitu.
- Testováno proti TS3 3.13.7. Konkrétní TS6 server a fyzická zvuková zařízení závisí na konfiguraci.
- Bez administrace serveru, souborů, avatarů a whisperu.

Mluvka není oficiální produkt TeamSpeak. TS3 server a jeho licence nejsou součástí repozitáře.

## Zvuk a diagnostika

Výchozí přenos je Opus VBR 48 kHz mono / 20 ms: **Vysoká 64/96 kb/s** nahoru/dolů,
**Úsporná 32/48 kb/s**. Mikrofonní Opus jde do TS beze změny; mix používá `Application::Audio`,
protože zachovává obecné audio i tón bez vnucené řečové charakteristiky. FFT/RMS měření
je součást E2E; RMS se porovnává se signálem za kompresorem. Licence jsou v `frontend/public/licence/` (součást distribuovaného frontendu). FEC je zapnuté, DTX vypnuté. PCM zůstává zálohou pro starší klienty/backend
a chybu WASM. Podrobnosti: [protokol](docs/protokol.md).

Prohlížeč používá [libopus-wasm 0.4.1](https://github.com/openclaw/libopus-wasm), MIT
(wrapper), BSD-3-Clause (libopus). Aktuálně udržovaný balík poskytuje encoder i decoder,
PLC, FEC a všechny požadované CTL. Instalovaný balík má 434 641 B; samostatný Vite Worker
má přibližně 442 kB nekomprimovaný (WASM je vložený). Worker se načte až při připojování;
SW jej při instalaci nepřednačítá. Funguje bez WebCodecs, SharedArrayBuffer a COOP/COEP.

Automatické zesílení **prohlížeče (AGC) je výchozí vypnuté**: v tichu zvyšuje zisk a může
zesilovat začátky vět. Jednorázová migrace nastavení v2 jej vypne i ve starých uložených
volbách; uživatel jej pak může znovu zapnout. Vlastní kompresor −18 dBFS / 4:1 / 5 ms /
150 ms a předstihem limiteru 5 ms běží stále, VAD měří před ním. Předběh 100 ms zachová slabý začátek slova,
hold 400 ms a rampy omezují lupnutí na hranicích vysílání.

**Nastavení → Diagnostika zvuku → Zkopírovat diagnostiku** zkopíruje JSON pro hlášení
problému. Pokud po aktualizaci PWA panel chybí, po ukončení hovoru aplikaci obnovte.
Nechte panel běžet během praskání a pošlete zkopírovaný text s modelem telefonu.
Kopie obsahuje pouze technické údaje: buffer/cíl, podtečení za minutu i celkem, PLC/ztráty,
mezery doručení za posledních 30 s, čas dekódování, latence a vzorkování zařízení, cestu
výstupu, prohlížeč a commit buildu. Build bez `.git` může dostat commit přes
`VITE_BUILD_COMMIT`; bez něj poctivě ukáže `unknown`. Worklet má navíc vlastní hash obsahu a verzovanou URL,
aby stará PWA cache nemíchala nový klient se starým přehrávačem. Neobsahuje adresu TS, přezdívky, UID ani přihlašovací údaje.

Na čistém desktopu začíná cíl bufferu na 70 ms (60 ms + půl rámce); při výpadku vzroste podle naměřené
mezery nejvýše na 150 ms. Mobil začíná s rezervou 320 ms. Cíl se snižuje o 2 ms/s
podle p95 za posledních 10 s, takže jej nedrží vysoko jednotlivé špičky. Dekodér zpracovává
přijaté pakety ihned ve Workeru a posílá PCM přímo do workletu přes MessagePort.
PLC se použije pro prokázanou díru v pořadí, nikoli pro pouhé opoždění TCP.
Aktuální výsledky jsou v [ověření audia](docs/overeni-audia.md).
SIGTERM/SIGINT čistě odpojí TS
relace a prohlížeče po aktualizaci obnoví hovor. Globální limit připojování omezuje flood
při současném reconnectu; skutečný flood blokuje cíl na 120 s.
## Upozornění a nepřečtené zprávy

V Nastavení jsou samostatné zvuky pro kanál, server, soukromé zprávy a šťouchnutí
(výchozí zapnuté) a **Hlasitost upozornění** 0–100 % (výchozí 70 %). Zpráva cinkne,
pokud její konverzaci právě nečtete, aplikace je na pozadí nebo okno nemá fokus.
Vlastní zprávy necinkají. Dávka zpráv zahraje nejvýš jednou za 1,5 sekundy.
Šťouchnutí má vlastní zvuk a výrazné upozornění. **Ztlumit zvuk** umlčí i tyto zvuky;
vibrace a systémová upozornění zůstávají. Zvuky se dekódují jednou v Web Audio,
vedou do stejného výstupu jako hlas a respektují hlavní hlasitost i výběr zařízení.
Jsou součástí offline cache. Po automatickém připojení může být potřeba klepnout
na **Klepni pro zapnutí zvuku**, aby prohlížeč přehrávání povolil.

Počty nepřečtených jsou u Kanálu, Serveru a jednotlivých soukromých konverzací
(nejvýše `99+`), na mobilu také u Chat, když prohlížíte strom. Viditelné otevření
konverzace je vynuluje, změna kanálu vymaže počet Kanálu. Součet je v titulku
stránky a na ikoně nainstalované aplikace, pokud prohlížeč podporuje App Badging.
Počty ani obsah chatu se neukládají mezi připojeními.

**Upozornění systému** zapnete v Nastavení; teprve tímto kliknutím aplikace požádá
o oprávnění. Skrytá aplikace zobrazuje zprávy a poke přes service worker, seskupené
podle konverzace; klepnutí vrátí aplikaci do příslušného chatu. Soukromá zpráva a
poke krátce zavibrují tam, kde to systém dovolí. Na iOS 16.4+ jsou oznámení dostupná
jen pro aplikaci **přidanou na plochu**. Fungují pouze dokud iOS aplikaci na pozadí
neuspí; zavřená či uspaná Mluvka zprávy nepřijímá. **Serverový Web Push zde není.**
Podporu iOS a požadavek gesta popisuje [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Pozvánka na server

Po připojení zvolte **Pozvat** pod názvem serveru. Odkaz může obsahovat heslo
serveru, cestu aktuálního kanálu a na výslovné zaškrtnutí také jeho známé heslo.
Lze ho zkopírovat, sdílet systémovým dialogem nebo naskenovat jako QR kód;
QR se vytváří přímo v aplikaci bez externí služby. Odkaz s heslem posílejte jen
lidem, kterým důvěřujete; base64url není šifrování.

Formát je `https://<host>/#pozvanka=<base64url(JSON)>`, verze JSON `v: 1`.
Údaje jsou ve fragmentu, který prohlížeč neposílá v HTTP požadavcích ani proxy logům.
Aplikace ho ihned po načtení odstraní z adresy. Příjemce vidí název serveru a kanál,
pole Přezdívka a Připojit; ostatní údaje jsou pod **Upravit podrobnosti**.
Připojení uloží server a hesla a povolí automatické připojování stejně jako běžný
výchozí formulář. Neplatný odkaz zobrazí českou chybu a běžný formulář.
Otevření pozvánky v právě připojené aplikaci nejprve vyžádá odpojení.

**iPhone a odkazy z Messengeru/WhatsAppu:** odkaz se obvykle otevře v Safari.
Nejdřív se připojte, pak zvolte Sdílet → Přidat na plochu. Safari a aplikace na
ploše mají oddělené lokální úložiště; jeho kopírování Apple negarantuje
([Apple WWDC23](https://developer.apple.com/videos/play/wwdc2023/10120/?time=884)).
Proto se přenos hesel instalací nespoléhá na `start_url` ani zanechaný fragment.
Zkopírujte původní pozvánku, otevřete Mluvku z plochy a zvolte **Vložit pozvánku**.
Odkaz vložte do pole (nebo použijte Načíst ze schránky, pokud ho prohlížeč dovolí).
Takto funguje i pozvánka do již nainstalované aplikace.
