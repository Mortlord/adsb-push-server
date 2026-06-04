# ADSB Radar – Push Server

Hintergrund-Server für Telegram-Benachrichtigungen des ADSB Radar.

## Funktion

- Empfängt Standort, Radius, Favoriten und Telegram Chat-ID von der App
- Pollt minütlich [airplanes.live](https://airplanes.live)
- Sendet Telegram-Benachrichtigung wenn ein Favorit im Alert-Radius (20nm) auftaucht
- Zählt alle Flugzeuge im Alert-Radius (unabhängig von Favoriten) für die Statistik
- Zählt Callsign-Gruppen im 20nm-Radius um Ziegelweg 11, Freiburg (Heimradar)
- Sendet täglich um 07:55 Uhr zwei Berichte:
  - Favoriten-Übersicht der letzten 24 Stunden
  - Heimradar-Bericht mit Callsign-Gruppen (gestern / laufende Woche / laufender Monat)

## Telegram-Befehle

| Befehl | Funktion |
|---|---|
| `/stats` | Top 20 häufigste Besucher in der eigenen Alert Zone |
| `/heimreport` | Heimradar-Bericht on demand abrufen |

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

Separater Railway-Service, der minütlich `/poll` aufruft und den Haupt-Server dabei wach hält.

## Endpunkte

| Endpunkt | Methode | Zweck |
|---|---|---|
| `/update` | POST | Standort + Favoriten von der App empfangen |
| `/poll` | GET | Poll auslösen (wird vom Cron-Job aufgerufen) |
| `/get-chat-id` | GET | Telegram Chat-ID ermitteln |
| `/setup-webhook` | GET | Telegram Webhook registrieren |
| `/status` | GET | Serverstatus und Anzahl aktiver Nutzer |

## Datenspeicherung

Alle Dateien liegen im Railway-Volume unter `/data`:

| Datei | Inhalt |
|---|---|
| `userstate.json` | Standort, Radius, Favoriten je Chat-ID |
| `flighthistory.json` | Letzte 100 Favoriten-Sichtungen je Chat-ID |
| `notifiedcache.json` | Cooldown-Timestamps (5 min) gegen Spam |
| `visitstats.json` | Besuchszähler je Callsign je Chat-ID |
| `homestats.json` | Callsign-Gruppen-Zähler je Tag (Heimradar) |
