import os
import json
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from pywebpush import webpush, WebPushException

app = Flask(__name__)
CORS(app)

# VAPID Schlüssel (werden als Railway Environment Variables gesetzt)
VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY')
VAPID_PUBLIC_KEY  = os.environ.get('VAPID_PUBLIC_KEY')
VAPID_CLAIMS      = {"sub": "mailto:" + os.environ.get('VAPID_EMAIL', 'admin@example.com')}

# Subscriptions in Memory (für Produktion: SQLite oder Railway Volume)
subscriptions = []

# ── Endpunkte ─────────────────────────────────

@app.route('/vapid-public-key', methods=['GET'])
def get_vapid_key():
    return jsonify({'publicKey': VAPID_PUBLIC_KEY})

@app.route('/subscribe', methods=['POST'])
def subscribe():
    sub = request.json
    if sub and sub not in subscriptions:
        subscriptions.append(sub)
    return jsonify({'ok': True})

@app.route('/unsubscribe', methods=['POST'])
def unsubscribe():
    sub = request.json
    if sub in subscriptions:
        subscriptions.remove(sub)
    return jsonify({'ok': True})

@app.route('/check', methods=['POST'])
def check():
    """
    Empfängt Liste von Favoriten-Callsigns und aktiven Callsigns.
    Schickt Push wenn ein Favorit aktiv ist.
    """
    data = request.json
    favorites = set(data.get('favorites', []))
    active    = set(data.get('active', []))
    matches   = favorites & active

    if not matches or not subscriptions:
        return jsonify({'matches': list(matches)})

    message = '✈ ' + ', '.join(sorted(matches)) + ' in deinem Radar!'

    dead = []
    for sub in subscriptions:
        try:
            webpush(
                subscription_info=sub,
                data=json.dumps({'title': 'ADSB Radar', 'body': message}),
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims=VAPID_CLAIMS
            )
        except WebPushException as e:
            if '410' in str(e) or '404' in str(e):
                dead.append(sub)  # Abgelaufene Subscription entfernen

    for d in dead:
        subscriptions.remove(d)

    return jsonify({'matches': list(matches), 'notified': len(subscriptions)})

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'subscriptions': len(subscriptions)})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
