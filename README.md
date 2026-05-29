# ADSB Radar – Push Server

Hintergrund-Server für Telegram-Benachrichtigungen des ADSB Radar.

## Funktion

- Empfängt Standort, Radius, Favoriten und Telegram Chat-ID von der App
- Pollt alle 60s [airplanes.live](https://airplanes.live) mit diesen Daten
- Sendet Telegram-Nachricht wenn ein Favorit im Alert-Radius auftaucht
- Aktiv zwischen 08:00 und 23:59 Uhr (Europe/Berlin)

## Setup

### 1. Railway Deployment

1. Dieses Repo auf Railway deployen
2. Environment Variables setzen:

| Variable | Wert |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token von @BotFather |

### 2. Telegram Bot einrichten

1. Telegram → [@BotFather](https://t.me/BotFather) → `/newbot`
2. Token als `TELEGRAM_BOT_TOKEN` in Railway eintragen
3. Bot öffnen → `/start`
4. Chat-ID abrufen: `https://<railway-url>/get-chat-id`
5. Chat-ID in der ADSB Radar App eintragen

## Endpunkte

| Endpunkt | Methode | Zweck |
|---|---|---|
| `/update` | POST | Standort + Favoriten von der App empfangen |
| `/get-chat-id` | GET | Telegram Chat-ID ermitteln |
| `/health` | GET | Status prüfen |
