# Mobil: dokončení #1289 a navázání #1298

Stav: hotovo podle automatických podmínek. Úplné E2E prošlo 100 kroky pro Opus a 100 pro PCM; oba procesy skončily kódem 0.

## Zjištěné příčiny

- Příkazový `ClientIsFlooding` 0x020c procházel stejnou větví jako odmítnutý handshake: spustil společnou 120s pauzu a ukončil živé relace. Nyní se odmítnutý příkaz vrací do fronty, cíl přeruší příkazy na 5 s a hovor pokračuje. Fronta čeká vždy na jedno potvrzení; úspěšnou zprávu neopakuje. Samostatný konzervativní bodový rozpočet tlumí dlouhé série chatu.
- `AudioEngine.close()` při každém ručním odpojení zastavil mikrofonní stopy. Další připojení proto volalo nový `getUserMedia`, což v Safari/PWA s povolením na jednotlivé žádosti vyvolávalo opakovanou výzvu. Živý stream nyní patří otevřené stránce: při odpojení se vypne a odpojí od zpracování, při připojení použije znovu, při zavření stránky se uvolní. Nové zařízení, změna DSP nebo ukončená stopa mohou vyžadovat nové získání.
- Původní obnovení zvuku bylo vázané na viditelnost, při selhání mobilního `play()` se ztrácela cesta přes skutečný audio element, klientské časovače považovaly pozastavené JS za mrtvé spojení a reconnect se na pozadí nezkoušel. Checkpoint #1289 tyto cesty opravil: skutečný přehrávající audio element, obnovení kontextu i na pozadí, 5s milost po probuzení, pokračování reconnectu, audio session a Media Session po dobu hovoru. Protokolové WS ping/pong už backend měl; nepřipisujeme jejich zavedení této změně.
- Cleanup po kicku posílal další `clientdisconnect` již odebranému klientovi a čekal na knihovní timeout. Potvrzený odchod se nyní označí a další UDP odpojení se přeskočí; oznámení kicku proto odchází hned, zatímco ruční převzetí stále čeká na ukončení živé relace.
- Mobilní ikonové odpojení nemělo přístupný název (jeho text CSS skrývalo). Náhradní mikrofonní lišta s pevným `bottom: 100px` navíc překrývala vyšší mobilní ovládání. Tlačítko má `aria-label` a lišta nyní zabírá vlastní místo v rozložení mezi chatem a ovládáním.
- Zprávy neměly společný výpočet barvy s avatarem ve stromu; hash přezdívky navíc měnil barvu po přejmenování. Společný výpočet používá UID, uchované také u starých zpráv, a lokální paletu.

## TS příkazy před a po

| Varianta | Po `clientinit` při připojení |
| --- | --- |
| `c089036` | `channelsubscribeall`, nepodmíněný `clientupdate` z prvního frontend `mute`; navíc počáteční `clientupdate`, pokud mute přišel už během handshake |
| checkpoint `2e402f1` | `channelsubscribeall`; `clientupdate` pouze při rozdílu mute/deafen oproti knize TS |
| nyní | `channelsubscribeall`; počáteční mute/deafen jsou rovnou v `clientinit`, změna zjištěná až později oprávněně přidá `clientupdate` |

Běžné připojení nyní potřebuje jeden aplikační příkaz po handshake. Výchozí kanál i jeho heslo jsou v `clientinit`; dodatečný `clientmove` se při připojení neposílá. Ani předtím se neposílaly dotazy `clientlist`/`channellist`: seznamy přicházejí z oznámení TS. Opakovaný stejný mute a stejný kanál nevysílají další příkaz; přezdívka se obnovuje nejvýše třikrát s rostoucí prodlevou.

Debug počítadla `ts_command`, `count`, `client`, `session_count` měří aplikační příkazy po druzích a cílovém serveru. Knihovní handshake/keepalive do těchto aplikačních počtů nepatří. Sdílený limit zůstává `TS_CMD_RATE=5`, burst 20; připojení nejméně po `TS_CONNECT_INTERVAL_MS=3000` a nejvýše tři za 45 s. Vlastní 120s pauza platí pro odmítnuté připojení, nikoli pro chybu chatového příkazu.

Skutečný ban má jen doložený odpočet `ban_seconds`, po něm ruční návrat; neznámý čas se nevymýšlí. `cooldown_seconds` označuje vlastní ochrannou pauzu, nikoli dobu TS banu. TS3 handshake marker má na drátu 0x0d01, v normalizované kategorii a logu 0x0d03 s výslovným `wire_code=0x0d01`.

## Ověření

