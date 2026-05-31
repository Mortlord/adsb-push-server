const express = require('express');
const cors    = require('cors');
const https   = require('https');
const fs      = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN || '';
const COOLDOWN_MS  = 5 * 60 * 1000;
const STATE_FILE   = '/data/userstate.json';
const HISTORY_FILE = '/data/flighthistory.json';
const CACHE_FILE   = '/data/notifiedcache.json';

try { fs.mkdirSync('/data', { recursive: true }); } catch(e) {}

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); }
  catch(e) { console.error('Save error:', e.message); }
}

let userState     = loadJSON(STATE_FILE,   {});
let history       = loadJSON(HISTORY_FILE, {});
let notifiedCache = loadJSON(CACHE_FILE,   {});

// ── Hilfsfunktionen ────────────────────────────────────────────

function sendTelegramMessage(chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fetchAircraft(lat, lon, radius) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.airplanes.live/v2/point/${lat}/${lon}/${radius}`,
      { headers: { 'User-Agent': 'adsb-radar/2.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R    = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 +
               Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y    = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x    = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
               Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  const deg  = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const dirs = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

// ── Polling-Logik ──────────────────────────────────────────────

let lastSummaryDate = '';

async function doPoll() {
  const now      = Date.now();
  const nowDE    = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', minute: 'numeric', hour12: false });
  const hour     = parseInt(nowDE.split(':')[0]);
  const minute   = parseInt(nowDE.split(':')[1]);
  const todayStr = new Date().toLocaleDateString('de-DE',   { timeZone: 'Europe/Berlin' });
  const timeStr  = new Date().toLocaleTimeString('de-DE',   { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });

  // Tagesübersicht um 07:55
  if (hour === 7 && minute >= 55 && minute <= 59 && lastSummaryDate !== todayStr) {
    lastSummaryDate = todayStr;
    for (const [chatId, entries] of Object.entries(history)) {
      const todayEntries = (entries || []).filter(e => e.date === todayStr);
      if (!todayEntries.length) continue;
      const unique = [...new Map(todayEntries.map(e => [e.callsign, e])).values()];
      let text = `<b>✈ ADSB Radar – Zusammenfassung ${todayStr}</b>\n\n`;
      text += `${unique.length} Favorit${unique.length > 1 ? 'en' : ''} heute in deinem Radar:\n`;
      unique.forEach(e => { text += `• <b>${e.callsign}</b> – ${e.dist} nm ${e.dir} (${e.time})\n`; });
      try { await sendTelegramMessage(chatId, text); console.log(`Summary sent to ${chatId}`); }
      catch(e) { console.error(`Summary error: ${e.message}`); }
    }
  }

  // Favoriten prüfen
  for (const [chatId, state] of Object.entries(userState)) {
    if (!state.lat || !state.favorites?.length) continue;
    try {
      const data     = await fetchAircraft(state.lat, state.lon, state.radius);
      const aircraft = data.ac || [];

      for (const ac of aircraft) {
        const callsign = (ac.flight || '').trim();
        if (!callsign) continue;
        const favs = state.favorites.map(f => f.trim().toUpperCase());
        if (!favs.includes(callsign.toUpperCase())) continue;
        if (ac.lat == null || ac.lon == null) continue;

        const dist = haversine(state.lat, state.lon, ac.lat, ac.lon);
        if (dist > state.alert_radius) continue;

        const key = `${chatId}:${callsign}`;
        if (now - (notifiedCache[key] || 0) < COOLDOWN_MS) continue;

        const dir  = bearing(state.lat, state.lon, ac.lat, ac.lon);
        const text = `✈ <b>${callsign}</b> ist in deinem Radar!\n${dist.toFixed(1)} nm ${dir}`;
        await sendTelegramMessage(chatId, text);
        notifiedCache[key] = now;
        saveJSON(CACHE_FILE, notifiedCache);

        if (!history[chatId]) history[chatId] = [];
        history[chatId].push({ callsign, dist: dist.toFixed(1), dir, date: todayStr, time: timeStr });
        if (history[chatId].length > 100) history[chatId] = history[chatId].slice(-100);
        saveJSON(HISTORY_FILE, history);

        console.log(`Telegram sent to ${chatId}: ${callsign} ${dist.toFixed(1)} nm ${dir}`);
      }
    } catch(e) { console.error(`Poll error for ${chatId}: ${e.message}`); }
  }

  console.log('Poll complete.');
}

// ── Endpunkte ──────────────────────────────────────────────────

// App schickt Standort + Favoriten
app.post('/update', (req, res) => {
  const { chat_id, lat, lon, radius, favorites, alert_radius } = req.body;
  if (!chat_id) return res.json({ ok: false });
  userState[chat_id] = { lat, lon, radius, favorites: favorites || [], alert_radius: alert_radius || 15, lastSeen: Date.now() };
  saveJSON(STATE_FILE, userState);
  console.log(`Updated [${chat_id}]: favorites=${favorites}, alert=${alert_radius}`);
  res.json({ ok: true });
});

// Cron-Job triggert Poll
app.get('/poll', async (req, res) => {
  try {
    await doPoll();
    res.json({ ok: true });
  } catch(e) {
    console.error('Poll error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
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
    if (!updates.length) return res.json({ chat_id: null });
    res.json({ chat_id: updates[updates.length - 1].message?.chat?.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: Object.keys(userState).length });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
