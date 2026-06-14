// routedb.js -- Lokale Routen-Aufloesung aus der VRS-Standing-Data (CC0, Public Domain)
// Quelle: https://github.com/vradarserver/standing-data
// Laedt Routen (Callsign -> ICAO-ICAO) und Flughaefen (ICAO -> {iata, city}) in den Speicher,
// cached eine flache Form unter dataDir und aktualisiert woechentlich im Hintergrund.

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

const TARBALL_URL = 'https://codeload.github.com/vradarserver/standing-data/tar.gz/refs/heads/main';

let routeMap   = new Map(); // CALLSIGN -> "ICAO-ICAO"
let airportMap = new Map(); // ICAO -> { iata, city }
let airlineCodes = new Set(); // bekannte Airline-Codes (Code/ICAO/IATA) aus der kanonischen Liste
let ready      = false;
let airlineReady = false;

// ---- CSV-Hilfen ---------------------------------------------------------
// Quote-sicheres Parsen einer einzelnen CSV-Zeile (Flughafennamen koennen Kommas enthalten)
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Callsign normalisieren wie in der VRS-Doku: Code + Nummer, fuehrende Nullen strippen
function normalizeCallsign(cs) {
  cs = (cs || '').trim().toUpperCase().replace(/^\uFEFF/, '');
  const m = cs.match(/^([A-Z]{2,3}|[A-Z][0-9]|[0-9][A-Z])(\d[A-Z0-9]*)$/);
  if (!m) return cs;
  let num = m[2].replace(/^0+/, '');
  if (num === '' || /^[A-Z]/.test(num)) num = '0' + num;
  return m[1] + num;
}

// ---- Builder ------------------------------------------------------------
function addRouteCsv(content, into) {
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('Callsign,') || line.charCodeAt(0) === 0xFEFF && line.includes('Callsign,')) continue;
    // Routen-Felder sind code-artig ohne Kommas/Quotes -> einfaches split reicht
    const f = line.split(',');
    if (f.length < 5) continue;
    const callsign = f[0].replace(/^\uFEFF/, '').trim();
    const codes = f[4].trim();
    if (callsign && codes && codes !== 'unknown') into.routes.set(callsign, codes);
  }
}

function addAirportCsv(content, into) {
  for (const line of content.split('\n')) {
    if (!line) continue;
    const first = line.replace(/^\uFEFF/, '');
    if (first.startsWith('Code,')) continue; // Header
    const f = parseCsvLine(first);
    if (f.length < 5) continue;
    const icao = (f[2] || '').trim();
    const iata = (f[3] || '').trim();
    const city = (f[4] || '').trim() || (f[1] || '').trim(); // Location, sonst Name
    if (icao) into.airports.set(icao, { iata, city });
  }
}

// Kanonische Airline-Liste: Code,Name,ICAO,IATA,... -> Set aller bekannten Codes.
// Bewusst grosszuegig (Code, ICAO und IATA), damit kein echter Airline-Flug faelschlich
// als Registrierung eingestuft wird.
function addAirlineCsv(content, into) {
  for (const line of content.split('\n')) {
    if (!line) continue;
    const first = line.replace(/^\uFEFF/, '');
    if (first.startsWith('Code,')) continue; // Header
    const f = parseCsvLine(first);
    if (f.length < 4) continue;
    for (const idx of [0, 2, 3]) { // Code, ICAO, IATA
      const code = (f[idx] || '').trim().toUpperCase();
      if (code) into.airlines.add(code);
    }
  }
}

