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
  'https://adsb-radar.de,https://www.adsb-radar.de').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // Anfragen ohne Origin (Cron, Telegram, curl) zulassen, Browser-Origins nur aus Whitelist
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
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
const AIRLINE_NAMES = {
  AAA:"Ansett Australia", AAF:"Aigle Azur", AAH:"Aloha Airlines", AAL:"American Airlines", AAN:"Amsterdam Airlines",
  AAQ:"Copterline", AAR:"Asiana Airlines", AAS:"Askari Aviation", AAW:"Afriqiyah Airways", AAY:"Allegiant Air",
  ABD:"Air Atlanta Icelandic", ABF:"Scanwings", ABI:"Aviabus", ABL:"Air Busan", ABQ:"Airblue",
  ABR:"ASL Airlines Belgium (FedEx)", ABS:"Transwest Air", ABY:"Air Arabia", ACA:"Air Canada", ACI:"Air Caledonie International",
  ACP:"Astral Aviation", ADE:"Ada Air", ADH:"Air One", ADN:"ADAC Luftrettung", ADO:"Hokkaido International Airlines", ADR:"Adria Airways",
  AEA:"Air Europa", AEB:"Aero Benin", AEE:"Aegean Airlines", AEG:"Airest", AEL:"Air Europe", AER:"Alaska Central Express",
  AES:"ACES Colombia", AEU:"Astraeus", AEW:"Aerosvit Airlines", AEY:"Air Italy", AFG:"Ariana Afghan Airlines",
  AFL:"Aeroflot Russian Airlines", AFR:"Air France", AGV:"Air Glaciers", AGX:"Aviogenex", AHO:"Air Hamburg (AHO)",
  AHY:"Azerbaijan Airlines", AIA:"Avies", AIC:"Air India Limited", AIO:"United States Air Force", AIQ:"Thai AirAsia",
  AIR:"Airlift International", AIZ:"Arkia Israel Airlines", AJM:"Air Jamaica", AJX:"Air Japan", AKA:"Air Korea Co. Ltd.",
  AKL:"Air Kiribati", ALE:"Alliance Jet", ALK:"SriLankan Airlines", ALO:"Allegheny Commuter Airlines", AMC:"Air Malta", AML:"Air Malawi",
  AMT:"ATA Airlines", AMU:"Air Macau", AMV:"AMC Airlines", AMX:"AeroMéxico", ANA:"All Nippon Airways",
  ANE:"Air Nostrum", ANG:"Air Niugini", ANK:"Air Nippon", ANO:"Airnorth", ANT:"Air North Charter - Canada",
  ANU:"Andalus Lineas Aereas", ANZ:"Air New Zealand", AOJ:"Avcon Jet", APW:"Arrow Air", ARD:"Aerocondor", ARE:"Aires",
  ARF:"Aero Flight", ARG:"Aerolineas Argentinas", ARU:"Aruba Airlines", ASA:"Alaska Airlines", ASD:"Air Sinai",
  ASH:"Mesa Airlines", ASL:"Air Serbia", ASQ:"Atlantic Southeast Airlines", ASZ:"Astrakhan Airlines", ATC:"Air Tanzania",
  ATM:"Airlines Of Tasmania", AUA:"Austrian Airlines", AUB:"Augsburg Airways", AUH:"Abu Dhabi Amiri Flight", AUI:"Ukraine International Airlines",
  AUL:"Aeroflot-Nord", AUR:"Aurigny Air Services", AUT:"Austral Lineas Aereas", AVA:"Avianca - Aerovias Nacionales de Colombia", AVN:"Air Vanuatu",
  AWA:"Asia Wings", AWE:"America West Airlines", AWG:"AnimaWings", AWH:"Aerowest", AWI:"Air Wisconsin", AWM:"Asian Wings Airways", AWQ:"Indonesia AirAsia",
  AWU:"Aeroline GmbH", AWW:"Air Wales", AXB:"Air India Express", AXC:"Indochina Airlines", AXE:"Air Explore",
  AXL:"Air Exel", AXM:"AirAsia", AXY:"AirX Charter", AXZ:"Aereonautica militare", AYZ:"Atlant-Soyuz Airlines", AZA:"Alitalia", AZE:"Arcus-Air",
  AZN:"Amaszonas", AZU:"Azul", AZW:"Air Zimbabwe", BAG:"dba", BAW:"British Airways",
  BBC:"Biman Bangladesh Airlines", BBG:"Bluebird Airways (BZ)", BBO:"Flybaboo", BBR:"Santa Barbara Airlines", BCC:"BusinessAir",
  BCI:"Blue Islands", BCN:"Ocean Air", BCS:"Brussels Airlines", BCY:"CityJet", BEE:"Flybe", BEL:"Brussels Airlines",
  BER:"Air Berlin", BEU:"Bateleur Air", BGD:"Air Bangladesh", BGY:"Bingo Airways", BHP:"Belair Airlines",
  BHS:"Bahamasair", BIE:"Air Mediterranee", BIH:"British International Helicopters", BKF:"BF-Lento OY", BKP:"Bangkok Airways",
  BLF:"Blue1", BLL:"Baltic Airlines", BLS:"Bearskin Lake Air Service", BLV:"Bellview Airlines", BLX:"TUIfly Nordic",
  BMA:"bmi", BMI:"bmibaby", BMJ:"Bemidji Airlines", BMM:"Atlas Blue", BMR:"British Midland Regional",
  BOH:"Air Bohemia", BON:"Air Bosna", BOT:"Air Botswana", BOV:"Boliviana de Aviacion (OB)", BPA:"Blue Panorama Airlines",
  BPS:"Budapest Aircraft Services/Manx2", BQB:"Buquebus Líneas Aéreas", BRG:"Bering Air", BRQ:"El-Buraq Air Transport", BRS:"Brazilian Air Force",
  BRU:"Belavia Belarusian Airlines", BSA:"Black Stallion Airways", BSX:"Bassaka airlines", BTA:"ExpressJet", BTI:"Air Baltic",
  BTM:"Air Batumi", BTQ:"Boutique Air (Priv)", BTV:"Metro Batavia", BUB:"Air Bourbon", BUR:"Air Bucharest",
  BUU:"Baikotovitchestrian Airlines ", BVT:"Berjaya Air", BWA:"Caribbean Airlines", BWG:"Blue Wings", BZE:"BRAZIL AIR",
  BZH:"Brit Air", CAI:"Corendon Airlines", CAL:"China Airlines", CAN:"Crest Aviation", CAO:"Air China Cargo", CAP:"CanXplorer",
  CAW:"Comair", CAY:"Cayman Airways", CBG:"GX Airlines", CCA:"Air China", CCB:"CARICOM AIRWAYS (BARBADOS) INC.",
  CCC:"CCML Airlines", CCG:"Central Connect Airlines", CCM:"Corse-Mediterranee", CDG:"Shandong Airlines", CDN:"Canadian Airlines",
  CDP:"Aero Condor Peru", CEB:"Cebu Pacific", CEL:"CEIBA Intercontinental", CEO:"Comfort Express Virtual Charters", CES:"China Eastern Airlines",
  CEY:"Air Century", CFE:"BA CityFlyer", CFG:"Condor Flugdienst", CGK:"Click Airways", CGP:"Cargo Plus Aviation",
  CHB:"West Air China", CHH:"Hainan Airlines", CHP:"Consorcio Aviaxsa", CHQ:"Chautauqua Airlines", CHW:"Charter Air",
  CHX:"Luftrettung", CHZ:"Challenge Air Cargo", CIF:"CB Airways UK ( Interliging Flights )", CIM:"Cimber Air", CIX:"City Connexion Airlines", CJC:"Colgan Air",
  CLH:"Lufthansa CityLine", CLI:"Calima Aviacion", CLJ:"Cello Aviation", CLX:"Cargolux", CLW:"Centralwings", CMI:"Continental Micronesia",
  CMA:"CMG Air Cargo", CMP:"Copa Airlines", CNF:"Canaryfly", CNO:"SAS Braathens", COA:"Continental Airlines", COE:"Comtel Air",
  COM:"Comair", CPA:"Cathay Pacific", CPN:"Caspian Airlines", CPZ:"Compass Airlines", CQH:"Spring Airlines",
  CQN:"Chongqing Airlines", CRK:"Hong Kong Airlines", CRL:"Corsairfly", CRO:"Crown Airways", CSA:"Czech Airlines",
  CSC:"Sichuan Airlines", CSH:"Shanghai Airlines", CSN:"China Southern Airlines", CSW:"Chair Airlines", CSX:"Choice Airways", CSZ:"Shenzhen Airlines",
  CTN:"Croatia Airlines", CUA:"China United Airlines", CUB:"Cubana de Aviación", CUD:"Air Cudlua", CVA:"Air Chathams",
  CWK:"Comores Airlines", CWM:"Air Marshall Islands", CXA:"Xiamen Airlines", CYD:"Access Air", CXI:"SpiceJet", CYH:"Yunnan Airlines",
  CYP:"Cyprus Airways", CZV:"Via Conectia Airlines", DAH:"Air Algerie", DAK:"First Flying", DAL:"Delta Air Lines",
  DAO:"Daallo Airlines", DAT:"Brussels Airlines", DBK:"Dubrovnik Air", DCD:"Air 26", DEA:"Delta Aerotaxi",
  DHI:"Adam Air", DJB:"Djibouti Airlines", DKH:"Juneyao Airlines", DLA:"Air Dolomiti", DLH:"Lufthansa",
  DME:"Royal Flight", DMO:"Domodedovo Airlines", DNL:"Dutch Antilles Express", DNM:"Denim Air", DNV:"Aeroflot-Don",
  DOA:"Dominicana de Aviaci", DOB:"Dobrolet", DRD:"Air Madrid", DRK:"Druk Air", DRU:"Alrosa Mirny Air Enterprise",
  DSM:"LAN Argentina", DSV:"Direct Aero Services", DSY:"Dennis Sky", DTA:"TAAG Angola Airlines", DTR:"DAT Danish Air Transport",
  DWA:"Dense Airways",  DWT:"Darwin Airline", DWW:"DAS Private Jets", DYA:"Dynamic Airways", EAA:"Eastok Avia", EAL:"European Air Express",
  EAV:"Eastern Atlantic Virtual Airlines", ECA:"Eurocypria Airlines", ECU:"Ecuavia", EDW:"Edelweiss Air", EEA:"Empresa Ecuatoriana De Aviacion",
  EEU:"Eurofly Service", EFA:"Far Eastern Air Transport", EFW:"British Airways", EFY:"EasyFly", EGF:"American Eagle Airlines", EGH:"BBN-Airways",
  EGS:"Eagles Airlines", EGT:"EGT Jet", EHN:"East Horizon", EIA:"Evergreen International Airlines", EIN:"Aer Lingus", EJA:"NetJets", EJU:"easyJet Europe",
  ELA:"Eastland Air", ELC:"Small Planet Airlines", ELK:"ELK Airways", ELL:"Estonian Air", ELO:"Eurolot",
  ELY:"El Al Israel Airlines", ENJ:"Enerjet", ENT:"Enter Air", ENY:"Envoy Air", ENZ:"Jota Aviation", ERO:"Sun D'Or",
  ERR:"Era Alaska", ERT:"Eritrean Airlines", ESK:"SkyEurope", ESR:"Eastar Jet", ETD:"Etihad Airways",
  ETH:"Ethiopian Airlines", EUD:"Air Italy Egypt", EUV:"EuropeSky", EVA:"EVA Air", EVC:"Comfort Express Virtual Charters Albany",
  EWG:"Eurowings", EXS:"Jet2.com", EZA:"Eznis Airways", EZE:"Eastern Airways", EZS:"easyJet Switzerland", EZY:"easyJet",
  FAB:"First Air", FAF:"France Airforce", FBL:"Fly Brasil", FBU:"Frenchbee", FCA:"First Choice Airways", FCB:"COBALT", FCM:"Flybe Finland Oy",
  FDB:"Fly Dubai", FDD:"Feeder Airlines", FDX:"FedEx", FEG:"FlyEgypt", FFM:"Firefly", FFT:"Frontier Airlines",
  FFV:"Fly540", FHE:"Hello", FHI:"FlyHigh Airlines Ireland (FH)", FHM:"Freebird Airlines Europe", FIF:"Air Finland", FIN:"Finnair",
  FIX:"Airfix Aviation", FJI:"Air Pacific", FJM:"Fly Jamaica Airways", FJO:"FlexJet", FKA:"Flying kangaroo Airline", FLB:"German Air Force - FLB",
  FLG:"Pinnacle Airlines", FLJ:"FlexJet", FLI:"Atlantic Airways", FLO:"Flexjet Operations Malta", FLT:"Flightline", FLZ:"Air Florida", FNA:"Norlandair",
  FOS:"Formosa Airlines", FOX:"FOX Linhas Aereas", FPO:"ASL Airlines France", FPT:"FlyPortugal", FRE:"Freedom Air",
  FRF:"Fleet Air International", FRL:"Freedom Airlines", FTA:"Frontier Flying Service", FVM:"Flugfelag Vestmannaeyja", FWI:"Air Caraïbes",
  FWL:"Florida West International Airways", FXI:"Air Iceland", FXX:"Felix Airways", FYH:"Flyhy Cargo Airlines", FYJ:"FLYJET",
  FZA:"Fuzhou Airlines", FZW:"Fly Africa Zimbabwe", GAC:"GlobeAir", GAI:"Moskovia Airlines", GAO:"Golden Air", GAP:"Air Philippines",
  GBA:"Gulf Air Bahrain", GBK:"Gabon Airlines", GBL:"GB Airways", GCA:"Grand Cru Airlines", GCR:"Tianjin Airlines",
  GDC:"Grand China Air", GDR:"Gadair European Airlines", GEC:"Lufthansa Cargo", GER:"German International Air Lines", GFA:"Gulf Air", GPX:"GP Aviation",
  GFG:"Georgian National Airlines", GFT:"Gulfstream International Airlines", GFY:"Greenfly", GHB:"Ghana International Airlines", GIA:"Garuda Indonesia",
  GIE:"Elysian Airlines", GIP:"Air Guinee Express", GJI:"GainJet (REVA Air Amb.)", GJS:"GoJet Airlines", GLA:"Great Lakes Airlines", GLG:"Aerolineas Galapagos (Aerogal)",
  GLO:"Gol Transportes Aéreos", GLP:"Globus", GMI:"Germania", GMR:"Golden Myanmar Airlines", GNN:"Georgian International Airlines",
  GOW:"Go Air", GRL:"Air Greenland", GSM:"Flyglobespan", GTA:"City Airways", GTI:"Atlas Air",
  GUY:"Air Guyane", GWI:"Germanwings", GWY:"USA3000 Airlines", GXG:"GermanXL", GZP:"Gazpromavia",
  HAG:"Hageland Aviation Services", HAL:"Hawaiian Airlines", HAM:"Haiti Ambassador Airlines", HAY:"Hamburg Airways", HBH:"Hebei Airlines",
  HBR:"Hebradran Air Services", HCC:"Holidays Czech Airlines", HCW:"Star1 Airlines", HDA:"Dragonair", HEJ:"Hellas Jet",
  HER:"Hex'Air", HFR:"Heli France", HHI:"Hamburg International", HKE:"Hong Kong Express Airways", HLF:"Hapagfly",
  HLX:"TUIfly", HMR:"North American Charters", HNX:"Hankook Airline", HPY:"Happy Air", HRM:"Hermes Airlines",
  HSK:"Sky Europe Airlines", HTH:"Helitt Líneas Aéreas", HVK:"Turkish Air Force", HVN:"Vietnam Airlines", HWY:"Highland Airways",
  HYM:"Himalayan Airlines", HYS:"HiSky Europe", HZA:"Horizon Airlines", IAA:"Indonesian Airlines", IAC:"Indian Airlines", IAM:"Aeronautica Militare",
  IAW:"Iraqi Airways", IBB:"Binter Canarias", IBE:"Iberia Airlines", IBK:"Norwegian Air International (D8)", IBS:"Iberia Express",
  IBU:"Indigo", IBX:"Ibex Airlines", ICE:"Icelandair", ICL:"CAL Cargo Air Lines", ICV:"Cargolux Italia", IDS:"Indonesia Sky",
  IDX:"Indonesa Air Aisa X", IGT:"Georgian Airlines", IGO:"IndiGo Airlines", IIA:"AIR INDOCHINE", IIR:"INAVIA Internacional", IKA:"Itek Air",
  ILN:"Interair South Africa", IMP:"Hellenic Imperial Airways", INE:"International Europe", IPV:"Parmiss Airlines (IPV)", IRA:"Iran Air",
  IRC:"Iran Aseman Airlines", IRK:"Kish Air", IRM:"Mahan Air", ISK:"Intersky", ISR:"Israir",
  ISS:"Meridiana", ISV:"Islena De Inversiones", ISW:"Islas Airways", ISX:"Island Spirit", ITY:"ITA Airways", ITK:"Interlink Airlines",
  ITX:"Imair Airlines", IWA:"Apache Air", IWD:"Iberworld", IXO:"OCEAN AIR CARGO", IYE:"Yemenia",
  JAA:"Japan Asia Airways", JAB:"Air Bagan", JAF:"Jetairfly", JAI:"Jet Airways", JAL:"Japan Airlines Domestic",
  JAS:"Japan Air System", JAZ:"JALways", JBA:"Helijet", JBU:"JetBlue Airways", JEF:"Jetflite",
  JET:"Wind Jet", JEX:"JAL Express", JFA:"JetFly", JFL:"JetFly", JFU:"Jet4You", JGN:"Jagson Airlines", JJA:"Jeju Air",
  JJP:"Jetstar Japan ", JKK:"Spanair", JNA:"Jin Air", JOR:"Blue Air", JOY:"Joy Air",
  JPU:"Jupiter Airlines", JRB:"Jc royal.britannica", JSA:"Jetstar Asia Airways", JSF:"Jet Stream Chater", JSR:"Jusur airways", JST:"Jetstar Airways",
  JTA:"Japan Transocean Air", JTO:"Jettor Airlines", JTY:"Jetology", JZA:"Air Canada Jazz", JZR:"Jazeera Airways", KAC:"Kuwait Airways",
  KAL:"Korean Air", KAP:"Cape Air", KBR:"KoralBlue Airlines", KBZ:"Air KBZ", KCU:"Skyline Ulasim Ticaret A.S.",
  KDA:"Kendell Airlines", KEA:"Korea Express Air", KEN:"Kenmore Air", KFR:"Kingfisher Airlines", KGL:"Kogalymavia Air Company",
  KGO:"Korongo Airlines", KHB:"Dalavia", KHK:"Kharkiv Airlines", KIL:"Kuban Airlines", KIN:"Kinloss Flying Training Unit",
  KIS:"Contact Air", KJC:"Krasnojarsky Airlines", KKK:"Atlasjet", KLC:"KLM Cityhopper", KLM:"KLM Royal Dutch Airlines",
  KLS:"Kal Star Aviation", KMF:"Kam Air", KMM:"KM Malta Airlines", KND:"Kan Air", KNE:"Nas Air", KNI:"KD Avia",
  KOL:"SOCHI AIR", KOQ:"Kostromskie avialinii", KOR:"Air Koryo", KQA:"Kenya Airways", KRP:"Carpatair",
  KRY:"Russkie Krylya", KSM:"Kosmos", KSY:"KSY", KSZ:"Sunrise Airways", KUH:"Kush Air",
  KYA:"Alghanim", KZK:"Air Kazakhstan", KZR:"Air Astana", KZU:"Kuzu Airlines Cargo", LAA:"Libyan Arab Airlines",
  LAJ:"British Mediterranean Airways", LAM:"Linhas A", LAN:"LAN Airlines", LAO:"Lao Airlines", LAP:"TAM Mercosur",
  LAV:"AlbaStar", LBC:"Albanian Airlines", LBL:"Line Blue", LBT:"Nouvel Air Tunisie", LDA:"Lauda Air",
  LFA:"Air Alfa", LGL:"Luxair", LGW:"Luftfahrtgesellschaft Walter", LHN:"Express One International", LHX:"Lufthansa City Airlines", LIA:"Leeward Islands Air Transport",
  LIL:"FlyLal", LIX:"LionXpress", LJJ:"Luchsh Airlines ", LLC:"FlyLAL Charters", LLM:"Yamal Airlines",
  LCO:"Latam Cargo", LMM:"LCM AIRLINES", LMU:"AlMasria Universal Airlines", LNE:"Aerolane", LNI:"Lion Mentari Airlines", LOC:"Locair",
  LOF:"Trans States Airlines", LOO:"LSM Airlines", LOT:"LOT Polish Airlines", LPE:"LAN Peru", LPR:"L",
  LRC:"LACSA", LTC:"LatCharter", LSI:"MSC Air", LTD:"Southern Airways Express", LTE:"LTE International Airways", LTO:"LTU Austria",
  LTR:"Lufttransport", LTU:"Air Lituanica", LTY:"Liberty Airways", LUA:"Luminair", LUR:"Atlantis European Airways", LXJ:"FlexJet", LXP:"LAN Express",
  LXR:"Air Luxor", LZB:"Bulgaria Air", MAA:"MasAir", MAC:"Malta Air Charter", MAH:"Malév",
  MAI:"Mauritania Airlines International", MAK:"MAT Macedonian Airlines", MAL:"Morningstar Air Express", MAS:"Malaysia Airlines", MAU:"Air Mauritius",
  MAV:"Maldivo Airlines", MBU:"Marabu Airlines", MCA:"MCA Airlines", MCK:"Macair Airlines", MDA:"Mandarin Airlines", MDG:"Air Madagascar",
  MDL:"Mandala Airlines", MDO:"Domenican Airlines", MDP:"Medallion Air", MDV:"Moldavian Airlines", MDW:"Midway Airlines",
  MEA:"Middle East Airlines", MEP:"Midwest Airlines", MFX:"My Freighter", MES:"Mesaba Airlines", MGL:"MIAT Mongolian Airlines", MGX:"Montenegro Airlines",
  MIC:"Mint Airways", MJG:"Michael Airlines", MJP:"Air Majoro", MJX:"Euroline", MKD:"MAT Airways",
  MKG:"Air Mekong", MKU:"Island Air (WP)", MLA:"40-Mile Air", MLD:"Air Moldova", MMM:"Myanmar Airways International",
  MNA:"Merpati Nusantara Airlines", MNB:"MNG Airlines", MNE:"Air Montenegro", MNO:"Mango", MNP:"Spirit of Manila Airlines", MON:"Monarch Airlines",
  MOV:"VIM Airlines", MPC:"MPC Air", MPD:"Air Plus Comet", MPE:"Canadian North", MPH:"Martinair", MRS:"Marusya Airways",
  MSA:"Poste Air Cargo", MSC:"Air Cairo", MSE:"EgyptAir Express", MSI:"Motor Sich", MSR:"Egyptair", MTW:"Mauritania Airways", MVD:"Kavminvodyavia",
  MWA:"Midwest Airlines (Egypt)", MWI:"Malaysia Wings", MXA:"Mexicana de Aviaci", MXD:"Malindo Air", MXI:"MexicanaLink",
  MXL:"Maxair", MYA:"Myflug", MYD:"Maya Island Air", MYP:"Mann Yadanarpon Airlines", MYJ:"My Jet", MYT:"MyTravel Airways",
  NAK:"Arik Niger", NAS:"Nasair", NAX:"Norwegian Air Shuttle", NCF:"Norfolk County Flight College", NCR:"National Air Cargo",
  NDC:"FlyNordic", NDN:"Transportes Aereos Cielos Andinos", NEA:"New England Airlines", NGB:"Nordic Global Airlines", NIA:"Nile Air",
  NIG:"Aero Contractors", NJE:"NetJets", NJS:"National Jet Systems", NKF:"Barents AirLink", NKS:"Spirit Airlines", NLH:"Norwegian Long Haul AS",
  NLY:"Niki", NMA:"Nesma Airlines", NMB:"Air Namibia", NMI:"Pacific Wings", NOK:"Nok Air", NOZ:"Norwegian",
  NSE:"SATENA", NSZ:"Norwegian Air Sweden", NTJ:"NextJet", NTM:"North American Airlines", NTW:"Nationwide Airlines",
  NVR:"Novair", NWA:"Northwest Airlines", NXB:"NEXT Brasil", NYT:"Yeti Airlines ", OAB:"Orbit Airlines Azerbaijan",
  OAE:"Omni Air International", OAI:"Orbit International Airlines", OAL:"Olympic Airlines", OAN:"Orbit Atlantic Airways", OAR:"Orbit Regional Airlines",
  OAW:"Helvetic Airways", OBS:"Orbest", OBT:"Orbit Airlines", OCA:"Aserca Airlines", OCN:"Discover Airlines",
  OEA:"Orient Thai Airlines", OGN:"Origin Pacific Airways", OHK:"Oasis Hong Kong Airlines", OHY:"Onur Air", OLA:"Overland Airways",
  OLS:"Sol Lineas Aereas", OLT:"Ostfriesische Lufttransport", OMA:"Oman Air", OME:"Homer Air", ONE:"Oceanair",
  OOM:"Zoom Airlines", ORB:"Orenburg Airlines", ORC:"Orchid Airlines", ORG:"Orenburzhie", OTG:"One Two Go Airlines",
  OTJ:"Fly Romania", OZJ:"Ozjet Airlines", OZW:"Skywest Airlines", PAL:"Philippine Airlines", PAO:"Polynesian Airlines",
  PBA:"PB Air", PBD:"Pobeda", PCO:"Pacific Coastal Airline", PDC:"Potomac Air", PDT:"Piedmont Airlines (1948-1989)",
  PEC:"Pacific East Asia Cargo Airlines", PEL:"Aeropelican Air Services", PEN:"Peninsula Airways", PFL:"Pacific Flier", PGA:"Portugalia", PGC:"European Aircraft Private Club",
  PGT:"Pegasus Airlines", PIA:"Pakistan International Airlines", PIC:"Jetstar Pacific", PKV:"Псковавиа", PLI:"Aeroper",
  PLR:"Northwestern Air", PMT:"PMTair", PMW:"Paramount Airways", PNR:"PAN Air", POE:"Porter Airlines",
  POT:"Polet", PPL:"Air Pegasus", PPW:"Royal Phnom Penh Airways", PQW:"PanAm World Airways", PRF:"Precision Air",
  PSA:"Pacific Island Aviation", PSB:"Syrian Pearl Airlines", PTB:"Passaredo Transportes Aereos", PTI:"Privatair",  PTN:"Platoon Aviation", PUA:"PLUNA",
  PYA:"Pouya Air", PYB:"All America BOPY", PZY:"Zapolyarie Airlines", QAX:"QatXpress", QER:"SOCHI AIR CHATER",
  QFA:"Qantas", QFZ:"Fars Air Qeshm", QQe:"Qatar Executive", QQQ:"ENTERair", QTR:"Qatar Airways", QXE:"Horizon Air",
  RAB:"Rainbow Air (RAI)", RAC:"Royal Air Cambodge", RAE:"Régional", RAM:"Royal Air Maroc", RAR:"Air Rarotonga",
  RAW:"Royal Airways", RAY:"Rainbow Air Canada", RBA:"Royal Brunei Airlines", RBG:"Air Arabia Egypt", RBY:"Vision Airlines (V2)",
  REA:"Aer Arann", REP:"Regional Paraguaya", REU:"Air Austral", RFJ:"Royal Falcon", RGA:"REGA Swiss Air-Rescue",
  RGG:"TransRussiaAirlines", RIT:"Asian Spirit", RJA:"Royal Jordanian", RJD:"Rotana Jet", RKA:"Air Afrique",
  RLA:"Airlinair", RLN:"Aero Lanka", RLU:"Rusline", RLX:"Go2Sky", RMK:"Simrik Airlines",
  RNA:"Royal Nepal Airlines", RNE:"Air Salone", RNV:"Armavia", RNX:"1Time Airline", RNY:"Rainbow Air US",
  RON:"Nauru Air Corporation", ROT:"Tarom", RPA:"Republic Airlines", RPB:"AeroRep", RPH:"Republic Express Airlines",
  RPO:"Rainbow Air Polynesia", RRJ:"AirRussia", RSD:"Russia State Transport", RSH:"Air Sahara", RSI:"Air Sunshine",
  RSJ:"RusJet", RSP:"Jet Suite", RSR:"Aero-Service", RSU:"Aerosur", RSY:"I-Fly",
  RTE:"Aeronorte", RUE:"Rainbow Air Euro", RUK:"Ryanair UK", RUS:"Cirrus Airlines", RWD:"Rwandair Express", RWW:"Fly Europa",
  RWZ:"Red Wings", RXA:"Regional Express", RXR:"REXAIR VIRTUEL", RYA:"Ryan Air Services", RYN:"Ryan International Airlines",
  RYR:"Ryanair", RZO:"SATA International", SAA:"South African Airways", SAE:"SOCHI AIR EXPRESS", SAI:"Shaheen Air International",
  SAL:"Spike Airlines", SAS:"Scandinavian Airlines System", SAT:"SATA Air Acores", SAY:"ScotAirways", SAZ:"Rega Swiss Air-Ambulance", SBD:"Snowbird Airlines",
  SBI:"S7 Airlines", SBS:"Seaborne Airlines", SCE:"Scenic Airlines", SCO:"Scoot", SCR:"Silver Cloud Air", SCW:"Malmö Aviation",
  SCX:"Sun Country Airlines", SDI:"San Dima Air", SDM:"Rossiya-Russian Airlines", SDR:"City Airline", SEA:"Southeast Air",
  SEH:"Sky Express", SEJ:"Spicejet", SEN:"Sevenair", SEU:"XL Airways France", SEY:"Air Seychelles",
  SFJ:"Star Flyer", SGG:"Senegal Airlines", SGY:"Skagway Air Service", SHA:"Sharp Airlines", SHD:"Sahara Airlines",
  SIA:"Singapore Airlines", SIB:"Sibaviatrans", SIH:"Skynet Airlines", SJM:"Svyaz Rossiya", SJO:"Spring Airlines Japan",
  SJS:"Southjet", SJU:"Skyjet Airlines", SJY:"Sriwijaya Air", SKU:"Sky Airline", SKV:"Sky Regional Airlines",
  SKW:"SkyWest", SKX:"Skyways Express", SKY:"Skymark Airlines", SLC:"Salsa d\\\\'Haiti", SLI:"Aerolitoral",
  SLK:"SilkAir", SLM:"Surinam Airways", SMJ:"Avient Aviation", SMW:"Carpatair Flight Training", SMX:"Alitalia Express",
  SMY:"Sama Airlines", SNB:"Sterling Airlines", SNC:"Air Cargo Carriers", SNJ:"Skynet Asia Airways", SOA:"Southern Air Charter",
  SOL:"Solomon Airlines", SOU:"Southern Airways", SOV:"Saratov Aviation Division", SOZ:"Sat Airlines", SPI:"South Pacific Island Airways",
  SPM:"Air Saint Pierre", SQC:"Singapore Airlines Cargo", SQH:"SeaPort Airlines", SRB:"Solar Air", SRH:"Siem Reap Airways",
  SRN:"Sprint Air", SRQ:"South East Asian Airlines", SRR:"Maersk Air Cargo", SRY:"ViaAir", SSA:"All America US", SSV:"Skyservice Airlines",
  STP:"STP Airways", STU:"Servicios de Transportes A", SUD:"Sudan Airways", SUW:"Interavia Airlines", SVA:"Saudi Arabian Airlines",
  SVF:"Swedish Air Force", SVG:"SVG Air", SVR:"Ural Airlines", SWA:"Southwest Airlines", SWD:"Southern Winds Airlines", SWM:"Sky Angkor Airlines (ZA)", SWT:"Swiftair",
  SWR:"Swiss International Air Lines", SWU:"Swiss European Air Lines", SWV:"Swe Fly", SXR:"Sky Express", SXS:"SunExpress",
  SYL:"Aircompany Yakutia", SYR:"Syrian Arab Airlines", SYX:"Skywalk Airlines", SZB:"Aerolineas heredas santa maria", SZZ:"SUR Lineas Aereas",
  TAE:"TAME", TAH:"Air Moorea", TAK:"Tatarstan Airlines", TAM:"TAM Brazilian Airlines", TAN:"Zanair",
  TAO:"Aeromar", TAP:"TAP Portugal", TAR:"Tunisair", TAT:"Grupo TACA", TAY:"ASL Airlines Belgium", TBZ:"TrasBrasil",
  TCF:"Shuttle America", TCG:"Thai Air Cargo", TCV:"TACV", TCW:"Thomas Cook Airlines", TCX:"Thomas Cook Airlines",
  TDK:"Transavia Denmark", TEZ:"Tez Jet Airlines", TFL:"Arkefly", TFN:"Norwegian Aviation College", TGN:"Trigana Air Service",
  TGW:"Tiger Airways Australia", TGZ:"Georgian Airways", THA:"Thai Airways International", THI:"TransHolding", THK:"Turk Hava Kurumu Hava Taksi Isletmesi",
  THS:"TransBrasil Airlines", THT:"Air Tahiti Nui", THY:"Turkish Airlines", TIB:"TRIP Linhas A", TIL:"Tajikistan International Airlines",
  TJA:"T.J. Air", TJD:"Aliserio", TJT:"Twin Jet", TKJ:"AJet", TKS:"Tomsk-Avia", TLA:"Translift Airways", TMA:"Trans Mediterranean Airlines",
  TNA:"TransAsia Airways", TNM:"Tiara Air", TNS:"Transilvania", TNU:"TransNusa Air", TOK:"Airlines PNG",
  TOM:"TUI Airways", TOS:"Tropic Air", TPA:"TAMPA", TRA:"Transavia Holland", TRK:"Turkuaz Airlines",
  TRS:"AirTran Airways", TSC:"Air Transat", TSO:"Transaero Airlines", TTZ:"Transair", TUA:"Turkmenistan Airlines",
  TUI:"TUIfly", TUR:"ATUR", TUS:"ABSA - Aerolinhas Brasileiras", TVF:"Transavia France", TVJ:"Thai Vietjet Air",
  TVS:"Travel Service", TWB:"Tway Airlines", TWD:"Turkish Wings Domestic", TWN:"Avialeasing Aviation Company", TXW:"Texas Wings",
  TYR:"Tyrolean Airways", TYS:"TransHolding System", TYW:"Tyrol Air Ambulance", UAC:"United Air Charters", UAE:"Emirates", UAL:"United Airlines",
  UAT:"Ukraine Atlantic", UAY:"University of Birmingham Air Squadron (RAF)", UBA:"Myanma Airways", UBD:"United Airways", UBG:"US-Bangla Airlines",
  UCA:"CommutAir", UDC:"DonbassAero", UDN:"Dniproavia", UEE:"Unites Eagle Airlines", UGX:"East African", UIA:"Uni Air",
  UJX:"AtlasGlobal Ukraine", UKM:"UM Airlines", UMK:"Yuzhmashavia", UPA:"Air Foyle", UPS:"UPS", URN:"Turan Air",
  USA:"US Airways", USH:"US Helicopter", UTA:"UTair Aviation", UTY:"Alliance Airlines", UWW:"LSM International ",
  UZB:"Uzbekistan Airways", VAS:"ATRAN Cargo Airlines", VAX:"V Air", VBW:"Air Burkina", VCV:"Conviasa",
  VDA:"Volga-Dnepr Airlines", VEX:"Virgin Express", VFC:"Vasco Air", VGN:"Virgin Nigeria Airways", VIA:"VIA Líneas Aéreas",
  VIM:"Air VIA", VIR:"Virgin Atlantic Airways", VIS:"Vision Air International", VJC:"VietJet Air", VJH:"VistaJet", VJT:"VistaJet", VKH:"Viking Hellas",
  VKG:"Sunclass Airlines", VKJ:"VickJet", VLE:"Volare Airlines", VLG:"Vueling Airlines", VLK:"Vladivostok Air", VLM:"VLM Airlines",
  VLO:"Varig Log", VLU:"Valuair", VNP:"Virgin Pacific", VOE:"VOLOTEA Airways", VOI:"Volaris",
  VOO:"Volotea", VOZ:"Virgin Australia", VQI:"Flyme (VP)", VRD:"Virgin America", VRN:"VRG Linhas Aereas",
  VSP:"VASP", VSV:"Scat Air", VTA:"Air Tahiti", VTI:"Air Vistara", VUE:"AD Aviation",
  VUN:"Air Ivoire", VVC:"VivaColombia", VVM:"Viva Macau", VVN:"88", VWA:"Virginwings",
  WAJ:"AirAsia Japan", WAL:"Western Airlines", WAU:"Wizz Air Ukraine", WBA:"Finncomm Airlines", WCG:"Warsaw Cargo", WEB:"WebJet Linhas A",
  WEN:"WestJet Encore", WER:"AeroWorld ", WFX:"Westfalia Express VA", WIF:"Widerøe", WJA:"WestJet",
  WLC:"Welcome Air", WMT:"WizzAir Malta", WOA:"World Airways", WON:"Wings Air", WOW:"Air Southwest", WRC:"Wind Rose Aviation",
  WSS:"World Scale Airlines", WTA:"Africa West", WTJ:"Whitejets", WUK:"Wizz Air UK", WVL:"Wizz Air Hungary", WZZ:"Wizz Air",
  XAN:"Southjet cargo", XAU:"XAIR USA", XAX:"AirAsia X", XBM:"CBM America", XEL:"Excel Charter",
  XLA:"Excel Airways", XOJ:"XOJET", XPT:"XPTO", XSR:"Executive AirShare", YCC:"Ciel Canadien",
  YCP:"Canadian National Airways", YEL:"Yellowtail", YEP:"YES Airways", YZZ:"LSM AIRLINES ", ZCS:"Southjet connect",
  ZNA:"Zenith International Airline", ZTF:"Mongolian International Air Lines ", ZTT:"ZABAIKAL AIRLINES", ZXY:"Japan Regio", ZZZ:"Zabaykalskii Airlines",
  КТК:"Катэкавиа",  
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
  try {
    const homeData = await fetchAircraft(HOME_LAT, HOME_LON, HOME_RADIUS + 5);
    for (const ac of (homeData.ac || [])) {
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
  } catch(e) { console.error(`Home poll error: ${e.message}`); }

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
        const prefix = callsign.slice(0, 3).toUpperCase();
        const airlineName = AIRLINE_NAMES[prefix] || '';
        history[chatId].push({ callsign, airline: airlineName, dist: dist.toFixed(1), dir, date: todayStr, time: timeStr, ts: now });
        if (history[chatId].length > 100) history[chatId] = history[chatId].slice(-100);
        saveJSON(HISTORY_FILE, history);

        // Telegram-Alert nur tagsüber (08:00–23:59)
        if (!isNight) {
          const airlineStr = airlineName ? ` · ${airlineName}` : '';
          const caption = `✈ <b>${callsign}</b>${airlineStr}\n${dist.toFixed(1)} nm ${dir}`;
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
// Einfacher In-Memory-Rate-Limiter pro IP (Punkt 5)
const routeHits = new Map(); // ip -> { count, windowStart }
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX       = 30; // max. 30 Route-Anfragen pro IP und Minute
function rateLimitRoute(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const rec = routeHits.get(ip);
  if (!rec || now - rec.windowStart > RL_WINDOW_MS) {
    routeHits.set(ip, { count: 1, windowStart: now });
    return next();
  }
  if (rec.count >= RL_MAX) {
    return res.status(429).json({ route: null, error: 'rate limit' });
  }
  rec.count++;
  return next();
}
// Map gelegentlich aufraeumen, damit sie nicht unbegrenzt waechst
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of routeHits) if (now - rec.windowStart > RL_WINDOW_MS) routeHits.delete(ip);
}, 5 * 60 * 1000).unref?.();

