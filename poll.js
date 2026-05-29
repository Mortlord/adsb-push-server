const https = require('https');
const fs    = require('fs');

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const COOLDOWN_MS = 5 * 60 * 1000;
const STATE_FILE  = '/tmp/userstate.json';
const CACHE_FILE  = '/tmp/notifiedcache.json';
const HISTORY_FILE = '/tmp/flighthistory.json';

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); }
  catch(e) { console.error('Save error:', e.message); }
}

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
  const R = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const dirs = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

async function sendDailySummary(chatId, history) {
  const today = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
  const todayEntries = (history[chatId] || []).filter(e => e.date === today);

  if (!todayEntries.length) return;

  // Einzigartige Callsigns
  const unique = [...new Map(todayEntries.map(e => [e.callsign, e])).values()];
  let text = `<b>✈ ADSB Radar – Zusammenfassung ${today}</b>\n\n`;
  text += `${unique.length} Favorit${unique.length > 1 ? 'en' : ''} heute in deinem Radar:\n`;
  unique.forEach(e => {
    text += `• <b>${e.callsign}</b> – ${e.dist} nm ${e.dir} (${e.time})\n`;
  });
  await sendTelegramMessage(chatId, text);
  console.log(`Daily summary sent to ${chatId}`);
}

async function main() {
  const nowDE   = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', minute: 'numeric', hour12: false });
  const hour    = parseInt(nowDE.split(':')[0]);
  const minute  = parseInt(nowDE.split(':')[1]);
  const userState     = loadJSON(STATE_FILE);
  const notifiedCache = loadJSON(CACHE_FILE);
  const history       = loadJSON(HISTORY_FILE);
  const now           = Date.now();
  let   cacheChanged  = false;
  let   histChanged   = false;

  // Tagesübersicht um 07:55
  if (hour === 7 && minute >= 55 && minute <= 59) {
    for (const chatId of Object.keys(userState)) {
      await sendDailySummary(chatId, history);
    }
    process.exit(0);
  }

  const todayStr = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
  const timeStr  = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });

  for (const [chatId, state] of Object.entries(userState)) {
    if (!state.lat || !state.favorites?.length) continue;
    try {
      const data     = await fetchAircraft(state.lat, state.lon, state.radius);
      const aircraft = data.ac || [];

      for (const ac of aircraft) {
        const callsign = (ac.flight || '').trim();
        if (!callsign || !state.favorites.includes(callsign)) continue;
        if (ac.lat == null || ac.lon == null) continue;

        const dist = haversine(state.lat, state.lon, ac.lat, ac.lon);
        if (dist > state.alert_radius) continue;

        const dir = bearing(state.lat, state.lon, ac.lat, ac.lon);
        const key = `${chatId}:${callsign}`;
        if (now - (notifiedCache[key] || 0) < COOLDOWN_MS) continue;

        // Notification mit Richtung
        const text = `✈ <b>${callsign}</b> ist in deinem Radar!\n${dist.toFixed(1)} nm ${dir}`;
        await sendTelegramMessage(chatId, text);
        notifiedCache[key] = now;
        cacheChanged = true;

        // Für Tagesübersicht speichern
        if (!history[chatId]) history[chatId] = [];
        history[chatId].push({ callsign, dist: dist.toFixed(1), dir, date: todayStr, time: timeStr });
        // Max 50 Einträge pro User
        if (history[chatId].length > 50) history[chatId] = history[chatId].slice(-50);
        histChanged = true;

        console.log(`Sent to ${chatId}: ${callsign} ${dist.toFixed(1)} nm ${dir}`);
      }
    } catch(e) {
      console.error(`Error for ${chatId}: ${e.message}`);
    }
  }

  if (cacheChanged) saveJSON(CACHE_FILE, notifiedCache);
  if (histChanged)  saveJSON(HISTORY_FILE, history);
  console.log('Poll complete.');
  process.exit(0);
}

main();
