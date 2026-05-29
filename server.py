import os
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
from pywebpush import webpush, WebPushException

app = Flask(__name__)
CORS(app)

VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY', '')
VAPID_PUBLIC_KEY  = os.environ.get('VAPID_PUBLIC_KEY', '')
VAPID_EMAIL       = os.environ.get('VAPID_EMAIL', 'admin@example.com')
VAPID_CLAIMS      = {"sub": f"mailto:{VAPID_EMAIL}"}

SUBS_FILE = '/tmp/subscriptions.json'

def load_subscriptions():
    try:
        with open(SUBS_FILE) as f:
            return json.load(f)
    except:
        return []

def save_subscriptions(subs):
    try:
        with open(SUBS_FILE, 'w') as f:
            json.dump(subs, f)
    except Exception as e:
        print(f"Save error: {e}")

subscriptions = load_subscriptions()

@app.route('/vapid-public-key', methods=['GET'])
def get_vapid_key():
    return jsonify({'publicKey': VAPID_PUBLIC_KEY})

@app.route('/subscribe', methods=['POST'])
def subscribe():
    global subscriptions
    sub = request.json
    endpoint = sub.get('endpoint', '')
    subscriptions = [s for s in subscriptions if s.get('endpoint') != endpoint]
    subscriptions.append(sub)
    save_subscriptions(subscriptions)
    print(f"Subscriptions: {len(subscriptions)}")
    return jsonify({'ok': True})

@app.route('/unsubscribe', methods=['POST'])
def unsubscribe():
    global subscriptions
    sub = request.json
    endpoint = sub.get('endpoint', '')
    subscriptions = [s for s in subscriptions if s.get('endpoint') != endpoint]
    save_subscriptions(subscriptions)
    return jsonify({'ok': True})

@app.route('/check', methods=['POST'])
def check():
    global subscriptions
    data      = request.json
    favorites = set(data.get('favorites', []))
    active    = set(data.get('active', []))
    matches   = favorites & active

    print(f"Check: favorites={favorites}, active={len(active)}, matches={matches}, subs={len(subscriptions)}")

    if not matches or not subscriptions:
        return jsonify({'matches': list(matches)})

    message = '✈ ' + ', '.join(sorted(matches)) + ' in deinem Radar!'
    dead = []

    for sub in subscriptions:
        try:
            webpush(
                subscription_info=sub,
                data=message,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims=VAPID_CLAIMS
            )
            print(f"Push sent OK: {message}")
        except WebPushException as e:
            print(f"Push failed ({e.response.status_code if e.response else 'no response'}): {e}")
            if e.response and e.response.status_code in (404, 410):
                dead.append(sub)
        except Exception as e:
            print(f"Push error: {e}")

    for d in dead:
        subscriptions.remove(d)
    if dead:
        save_subscriptions(subscriptions)

    return jsonify({'matches': list(matches), 'notified': len(subscriptions)})

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'subscriptions': len(subscriptions)})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
