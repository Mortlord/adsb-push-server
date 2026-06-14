# ADSB Radar – Push Server

Hintergrund-Server für das ADSB Radar: Telegram-Benachrichtigungen, Routen-Auflösung und der Flugzeug-Feed für beide Frontend-Apps.

## Funktion

- Empfängt Standort, Radius und Favoriten von der App (authentifiziert über einen Aktivierungscode, nicht mehr über die rohe Chat-ID)
- Pollt alle 5 Minuten [airplanes.live](https://airplanes.live)
- Sendet Telegram-Benachrichtigung wenn ein Favorit im Alert-Radius auftaucht (08:00–23:59 Uhr lokaler Zeit)
- Sichtungen werden auch nachts aufgezeichnet, nur der Alert wird unterdrückt
- Zählt alle Flugzeuge im Alert-Radius für die Statistik
- Zählt Callsign-Gruppen im 20nm-Radius um Freiburg (Heimradar)
- Sendet täglich um 23:55 Uhr einen Abendbericht:
  - **Betreiber:** Heimradar-Bericht (Callsign-Gruppen + unique Callsigns), unbekannte Gruppen, Favoriten des Tages
  - **Alle Nutzer:** Favoriten des Tages mit Uhrzeit und Richtung
- Löscht täglich Daten älter als 3 Tage (`flightHistory`, `homeStats`, `unknownCallsigns`)
- Löst Flugrouten auf (`/route`): zuerst aus einer lokal gehosteten Routen-Datenbank, sonst über externe APIs als Lückenfüller
- Stellt den Flugzeug-Feed als eigenen Proxy bereit (`/aircraft`), ohne fremden CORS-Proxy
- Liefert `AIRLINE_NAMES` als API für beide Frontend-Apps

## Komponenten

| Datei | Rolle |
|---|---|
| `server.js` | Hauptserver: API, Telegram-Bot, Poll-Logik, Routen-Auflösung |
| `routedb.js` | Lokale Routen-Datenbank (Download, Aufbereitung, Auflösung im Speicher) |
| `poll.js` | Separater Cron-Service, ruft alle 5 Minuten `/poll` auf und hält den Hauptserver wach |

## Telegram-Befehle

| Befehl | Funktion |
|---|---|
| `/start` | Aktivierungscode anzeigen und Bot aktivieren |
| `/favoriten` | Heutige Favoriten-Sichtungen mit Uhrzeit |
| `/stats` | Top 20 häufigste Besucher in der eigenen Alert Zone |
| `/unbekannt` | Unbekannte Callsign-Gruppen (Betreiber) |
| `/validateHB` | HB-Register validieren (Betreiber) |
| `/deleteunbekannt` | Unbekannte Liste leeren (Betreiber) |

## Setup

### 1. Abhängigkeiten

In der `package.json` müssen neben `express` und `cors` auch `tar` stehen. `tar` wird von `routedb.js` benötigt, um das Routen-Archiv zu entpacken:

```json
"dependencies": {
  "express": "^4.18.2",
  "cors": "^2.8.5",
  "tar": "^7.5.16"
}
```

Railway führt beim Deploy automatisch `npm install` aus.

### 2. Railway Deployment

1. Dieses Repo auf Railway deployen (Hauptserver)
2. Volume anlegen mit Mount Path `/data` (persistenter Speicher für Statistiken und Routen-Cache)
3. Umgebungsvariablen setzen:

| Variable | Pflicht | Wert |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ja | Token von @BotFather |
| `ADMIN_SECRET` | ja | Zufallsgeheimnis, schützt `/poll`, `/get-chat-id`, `/setup-webhook` |
| `WEBHOOK_SECRET` | ja | Zufallsgeheimnis, verifiziert eingehende Telegram-Webhooks |
| `PUBLIC_HOST` | ja | Öffentlicher Host des Servers, z.B. `web-production-xxxx.up.railway.app` (für `/setup-webhook`) |
| `OWNER_CHAT_ID` | ja | Chat-ID des Betreibers (Heimradar-Bericht, betreiberspezifische Befehle) |
| `ALLOWED_ORIGINS` | empfohlen | Kommagetrennte CORS-Whitelist, z.B. `https://adsb-radar.de,https://www.adsb-radar.de,https://mortlord.github.io`. Hat einen Default, sollte bei eigenen Domains gesetzt werden |
| `AERODATABOX_KEY` | optional | RapidAPI-Key, nur für die AeroDataBox-Whitelist-Prefixe |
| `STATE_ENC_KEY` | optional | Hex-Schlüssel zur Verschlüsselung der Dateien unter `/data`. Einmal gesetzt nicht mehr ändern, sonst sind die alten Dateien nicht mehr lesbar |
| `HOME_LAT` | optional | Breitengrad des Heimradars (Default 47.9732, Freiburg) |
| `HOME_LON` | optional | Längengrad des Heimradars (Default 7.8319, Freiburg) |
| `HOME_RADIUS` | optional | Heimradar-Radius in nm (Default 20) |

`PORT` wird von Railway automatisch gesetzt.

Zufallsgeheimnisse lassen sich z.B. unter Windows per PowerShell erzeugen:

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
($b | ForEach-Object { $_.ToString("x2") }) -join ''
```

### 3. Telegram Bot einrichten

1. Telegram → [@BotFather](https://t.me/BotFather) → `/newbot`
2. Token als `TELEGRAM_BOT_TOKEN` in Railway eintragen
3. Webhook registrieren: `https://<PUBLIC_HOST>/setup-webhook` (mit Admin-Auth, siehe unten)
4. Bot öffnen → `/start` → der Bot zeigt deinen **Aktivierungscode**
5. Aktivierungscode in der ADSB Radar App unter ⭐ FAVORITEN eintragen

Der Aktivierungscode ersetzt die frühere Chat-ID-Eingabe. Er ist pro Nutzer eindeutig, wird wie ein Passwort behandelt und bindet die App-Aufrufe serverseitig an die richtige Chat-ID. `/get-chat-id` ist nur noch ein Admin-Hilfsendpunkt.

### 4. Cron-Job (poll.js)

Separater Railway-Service, der alle 5 Minuten `/poll` aufruft und den Hauptserver dabei wach hält. Da `/poll` jetzt Admin-geschützt ist, muss dieser Service ebenfalls `ADMIN_SECRET` als Umgebungsvariable gesetzt haben (identisch zum Hauptserver). `poll.js` sendet das Geheimnis im Header `X-Admin-Secret`.

## Routen-Datenbank

Die Routen-Auflösung läuft primär lokal, um unabhängig von externen Rate-Limits zu sein.

- Quelle: [vradarserver/standing-data](https://github.com/vradarserver/standing-data) (Lizenz **CC0 1.0**, Public Domain)
- Beim Start lädt `routedb.js` die aufbereitete Form aus `/data`. Fehlt sie oder ist sie älter als 7 Tage, wird das Archiv im Hintergrund geladen, abgeflacht und gecacht
- Im Speicher liegen rund 616.000 Routen, 34.000 Flughäfen und 6.900 Airline-Codes (etwa 75 MB RAM, etwa 12 MB auf `/data`)
- Wöchentliche Aktualisierung im Hintergrund

Auflösungsreihenfolge in `/route`:

1. Server-Cache
2. Lokale Routen-DB (`source: "local"`)
3. AeroDataBox (nur Whitelist-Prefixe, falls `AERODATABOX_KEY` gesetzt)
4. adsbdb als Lückenfüller für Airline-Callsigns, die in der lokalen DB fehlen (mit exponentiellem Backoff bei 429)

Registrierungs- und Privat-Callsigns werden anhand der kanonischen Airline-Code-Liste sicher erkannt und gar nicht erst extern angefragt, da sie ohnehin keine Route haben. adsb.lol dient nur als Fallback, solange die lokale DB nicht bereit ist, da es dieselben VRS-Daten nutzt.

## Endpunkte

| Endpunkt | Methode | Schutz | Zweck |
|---|---|---|---|
| `/update` | POST | Token | Standort + Favoriten von der App empfangen |
| `/delete` | DELETE | Token | Nutzerdaten löschen |
| `/route` | GET | Rate-Limit (600/min/IP) | Flugroute zu einem Callsign auflösen |
| `/aircraft` | GET | Rate-Limit (60/min/IP) | Flugzeug-Feed von airplanes.live (Proxy) |
| `/airlines` | GET | – | `AIRLINE_NAMES` als JSON (für beide Frontend-Apps) |
| `/status` | GET | – | Serverstatus und Anzahl aktiver Nutzer |
| `/poll` | GET | Admin | Poll auslösen (wird vom Cron-Job aufgerufen) |
| `/get-chat-id` | GET | Admin | Telegram Chat-ID ermitteln |
| `/setup-webhook` | GET | Admin | Telegram Webhook registrieren |
| `/telegram-webhook` | POST | Secret-Token | Eingehende Telegram-Updates |

## Datenspeicherung

Alle Dateien liegen im Railway-Volume unter `/data`. Die Statistik-Dateien werden täglich auf 3 Tage gekürzt. Bei gesetztem `STATE_ENC_KEY` werden die Zustandsdateien verschlüsselt abgelegt.

| Datei | Inhalt |
|---|---|
| `userstate.json` | Standort, Radius, Alert-Radius, Favoriten, Zeitzone je Chat-ID |
| `chattokens.json` | Aktivierungscodes (Token) je Chat-ID |
| `flighthistory.json` | Favoriten-Sichtungen je Chat-ID (max. 3 Tage) |
| `notifiedcache.json` | Cooldown-Timestamps (5 min) gegen Spam |
| `visitstats.json` | Besuchszähler je Callsign je Chat-ID |
| `homestats.json` | Callsign-Gruppen + Callsign-Liste je Tag, max. 3 Tage (Heimradar) |
| `unknowncallsigns.json` | Unbekannte Callsign-Prefixe mit Beispielen |
| `hbcallsigns.json` | Schweizer HB-Privatregister |
| `routecache.json` | Zwischenspeicher aufgelöster Routen (positiv und negativ) |
| `vrs-routes.csv` | Lokale Routen-DB: Callsign → Flughäfen (ICAO) |
| `vrs-airports.json` | Lokale Routen-DB: ICAO → IATA, Ort |
| `vrs-airlines.txt` | Bekannte Airline-Codes (Abgrenzung Linien- vs. Privatflug) |
| `vrs-meta.json` | Zeitstempel und Umfang des letzten DB-Aufbaus |

## Sicherheit

- App-Aufrufe (`/update`, `/delete`) sind über einen pro Nutzer eindeutigen Token authentifiziert. Die Chat-ID wird serverseitig aus dem Token abgeleitet, nie aus dem Request-Body
- Admin-Endpunkte (`/poll`, `/get-chat-id`, `/setup-webhook`) erfordern `ADMIN_SECRET`
- Eingehende Telegram-Webhooks werden über den `X-Telegram-Bot-Api-Secret-Token` gegen `WEBHOOK_SECRET` verifiziert
- CORS ist auf `ALLOWED_ORIGINS` beschränkt
- Eigene Rate-Limits auf `/route` und `/aircraft`
- Optionale Verschlüsselung der `/data`-Dateien über `STATE_ENC_KEY`
- Quellenangabe: Routendaten von [vradarserver/standing-data](https://github.com/vradarserver/standing-data) (CC0)
