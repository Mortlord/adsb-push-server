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
const UNKNOWN_FILE    = '/data/unknowncallsigns.json';
const HB_FILE         = '/data/hbcallsigns.json';

// Heimadresse fix: Ziegelweg 11, 79100 Freiburg
const HOME_LAT    = 47.9732;
const HOME_LON    = 7.8319;
const HOME_RADIUS = 20; // nm

let userState     = loadJSON(STATE_FILE,   {});
let history       = loadJSON(HISTORY_FILE, {});
let notifiedCache = loadJSON(CACHE_FILE,   {});
let visitStats    = loadJSON(STATS_FILE,   {}); // { chatId: { callsign: count } }
// homeStats: { 'DD.MM.YYYY': { PREFIX: count } }
let homeStats         = loadJSON(HOME_STATS_FILE, {});
// unknownCallsigns: { PREFIX: [callsign, ...] }
let unknownCallsigns  = loadJSON(UNKNOWN_FILE, {});
let lastUnbekannтPrefixes = new Set(); // Prefixe, die beim letzten /unbekannt-Aufruf bekannt waren
// hbCallsigns: [callsign, ...] -- Schweizer Privatregister
let hbCallsigns       = loadJSON(HB_FILE, []);

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
  FFV:"Fly540", FHE:"Hello", FHI:"FlyHigh Airlines Ireland (FH)", FHM:"Freebird Airlines Europe", FIF:"Air Finland", FIF:"Air Finland", FIN:"Finnair",
  FIX:"Airfix Aviation", FJI:"Air Pacific", FJM:"Fly Jamaica Airways", FJO:"FlexJet", FKA:"Flying kangaroo Airline", FLB:"German Air Force - FLB",
  FLG:"Pinnacle Airlines", FLJ:"FlexJet", FLI:"Atlantic Airways", FLO:"Flexjet Operations Malta", FLT:"Flightline", FLZ:"Air Florida", FNA:"Norlandair",
  FOS:"Formosa Airlines", FOX:"FOX Linhas Aereas", FPO:"ASL Airlines France", FPT:"FlyPortugal", FRE:"Freedom Air",
  FRF:"Fleet Air International", FRL:"Freedom Airlines", FTA:"Frontier Flying Service", FVM:"Flugfelag Vestmannaeyja", FWI:"Air Caraïbes",
  FWL:"Florida West International Airways", FXI:"Air Iceland", FXX:"Felix Airways", FYH:"Flyhy Cargo Airlines", FYJ:"FLYJET",
  FZA:"Fuzhou Airlines", FZW:"Fly Africa Zimbabwe", GAC:"GlobeAir", GAI:"Moskovia Airlines", GAO:"Golden Air", GAP:"Air Philippines",
  GBA:"Gulf Air Bahrain", GBK:"Gabon Airlines", GBL:"GB Airways", GCA:"Grand Cru Airlines", GCR:"Tianjin Airlines",
  GDC:"Grand China Air", GDR:"Gadair European Airlines", GEC:"Lufthansa Cargo", GER:"German International Air Lines", GFA:"Gulf Air", GPX:"GP Aviation",
  GFG:"Georgian National Airlines", GFT:"Gulfstream International Airlines", GFY:"Greenfly", GHB:"Ghana International Airlines", GIA:"Garuda Indonesia",
  GIE:"Elysian Airlines", GIP:"Air Guinee Express", GJI:"REVA Air Ambulance", GJS:"GoJet Airlines", GLA:"Great Lakes Airlines", GLG:"Aerolineas Galapagos (Aerogal)",
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
  LRC:"LACSA", LTC:"LatCharter", LTD:"Southern Airways Express", LTE:"LTE International Airways", LTO:"LTU Austria",
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
  TAO:"Aeromar", TAP:"TAP Portugal", TAR:"Tunisair", TAT:"Grupo TACA", TBZ:"TrasBrasil",
  TCF:"Shuttle America", TCG:"Thai Air Cargo", TCV:"TACV", TCW:"Thomas Cook Airlines", TCX:"Thomas Cook Airlines",
  TDK:"Transavia Denmark", TEZ:"Tez Jet Airlines", TFL:"Arkefly", TFN:"Norwegian Aviation College", TGN:"Trigana Air Service",
  TGW:"Tiger Airways Australia", TGZ:"Georgian Airways", THA:"Thai Airways International", THI:"TransHolding", THK:"Turk Hava Kurumu Hava Taksi Isletmesi",
  THS:"TransBrasil Airlines", THT:"Air Tahiti Nui", THY:"Turkish Airlines", TIB:"TRIP Linhas A", TIL:"Tajikistan International Airlines",
  TJA:"T.J. Air", TJD:"Aliserio", TJT:"Twin Jet", TKJ:"AJet", TKS:"Tomsk-Avia", TLA:"Translift Airways", TMA:"Trans Mediterranean Airlines",
  TNA:"TransAsia Airways", TNM:"Tiara Air", TNS:"Transilvania", TNU:"TransNusa Air", TOK:"Airlines PNG",
  TOM:"TUI Airways", TOS:"Tropic Air", TPA:"TAMPA", TRA:"Transavia Holland", TRK:"Turkuaz Airlines",
  TRS:"AirTran Airways", TSC:"Air Transat", TSO:"Transaero Airlines", TTZ:"Transair", TUA:"Turkmenistan Airlines",
  TUI:"Tuninter", TUR:"ATUR", TUS:"ABSA - Aerolinhas Brasileiras", TVF:"Transavia France", TVJ:"Thai Vietjet Air",
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
  WSS:"World Scale Airlines", WTA:"Africa West", WTJ:"Whitejets", WUK:"Wizz Air UK", WVL:"Wizz Air Hungary", WMT:"Wizz Air Malta", WZZ:"Wizz Air",
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

