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

const STATS_FILE      = '/data/visitstats.json';
const HOME_STATS_FILE = '/data/homestats.json';

// Heimadresse fix: Ziegelweg 11, 79100 Freiburg
const HOME_LAT    = 47.9732;
const HOME_LON    = 7.8319;
const HOME_RADIUS = 20; // nm

let userState     = loadJSON(STATE_FILE,   {});
let history       = loadJSON(HISTORY_FILE, {});
let notifiedCache = loadJSON(CACHE_FILE,   {});
let visitStats    = loadJSON(STATS_FILE,   {}); // { chatId: { callsign: count } }
// homeStats: { 'DD.MM.YYYY': { PREFIX: count } }
let homeStats     = loadJSON(HOME_STATS_FILE, {});

// ICAO-Prefix -> Klarname
const AIRLINE_NAMES = {
  DLH: 'Lufthansa',        EWG: 'Eurowings',         CLH: 'Lufthansa CityLine',
  CFG: 'Condor',           TUI: 'TUI fly',            TOM: 'TUI fly',
  EZY: 'easyJet',          EJU: 'easyJet Europe',     RYR: 'Ryanair',
  WZZ: 'Wizz Air',         VLG: 'Vueling',            IBE: 'Iberia',
  BAW: 'British Airways',  AFR: 'Air France',         KLM: 'KLM',
  AUA: 'Austrian',         SWR: 'Swiss',              BEL: 'Brussels Airlines',
  UAE: 'Emirates',         ETD: 'Etihad',             QTR: 'Qatar Airways',
  THY: 'Turkish Airlines', RAM: 'Royal Air Maroc',    TAR: 'Tunisair',
  SVA: 'Saudia',           ELY: 'El Al',              MSR: 'EgyptAir',
  DAH: 'Air Algerie',      AAL: 'American Airlines',  UAL: 'United Airlines',
  DAL: 'Delta Air Lines',  ACA: 'Air Canada',         AMX: 'Aeromexico',
  CPA: 'Cathay Pacific',   CCA: 'Air China',          CSN: 'China Southern',
  CES: 'China Eastern',    JAL: 'Japan Airlines',     ANA: 'All Nippon Airways',
  KAL: 'Korean Air',       AAR: 'Asiana Airlines',    SIA: 'Singapore Airlines',
  MAS: 'Malaysia Airlines',THA: 'Thai Airways',       VNA: 'Vietnam Airlines',
  HVN: 'Vietnam Airlines', QFA: 'Qantas',             ANZ: 'Air New Zealand',
  ETH: 'Ethiopian Airlines',KQA: 'Kenya Airways',     GAF: 'German Air Force',
  GEC: 'Lufthansa Cargo',  BOX: 'DHL Air',            UPS: 'UPS Airlines',
  FDX: 'FedEx',            TAY: 'ASL Airlines',       MSC: 'Air Cairo',
  SAS: 'Scandinavian',     FIN: 'Finnair',            LOT: 'LOT Polish Airlines',
  CSA: 'Czech Airlines',   MAH: 'Malev',              TAP: 'TAP Air Portugal',
};

// Prefix-Matching: 'HVN' matcht HVN10, HVN18 etc.
function matchesFavorite(callsign, favorites) {
  const cs = callsign.toUpperCase();
  return favorites.some(f => {
    const fav = f.trim().toUpperCase();
    return cs === fav || cs.startsWith(fav);
  });
}

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

// ── Heim-Bericht generieren (wiederverwendbar) ─────────────────

