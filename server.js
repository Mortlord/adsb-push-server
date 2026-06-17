const express = require('express');
const cors    = require('cors');
const https   = require('https');
const fs      = require('fs');
const crypto  = require('crypto');
const path    = require('path');
const routedb = require('./routedb');

const app = express();

// CORS auf die eigene Origin einschraenken statt '*' (Punkt 1/6/7)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://adsb-radar.de,https://www.adsb-radar.de,https://mortlord.github.io').split(',').map(s => s.trim()).filter(Boolean);
console.log('CORS erlaubte Origins:', JSON.stringify(ALLOWED_ORIGINS));
app.use(cors({
  origin(origin, cb) {
    // Anfragen ohne Origin (Cron, Telegram, curl) zulassen, Browser-Origins nur aus Whitelist
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // Sauber ablehnen statt zu werfen: kein Stacktrace, kein 500, der Browser blockt anhand fehlender CORS-Header
    console.warn(`CORS: Origin abgelehnt: ${origin}`);
    return cb(null, false);
  }
}));
app.use(express.json({ limit: '64kb' }));

const BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN || '';
const AERODATABOX_KEY  = process.env.AERODATABOX_KEY || '';

// Geteilte Geheimnisse fuer Admin-Endpunkte und Telegram-Webhook (Punkte 2,3,4)
const ADMIN_SECRET     = process.env.ADMIN_SECRET || '';
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET || '';
// Fester Public-Host fuer setup-webhook, NICHT aus dem Host-Header (Punkt 4)
const PUBLIC_HOST      = process.env.PUBLIC_HOST || '';

// Konstantzeit-Vergleich gegen Timing-Angriffe
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Middleware: schuetzt Admin-Endpunkte per Header X-Admin-Secret oder ?key=
function requireAdmin(req, res, next) {
  const provided = req.get('X-Admin-Secret') || req.query.key || '';
  if (ADMIN_SECRET && safeEqual(provided, ADMIN_SECRET)) return next();
  return res.status(403).json({ ok: false, error: 'forbidden' });
}

// Prefixe die über AeroDataBox laufen (Whitelist)
const AERODATABOX_ONLY = new Set([
  'ENT','FRF','SRN','ABR',  // Sonstige
]);
const COOLDOWN_MS  = 5 * 60 * 1000;
const STATE_FILE   = '/data/userstate.json';
const HISTORY_FILE = '/data/flighthistory.json';
const CACHE_FILE   = '/data/notifiedcache.json';

try { fs.mkdirSync('/data', { recursive: true }); } catch(e) {}

// ── Verschluesselung der State-Dateien im Ruhezustand (AES-256-GCM) ──
// Schluessel aus Env STATE_ENC_KEY (32 Byte, base64 oder hex). Fehlt er,
// wird im Klartext gespeichert und nur eine Warnung geloggt (Abwaertskompatibel).
const STATE_ENC_KEY = (() => {
  const raw = process.env.STATE_ENC_KEY || '';
  if (!raw) { console.warn('STATE_ENC_KEY nicht gesetzt: State wird im Klartext gespeichert.'); return null; }
  let key;
  try { key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64'); }
  catch { key = null; }
  if (!key || key.length !== 32) { console.error('STATE_ENC_KEY ungueltig (32 Byte noetig): Klartext-Fallback.'); return null; }
  return key;
})();
const ENC_MAGIC = 'ENC1:'; // Praefix markiert verschluesselte Dateien

function encryptString(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', STATE_ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_MAGIC + Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptString(raw) {
  const payload = Buffer.from(raw.slice(ENC_MAGIC.length), 'base64');
  const iv  = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const enc = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', STATE_ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function loadJSON(file, def) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.startsWith(ENC_MAGIC)) {
      if (!STATE_ENC_KEY) { console.error(`Datei ${file} ist verschluesselt, aber kein Schluessel gesetzt.`); return def; }
      return JSON.parse(decryptString(raw));
    }
    // Klartext (alte Datei) lesen, wird beim naechsten Save automatisch verschluesselt
    return JSON.parse(raw);
  } catch { return def; }
}

