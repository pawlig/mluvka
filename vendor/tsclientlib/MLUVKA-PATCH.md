# Lokální oprava tsclientlib

Zdroj: ReSpeak/tsclientlib, commit `ee3bc6f45a7137db7793ba5593a321df400d53e5`, crate `tsclientlib`.
Licence MIT OR Apache-2.0 jsou přiložené. Ostatní crate zůstávají na původním git rev.

TS3 při ochraně nových hlasových připojení z jedné IP vrací `ConnectFailedBanned` (0x0d01)
s `extra_message = "flood prevention, please try again later"`. Upstream v `wait_initserver`
zahazuje extra_message. Lokální změna zachová pouze bezpečný enum `ConnectFloodPrevention`,
rozliší ho před obecnými bany a zabrání dalším pokusům přes DNS adresy. Žádný serverový text
se neukládá do chyby ani logu. Jiný text či jiný kód zůstává původním trvalým banem/chybou.

Backend tento jednoznačný příznak normalizuje do kategorie BanFlooding (0x0d03), přičemž
log obsahuje i `wire_code=0x0d01`. Při aktualizaci upstreamu přenést tento malý rozdíl nebo
použít upstream API zachovávající důvod odmítnutí. Přímé aplikační TS příkazy a audio se nemění.

Při skutečném 0x0d01 zachováváme navíc pouze číselnou zbývající dobu z jednoznačného textu `you may retry in X seconds`, obdobných retry/expiry údajů nebo číselného extra_msg. Neznámý důvod zůstává banem bez doby; parser ani chyba nezachovávají volný serverový text.
