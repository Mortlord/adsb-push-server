const express = require('express');
const cors    = require('cors');
const webpush = require('web-push');
const fs      = require('fs');

const app  = express();
app.use(cors());
app.use(express.json());

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL       = process.env.VAPID_EMAIL       || 'admin@example.com';
const SUBS_FILE         = '/tmp/subscriptions.json';
const COOLDOWN_MS       = 5 * 60 * 1000; // 5 Minuten pro Callsign pro Gerät

webpush.setVapidDetails(
  `mailto:${VAPID_EMAIL}`,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// { endpoint: subscription }
let subscriptions = {};
// { endpoint_callsign: timestamp }
let notifiedCache = {};

function loadSubscriptions() {
  try {
    const data = fs.readFileSync(SUBS_FILE, 'utf8');
    subscriptions = JSON.parse(data);
    console.log(`Loaded ${Object.keys(subscriptions).length} subscriptions`);
  } catch { subscriptions = {}; }
}

function saveSubscriptions() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions)); }
  catch(e) { console.error('Save error:', e); }
}

loadSubscriptions();

app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/subscribe', (req, res) => {
  const sub = req.body;
  subscriptions[sub.endpoint] = sub;
  saveSubscriptions();
  console.log(`Subscriptions: ${Object.keys(subscriptions).length}`);
  res.json({ ok: true });
});

app.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  delete subscriptions[endpoint];
  saveSubscriptions();
  res.json({ ok: true });
});

app.post('/check', async (req, res) => {
  const { favorites = [], active = [], endpoint } = req.body;

  // Nur das anfragende Gerät benachrichtigen
  const sub = endpoint && subscriptions[endpoint];
  if (!sub || !favorites.length) {
    return res.json({ matches: [] });
  }

  const activeSet = new Set(active);
  const matches   = favorites.filter(cs => activeSet.has(cs));

  if (!matches.length) {
    return res.json({ matches });
  }

  const now        = Date.now();
  const newMatches = matches.filter(cs => {
    const key = `${endpoint}:${cs}`;
    return now - (notifiedCache[key] || 0) > COOLDOWN_MS;
  });

  console.log(`Check [${endpoint.slice(-8)}]: matches=${matches}, new=${newMatches}`);

  if (!newMatches.length) {
    return res.json({ matches, cooldown: true });
  }

  const body    = '✈ ' + newMatches.sort().join(', ') + ' in deinem Radar!';
  const payload = JSON.stringify({ title: 'ADSB Radar', body });

  try {
    await webpush.sendNotification(sub, payload);
    console.log(`Push sent OK: ${body}`);
    newMatches.forEach(cs => {
      notifiedCache[`${endpoint}:${cs}`] = now;
    });
  } catch(e) {
    console.log(`Push failed (${e.statusCode}): ${e.body}`);
    if (e.statusCode === 404 || e.statusCode === 410) {
      delete subscriptions[endpoint];
      saveSubscriptions();
    }
  }

  res.json({ matches, notified: newMatches });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', subscriptions: Object.keys(subscriptions).length });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