// ---- Download + Flatten via Tarball-Stream ------------------------------
// Streamt das gzippte Tarball, filtert nur die noetigen CSVs heraus.
function buildFromTarball() {
  const tar = require('tar');
  return new Promise((resolve, reject) => {
    const into = { routes: new Map(), airports: new Map(), airlines: new Set() };
    const parser = new tar.Parser();
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };

    parser.on('entry', entry => {
      const p = entry.path; // z.B. standing-data-main/routes/schema-01/B/BAW-all.csv
      const isRoute   = /\/routes\/schema-01\/[^/]+\/.+\.csv$/.test(p);
      const isAirport = /\/airports\/schema-01\/[^/]+\/.+\.csv$/.test(p);
      const isAirline = /\/airlines\/schema-01\/airlines\.csv$/.test(p);
      if (!isRoute && !isAirport && !isAirline) { entry.resume(); return; }
      const chunks = [];
      entry.on('data', c => chunks.push(c));
      entry.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (isRoute) addRouteCsv(text, into);
        else if (isAirport) addAirportCsv(text, into);
        else addAirlineCsv(text, into);
      });
      entry.on('error', fail);
    });
    parser.on('end', () => { if (!settled) { settled = true; resolve(into); } });
    parser.on('error', fail);

    https.get(TARBALL_URL, { headers: { 'User-Agent': 'adsb-radar/2.0' } }, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // Redirect folgen
        https.get(res.headers.location, { headers: { 'User-Agent': 'adsb-radar/2.0' } }, r2 => {
          r2.pipe(zlib.createGunzip()).pipe(parser).on('error', fail);
        }).on('error', fail);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) { fail(new Error('HTTP ' + res.statusCode)); res.resume(); return; }
      res.pipe(zlib.createGunzip()).pipe(parser).on('error', fail);
    }).on('error', fail);
  });
}

// ---- Persistenz (flache Cache-Dateien) ----------------------------------
function flatPaths(dataDir) {
  return {
    routes:   path.join(dataDir, 'vrs-routes.csv'),
    airports: path.join(dataDir, 'vrs-airports.json'),
    airlines: path.join(dataDir, 'vrs-airlines.txt'),
    meta:     path.join(dataDir, 'vrs-meta.json'),
  };
}

function writeFlat(dataDir, into) {
  const p = flatPaths(dataDir);
  const lines = [];
  for (const [cs, codes] of into.routes) lines.push(cs + ',' + codes);
  fs.writeFileSync(p.routes + '.tmp', lines.join('\n'));
  fs.renameSync(p.routes + '.tmp', p.routes);
  fs.writeFileSync(p.airports + '.tmp', JSON.stringify(Object.fromEntries(into.airports)));
  fs.renameSync(p.airports + '.tmp', p.airports);
  fs.writeFileSync(p.airlines + '.tmp', [...into.airlines].join('\n'));
  fs.renameSync(p.airlines + '.tmp', p.airlines);
  fs.writeFileSync(p.meta, JSON.stringify({ builtAt: Date.now(), routes: into.routes.size, airports: into.airports.size, airlines: into.airlines.size }));
}

function loadFlat(dataDir) {
  const p = flatPaths(dataDir);
  const rTxt = fs.readFileSync(p.routes, 'utf8');
  const rm = new Map();
  for (const line of rTxt.split('\n')) {
    if (!line) continue;
    const i = line.indexOf(',');
    if (i > 0) rm.set(line.slice(0, i), line.slice(i + 1));
  }
  const am = new Map(Object.entries(JSON.parse(fs.readFileSync(p.airports, 'utf8'))));
  routeMap = rm;
  airportMap = am;
  ready = true;
  // Airline-Codes (optional; aeltere Caches haben die Datei evtl. noch nicht)
  try {
    const aTxt = fs.readFileSync(p.airlines, 'utf8');
    airlineCodes = new Set(aTxt.split('\n').filter(Boolean));
    airlineReady = airlineCodes.size > 0;
  } catch { airlineReady = false; }
  return { routes: rm.size, airports: am.size, airlines: airlineCodes.size };
}

function flatAgeDays(dataDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(flatPaths(dataDir).meta, 'utf8'));
    return (Date.now() - meta.builtAt) / 86400000;
  } catch { return Infinity; }
}

async function rebuild(dataDir) {
  const into = await buildFromTarball();
  if (into.routes.size < 1000 || into.airports.size < 1000) {
    throw new Error(`unplausibel wenige Eintraege (${into.routes.size}/${into.airports.size})`);
  }
  writeFlat(dataDir, into);
  routeMap = into.routes;
  airportMap = into.airports;
  airlineCodes = into.airlines;
  airlineReady = into.airlines.size > 0;
  ready = true;
  console.log(`[routedb] aufgebaut: ${into.routes.size} Routen, ${into.airports.size} Flughaefen, ${into.airlines.size} Airline-Codes`);
}

