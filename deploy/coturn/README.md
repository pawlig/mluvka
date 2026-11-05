# coturn na Easypanelu

Příprava pro samostatnou App z image `coturn/coturn`; nic se tímto repozitářem nenasazuje.
Nasazený TURN od Martina lze použít přímo, bez TLS a bez změny image Mluvky.

1. DNS `turn.example.org` musí směřovat záznamem A na veřejnou IP hostitele, přímo, bez HTTP proxy/CDN.
   AAAA přidejte jen při funkčním IPv6 routování a firewallu.
2. Mapujte **3478/udp i 3478/tcp** a celý **49160–49200/udp** na stejné porty kontejneru.
   Stejné porty povolte na firewallu hostitele. Nestačí doména v HTTP reverse proxy Easypanelu.
   Při použití host network otevřete tyto porty přímo na hostiteli.
3. V coturn nastavte `use-auth-secret`, `static-auth-secret` shodný s Mluvkou, `realm=example.org`,
   `external-ip` na veřejnou IP hostitele. Při NAT použijte `veřejná/privátní` podle síťového režimu.
   Použijte aktuální image se zapracovanými bezpečnostními opravami coturn.
4. Připojte konfiguraci odvozenou z [turnserver.conf.example](turnserver.conf.example).
   **coturn sám nenahrazuje `${TURN_SECRET}` ani `${TURN_EXTERNAL_IP}` z env**.
   Runtime entrypoint nebo generátor konfigurace musí vložit hodnoty do souboru s právy 0600
   mimo repozitář a spustit `turnserver -c /run/turnserver.conf`. Heslo nevypisovat do logů.
   Pokud konfiguraci spravuje Martin již existujícím způsobem, zachovejte jej.
5. Zachovejte všechny `denied-peer-ip` ze šablony (včetně IPv6), `no-multicast-peers`, `no-cli`,
   `fingerprint`. `user-quota=12` dovoluje paralelní vysílání a sledování i dočasné ICE restarty;
   `total-quota=120` a `max-bps=1500000` (bajty/s na TURN session) jsou výchozí provozní stropy.
   Šest diváků znamená šest samostatných přenosů; při růstu provozu sledujte kapacitu uplinku a alokace.

U **Mluvky** nastavte:

```text
TURN_URLS=turn:turn.example.org:3478?transport=udp,turn:turn.example.org:3478?transport=tcp
TURN_SECRET=<stejná hodnota jako static-auth-secret coturn, vložit z trezoru>
STUN_URLS=stun:stun.l.google.com:19302
```

`STUN_URLS` lze vynechat (uvedená hodnota je výchozí) nebo nastavit prázdné.
`TURN_SECRET` už je podle předávky nastavený; zkontrolovat shodu, doplnit `TURN_URLS`.
Žádné `turns:` ani certifikát není pro toto nastavení potřeba. Web Mluvky potřebuje HTTPS
kvůli `getDisplayMedia`; lokálně funguje localhost. `TURN_URLS` bez hesla ukončí start backendu
s chybou konfigurace. Samotné heslo se nikdy neposílá klientovi.

## Ověření

Přihlaste dvě Mluvky do stejného kanálu. Přes DevTools v přihlášené stránce načtěte `/api/ice`
s `Authorization: Bearer <token ze share_session>`; token, dočasné uživatelské jméno ani credential
nikam neukládejte. Username má tvar `expiry:hash-uid`, expiry je za 12 hodin a credential je
`base64(HMAC-SHA1(TURN_SECRET, username))` podle [coturn TURN REST API](https://github.com/coturn/coturn/blob/master/README.turnserver).
Endpoint bez živé relace vrátí 401, po odpojení token okamžitě přestává platit.

Do [Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
lze krátce vložit dočasné údaje a URL UDP i TCP; očekává se kandidát `relay`.
Alternativně `turnutils_uclient -h` vypíše přepínače konkrétní instalované verze:
`-u` username, `-w` credential, `-p 3478`, `-y` client-to-client test, `-t` pro TCP k TURN.
Produkční credentials neposílejte do sdílené historie shellu ani screenshotů.
Samotný relay kandidát neprokazuje tok médií: otestujte také sdílení mezi dvěma různými sítěmi
(například desktop na Wi-Fi a mobil na datech) a v debug okně ověřte `candidate: relay` a růst fps/bitrate.

Lokální regresní test `npm run e2e` sám spouští coturn na 3479 a relay 49220–49260,
vygeneruje náhodné testovací heslo a v `finally` proces i dočasný config odstraní.
Test používá `allow-loopback-peers` jen kvůli jednomu lokálnímu hostiteli — **nepatří do produkce**.
Vynucení `iceTransportPolicy: relay` existuje pouze v buildu `VITE_E2E_SHARING=1`;
produkční build tento přepínač neobsahuje. Canvas stream vkládá jen Playwright harness.

Bez `TURN_URLS` vrací backend pouze STUN. Přímé spojení může fungovat v LAN a přes některé NAT;
v mobilních sítích, symetrickém NAT nebo při blokovaném UDP se nemusí podařit připojit.
