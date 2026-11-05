# Mobil: dokončení #1289 a navázání #1298

Stav: implementace a lokální statické kontroly hotové; úplné E2E čeká na sdílený TS3 zámek.

## Zjištěné příčiny

- Příkazový `ClientIsFlooding` 0x020c procházel stejnou větví jako odmítnutý handshake: spustil společnou 120s pauzu a ukončil živé relace. Nyní se odmítnutý příkaz vrací do fronty, cíl přeruší příkazy na 5 s a hovor pokračuje. Fronta čeká vždy na jedno potvrzení; úspěšnou zprávu neopakuje. Samostatný konzervativní bodový rozpočet tlumí dlouhé série chatu.
- `AudioEngine.close()` při každém ručním odpojení zastavil mikrofonní stopy. Další připojení proto volalo nový `getUserMedia`, což v Safari/PWA s povolením na jednotlivé žádosti vyvolávalo opakovanou výzvu. Živý stream nyní patří otevřené stránce: při odpojení se vypne a odpojí od zpracování, při připojení použije znovu, při zavření stránky se uvolní. Nové zařízení, změna DSP nebo ukončená stopa mohou vyžadovat nové získání.
- Původní obnovení zvuku bylo vázané na viditelnost, při selhání mobilního `play()` se ztrácela cesta přes skutečný audio element, klientské časovače považovaly pozastavené JS za mrtvé spojení a reconnect se na pozadí nezkoušel. Checkpoint #1289 tyto cesty opravil: skutečný přehrávající audio element, obnovení kontextu i na pozadí, 5s milost po probuzení, pokračování reconnectu, audio session a Media Session po dobu hovoru. Protokolové WS ping/pong už backend měl; nepřipisujeme jejich zavedení této změně.
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
- `prohlizec kontrola http://127.0.0.1:3105 docs/kontrola-1298 --zaklad docs/kontrola-mobil`: bez chyb konzole, JS výjimek a mobilního vodorovného přesahu; snímek mobilu viz `kontrola-1298/mobil.png`. Rozdíly pixelů úvodní vlny jsou časová animace, strom stránky se nezměnil.
- Úplné `npm run e2e`: čeká na zámek; výsledek bude doplněn po běhu na portech 3104/9104/10104/30104.

Bez fyzického telefonu nelze prokázat chování konkrétního iOS/Androidu při zamčení displeje, systémovém telefonátu, úspoře baterie nebo dlouhodobém uspání Safari/PWA. Chromium emulace ověřuje řízené pozadí a zmrazení, ne rozhodnutí mobilního operačního systému. Oprávnění při novém otevření stránky zůstává pod kontrolou prohlížeče.