// ---- Oeffentliche API ---------------------------------------------------
// init: laedt vorhandenen Cache sofort (schneller Start), aktualisiert bei Bedarf im Hintergrund
async function initRouteDB(dataDir = '/data', refreshDays = 7) {
  const p = flatPaths(dataDir);
  const haveFlat = fs.existsSync(p.routes) && fs.existsSync(p.airports);
  if (haveFlat) {
    try {
      const n = loadFlat(dataDir);
      console.log(`[routedb] aus Cache geladen: ${n.routes} Routen, ${n.airports} Flughaefen, ${n.airlines} Airline-Codes`);
    } catch (e) { console.warn('[routedb] Cache-Laden fehlgeschlagen:', e.message); }
  }
  // Erstaufbau, Aktualisierung oder fehlende Airline-Liste -> im Hintergrund neu aufbauen
  if (!haveFlat || flatAgeDays(dataDir) > refreshDays || !airlineReady) {
    rebuild(dataDir).catch(e => console.warn('[routedb] Aufbau fehlgeschlagen:', e.message));
  }
  // Woechentliche Aktualisierung
  setInterval(() => {
    if (flatAgeDays(dataDir) > refreshDays) {
      rebuild(dataDir).catch(e => console.warn('[routedb] Aktualisierung fehlgeschlagen:', e.message));
    }
  }, 24 * 60 * 60 * 1000).unref?.();
}

// resolveLocalRoute: liefert { orig, dest } oder null
function resolveLocalRoute(callsign) {
  if (!ready) return null;
  const key = normalizeCallsign(callsign);
  const codes = routeMap.get(key);
  if (!codes || codes === 'unknown') return null;
  const parts = codes.split('-');
  if (parts.length < 2) return null;
  const o = airportMap.get(parts[0]);
  const d = airportMap.get(parts[parts.length - 1]);
  if (!o || !d || !o.iata || !d.iata) return null;
  return {
    orig: { iata: o.iata, icao: parts[0], city: o.city || '' },
    dest: { iata: d.iata, icao: parts[parts.length - 1], city: d.city || '' },
  };
}

function routeDBStats() { return { ready, routes: routeMap.size, airports: airportMap.size, airlineReady, airlines: airlineCodes.size }; }

// Treffsichere Abgrenzung: liefert
//   true  -> Praefix ist ein bekannter Airline-Code (Linienflug, extern lohnt sich)
//   false -> definitiv kein Airline-Code (Registrierung/Privat, extern ueberspringen)
//   null  -> Liste nicht geladen, keine Aussage (im Zweifel NICHT ueberspringen)
function isAirlineCallsign(callsign) {
  if (!airlineReady) return null;
  const m = normalizeCallsign(callsign).match(/^([A-Z]{2,3}|[A-Z][0-9]|[0-9][A-Z])(\d[A-Z0-9]*)$/);
  if (!m) return false; // sieht nicht wie Airline-Code plus Nummer aus
  return airlineCodes.has(m[1]);
}

// Testhilfe: aus lokalem Verzeichnis aufbauen (ohne Download)
function _buildFromDir(dir) {
  const into = { routes: new Map(), airports: new Map(), airlines: new Set() };
  const walk = (d, kind) => {
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp, kind);
      else if (name.endsWith('.csv')) {
        const txt = fs.readFileSync(fp, 'utf8');
        if (kind === 'route') addRouteCsv(txt, into);
        else if (kind === 'airport') addAirportCsv(txt, into);
        else addAirlineCsv(txt, into);
      }
    }
  };
  walk(path.join(dir, 'routes/schema-01'), 'route');
  walk(path.join(dir, 'airports/schema-01'), 'airport');
  walk(path.join(dir, 'airlines/schema-01'), 'airline');
  return into;
}

module.exports = {
  initRouteDB, resolveLocalRoute, routeDBStats, normalizeCallsign, isAirlineCallsign,
  _buildFromDir, _setMaps: (r, a, al) => { routeMap = r; airportMap = a; ready = true; if (al) { airlineCodes = al; airlineReady = al.size > 0; } },
  _writeFlat: writeFlat, _loadFlat: loadFlat, _buildFromTarball: buildFromTarball,
};