function saveJSON(file, data) {
  // Atomar schreiben + restriktive Rechte 0600, optional verschluesselt (Punkte 11, 9)
  try {
    const json = JSON.stringify(data);
    const out  = STATE_ENC_KEY ? encryptString(json) : json;
    const tmp  = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  catch(e) { console.error('Save error:', e.message); }
}

const STATS_FILE      = '/data/visitstats.json';
const HOME_STATS_FILE = '/data/homestats.json';
const UNKNOWN_FILE    = '/data/unknowncallsigns.json';
const HB_FILE         = '/data/hbcallsigns.json';
const ROUTE_CACHE_FILE = '/data/routecache.json';

// Heimadresse aus Env-Vars statt hartkodiert (Punkt 8)
const HOME_LAT    = parseFloat(process.env.HOME_LAT || '47.9732');
const HOME_LON    = parseFloat(process.env.HOME_LON || '7.8319');
const HOME_RADIUS = parseInt(process.env.HOME_RADIUS || '20', 10); // nm

let userState     = loadJSON(STATE_FILE,   {});
let history       = loadJSON(HISTORY_FILE, {});
let notifiedCache = loadJSON(CACHE_FILE,   {});
let visitStats    = loadJSON(STATS_FILE,   {}); // { chatId: { callsign: count } }
// homeStats: { 'DD.MM.YYYY': { PREFIX: count } }
let homeStats         = loadJSON(HOME_STATS_FILE, {});
// unknownCallsigns: { PREFIX: [callsign, ...] }
let unknownCallsigns  = loadJSON(UNKNOWN_FILE, {});
// routeCache: { callsign: { orig, dest, ts } } — 7 Tage TTL
let serverRouteCache  = loadJSON(ROUTE_CACHE_FILE, {});
const ROUTE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 Tage (Punkt 13: Kommentar korrigiert)
let lastUnknownPrefixes = new Set(); // Prefixe, die beim letzten /unbekannt-Aufruf bekannt waren (Punkt 12: ASCII-Name)
// hbCallsigns: [callsign, ...] -- Schweizer Privatregister
let hbCallsigns       = loadJSON(HB_FILE, []);

// Auth-Token-Store: bindet App-Aufrufe an eine Chat-ID (Punkt 1)
// chatTokens: { chatId: token }   tokenIndex: { token: chatId }
const TOKEN_FILE  = '/data/chattokens.json';
let chatTokens    = loadJSON(TOKEN_FILE, {});
let tokenIndex    = {};
for (const [cid, tok] of Object.entries(chatTokens)) tokenIndex[tok] = cid;

function issueToken(chatId) {
  if (chatTokens[chatId]) return chatTokens[chatId];
  const tok = crypto.randomBytes(24).toString('base64url');
  chatTokens[chatId] = tok;
  tokenIndex[tok] = chatId;
  saveJSON(TOKEN_FILE, chatTokens);
  return tok;
}
// Loest eine Chat-ID aus einem mitgesendeten Token auf (oder null)
function chatIdFromToken(token) {
  if (!token) return null;
  return tokenIndex[token] || null;
}

// ICAO-Prefix -> Klarname
// Eigene Airline-Namen NUR fuer Codes, die NICHT in der heruntergeladenen airlines.csv stehen.
// Die ~5900 VRS-Namen liefert routedb (getAirlineNames); diese hier ergaenzen/ueberschreiben sie.
const AIRLINE_OVERRIDES = {
  "AAA":"Ansett Australia", "AAF":"Aigle Azur", "ADH":"Air One", "AHO":"Air Hamburg (AHO)",
  "AMC":"Air Malta", "AMT":"ATA Airlines", "ANU":"Andalus Lineas Aereas", "ARF":"Aero Flight",
  "ASZ":"Astrakhan Airlines", "AUB":"Augsburg Airways", "AUT":"Austral Lineas Aereas", "AWM":"Asian Wings Airways",
  "AWW":"Air Wales", "AXC":"Indochina Airlines", "AXL":"Air Exel", "AXZ":"Aereonautica militare",
  "AZA":"Alitalia", "BAG":"dba", "BEE":"Flybe", "BEU":"Bateleur Air",
  "BIE":"Air Mediterranee", "BMI":"bmibaby", "BMR":"British Midland Regional", "BON":"Air Bosna",
  "BQB":"Buquebus Líneas Aéreas", "BSA":"Black Stallion Airways", "BSX":"Bassaka airlines", "BTA":"ExpressJet",
  "BTM":"Air Batumi", "BUB":"Air Bourbon", "BUU":"Baikotovitchestrian Airlines ", "BWG":"Blue Wings",
  "CCB":"CARICOM AIRWAYS (BARBADOS) INC.", "CIF":"CB Airways UK ( Interliging Flights )", "CIX":"City Connexion Airlines", "CLI":"Calima Aviacion",
  "CNO":"SAS Braathens", "COE":"Comtel Air", "CSX":"Choice Airways", "CUD":"Air Cudlua",
  "CYD":"Access Air", "CYH":"Yunnan Airlines", "CZV":"Via Conectia Airlines", "DAK":"First Flying",
  "DCD":"Air 26", "DHI":"Adam Air", "DJB":"Djibouti Airlines", "DME":"Royal Flight",
  "DMO":"Domodedovo Airlines", "DNM":"Denim Air", "DOA":"Dominicana de Aviaci", "DOB":"Dobrolet",
  "DSV":"Direct Aero Services", "DSY":"Dennis Sky", "DWA":"Dense Airways", "EAA":"Eastok Avia",
  "EGH":"BBN-Airways", "EGS":"Eagles Airlines", "EHN":"East Horizon", "ELA":"Eastland Air",
  "ELC":"Small Planet Airlines", "ELK":"ELK Airways", "ENJ":"Enerjet", "ERR":"Era Alaska",
  "ESK":"SkyEurope", "EUD":"Air Italy Egypt", "EUV":"EuropeSky", "EVC":"Comfort Express Virtual Charters Albany",
  "FBL":"Fly Brasil", "FCB":"COBALT", "FDD":"Feeder Airlines", "FFV":"Fly540",
  "FHE":"Hello", "FHI":"FlyHigh Airlines Ireland (FH)", "FKA":"Flying kangaroo Airline", "FLB":"German Air Force - FLB",
  "FLT":"Flightline", "FOX":"FOX Linhas Aereas", "FPT":"FlyPortugal", "FVM":"Flugfelag Vestmannaeyja",
  "FXX":"Felix Airways", "FYJ":"FLYJET", "FZW":"Fly Africa Zimbabwe", "GAI":"Moskovia Airlines",
  "GBK":"Gabon Airlines", "GBL":"GB Airways", "GDR":"Gadair European Airlines", "GFT":"Gulfstream International Airlines",
  "GFY":"Greenfly", "GIE":"Elysian Airlines", "GNN":"Georgian International Airlines", "GTA":"City Airways",
  "GXG":"GermanXL", "HAM":"Haiti Ambassador Airlines", "HBR":"Hebradran Air Services", "HCC":"Holidays Czech Airlines",
  "HCW":"Star1 Airlines", "HDA":"Dragonair", "HEJ":"Hellas Jet", "HLX":"TUIfly",
  "HNX":"Hankook Airline", "HPY":"Happy Air", "HRM":"Hermes Airlines", "HTH":"Helitt Líneas Aéreas",
  "HZA":"Horizon Airlines", "IBK":"Norwegian Air International (D8)", "IDS":"Indonesia Sky", "IIA":"AIR INDOCHINE",
  "IIR":"INAVIA Internacional", "IMP":"Hellenic Imperial Airways", "INE":"International Europe", "IPV":"Parmiss Airlines (IPV)",
  "ISS":"Meridiana", "ISX":"Island Spirit", "IWA":"Apache Air", "IXO":"OCEAN AIR CARGO",
  "JAB":"Air Bagan", "JGN":"Jagson Airlines", "JKK":"Spanair", "JOR":"Blue Air",
  "JPU":"Jupiter Airlines", "JRB":"Jc royal.britannica", "JSF":"Jet Stream Chater", "JSR":"Jusur airways",
  "JTO":"Jettor Airlines", "KBR":"KoralBlue Airlines", "KCU":"Skyline Ulasim Ticaret A.S.", "KDA":"Kendell Airlines",
  "KEA":"Korea Express Air", "KFR":"Kingfisher Airlines", "KGO":"Korongo Airlines", "KIL":"Kuban Airlines",
  "KJC":"Krasnojarsky Airlines", "KKK":"Atlasjet", "KLS":"Kal Star Aviation", "KND":"Kan Air",
  "KOL":"SOCHI AIR", "KOQ":"Kostromskie avialinii", "KRY":"Russkie Krylya", "KSY":"KSY",
  "KUH":"Kush Air", "KYA":"Alghanim", "KZK":"Air Kazakhstan", "LBC":"Albanian Airlines",
  "LBL":"Line Blue", "LHN":"Express One International", "LIX":"LionXpress", "LJJ":"Luchsh Airlines ",
  "LLC":"FlyLAL Charters", "LMM":"LCM AIRLINES", "LOC":"Locair", "LOO":"LSM Airlines",
  "LTD":"Southern Airways Express", "LTU":"Air Lituanica", "LUR":"Atlantis European Airways", "MAK":"MAT Macedonian Airlines",
  "MCA":"MCA Airlines", "MDO":"Domenican Airlines", "MDP":"Medallion Air", "MDW":"Midway Airlines",
  "MJG":"Michael Airlines", "MJP":"Air Majoro", "MJX":"Euroline", "MKD":"MAT Airways",
  "MKG":"Air Mekong", "MKU":"Island Air (WP)", "MLD":"Air Moldova", "MNP":"Spirit of Manila Airlines",
  "MON":"Monarch Airlines", "MRS":"Marusya Airways", "MSE":"EgyptAir Express", "MTW":"Mauritania Airways",
  "MXI":"MexicanaLink", "MYT":"MyTravel Airways", "NAK":"Arik Niger", "NAX":"Norwegian Air Shuttle",
  "NDN":"Transportes Aereos Cielos Andinos", "NLH":"Norwegian Long Haul AS", "NMB":"Air Namibia", "NTM":"North American Airlines",
  "NWA":"Northwest Airlines", "NXB":"NEXT Brasil", "OAB":"Orbit Airlines Azerbaijan", "OAI":"Orbit International Airlines",
  "OAR":"Orbit Regional Airlines", "OBT":"Orbit Airlines", "OEA":"Orient Thai Airlines", "OHK":"Oasis Hong Kong Airlines",
  "OLS":"Sol Lineas Aereas", "OME":"Homer Air", "OOM":"Zoom Airlines", "ORG":"Orenburzhie",
  "OTJ":"Fly Romania", "OZW":"Skywest Airlines", "PFL":"Pacific Flier", "PKV":"Псковавиа",
  "PLI":"Aeroper", "PPL":"Air Pegasus", "PQW":"PanAm World Airways", "PSB":"Syrian Pearl Airlines",
  "PTI":"Privatair", "PYA":"Pouya Air", "PYB":"All America BOPY", "PZY":"Zapolyarie Airlines",
  "QAX":"QatXpress", "QER":"SOCHI AIR CHATER", "QQQ":"ENTERair", "RAB":"Rainbow Air (RAI)",
  "RAW":"Royal Airways", "RAY":"Rainbow Air Canada", "REP":"Regional Paraguaya", "RFJ":"Royal Falcon",
  "RGG":"TransRussiaAirlines", "RMK":"Simrik Airlines", "RNY":"Rainbow Air US", "RPO":"Rainbow Air Polynesia",
  "RRJ":"AirRussia", "RSU":"Aerosur", "RUE":"Rainbow Air Euro", "RUS":"Cirrus Airlines",
  "RWW":"Fly Europa", "RXR":"REXAIR VIRTUEL", "SAE":"SOCHI AIR EXPRESS", "SAL":"Spike Airlines",
  "SBD":"Snowbird Airlines", "SCW":"Malmö Aviation", "SDI":"San Dima Air", "SGG":"Senegal Airlines",
  "SJS":"Southjet", "SJU":"Skyjet Airlines", "SLC":"Salsa d\\\\\\\\'Haiti", "SLK":"SilkAir",
  "SMW":"Carpatair Flight Training", "SNB":"Sterling Airlines", "SOA":"Southern Air Charter", "SOV":"Saratov Aviation Division",
  "SQH":"SeaPort Airlines", "SRB":"Solar Air", "SRH":"Siem Reap Airways", "SSA":"All America US",
  "SVG":"SVG Air", "SXR":"Sky Express", "SZZ":"SUR Lineas Aereas", "TAO":"Aeromar",
  "TCW":"Thomas Cook Airlines", "TCX":"Thomas Cook Airlines", "TDK":"Transavia Denmark", "THI":"TransHolding",
  "THS":"TransBrasil Airlines", "TJA":"T.J. Air", "TKS":"Tomsk-Avia", "TNA":"TransAsia Airways",
  "TNM":"Tiara Air", "TNS":"Transilvania", "TTZ":"Transair", "TWD":"Turkish Wings Domestic",
  "TXW":"Texas Wings", "TYR":"Tyrolean Airways", "TYS":"TransHolding System", "UAT":"Ukraine Atlantic",
  "UAY":"University of Birmingham Air Squadron (RAF)", "UGX":"East African", "UJX":"AtlasGlobal Ukraine", "USH":"US Helicopter",
  "UWW":"LSM International ", "VAX":"V Air", "VEX":"Virgin Express", "VIA":"VIA Líneas Aéreas",
  "VIS":"Vision Air International", "VKH":"Viking Hellas", "VKJ":"VickJet", "VLM":"VLM Airlines",
  "VNP":"Virgin Pacific", "VOO":"Volotea", "VTI":"Air Vistara", "VVC":"VivaColombia",
  "VVN":"88", "VWA":"Virginwings", "WER":"AeroWorld ", "WFX":"Westfalia Express VA",
  "WLC":"Welcome Air", "WOW":"Air Southwest", "WSS":"World Scale Airlines", "WTJ":"Whitejets",
  "XAN":"Southjet cargo", "XBM":"CBM America", "XLA":"Excel Airways", "XPT":"XPTO",
  "YCC":"Ciel Canadien", "YCP":"Canadian National Airways", "YEL":"Yellowtail", "YEP":"YES Airways",
  "YZZ":"LSM AIRLINES ", "ZCS":"Southjet connect", "ZNA":"Zenith International Airline", "ZTF":"Mongolian International Air Lines ",
  "ZTT":"ZABAIKAL AIRLINES", "ZXY":"Japan Regio", "ZZZ":"Zabaykalskii Airlines",
};
// Effektive Namen = VRS-Basis + eigene Overrides (Overrides gewinnen). Wird nach routedb-Laden gemergt.
let AIRLINE_NAMES = { ...AIRLINE_OVERRIDES };
function rebuildAirlineNames() {
  try {
    AIRLINE_NAMES = { ...routedb.getAirlineNames(), ...AIRLINE_OVERRIDES };
    console.log(`AIRLINE_NAMES: ${Object.keys(AIRLINE_NAMES).length} (VRS + ${Object.keys(AIRLINE_OVERRIDES).length} Overrides)`);
  } catch (e) { console.warn('AIRLINE_NAMES merge:', e.message); }
}

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

function sendTelegramPhoto(chatId, photoUrl, caption) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML' });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendPhoto`,
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

async function fetchPlanespottersPhoto(hex, reg, type) {
  return new Promise((resolve) => {
    let url = `/pub/photos/hex/${hex}`;
    const params = [];
    if (reg)  params.push(`reg=${encodeURIComponent(reg)}`);
    if (type) params.push(`icaoType=${encodeURIComponent(type)}`);
    if (params.length) url += '?' + params.join('&');

    const req = https.get({
      hostname: 'api.planespotters.net',
      path: url,
      headers: { 'User-Agent': 'adsb-radar/2.0 (+https://adsb-radar.de/legal.html)', 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`Planespotters raw status=${res.statusCode} body=${data.slice(0,200)}`);
        try {
          const json = JSON.parse(data);
          if (!json.photos?.length) { resolve(null); return; }
          const p = json.photos[0];
          resolve({ url: p.thumbnail_large?.src || p.thumbnail?.src, photographer: p.photographer });
        } catch { resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('Planespotters error:', e.message); resolve(null); });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

function fetchFromUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'adsb-radar/2.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('fetchAircraft timeout')); });
  });
}

async function fetchAircraft(lat, lon, radius) {
  try {
    return await fetchFromUrl(`https://api.airplanes.live/v2/point/${lat}/${lon}/${radius}`);
  } catch(e) {
    console.warn(`airplanes.live fehler (${e.message}), Fallback auf adsb.fi`);
    return await fetchFromUrl(`https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${radius}`);
  }
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

// ── Abend-Bericht generieren ──────────────────────────────────

const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '';

// ════════════════════════════════════════════════════════════
// SERVER-WÄCHTER (Ereignis-Alerts) + BESUCHERZÄHLER
// ════════════════════════════════════════════════════════════
const HEALTH_FILE   = '/data/healthstate.json';
const VISITORS_FILE = '/data/visitors.json';

const HEALTH_ALERTS    = (process.env.HEALTH_ALERTS || '1') !== '0';
const POLL_STALL_MIN   = parseInt(process.env.POLL_STALL_MIN   || '5',  10); // Poll seit X Min nicht gelaufen
const EMPTY_FEED_POLLS = parseInt(process.env.EMPTY_FEED_POLLS || '10', 10); // X leere Tag-Abfragen in Folge
const MEM_ALERT_MB     = parseInt(process.env.MEM_ALERT_MB     || '0',  10); // 0 = aus
const VISITOR_SALT     = process.env.HEALTH_SALT || ADMIN_SECRET || 'adsb-radar';

// Gesundheits-Laufzeitwerte; Flags/Zeitstempel persistiert gegen Neustart-Doppelalarme,
// die reinen Laufzeitfelder werden bei jedem Start zurückgesetzt (Karenz nach Neustart).
let health = loadJSON(HEALTH_FILE, {});
health.flags     = health.flags     || { source:false, empty:false, stalled:false, mem:false, adsbdb:false };
health.alertsLog = health.alertsLog || [];
health.lastPollTs        = 0;
health.lastPollOk        = false;
health.lastAircraftCount = 0;
health.consecutiveEmpty  = 0;
function saveHealth(){ saveJSON(HEALTH_FILE, health); }

// Besucher: Hash -> letzter Zeitstempel (rollierendes 24h-Fenster, täglich rotierendes Salt).
// Es wird nie die IP gespeichert, nur ein gesalzener Hash -> datenschutzfreundlich.
let visitors = loadJSON(VISITORS_FILE, {});
function visitorHash(ip){
  const day = new Date().toISOString().slice(0,10);
  return crypto.createHash('sha256').update(`${VISITOR_SALT}:${day}:${ip}`).digest('hex').slice(0,16);
}
function recordVisitor(req){
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (ip) visitors[visitorHash(ip)] = Date.now();
}
function uniqueVisitors24h(){
  const cutoff = Date.now() - 24*60*60*1000;
  let n = 0;
  for (const h of Object.keys(visitors)) { if (visitors[h] < cutoff) delete visitors[h]; else n++; }
  return n;
}

// Alert an den Owner; nur bei Zustandswechsel aufgerufen
async function healthAlert(text){
  if (!HEALTH_ALERTS || !OWNER_CHAT_ID) return;
  health.alertsLog = (health.alertsLog || []).filter(ts => ts > Date.now() - 24*60*60*1000);
  health.alertsLog.push(Date.now());
  saveHealth();
  try { await sendTelegramMessage(OWNER_CHAT_ID, text); }
  catch(e){ console.error('healthAlert:', e.message); }
}
// Feuert nur an der Flanke: aus->an sendet onText, an->aus sendet offText (optional)
async function setHealthFlag(key, bad, onText, offText){
  const was = !!health.flags[key];
  if (bad && !was)      { health.flags[key] = true;  saveHealth(); await healthAlert(onText); }
  else if (!bad && was) { health.flags[key] = false; saveHealth(); if (offText) await healthAlert(offText); }
}

function fmtDuration(ms){
  const s = Math.floor(ms/1000);
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
function buildStatusReport(){
  const up      = fmtDuration(process.uptime()*1000);
  const rssMb   = Math.round(process.memoryUsage().rss/1048576);
  const pollAge = health.lastPollTs ? `vor ${fmtDuration(Date.now()-health.lastPollTs)}` : '—';
  const src     = health.flags.source ? '⚠️ ausgefallen' : (health.lastPollOk ? '✅ ok' : '—');
  let rdb = '—';
  try { const s = routedb.routeDBStats(); if (s && s.ready) rdb = `${s.routes} Routen, ${s.airports} Flughäfen, ${s.airlines} Airlines`; } catch {}
  const cool = adsbdbCooldownMs > ADSBDB_COOLDOWN_MS ? `Backoff ${Math.round(adsbdbCooldownMs/60000)}m` : 'normal';
  const cutoff = Date.now() - 24*60*60*1000;
  let favAlerts = 0;
  for (const arr of Object.values(history)) for (const e of (arr||[])) if (e.ts && e.ts > cutoff) favAlerts++;
  const visitors24     = uniqueVisitors24h();
  const healthAlerts24 = (health.alertsLog||[]).filter(ts => ts > cutoff).length;
  return [
    '🩺 <b>Serverstatus</b>',
    `Uptime: ${up}`,
    `Letzter Poll: ${pollAge}`,
    `Datenquelle: ${src}`,
    `Zuletzt ${health.lastAircraftCount} Flugzeuge (Heimradar)`,
    `Route-DB: ${rdb}`,
    `adsbdb: ${cool}`,
    `Speicher: ${rssMb} MB`,
    `Nutzer (Tokens): ${Object.keys(userState).length}`,
    `Favoriten-Alerts 24h: ${favAlerts}`,
    `Health-Alerts 24h: ${healthAlerts24}`,
    '',
    `👥 <b>Unique Besucher 24h: ${visitors24}</b>`
  ].join('\n');
}

function buildEveningReport(todayStr, chatId) {
  let report = '';

  // Heimradar + Unbekannte nur für den Betreiber
  if (chatId === OWNER_CHAT_ID) {
    const dayData = homeStats[todayStr] || {};
    const uniqueHome = (dayData._callsigns || []).length;
    const rows = Object.entries(dayData)
      .filter(([p]) => p !== '_callsigns')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    report += `<b>🏠 Heimradar Freiburg – ${todayStr}</b> – ${uniqueHome} unique Callsigns\n\n`;
    if (rows.length) {
      rows.forEach(([p, c]) => {
        const name = AIRLINE_NAMES[p] || '';
        report += `  <b>${p}</b>${name ? ' ' + name : ''}: ${c}x\n`;
      });
    } else {
      report += '  (keine Daten)\n';
    }

    const unknownToday = Object.entries(dayData)
      .filter(([p]) => p !== '_callsigns' && !AIRLINE_NAMES[p])
      .sort((a, b) => b[1] - a[1]);
    if (unknownToday.length) {
      report += `\n<b>❓ Unbekannte Gruppen heute</b>\n`;
      unknownToday.forEach(([p, c]) => {
        const examples = (unknownCallsigns[p] || []).slice(0, 3).join(', ');
        report += `  <b>${p}</b>: ${c}x${examples ? ' – z.B. ' + examples : ''}\n`;
      });
    }
    report += '\n';
  }

  // Favoriten für alle
  const favEntries = (history[chatId] || []).filter(e => e.date === todayStr);
  const uniqueFavs = [...new Map(favEntries.map(e => [e.callsign, e])).values()];
  report += `<b>⭐ Favoriten heute</b> – ${uniqueFavs.length} unique Callsigns\n`;
  if (uniqueFavs.length) {
    uniqueFavs.forEach(e => {
      const airlineStr = e.airline ? ` · ${e.airline}` : '';
      report += `  <b>${e.callsign}</b>${airlineStr} – ${e.dist} nm ${e.dir} (${e.time})\n`;
    });
  } else {
    report += '  (keine Favoriten gesichtet)\n';
  }

  return report;
}

// ── Polling-Logik ──────────────────────────────────────────────

let lastSummaryDate = '';
let lastResetDate   = '';

async function doPoll() {
  const now      = Date.now();
  const nowDE    = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: 'numeric', minute: 'numeric', hour12: false });
  const hour     = parseInt(nowDE.split(':')[0]);
  const minute   = parseInt(nowDE.split(':')[1]);
  const todayStr = new Date().toLocaleDateString('de-DE',   { timeZone: 'Europe/Berlin' });
  const timeStr  = new Date().toLocaleTimeString('de-DE',   { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });

  // Nacht-Reset um 0:00 -- visitStats leeren
  if (hour === 0 && minute <= 2 && lastResetDate !== todayStr) {
    lastResetDate = todayStr;
    visitStats = {};
    saveJSON(STATS_FILE, visitStats);
    console.log('visitStats reset at midnight');
  }

  // Abendbericht um 23:59 -- Tagesrückblick + Aufräumen
  if (hour === 23 && minute >= 55 && lastSummaryDate !== todayStr) {
    lastSummaryDate = todayStr;

    // Bericht an alle bekannten Chat-IDs
    for (const chatId of Object.keys(userState)) {
      try {
        const report = buildEveningReport(todayStr, chatId);
        await sendTelegramMessage(chatId, report);
        console.log(`Evening report sent to ${chatId}`);
      } catch(e) { console.error(`Evening report error: ${e.message}`); }
    }

    // flightHistory: heute leeren + älter als 3 Tage löschen
    const cutoff3h = now - 3 * 24 * 60 * 60 * 1000;
    for (const chatId of Object.keys(history)) {
      history[chatId] = (history[chatId] || []).filter(e => {
        if (e.date === todayStr) return false; // heute leeren
        if (e.ts && e.ts < cutoff3h) return false; // älter als 3 Tage
        return true;
      });
    }
    saveJSON(HISTORY_FILE, history);

    // homeStats: Einträge älter als 3 Tage löschen
    const cutoff3 = now - 3 * 24 * 60 * 60 * 1000;
    for (const dayStr of Object.keys(homeStats)) {
      const [d, m, y] = dayStr.split('.').map(Number);
      if (new Date(y, m - 1, d).getTime() < cutoff3) delete homeStats[dayStr];
    }
    saveJSON(HOME_STATS_FILE, homeStats);

    // unknownCallsigns: Prefixe löschen die in den letzten 3 Tagen nicht in homeStats vorkamen
    const activePrefixes = new Set();
    for (const dayData of Object.values(homeStats))
      for (const p of Object.keys(dayData))
        if (p !== '_callsigns') activePrefixes.add(p);
    for (const p of Object.keys(unknownCallsigns))
      if (!activePrefixes.has(p)) delete unknownCallsigns[p];
    saveJSON(UNKNOWN_FILE, unknownCallsigns);

    console.log('Nightly cleanup done');
  }

  // Heim-Zählung: Callsign-Prefixe im 20nm Radius um Ziegelweg 11
  health.lastPollTs = now;
  try {
    const homeData = await fetchAircraft(HOME_LAT, HOME_LON, HOME_RADIUS + 5);
    const homeAc = homeData.ac || [];
    health.lastPollOk = true;
    health.lastAircraftCount = homeAc.length;
    await setHealthFlag('source', false, null, '✅ Datenquelle wieder erreichbar.');
    // Leeren-Feed-Wächter nur tagsüber (08–22 Uhr); nachts ist Stille normal
    health.consecutiveEmpty = (hour >= 8 && hour < 22 && homeAc.length === 0)
      ? health.consecutiveEmpty + 1 : 0;
    await setHealthFlag('empty', health.consecutiveEmpty >= EMPTY_FEED_POLLS,
      `⚠️ Heimradar: seit ${health.consecutiveEmpty} Abfragen 0 Flugzeuge (tagsüber). Feed evtl. gestört.`,
      '✅ Heimradar empfängt wieder Flugzeuge.');
    for (const ac of homeAc) {
      const callsign = (ac.flight || '').trim();
      if (!callsign || ac.lat == null || ac.lon == null) continue;
      if (haversine(HOME_LAT, HOME_LON, ac.lat, ac.lon) > HOME_RADIUS) continue;
      const prefix = callsign.replace(/[0-9]/g, '').substring(0, 3).toUpperCase();
      if (prefix.length < 2) continue;
      if (!/\d/.test(callsign)) continue;           // keine Ziffern = Privatmaschine
      if (/^N\d/.test(callsign)) continue;           // US-Register (N358MM etc.)

      // HB-Register (Schweizer Privatmaschinen) separat erfassen und ausschließen
      if (/^HB\d/.test(callsign)) {
        if (!hbCallsigns.includes(callsign)) {
          hbCallsigns.push(callsign);
          saveJSON(HB_FILE, hbCallsigns);
        }
        continue;
      }
      const homeKey = `home:${callsign}`;
      if (now - (notifiedCache[homeKey] || 0) < COOLDOWN_MS) continue;
      notifiedCache[homeKey] = now;
      if (!homeStats[todayStr]) homeStats[todayStr] = {};
      homeStats[todayStr][prefix] = (homeStats[todayStr][prefix] || 0) + 1;
      if (!homeStats[todayStr]._callsigns) homeStats[todayStr]._callsigns = [];
      if (!homeStats[todayStr]._callsigns.includes(callsign))
        homeStats[todayStr]._callsigns.push(callsign);

      // Unbekannte Prefixe mit vollständigem Callsign aufzeichnen
      if (!AIRLINE_NAMES[prefix]) {
        if (!unknownCallsigns[prefix]) unknownCallsigns[prefix] = [];
        if (!unknownCallsigns[prefix].includes(callsign))
          unknownCallsigns[prefix].push(callsign);
        // Bekannte Prefixe bereinigen
        for (const p of Object.keys(unknownCallsigns)) {
          if (AIRLINE_NAMES[p]) delete unknownCallsigns[p];
        }
        saveJSON(UNKNOWN_FILE, unknownCallsigns);
      }
    }
    saveJSON(HOME_STATS_FILE, homeStats);
    saveJSON(CACHE_FILE, notifiedCache);
  } catch(e) {
    console.error(`Home poll error: ${e.message}`);
    health.lastPollOk = false;
    // fetchAircraft wirft nur, wenn primaere UND Fallback-Quelle scheitern
    await setHealthFlag('source', true,
      `⚠️ Datenquelle ausgefallen: airplanes.live und adsb.fi nicht erreichbar (${e.message}). Heimradar pausiert.`,
      null);
  }

  // Alle Flugzeuge im Alert-Radius zählen (unabhängig von Favoriten)
  for (const [chatId, state] of Object.entries(userState)) {
    if (!state.lat) continue;

    // Zeitzone des Nutzers prüfen statt global Europe/Berlin
    const userTz = state.timezone || 'Europe/Berlin';
    const userTimeStr = new Date().toLocaleString('de-DE', { timeZone: userTz, hour: 'numeric', minute: 'numeric', hour12: false });
    const userHour = parseInt(userTimeStr.split(':')[0]);
    const isNight = userHour < 8; // Nachts keine Telegram-Alerts, aber History/Stats laufen weiter

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

        // History und Cache immer schreiben (auch nachts)
        notifiedCache[key] = now;
        saveJSON(CACHE_FILE, notifiedCache);

        if (!history[chatId]) history[chatId] = [];
        // Nur echte Airline-Rufzeichen (3 Buchstaben + Ziffer); Kennzeichen wie
        // HBCAT (HB-CAT) oder DEFXF (D-EFXF) bekommen keinen Airline-Namen.
        const csUp = callsign.trim().toUpperCase();
        const airlineName = /^[A-Z]{3}[0-9]/.test(csUp) ? (AIRLINE_NAMES[csUp.slice(0, 3)] || '') : '';
        history[chatId].push({ callsign, airline: airlineName, dist: dist.toFixed(1), dir, date: todayStr, time: timeStr, ts: now });
        if (history[chatId].length > 100) history[chatId] = history[chatId].slice(-100);
        saveJSON(HISTORY_FILE, history);

        // Telegram-Alert nur tagsüber (08:00–23:59)
        if (!isNight) {
          const airlineStr = airlineName ? ` · ${airlineName}` : '';
          // Flugzeugtyp und Route (aus lokaler DB) ergaenzen, sofern vorhanden
          const acType = (ac.t || '').trim();
          const lr = routedb.resolveLocalRoute(callsign);
          const routeStr = lr ? `${lr.orig.iata} › ${lr.dest.iata}` : '';
          const metaParts = [];
          if (routeStr) metaParts.push(routeStr);
          if (acType)   metaParts.push(acType);
          const metaStr = metaParts.length ? `\n${metaParts.join(' · ')}` : '';
          const caption = `✈ <b>${callsign}</b>${airlineStr}${metaStr}\n${dist.toFixed(1)} nm ${dir}`;
          const photoHex = (ac.hex || '').toLowerCase();
          console.log(`Photo lookup: ${callsign} hex=${photoHex} reg=${ac.r||''} type=${ac.t||''}`);
          const photo = photoHex ? await fetchPlanespottersPhoto(photoHex, ac.r, ac.t) : null;
          console.log(`Photo result: ${callsign} found=${!!photo?.url}`);
          if (photo?.url) {
            const creditStr = photo.photographer ? `\n© ${photo.photographer}` : '';
            await sendTelegramPhoto(chatId, photo.url, caption + creditStr);
          } else {
            await sendTelegramMessage(chatId, caption);
          }
          console.log(`Telegram sent to ${chatId}: ${callsign} ${dist.toFixed(1)} nm ${dir}`);
        } else {
          console.log(`Nacht-Unterdrückung für ${chatId}: ${callsign} ${dist.toFixed(1)} nm ${dir} (kein Alert)`);
        }
      }
    } catch(e) { console.error(`Poll error for ${chatId}: ${e.message}`); }
  }

  console.log('Poll complete.');
}