const OWNER_CHAT_ID = '8991828124';

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
      report += `  <b>${e.callsign}</b> – ${e.dist} nm ${e.dir} (${e.time})\n`;
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
        history[chatId].push({ callsign, dist: dist.toFixed(1), dir, date: todayStr, time: timeStr, ts: now });
        if (history[chatId].length > 100) history[chatId] = history[chatId].slice(-100);
        saveJSON(HISTORY_FILE, history);

        // Telegram-Alert nur tagsüber (08:00–23:59)
        if (!isNight) {
          const text = `✈ <b>${callsign}</b> ist in deinem Radar!\n${dist.toFixed(1)} nm ${dir}`;
          await sendTelegramMessage(chatId, text);
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
  const { chat_id, lat, lon, radius, favorites, alert_radius, timezone } = req.body;
  if (!chat_id) return res.json({ ok: false });
  userState[chat_id] = { lat, lon, radius, favorites: favorites || [], alert_radius: alert_radius || 20, timezone: timezone || 'Europe/Berlin', lastSeen: Date.now() };
  saveJSON(STATE_FILE, userState);
  console.log(`Updated [${chat_id}]: favorites=${favorites}, alert=${alert_radius}`);
  res.json({ ok: true });
});

// Nutzer-Daten löschen (DSGVO Art. 17)
app.delete('/delete', (req, res) => {
  const { chat_id } = req.body;
  if (!chat_id) return res.json({ ok: false, error: 'chat_id required' });
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
  console.log(`Deleted data for ${chat_id}`);
  res.json({ ok: true, deleted });
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

  if (text === '/start') {
    const welcomeText = `✈ <b>Willkommen bei ADSB Radar!</b>

Deine Chat-ID: <code>${chatId}</code>

Trage diese Zahl in der App unter ⭐ FAVORITEN ein, um Benachrichtigungen zu aktivieren.

<b>So geht's:</b>
1. Öffne <a href="https://adsb-radar.de">adsb-radar.de</a>
2. Tippe auf ⭐ FAVORITEN
3. Füge Callsigns oder Prefixe hinzu (z.B. <b>LH</b> für alle Lufthansa-Flüge)
4. Trage deine Chat-ID ein und tippe auf Speichern

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
      reply += `<b>${e.callsign}</b> – ${e.dist} nm ${e.dir} (${e.time})\n`;
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
      const isFirstCall = lastUnbekannтPrefixes.size === 0;
      let reply = `<b>❓ Unbekannte Callsign-Gruppen</b>\n\n`;
      sorted.forEach(([p, c]) => {
        const examples = (unknownCallsigns[p] || []).slice(0, 3).join(', ');
        const isNew = !isFirstCall && !lastUnbekannтPrefixes.has(p);
        reply += `${isNew ? '🆕 ' : ''}<b>${p}</b>: ${c}x${examples ? ' – z.B. ' + examples : ''}\n`;
      });
      lastUnbekannтPrefixes = new Set(Object.keys(totals));
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

app.get('/airlines', (req, res) => {
  res.json(AIRLINE_NAMES);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
