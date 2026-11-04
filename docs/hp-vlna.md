# Přihlašovací vlna — částicový proud

Základ tvoří původních 36 zelených oscilátorových strun. Okolo nich pluje prach: WebGL2 simuluje pozici, rychlost a život částic v páru GPU bufferů pomocí transform feedback. Proud strun částice strhává. Desktop má 6 144 trvalých bodů a až 8 192 jisker, mobil polovinu; rozlišení i počet bodů klesají podle výkonu. Canvas fallback počítá nejvýše 640 trvalých bodů a 320 jisker na CPU.

Myš působí magneticky už při přiblížení. Pole dohání kurzor tlumenou pružinou; rychlost i směr vytvářejí brázdu. Klik vyšle rázovou vlnu a prach také ze strun. Držení stáčí částice do víru, puštění je rozmetá. Dvojklik/dvojťuk rozladí jednotlivé struny na 3,8 sekundy. Pointer Events zachovávají až osm současných zdrojů a dotykový švih. Události formuláře zůstávají nativní, `touch-action: none` platí jen na canvasu.

Přibližně po třech sekundách klidu prach začne tvořit **mluvka**. Offscreen maska používá aplikační Manrope 800; její vzorky jsou cíle částic, nápis není DOM vrstva. Struny se při formování ztiší. Pohyb nápis roztrhá a uvolní částice. Rozměry cílové masky se přepočítávají pro mobilní pás, levou část telefonu na šířku i skutečné místo vedle karty desktopu a po načtení písma.

WebGL nejprve vykreslí struny a body do textury. Samostatný průchod provede RGB split, posun řádků, bloků a prostorový šum. Silný klik, rychlý švih a rozpad nápisu jej spouštějí na nejvýše 220 ms; odstup mezi spuštěními je alespoň 460 ms. Náhodný jemný zásah má rozestup alespoň 4,5 s, aktivita jej odsouvá. Efekt přesouvá existující obraz, nevytváří celoplošný záblesk. Šum se v rámci zásahu časově nepřepíná. Canvas fallback používá posun řádků. `prefers-reduced-motion` úplně vypíná glitch, emise a výbuchy a zpomaluje dýchání.

Desktopová vlna leží také pod průhlednou kartou. Na výšku má vlastní pás vysoký 34 dvh, formulář pod ním nativně scrolluje. Na šířku scrolluje pravá karta.

Skrytí dokumentu nebo opuštění viewportu uspí render. Odmontování ruší rAF, oba observery, posluchače a všechny GPU buffery, programy, shadery, VAO, transform feedback, framebuffer i texturu. Uvolní kontext a offscreen canvas; čekající načtení písma má ochranu proti práci po odmontování. Ztráta WebGL kontextu přepne na nový Canvas 2D.

`window.__vlnaStats` obsahuje FPS, vyhlazený interval snímků (`frameMs`, nikoli čas GPU příkazu), `renderScale`, mód, energii, zdroje, počet snímků a stav běhu. Navíc `particles` počítá trvalé body a jiskry s živou dobou 2,4 s, `particleLimit` aktuální adaptivní kapacitu, `glitch` sílu deformace, `name` míru formování, `nameBounds` oblast masky a `detune` rozladění. Pixelový poměr je nejvýše 2; nad 20 ms se render i částice postupně zmenšují až na 45 % a po stabilizaci se vracejí.

## Ověření bez TeamSpeak serveru

```sh
npm ci
npm run typecheck
npm run build
npx vite preview --config frontend/vite.config.ts --port 4180
# V dalším terminálu, ve stejném worktree:
node scripts/test-hp-vlna.mjs
prohlizec kontrola http://localhost:4180 docs/screenshots/hp-kontrola
npx esbuild frontend/src/Vlna.tsx --bundle --minify --format=esm --external:react | gzip -c | wc -c
prohlizec close
```

Skript se připojí přes CDP k čistému Chromu spuštěnému obalem `prohlizec`, vytváří izolované kontexty a skutečné vstupy myši i CDP dotyků (`hasTouch`, DPR 2). Ve statickém `dist/` dočasně sestaví samostatný mount komponenty pro kontrolu životního cyklu. Následující build tento pomocný soubor odstraní. Nenavazuje spojení s TS ani WS serverem.

Výsledky, rozdíly pixelů, FPS a počty částic jsou v `screenshots/hp-overeni.json`. Test ověřuje čas zahájení nápisu, shodu skutečných pixelů s nezávisle vykreslenou maskou Manrope (F1, precision, recall, tolerance jednoho pixelu) a horší shodu s kontrolním slovem. Dále jeho rozpad, zánik glitche do 300 ms, rozladění, růst počtu částic, dva prsty, švih, psaní, nativní scroll, omezený pohyb, Canvas fallback, ztrátu kontextu a společnou adaptaci renderu a částic. Instrumentace kontroluje nulový počet naplánovaných rAF i GPU objektů po odmontování. Skrytí dokumentu simuluje hodnotou `document.hidden` a událostí; opuštění viewportu ověřuje skutečným IntersectionObserverem. Screenshoty používají CSS rozměry viewportů.

Fyzický Android/iPhone, jejich GPU, systémová klávesnice a spotřeba baterie vyžadují ověření na zařízení. Mobilní emulace tuto zkoušku nenahrazuje.

Kontrola odstraněných hlášek (očekává se žádný výstup, návratový kód 1):

```sh
rg -ni 'MÍSTO PRO VÁŠ HLAS|DOBRÁ PARTA|Tak se|slyšíme|Váš TeamSpeak|Připojte se k ostatním|BEZ INSTALACE|01 / PŘIPOJIT|VÍTEJTE NA MLUVCE|Pojďte za ostatními|Stačí adresa|Identita zůstává|MLUVKA / WEBOVÝ|Malá aplikace' frontend
```
