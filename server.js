const express  = require('express');
const cors     = require('cors');
const https    = require('https');
const fs       = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const COOLDOWN_MS = 5 * 60 * 1000; // 5 Minuten pro Callsign

const STATE_FILE = '/tmp/userstate.json';

function loadUserState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveUserState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(userState)); }
  catch(e) { console.error('Save error:', e.message); }
}

// Gespeicherter Zustand pro Chat-ID
const userState = loadUserState();

// Cooldown-Cache { chatId_callsign: timestamp }
const notifiedCache = {};

function sendTelegramMessage(chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fetchAircraft(lat, lon, radius) {
  return new Promise((resolve, reject) => {
    const url = `https://api.airplanes.live/v2/point/${lat}/${lon}/${radius}`;
    https.get(url, { headers: { 'User-Agent': 'adsb-radar/2.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Nautische Meilen
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// App schickt beim Öffnen Standort + Favoriten
app.post('/update', (req, res) => {
  const { chat_id, lat, lon, radius, favorites, alert_radius } = req.body;
  if (!chat_id) return res.json({ ok: false, error: 'chat_id required' });
  userState[chat_id] = { lat, lon, radius, favorites: favorites || [], alert_radius: alert_radius || 15, lastSeen: Date.now() };
  saveUserState();
  console.log(`Updated [${chat_id}]: lat=${lat}, lon=${lon}, radius=${radius}, favorites=${favorites}, alert=${alert_radius}`);
  res.json({ ok: true });
});

// Chat-ID ermitteln
app.get('/get-chat-id', async (req, res) => {
  try {
    const r = await new Promise((resolve, reject) => {
      https.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`, resp => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    const updates = r.result || [];
    if (!updates.length) return res.json({ chat_id: null, hint: 'Sende /start an den Bot und versuche es erneut' });
    const latest  = updates[updates.length - 1];
    const chat_id = latest.message?.chat?.id;
    res.json({ chat_id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: Object.keys(userState).length, bot: !!BOT_TOKEN });
});

// Polling: alle 60s für jeden registrierten User
async function pollAll() {
  // Nur zwischen 08:00 und 23:59 UTC+1 (Europe/Berlin)
  const hour = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false });
  if (parseInt(hour) < 8) return;
  for (const [chatId, state] of Object.entries(userState)) {
    if (!state.lat || !state.favorites.length) continue;
    try {
      const data = await fetchAircraft(state.lat, state.lon, state.radius);
      const aircraft = data.ac || [];
      const now = Date.now();

      for (const ac of aircraft) {
        const callsign = (ac.flight || '').trim();
        if (!callsign || !state.favorites.includes(callsign)) continue;

        // Distanz berechnen
        if (ac.lat == null || ac.lon == null) continue;
        const dist = haversine(state.lat, state.lon, ac.lat, ac.lon);
        if (dist > state.alert_radius) continue;

        // Cooldown prüfen
        const key = `${chatId}:${callsign}`;
        if (now - (notifiedCache[key] || 0) < COOLDOWN_MS) continue;

        // Telegram senden
        const text = `✈ ${callsign} ist in deinem Radar! (${dist.toFixed(1)} nm)`;
        await sendTelegramMessage(chatId, text);
        notifiedCache[key] = now;
        console.log(`Telegram sent to ${chatId}: ${text}`);
      }
    } catch(e) {
      console.error(`Poll error for ${chatId}: ${e.message}`);
    }
  }
}

setInterval(pollAll, 60 * 1000);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