function buildHeimReport(refDate) {
  // refDate = Date-Objekt des Bezugstages (normalerweise gestern)
  const ydayStr = refDate.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
  const ydayMs  = refDate.getTime();

  function isoWeekday(dStr) {
    const [d, m, y] = dStr.split('.').map(Number);
    return (new Date(y, m - 1, d).getDay() + 6) % 7; // 0=Mo 6=So
  }
  function daysRange(fromMs, toMs) {
    const days = [];
    for (let t = fromMs; t <= toMs; t += 86400000)
      days.push(new Date(t).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }));
    return days;
  }

  const weekStart  = ydayMs - isoWeekday(ydayStr) * 86400000;
  const [dd, mm, yy] = ydayStr.split('.').map(Number);
  const monthStart = new Date(yy, mm - 1, 1).getTime();

  function sumDays(dayList) {
    const totals = {};
    for (const day of dayList)
      for (const [p, c] of Object.entries(homeStats[day] || {}))
        totals[p] = (totals[p] || 0) + c;
    return totals;
  }
  function fmtTable(totals, label) {
    const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (!rows.length) return `<b>${label}</b>\n  (keine Daten)\n`;
    let s = `<b>${label}</b>\n`;
    rows.forEach(([p, c]) => {
      const name = AIRLINE_NAMES[p] || '';
      s += `  <b>${p}</b>${name ? ' ' + name : ''}: ${c}x\n`;
    });
    return s;
  }

  const nowMs     = Date.now();
  const weekDays  = daysRange(weekStart, nowMs);
  const monthDays = daysRange(monthStart, nowMs);

  let report = `<b>🏠 Heimradar Freiburg – Callsign-Gruppen (20nm)</b>\n\n`;
  report += fmtTable(homeStats[ydayStr] || {}, `Gestern (${ydayStr})`);
  report += '\n';
  report += fmtTable(sumDays(weekDays),  'Laufende Woche (Mo-So, inkl. heute)');
  report += '\n';
  report += fmtTable(sumDays(monthDays), `Laufender Monat (${mm}/${yy}, inkl. heute)`);
  return report;
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

  // Tagesübersicht um 07:55 -- letzte 24 Stunden
  if (hour === 7 && minute >= 55 && minute <= 59 && lastSummaryDate !== todayStr) {
    lastSummaryDate = todayStr;
    const cutoff = now - 24 * 60 * 60 * 1000;
    for (const [chatId, entries] of Object.entries(history)) {
      const recent = (entries || []).filter(e => e.ts && e.ts >= cutoff);
      if (!recent.length) continue;
      const unique = [...new Map(recent.map(e => [e.callsign, e])).values()];
      let text = `<b>✈ ADSB Radar – Letzte 24 Stunden</b>\n\n`;
      text += `${unique.length} Favorit${unique.length > 1 ? 'en' : ''} in deinem Radar:\n`;
      unique.forEach(e => { text += `• <b>${e.callsign}</b> – ${e.dist} nm ${e.dir} (${e.time})\n`; });
      try { await sendTelegramMessage(chatId, text); console.log(`Summary sent to ${chatId}`); }
      catch(e) { console.error(`Summary error: ${e.message}`); }
    }

    // Heim-Bericht an alle bekannten Chat-IDs
    const chatIds = Object.keys(userState);
    if (chatIds.length > 0) {
      const report = buildHeimReport(new Date(now - 24 * 60 * 60 * 1000));
      for (const chatId of chatIds) {
        try { await sendTelegramMessage(chatId, report); console.log(`Home report sent to ${chatId}`); }
        catch(e) { console.error(`Home report error: ${e.message}`); }
      }
    }
  }

  // Heim-Zählung: Callsign-Prefixe im 20nm Radius um Ziegelweg 11
  try {
    const homeData = await fetchAircraft(HOME_LAT, HOME_LON, HOME_RADIUS + 5);
    for (const ac of (homeData.ac || [])) {
      const callsign = (ac.flight || '').trim();
      if (!callsign || ac.lat == null || ac.lon == null) continue;
      if (haversine(HOME_LAT, HOME_LON, ac.lat, ac.lon) > HOME_RADIUS) continue;
      const prefix = callsign.replace(/[0-9]/g, '').substring(0, 3).toUpperCase();
      if (prefix.length < 2) continue;
      const homeKey = `home:${callsign}`;
      if (now - (notifiedCache[homeKey] || 0) < COOLDOWN_MS) continue;
      notifiedCache[homeKey] = now;
      if (!homeStats[todayStr]) homeStats[todayStr] = {};
      homeStats[todayStr][prefix] = (homeStats[todayStr][prefix] || 0) + 1;
    }
    saveJSON(HOME_STATS_FILE, homeStats);
    saveJSON(CACHE_FILE, notifiedCache);
  } catch(e) { console.error(`Home poll error: ${e.message}`); }

  // Alle Flugzeuge im Alert-Radius zählen (unabhängig von Favoriten)
  for (const [chatId, state] of Object.entries(userState)) {
    if (!state.lat) continue;
    try {
      const data     = await fetchAircraft(state.lat, state.lon, state.radius);
      const aircraft = data.ac || [];

      for (const ac of aircraft) {
        const callsign = (ac.flight || '').trim();
        if (!callsign || ac.lat == null || ac.lon == null) continue;
        const dist = haversine(state.lat, state.lon, ac.lat, ac.lon);
        if (dist > state.alert_radius) continue;

        // Besuch zählen -- einmal pro 5 Minuten pro Callsign
        const visitKey = `${chatId}:visit:${callsign}`;
        if (now - (notifiedCache[visitKey] || 0) >= COOLDOWN_MS) {
          notifiedCache[visitKey] = now;
          if (!visitStats[chatId]) visitStats[chatId] = {};
          visitStats[chatId][callsign] = (visitStats[chatId][callsign] || 0) + 1;
        }
      }
      saveJSON(STATS_FILE, visitStats);

      // Favoriten prüfen mit Prefix-Matching
      if (!state.favorites?.length) continue;
      for (const ac of aircraft) {
        const callsign = (ac.flight || '').trim();
        if (!callsign) continue;
        if (!matchesFavorite(callsign, state.favorites)) continue;
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
        history[chatId].push({ callsign, dist: dist.toFixed(1), dir, date: todayStr, time: timeStr, ts: now });
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
  userState[chat_id] = { lat, lon, radius, favorites: favorites || [], alert_radius: alert_radius || 20, lastSeen: Date.now() };
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

// Telegram Webhook fuer Bot-Kommandos
app.post('/telegram-webhook', async (req, res) => {
  const msg = req.body?.message;
  if (!msg) return res.json({ ok: true });
  const chatId = String(msg.chat?.id);
  const text   = msg.text || '';

  if (text.startsWith('/stats')) {
    const stats = visitStats[chatId];
    if (!stats || !Object.keys(stats).length) {
      await sendTelegramMessage(chatId, 'Noch keine Besuche aufgezeichnet.');
      return res.json({ ok: true });
    }
    const sorted = Object.entries(stats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    let reply = `<b>✈ Häufigste Besucher in deiner Alert Zone</b>\n\n`;
    sorted.forEach(([cs, count], i) => {
      reply += `${i + 1}. <b>${cs}</b> – ${count}x\n`;
    });
    await sendTelegramMessage(chatId, reply);
    return res.json({ ok: true });
  }

  if (text.startsWith('/heimreport')) {
    try {
      // Bericht bezieht sich auf heute (laufender Tag) statt gestern
      const now    = Date.now();
      const report = buildHeimReport(new Date(now - 24 * 60 * 60 * 1000));
      await sendTelegramMessage(chatId, report);
    } catch(e) {
      await sendTelegramMessage(chatId, 'Fehler beim Erstellen des Berichts.');
      console.error('heimreport error:', e.message);
    }
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

// Webhook bei Telegram registrieren
app.get('/setup-webhook', async (req, res) => {
  const host = req.headers.host;
  const url  = `https://${host}/telegram-webhook`;
  try {
    const r = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ url });
      const reqH = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${BOT_TOKEN}/setWebhook`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, resp => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve(JSON.parse(data)));
      });
      reqH.on('error', reject);
      reqH.write(body);
      reqH.end();
    });
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/status', (req, res) => {
  res.json({ status: 'ok', users: Object.keys(userState).length });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