// Routen-Quellen-Schonung gegen Rate-Limit (429): negatives Caching, Drosselung, Cooldown
const NEG_TTL_MS          = 12 * 60 * 60 * 1000; // "keine Route" 12h cachen
const ROUTE_MIN_INTERVAL  = 700;                 // min. Abstand zwischen Aufrufen je Quelle (ms)
const ADSBDB_COOLDOWN_MS  = 90 * 1000;           // nach 429: 90s gar nicht anfragen
let   adsbdbCooldownUntil = 0;
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
        serverRouteCache[callsign] = { route: r1.route, ts: Date.now() };
        saveJSON(ROUTE_CACHE_FILE, serverRouteCache);
        return res.json({ route: r1.route, source: 'adsbdb' });
      }
      if (r1.rateLimited) {
        adsbdbCooldownUntil = Date.now() + ADSBDB_COOLDOWN_MS;
        console.warn(`adsbdb 429 -- Cooldown ${ADSBDB_COOLDOWN_MS / 1000}s aktiv`);
      } else {
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

app.get('/airlines', (req, res) => {
  res.json(AIRLINE_NAMES);
});

// Eigener Aircraft-Proxy als Fallback statt corsproxy.io (Punkt 7)
// Akzeptiert nur numerische Koordinaten und ruft ausschliesslich die bekannten Upstreams auf
app.get('/aircraft', rateLimitRoute, async (req, res) => {
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
routedb.initRouteDB('/data', 7).catch(e => console.warn('[routedb] init:', e.message));

app.listen(port, () => console.log(`Server running on port ${port}`));