// ── Endpunkte ──────────────────────────────────────────────────

// App schickt Standort + Favoriten
app.post('/update', (req, res) => {
  const { token, lat, lon, radius, favorites, alert_radius, timezone } = req.body;
  // Chat-ID wird serverseitig aus dem Token abgeleitet, NICHT aus dem Body (Punkt 1)
  const chat_id = chatIdFromToken(token);
  if (!chat_id) return res.status(401).json({ ok: false, error: 'invalid token' });

  const favArr = Array.isArray(favorites) ? favorites.slice(0, 50).map(String) : [];
  userState[chat_id] = {
    lat, lon, radius,
    favorites: favArr,
    alert_radius: alert_radius || 20,
    timezone: timezone || 'Europe/Berlin',
    lastSeen: Date.now()
  };
  saveJSON(STATE_FILE, userState);
  console.log(`Updated [${chat_id}]: ${favArr.length} favs, alert=${alert_radius}`);
  res.json({ ok: true });
});

// Nutzer-Daten löschen (DSGVO Art. 17)
app.delete('/delete', (req, res) => {
  const { token } = req.body;
  const chat_id = chatIdFromToken(token);
  if (!chat_id) return res.status(401).json({ ok: false, error: 'invalid token' });
  let deleted = false;
  if (userState[chat_id])     { delete userState[chat_id];     saveJSON(STATE_FILE,   userState);   deleted = true; }
  if (history[chat_id])       { delete history[chat_id];       saveJSON(HISTORY_FILE, history);               }
  if (notifiedCache[chat_id]) { delete notifiedCache[chat_id]; saveJSON(CACHE_FILE,   notifiedCache);         }
  if (visitStats[chat_id])    { delete visitStats[chat_id];    saveJSON(STATS_FILE,   visitStats);            }
  // Cache-Einträge mit chatId-Prefix entfernen
  for (const key of Object.keys(notifiedCache)) {
    if (key.startsWith(`${chat_id}:`)) delete notifiedCache[key];
  }
  saveJSON(CACHE_FILE, notifiedCache);
  // Token widerrufen, damit die Bindung vollstaendig geloescht wird
  delete tokenIndex[token];
  delete chatTokens[chat_id];
  saveJSON(TOKEN_FILE, chatTokens);
  console.log(`Deleted data for ${chat_id}`);
  res.json({ ok: true, deleted });
});

