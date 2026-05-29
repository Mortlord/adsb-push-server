const https = require('https');
const fs    = require('fs');

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const COOLDOWN_MS = 5 * 60 * 1000;
const STATE_FILE  = '/tmp/userstate.json';
const CACHE_FILE  = '/tmp/notifiedcache.json';

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
    const body = JSON.stringify({ chat_id: chatId, text });
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

async function main() {
  // Zeitcheck: nur 08:00-23:59 Europe/Berlin
  const hour = parseInt(new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false }));
  if (hour < 8) { console.log('Outside active hours, skipping.'); process.exit(0); }

  const userState     = loadJSON(STATE_FILE);
  const notifiedCache = loadJSON(CACHE_FILE);
  const now           = Date.now();
  let   cacheChanged  = false;

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

        const key = `${chatId}:${callsign}`;
        if (now - (notifiedCache[key] || 0) < COOLDOWN_MS) continue;

        const text = `✈ ${callsign} ist in deinem Radar! (${dist.toFixed(1)} nm)`;
        await sendTelegramMessage(chatId, text);
        notifiedCache[key] = now;
        cacheChanged = true;
        console.log(`Sent: ${text}`);
      }
    } catch(e) {
      console.error(`Error for ${chatId}: ${e.message}`);
    }
  }

  if (cacheChanged) saveJSON(CACHE_FILE, notifiedCache);
  console.log('Poll complete.');
  process.exit(0);
}

main();
