# ADSB Radar – Push Server

Hintergrund-Server für Telegram-Benachrichtigungen des ADSB Radar.

## Funktion

- Empfängt Standort, Radius, Favoriten und Telegram Chat-ID von der App
- Pollt alle 5 Minuten [airplanes.live](https://airplanes.live)
- Sendet Telegram-Benachrichtigung wenn ein Favorit im Alert-Radius auftaucht (08:00–23:59 Uhr lokaler Zeit)
- Sichtungen werden auch nachts aufgezeichnet, nur der Alert wird unterdrückt
- Zählt alle Flugzeuge im Alert-Radius für die Statistik
- Zählt Callsign-Gruppen im 20nm-Radius um Freiburg (Heimradar)
- Sendet täglich um 23:55 Uhr einen Abendbericht:
  - **Betreiber:** Heimradar-Bericht (Callsign-Gruppen + unique Callsigns), unbekannte Gruppen, Favoriten des Tages
  - **Alle Nutzer:** Favoriten des Tages mit Uhrzeit und Richtung
- Löscht täglich Daten älter als 3 Tage (`flightHistory`, `homeStats`, `unknownCallsigns`)
- Liefert `AIRLINE_NAMES` als API für beide Frontend-Apps

## Telegram-Befehle

| Befehl | Funktion |
|---|---|
| `/start` | Chat-ID anzeigen und Bot aktivieren |
| `/favoriten` | Heutige Favoriten-Sichtungen mit Uhrzeit |
| `/stats` | Top 20 häufigste Besucher in der eigenen Alert Zone |
| `/unbekannt` | Unbekannte Callsign-Gruppen (Betreiber) |
| `/validateHB` | HB-Register validieren (Betreiber) |
| `/deleteunbekannt` | Unbekannte Liste leeren (Betreiber) |

## Setup

### 1. Railway Deployment

1. Dieses Repo auf Railway deployen
2. Environment Variable setzen:

| Variable | Wert |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token von @BotFather |

3. Volume anlegen mit Mount Path `/data` (persistenter Speicher für Statistiken)

### 2. Telegram Bot einrichten

1. Telegram → [@BotFather](https://t.me/BotFather) → `/newbot`
2. Token als `TELEGRAM_BOT_TOKEN` in Railway eintragen
3. Bot öffnen → `/start`
4. Chat-ID abrufen: `https://<railway-url>/get-chat-id`
5. Chat-ID in der ADSB Radar App eintragen
6. Webhook registrieren: `https://<railway-url>/setup-webhook`

### 3. Cron-Job (poll.js)

Separater Railway-Service, der alle 5 Minuten `/poll` aufruft und den Haupt-Server dabei wach hält.

## Endpunkte

| Endpunkt | Methode | Zweck |
|---|---|---|
| `/update` | POST | Standort + Favoriten von der App empfangen |
| `/poll` | GET | Poll auslösen (wird vom Cron-Job aufgerufen) |
| `/airlines` | GET | `AIRLINE_NAMES` als JSON (für beide Frontend-Apps) |
| `/get-chat-id` | GET | Telegram Chat-ID ermitteln |
| `/setup-webhook` | GET | Telegram Webhook registrieren |
| `/status` | GET | Serverstatus und Anzahl aktiver Nutzer |

## Datenspeicherung

Alle Dateien liegen im Railway-Volume unter `/data`. Daten älter als 3 Tage werden täglich automatisch bereinigt.

| Datei | Inhalt |
|---|---|
| `userstate.json` | Standort, Radius, Alert-Radius, Favoriten, Zeitzone je Chat-ID |
| `flighthistory.json` | Favoriten-Sichtungen je Chat-ID (max. 3 Tage) |
| `notifiedcache.json` | Cooldown-Timestamps (5 min) gegen Spam |
| `visitstats.json` | Besuchszähler je Callsign je Chat-ID |
| `homestats.json` | Callsign-Gruppen + Callsign-Liste je Tag, max. 3 Tage (Heimradar) |
| `unknowncallsigns.json` | Unbekannte Callsign-Prefixe mit Beispielen |
| `hbcallsigns.json` | Schweizer HB-Privatregister |