// Cron-Job triggert Poll – nur mit Admin-Secret (Punkt 2)
app.get('/poll', requireAdmin, async (req, res) => {
  try {
    await doPoll();
    res.json({ ok: true });
  } catch(e) {
    console.error('Poll error:', e.message); // Detail nur ins Log (Punkt 10)
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// Chat-ID/Updates ermitteln – Dev-Hilfsendpunkt, nur mit Admin-Secret (Punkt 2)
app.get('/get-chat-id', requireAdmin, async (req, res) => {
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
  } catch(e) {
    console.error('get-chat-id error:', e.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// Telegram Webhook fuer Bot-Kommandos
app.post('/telegram-webhook', async (req, res) => {
  // Secret-Token aus dem Header pruefen (Punkt 3)
  if (WEBHOOK_SECRET) {
    const got = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!safeEqual(got, WEBHOOK_SECRET)) {
      return res.status(403).json({ ok: false });
    }
  }
  const msg = req.body?.message;
  if (!msg) return res.json({ ok: true });
  const chatId = String(msg.chat?.id);
  const text   = msg.text || '';

  if (text === '/start') {
    const token = issueToken(chatId);
    const welcomeText = `✈ <b>Willkommen bei ADSB Radar!</b>

Dein Aktivierungscode:
<code>${token}</code>

Trage diesen Code in der App unter ⭐ FAVORITEN ein, um Benachrichtigungen zu aktivieren. Behandle ihn wie ein Passwort und teile ihn nicht.

<b>So geht's:</b>
1. Öffne <a href="https://adsb-radar.de">adsb-radar.de</a>
2. Tippe auf ⭐ FAVORITEN
3. Füge Callsigns oder Prefixe hinzu (z.B. <b>LH</b> für alle Lufthansa-Flüge)
4. Trage deinen Aktivierungscode ein und tippe auf Speichern

Du wirst benachrichtigt wenn ein Favorit in deine Alert Zone fliegt (08:00–23:59 Uhr).\n\n<b>Befehle:</b>\n/favoriten – Heutige Favoriten-Sichtungen\n/stats – Häufigste Besucher in deiner Alert Zone`;
    await sendTelegramMessage(chatId, welcomeText);
    return res.json({ ok: true });
  }

  if (text === '/status') {
    if (chatId !== OWNER_CHAT_ID) { await sendTelegramMessage(chatId, 'Nicht berechtigt.'); return res.json({ ok: true }); }
    await sendTelegramMessage(chatId, buildStatusReport());
    return res.json({ ok: true });
  }

  if (text.startsWith('/favoriten')) {
    const todayStrFav = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
    const todayEntries = (history[chatId] || []).filter(e => e.date === todayStrFav);
    if (!todayEntries.length) {
      await sendTelegramMessage(chatId, '⭐ Heute noch keine Favoriten gesichtet.');
      return res.json({ ok: true });
    }
    todayEntries.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    let reply = `<b>⭐ Favoriten heute</b> – ${todayEntries.length} Sichtung${todayEntries.length > 1 ? 'en' : ''}\n\n`;
    todayEntries.forEach(e => {
      const airlineStr = e.airline ? ` · ${e.airline}` : '';
      reply += `<b>${e.callsign}</b>${airlineStr} – ${e.dist} nm ${e.dir} (${e.time})\n`;
    });
    await sendTelegramMessage(chatId, reply);
    return res.json({ ok: true });
  }

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

  if (text.startsWith('/unbekannt')) {
    try {
      // Alle Prefixe aus homeStats sammeln und gegen AIRLINE_NAMES prüfen
      const totals = {};
      for (const dayData of Object.values(homeStats)) {
        for (const [p, c] of Object.entries(dayData)) {
          if (p === '_callsigns') continue;
          if (!AIRLINE_NAMES[p]) totals[p] = (totals[p] || 0) + c;
        }
      }
      if (!Object.keys(totals).length) {
        await sendTelegramMessage(chatId, 'Alle Prefixe sind bekannt.');
        return res.json({ ok: true });
      }
      const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
      const isFirstCall = lastUnknownPrefixes.size === 0;
      let reply = `<b>❓ Unbekannte Callsign-Gruppen</b>\n\n`;
      sorted.forEach(([p, c]) => {
        const examples = (unknownCallsigns[p] || []).slice(0, 3).join(', ');
        const isNew = !isFirstCall && !lastUnknownPrefixes.has(p);
        reply += `${isNew ? '🆕 ' : ''}<b>${p}</b>: ${c}x${examples ? ' – z.B. ' + examples : ''}\n`;
      });
      lastUnknownPrefixes = new Set(Object.keys(totals));
      await sendTelegramMessage(chatId, reply);
    } catch(e) {
      await sendTelegramMessage(chatId, 'Fehler beim Erstellen des Berichts.');
      console.error('unbekannt error:', e.message);
    }
    return res.json({ ok: true });
  }

  if (text.startsWith('/validatehb') || text.startsWith('/validateHB')) {
    try {
      if (!hbCallsigns.length) {
        await sendTelegramMessage(chatId, 'Keine HB-Callsigns aufgezeichnet.');
        return res.json({ ok: true });
      }
      const sorted = [...hbCallsigns].sort();
      let reply = `<b>🇨🇭 HB-Register (Schweizer Privatmaschinen)</b>\n${sorted.length} Einträge\n\n`;
      reply += sorted.join(', ');
      await sendTelegramMessage(chatId, reply);
    } catch(e) {
      await sendTelegramMessage(chatId, 'Fehler.');
      console.error('validateHB error:', e.message);
    }
    return res.json({ ok: true });
  }

  if (text.startsWith('/deleteunbekannt')) {
    if (chatId !== OWNER_CHAT_ID) {
      await sendTelegramMessage(chatId, 'Nicht berechtigt.');
      return res.json({ ok: true });
    }
    try {
      unknownCallsigns = {};
      saveJSON(UNKNOWN_FILE, unknownCallsigns);
      await sendTelegramMessage(chatId, '✅ Unbekannte Callsign-Liste geleert.');
    } catch(e) {
      await sendTelegramMessage(chatId, 'Fehler.');
      console.error('deleteunbekannt error:', e.message);
    }
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

// Webhook bei Telegram registrieren
app.get('/setup-webhook', requireAdmin, async (req, res) => {
  // Festen Public-Host nutzen statt req.headers.host (Punkt 4)
  const host = PUBLIC_HOST || req.headers.host;
  const url  = `https://${host}/telegram-webhook`;
  try {
    const r = await new Promise((resolve, reject) => {
      // secret_token wird bei jedem eingehenden Update als Header zurueckgesendet (Punkt 3)
      const payload = { url };
      if (WEBHOOK_SECRET) payload.secret_token = WEBHOOK_SECRET;
      const body = JSON.stringify(payload);
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
  } catch(e) {
    console.error('setup-webhook error:', e.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// ── Route-Auflösung ───────────────────────────────────────────
// In-Memory-Rate-Limiter pro IP. Fabrik, damit /route und /aircraft eigene Grenzen haben.
const RL_WINDOW_MS = 60 * 1000;
function makeRateLimiter(max) {
  const hits = new Map(); // ip -> { count, windowStart }
  // Map gelegentlich aufraeumen, damit sie nicht unbegrenzt waechst
  setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of hits) if (now - rec.windowStart > RL_WINDOW_MS) hits.delete(ip);
  }, 5 * 60 * 1000).unref?.();
  return function(req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now - rec.windowStart > RL_WINDOW_MS) {
      hits.set(ip, { count: 1, windowStart: now });
      return next();
    }
    if (rec.count >= max) {
      return res.status(429).json({ route: null, error: 'rate limit' });
    }
    rec.count++;
    return next();
  };
}
// /route kommt jetzt fast immer aus der lokalen DB (in-memory, sehr guenstig) und wird
// pro Flugzeug aufgerufen, also beim Laden stossweise -> grosszuegige Grenze.
const rateLimitRoute = makeRateLimiter(600);
// /aircraft ist der externe Karten-Feed, nur ein Aufruf pro Aktualisierungszyklus -> knapper.
const rateLimitAircraft = makeRateLimiter(60);

// Routen-Quellen-Schonung gegen Rate-Limit (429): negatives Caching, Drosselung, Cooldown
const NEG_TTL_MS          = 12 * 60 * 60 * 1000; // "keine Route" 12h cachen
const ROUTE_MIN_INTERVAL  = 700;                 // min. Abstand zwischen Aufrufen je Quelle (ms)
const ADSBDB_COOLDOWN_MS  = 90 * 1000;           // Basis-Pause nach 429 (auch adsb.lol)
const ADSBDB_COOLDOWN_MAX = 60 * 60 * 1000;      // Obergrenze des Backoffs: 1h
let   adsbdbCooldownUntil = 0;
let   adsbdbCooldownMs    = ADSBDB_COOLDOWN_MS;  // aktuelle Backoff-Dauer (verdoppelt sich je 429)
let   adsblolCooldownUntil = 0;

// Erzeugt eine Drossel, die Aufrufe serialisiert und auf minInterval entzerrt
function makeThrottle(minInterval) {
  let last = 0;
  let chain = Promise.resolve();
  return function() {
    const p = chain.then(async () => {
      const wait = Math.max(0, last + minInterval - Date.now());
      if (wait) await new Promise(r => setTimeout(r, wait));
      last = Date.now();
    });
    chain = p.catch(() => {});
    return p;
  };
}
const adsbdbThrottle = makeThrottle(ROUTE_MIN_INTERVAL);
const adsblolThrottle = makeThrottle(ROUTE_MIN_INTERVAL);

// GET mit JSON-Antwort: liefert { status, json|null }
function getJson(options, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(options, r => {
      const status = r.statusCode;
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve({ status, json: JSON.parse(data) }); }
        catch { resolve({ status, json: null }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Routen-Lookup adsbdb -> { route|null, rateLimited }
async function lookupAdsbdb(callsign) {
  await adsbdbThrottle();
  const { status, json } = await getJson({
    hostname: 'api.adsbdb.com',
    path: `/v0/callsign/${encodeURIComponent(callsign)}`,
    headers: { 'User-Agent': 'adsb-radar/2.0 (+https://adsb-radar.de)' }
  });
  if (status === 429) return { route: null, rateLimited: true };
  const fr = json?.response?.flightroute;
  if (fr?.origin?.iata_code && fr?.destination?.iata_code) {
    return { route: {
      orig: { iata: fr.origin.iata_code,      icao: fr.origin.icao_code      || '', city: fr.origin.municipality      || fr.origin.name      || '' },
      dest: { iata: fr.destination.iata_code, icao: fr.destination.icao_code || '', city: fr.destination.municipality || fr.destination.name || '' }
    }, rateLimited: false };
  }
  return { route: null, rateLimited: false };
}

// Routen-Lookup adsb.lol (VRS standing-data) -> { route|null, rateLimited }
// GET /api/0/route/{callsign}/{lat}/{lng}; lat/lng nur fuer das plausible-Flag, hier egal
async function lookupAdsblol(callsign) {
  await adsblolThrottle();
  const { status, json } = await getJson({
    hostname: 'api.adsb.lol',
    path: `/api/0/route/${encodeURIComponent(callsign)}/${HOME_LAT}/${HOME_LON}`,
    headers: { 'User-Agent': 'adsb-radar/2.0 (+https://adsb-radar.de)' }
  });
  if (status === 429) return { route: null, rateLimited: true };
  const aps = json?._airports;
  if (json?.airport_codes && json.airport_codes !== 'unknown' && Array.isArray(aps) && aps.length >= 2) {
    const o = aps[0], d = aps[aps.length - 1];
    if (o?.iata && d?.iata) {
      return { route: {
        orig: { iata: o.iata, icao: o.icao || '', city: o.location || o.name || '' },
        dest: { iata: d.iata, icao: d.icao || '', city: d.location || d.name || '' }
      }, rateLimited: false };
    }
  }
  return { route: null, rateLimited: false };
}

// Abgelaufene Cache-Eintraege stuendlich aufraeumen, damit die Datei nicht waechst
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [cs, e] of Object.entries(serverRouteCache)) {
    const ttl = e.route ? ROUTE_TTL_MS : NEG_TTL_MS;
    if (now - e.ts > ttl) { delete serverRouteCache[cs]; changed = true; }
  }
  if (changed) saveJSON(ROUTE_CACHE_FILE, serverRouteCache);
}, 60 * 60 * 1000).unref?.();

// Normalisiert Route aus AeroDataBox oder adsbdb
// GET /route?callsign=DLH1234
app.get('/route', rateLimitRoute, async (req, res) => {
  const callsign = (req.query.callsign || '').trim().toUpperCase();
  if (!callsign) return res.json({ route: null });
  // Nur plausible Callsigns zulassen (2-8 alphanumerische Zeichen), sonst keine API-Calls (Punkt 5)
  if (!/^[A-Z0-9]{2,8}$/.test(callsign)) return res.json({ route: null });

  const prefix = callsign.slice(0, 3);
  const isKnownAirline = !!AIRLINE_NAMES[prefix];

  // Serverseitiger Cache: Treffer 14 Tage, bestaetigte "keine Route" 12h
  const cached = serverRouteCache[callsign];
  if (cached) {
    const ttl = cached.route ? ROUTE_TTL_MS : NEG_TTL_MS;
    if ((Date.now() - cached.ts) < ttl) {
      return res.json({ route: cached.route, source: 'cache' });
    }
  }

  // Lokale Routen-DB zuerst (kostenlos, kein externer Aufruf, kein Rate-Limit)
  const local = routedb.resolveLocalRoute(callsign);
  if (local) {
    return res.json({ route: local, source: 'local' });
  }

  // Treffsichere Abgrenzung: ist der Praefix definitiv KEIN bekannter Airline-Code,
  // handelt es sich um eine Registrierung/Privat -> keine Route, gar nicht extern fragen.
  // Nur ueberspringen, wenn die Airline-Liste geladen ist (sonst im Zweifel weiter extern).
  if (routedb.isAirlineCallsign(callsign) === false) {
    return res.json({ route: null, source: 'local-miss' });
  }

  // AeroDataBox nur für Whitelist-Prefixe
  if (AERODATABOX_ONLY.has(prefix) && AERODATABOX_KEY) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req2 = https.get({
          hostname: 'aerodatabox.p.rapidapi.com',
          path: `/flights/callsign/${encodeURIComponent(callsign)}?withAircraftImage=false&withLocation=false`,
          headers: {
            'X-RapidAPI-Key': AERODATABOX_KEY,
            'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com'
          }
        }, r => {
          let data = '';
          r.on('data', c => data += c);
          r.on('end', () => {
            try {
              const json = JSON.parse(data);
              const f = Array.isArray(json) ? json[0] : json;
              if (f?.departure?.airport?.iata && f?.arrival?.airport?.iata) {
                resolve({
                  orig: { iata: f.departure.airport.iata, icao: f.departure.airport.icao || '', city: f.departure.airport.name || '' },
                  dest: { iata: f.arrival.airport.iata,   icao: f.arrival.airport.icao || '',   city: f.arrival.airport.name || '' }
                });
              } else { resolve(null); }
            } catch { resolve(null); }
          });
        });
        req2.on('error', reject);
        req2.setTimeout(8000, () => { req2.destroy(); reject(new Error('timeout')); });
      });
      if (result) {
        console.log(`AeroDataBox route: ${callsign} ${result.orig.iata}→${result.dest.iata}`);
        serverRouteCache[callsign] = { route: result, ts: Date.now() };
        saveJSON(ROUTE_CACHE_FILE, serverRouteCache);
        return res.json({ route: result, source: 'aerodatabox' });
      }
    } catch(e) {
      console.warn(`AeroDataBox error for ${callsign}: ${e.message}`);
    }
  }

  // Routen-Aufloesung: zuerst adsbdb, dann adsb.lol als Fallback.
  // Negatives Caching nur, wenn BEIDE Quellen definitiv "keine Route" liefern.
  let adsbdbDefiniteMiss = false;
  let adsblolDefiniteMiss = false;

  // 1) adsbdb (sofern nicht im Cooldown)
  if (Date.now() >= adsbdbCooldownUntil) {
    try {
      const r1 = await lookupAdsbdb(callsign);
      if (r1.route) {
        adsbdbCooldownMs = ADSBDB_COOLDOWN_MS; // adsbdb antwortet -> Backoff zuruecksetzen
        serverRouteCache[callsign] = { route: r1.route, ts: Date.now() };
        saveJSON(ROUTE_CACHE_FILE, serverRouteCache);
        return res.json({ route: r1.route, source: 'adsbdb' });
      }
      if (r1.rateLimited) {
        // 429: aktuelle Pause setzen, dann Backoff fuer das naechste Mal verdoppeln
        adsbdbCooldownUntil = Date.now() + adsbdbCooldownMs;
        console.warn(`adsbdb 429 -- Cooldown ${Math.round(adsbdbCooldownMs / 1000)}s aktiv`);
        adsbdbCooldownMs = Math.min(adsbdbCooldownMs * 2, ADSBDB_COOLDOWN_MAX);
      } else {
        adsbdbCooldownMs = ADSBDB_COOLDOWN_MS; // normale Antwort (keine Route) -> Backoff zuruecksetzen
        adsbdbDefiniteMiss = true;
      }
    } catch(e) { console.warn(`adsbdb error for ${callsign}: ${e.message}`); }
  }

  // 2) adsb.lol nur, wenn die lokale DB NICHT bereit ist. Bei bereiter lokaler DB ist
  //    adsb.lol redundant (dieselben VRS-Daten) und wird als definitiver Miss gewertet.
  if (routedb.routeDBStats().ready) {
    adsblolDefiniteMiss = true;
  } else if (Date.now() >= adsblolCooldownUntil) {
    try {
      const r2 = await lookupAdsblol(callsign);
      if (r2.route) {
        serverRouteCache[callsign] = { route: r2.route, ts: Date.now() };
        saveJSON(ROUTE_CACHE_FILE, serverRouteCache);
        return res.json({ route: r2.route, source: 'adsblol' });
      }
      if (r2.rateLimited) {
        adsblolCooldownUntil = Date.now() + ADSBDB_COOLDOWN_MS;
        console.warn(`adsb.lol 429 -- Cooldown ${ADSBDB_COOLDOWN_MS / 1000}s aktiv`);
      } else {
        adsblolDefiniteMiss = true;
      }
    } catch(e) { console.warn(`adsb.lol error for ${callsign}: ${e.message}`); }
  }

  // Nur cachen, wenn beide Quellen eindeutig nichts hatten (kein Cooldown/Fehler dazwischen)
  if (adsbdbDefiniteMiss && adsblolDefiniteMiss) {
    serverRouteCache[callsign] = { route: null, ts: Date.now() };
    saveJSON(ROUTE_CACHE_FILE, serverRouteCache);
    return res.json({ route: null }); // endgueltige Fehlanzeige (Frontend wartet laenger)
  }
  // Mindestens eine Quelle war gedrosselt/Fehler -> transient, Frontend bald erneut
  return res.json({ route: null, source: 'ratelimited' });
});

app.get('/status', (req, res) => {
  res.json({ status: 'ok', users: Object.keys(userState).length });
});

// Admin-Diagnose: gespeicherten Nutzerzustand einsehen (z.B. Favoriten pruefen)
// Aufruf: /debug-userstate?key=ADMIN_SECRET            -> Uebersicht aller Nutzer
//         /debug-userstate?key=ADMIN_SECRET&token=...  -> voller Stand zu einem Token
app.get('/debug-userstate', requireAdmin, (req, res) => {
  const token = (req.query.token || '').trim();
  if (token) {
    const chatId = chatIdFromToken(token);
    if (!chatId) return res.json({ found: false, error: 'unbekannter Token' });
    return res.json({ found: true, chatId, state: userState[chatId] || null });
  }
  const out = {};
  for (const [cid, st] of Object.entries(userState)) {
    out[cid] = {
      favorites:    st.favorites || [],
      alert_radius: st.alert_radius,
      lastSeen:     st.lastSeen ? new Date(st.lastSeen).toISOString() : null
    };
  }
  return res.json({ users: Object.keys(userState).length, state: out });
});

app.get('/airlines', (req, res) => {
  res.json(AIRLINE_NAMES);
});

// Eigener Aircraft-Proxy als Fallback statt corsproxy.io (Punkt 7)
// Akzeptiert nur numerische Koordinaten und ruft ausschliesslich die bekannten Upstreams auf
app.get('/aircraft', rateLimitAircraft, async (req, res) => {
  recordVisitor(req);
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = Math.min(parseInt(req.query.radius, 10) || 40, 250);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'bad coordinates' });
  }
  try {
    const data = await fetchAircraft(lat.toFixed(4), lon.toFixed(4), radius);
    res.json(data);
  } catch(e) {
    console.error('aircraft proxy error:', e.message);
    res.status(502).json({ error: 'upstream error' });
  }
});

const port = process.env.PORT || 3000;
// Lokale Routen-DB laden (Cache sofort, woechentliche Aktualisierung im Hintergrund)
routedb.initRouteDB('/data', 7, rebuildAirlineNames).catch(e => console.warn('[routedb] init:', e.message));

// ── Wächter-Intervall: Poll-Stillstand, Speicher, adsbdb-Backoff; Besucher persistieren ──
setInterval(async () => {
  const now = Date.now();
  if (health.lastPollTs) {
    const stalledMin = (now - health.lastPollTs) / 60000;
    await setHealthFlag('stalled', stalledMin >= POLL_STALL_MIN,
      `⚠️ Poll-Stillstand: seit ${Math.round(stalledMin)} Min kein Poll. Läuft der Railway-Cron noch?`,
      '✅ Poll läuft wieder.');
  }
  if (MEM_ALERT_MB > 0) {
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    await setHealthFlag('mem', rssMb >= MEM_ALERT_MB,
      `⚠️ Hoher Speicher: ${rssMb} MB (Schwelle ${MEM_ALERT_MB} MB).`,
      '✅ Speicher wieder normal.');
  }
  await setHealthFlag('adsbdb', adsbdbCooldownMs >= 12 * 60 * 1000,
    `⚠️ adsbdb stark gedrosselt: Backoff ${Math.round(adsbdbCooldownMs/60000)} Min (anhaltende 429).`,
    '✅ adsbdb wieder normal.');
  uniqueVisitors24h();                  // 24h-Fenster beschneiden
  try { saveJSON(VISITORS_FILE, visitors); } catch {}
}, 60 * 1000).unref?.();

// ── Startup-Meldung (erkennt unerwartete Neustarts / Crash-Loops) ──
(function(){
  const now  = Date.now();
  const last = health.lastStartupTs || 0;
  const quick = last && (now - last) < 30 * 60 * 1000;
  health.lastStartupTs = now;
  saveHealth();
  if (!HEALTH_ALERTS || !OWNER_CHAT_ID) return;
  if (quick) {
    if (!health.lastLoopWarnTs || now - health.lastLoopWarnTs > 30 * 60 * 1000) {
      health.lastLoopWarnTs = now; saveHealth();
      healthAlert('⚠️ Server wurde innerhalb von 30 Min erneut gestartet (möglicher Crash-Loop). Bitte Railway-Logs prüfen.');
    }
  } else {
    healthAlert('🔄 ADSB-Server gestartet.');
  }
})();

// ── /status nur im Befehlsmenü des Owners registrieren (privat, kein Leak an andere) ──
(function(){
  if (!BOT_TOKEN || !OWNER_CHAT_ID) return;
  const body = JSON.stringify({
    commands: [{ command: 'status', description: 'Serverstatus & Besucher (24h)' }],
    scope: { type: 'chat', chat_id: Number(OWNER_CHAT_ID) }
  });
  const r = https.request({
    hostname: 'api.telegram.org', path: `/bot${BOT_TOKEN}/setMyCommands`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, resp => { resp.on('data', ()=>{}); resp.on('end', ()=>{}); });
  r.on('error', e => console.warn('setMyCommands:', e.message));
  r.write(body); r.end();
})();

app.listen(port, () => console.log(`Server running on port ${port}`));