- `cargo test`: 13 testů prošlo včetně skutečného vendorového parseru banu/handshake markeru a oddělení příkazového floodu.
- `cargo clippy --all-targets -- -D warnings`: bez chyb.
- `npm run typecheck`, `npm run build`: bez chyb.
- `node --test e2e/reconnect.test.mjs`: jeden test prošel (hranice jitteru, exponenciální prodleva a strop).
- `prohlizec kontrola http://127.0.0.1:3106 docs/kontrola-1298 --zaklad docs/kontrola-mobil`: bez chyb konzole, JS výjimek a mobilního vodorovného přesahu; snímek mobilu viz `kontrola-1298/mobil.png`. Rozdíly pixelů úvodní vlny jsou časová animace, strom stránky se nezměnil.
- Izolovaná mobilní komponentová kontrola s napodobenými WS odpověďmi (bez TS3): dvě připojení / jeden `getUserMedia`; skutečně zamítnuté oprávnění bez překryvu a dalších žádostí 10 s; jednorázová nápověda, ruční retry a neblokované odpojení. Snímky `kontrola-1298/mikrofon-portrait.png` a `mikrofon-landscape.png` jsou z této komponentové kontroly.
- Cílené `E2E_CODEC=opus E2E_REGRESSION_ONLY=1 node e2e/run.mjs`: 28 kroků prošlo pod TS3 zámkem. Zahrnuje skutečné odmítnuté unmute i chat 0x020c bez výměny relace, 120s společnou handshake pauzu a návrat, mobilní stream reuse, kick, chybějící mikrofon, pozadí, zmrazení, barvy i zdravý online.
- Úplné `E2E_PORT=3104 TS3_VOICE_PORT=9104 TS3_QUERY_PORT=10104 TS3_FT_PORT=30104 npm run e2e` pod sdíleným zámkem: **200 úspěšných kroků**, Opus 0 / PCM 0, `complete: true`, žádná JS chyba. Strojový výsledek: `e2e-vysledky.json`.


### Naměřeno v úplném běhu

| Kontrola | Opus | PCM |
| --- | ---: | ---: |
| Přijaté a zpracované rámce za 60 s na pozadí | +3003 | +3002 |
| Kontrola po 30s zmrazení včetně celé 5s milosti | 5023 ms | 5017 ms |
| Poslední relace znovu připojena po společné handshake pauze | 126436 ms | 126434 ms |
| Nejnižší kontrast textu palety | 5,427:1 | 5,427:1 |

V obou transportech měla šestice na výchozím antifloodu přesně 6× `channelsubscribeall`,
6× `clientmove`, 6× `sendtextmessage`; opakování stejného mute přidalo 0 příkazů.
Během pozadí byl výstupní RMS kladný a WS i `clid` stejné. Po zamítnutém unmute
ServerQuery ověřilo skutečné odtlumení; zamítnutá chatová zpráva dorazila právě jednou.
Handshake pauza zachovala alespoň 120 s bez odchozích příkazů a po ní postupné připojení.
Zámek se po ukončení běhu uvolnil; cizí zámky se nemazaly.

Snímky `screenshots/mobil-bez-mikrofonu.png`, `mobil-ban.png` a `mobil-barvy.png`
byly vizuálně prohlédnuté: ovládání odpojení je dostupné, odpočet čitelný a paleta
se vejde do mobilního displeje. Odpočet banu je izolovaná UI kontrola s napodobenou
chybovou odpovědí; parsování skutečného formátu zprávy ověřují Rust unit testy.

Bez fyzického telefonu nelze prokázat chování konkrétního iOS/Androidu při zamčení displeje, systémovém telefonátu, úspoře baterie nebo dlouhodobém uspání Safari/PWA. Chromium emulace ověřuje řízené pozadí a zmrazení, ne rozhodnutí mobilního operačního systému. Oprávnění při novém otevření stránky zůstává pod kontrolou prohlížeče.

## Lokální commity

Východisko `2e402f1` zůstalo zachované. Navazující implementace, testy a průběžné doklady:

| Commit | Změna |
| --- | --- |
| `d386326` | Zpomalení příkazového floodu bez ukončení hovoru. |
| `7fc8bed` | Zachování mikrofonu mezi připojeními na jedné stránce. |
| `f50557e` | Náhodné rozložení reconnectu po výpadku backendu. |
| `fe5d74a` | Počáteční mute v handshaku a převzetí identity po odpojení. |
| `4b267ff` | Doložený odpočet banu a vlastní ochranné pauzy. |
| `e0923bd` | Zachování relace i při flood chybě bez potvrzovacího kódu. |
| `975270b` | Aktuální cesty k trvalému povolení mikrofonu. |
| `0603a16` | Ověření mobilního formuláře a ovládání ochranné pauzy. |
| `92cb774` | Dokončení ručního odpojení i při zpomalené frontě. |
| `150270c` | Průběžné doklady příčin a omezení mobilních oprav. |
| `1dc3f9e` | Čekání testu na asynchronní připojení drženého mikrofonu. |
| `0cc2b7a` | Životní cyklus stránky v izolovaném testu mikrofonu. |
| `ac9be50` | Nové získání mikrofonu při skutečné ztrátě zařízení. |
| `0f11e7a` | Izolované ověření držení a uvolnění mikrofonu. |
| `80a337f` | Žádné automatické opakování čekající výzvy mikrofonu. |
| `cef3fb0` | Zastavení nahrazené relace ve frontě a přesný flood kód. |
| `62ea9aa` | Chatový test čeká na doručení přes antiflood frontu. |
| `b54dfc8` | Mobilní ověření jednorázové nápovědy a odpočtu banu. |
| `13d79fc` | Potvrzení mute po odmítnutém příkazu zůstává ve frontě. |
| `9cdadba` | Samostatný název počítadla doručených zpráv. |
| `ffc9eb4` | Měření pokusů mockované WS a zákaz návratu po reloadu. |
| `7ebe0b7` | Přístupný název mobilního tlačítka odpojení. |
| `dbd31d1` | Lišta mikrofonu zabírá místo nad mobilním ovládáním. |
| `76efdd8` | Doklady mobilního odpojení bez povoleného mikrofonu. |
| `7a3f955` | Kick nečeká na opětovné odpojení již odebraného klienta. |
| `454db66` | Úspěšné cílené regrese mikrofonu pozadí a obou druhů floodu. |
