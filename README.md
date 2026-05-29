# ADSB Radar -- Push Notification Server

Minimaler Flask-Server für Web Push Notifications.

## Setup

### 1. VAPID Keys generieren

```bash
pip install pywebpush cryptography
python generate_keys.py
```

### 2. Railway Deployment

1. Dieses Repo auf GitHub pushen
2. Railway → New Project → Deploy from GitHub Repo
3. Environment Variables setzen:
   - `VAPID_PRIVATE_KEY` -- aus generate_keys.py
   - `VAPID_PUBLIC_KEY`  -- aus generate_keys.py
   - `VAPID_EMAIL`       -- deine E-Mail

### 3. URL in index.html eintragen

Nach dem Deployment gibt Railway eine URL wie `https://adsb-push-server.railway.app`.
Diese URL in `index.html` als `PUSH_SERVER_URL` eintragen.

## Endpunkte

| Endpunkt | Methode | Zweck |
|---|---|---|
| `/vapid-public-key` | GET | Public Key für Browser |
| `/subscribe` | POST | Push-Subscription speichern |
| `/unsubscribe` | POST | Subscription löschen |
| `/check` | POST | Favoriten prüfen, Push senden |
| `/health` | GET | Status |
