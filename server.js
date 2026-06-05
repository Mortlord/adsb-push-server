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

// ICAO-Prefix -> Klarname
const AIRLINE_NAMES = {
  AAA:"Ansett Australia", AAF:"Aigle Azur", AAH:"Aloha Airlines", AAL:"American Airlines", AAN:"Amsterdam Airlines",
  AAQ:"Copterline", AAR:"Asiana Airlines", AAS:"Askari Aviation", AAW:"Afriqiyah Airways", AAY:"Allegiant Air",
  ABD:"Air Atlanta Icelandic", ABF:"Scanwings", ABI:"Aviabus", ABL:"Air Busan", ABQ:"Airblue",
  ABR:"ASL Airlines Belgium (FedEx)", ABS:"Transwest Air", ABY:"Air Arabia", ACA:"Air Canada", ACI:"Air Caledonie International",
  ACP:"Astral Aviation", ADE:"Ada Air", ADH:"Air One", ADO:"Hokkaido International Airlines", ADR:"Adria Airways",
  AEA:"Air Europa", AEB:"Aero Benin", AEE:"Aegean Airlines", AEG:"Airest", AEL:"Air Europe", AER:"Alaska Central Express",
  AES:"ACES Colombia", AEU:"Astraeus", AEW:"Aerosvit Airlines", AEY:"Air Italy", AFG:"Ariana Afghan Airlines",
  AFL:"Aeroflot Russian Airlines", AFR:"Air France", AGV:"Air Glaciers", AGX:"Aviogenex", AHO:"Air Hamburg (AHO)",
  AHY:"Azerbaijan Airlines", AIA:"Avies", AIC:"Air India Limited", AIO:"United States Air Force", AIQ:"Thai AirAsia",
  AIR:"Airlift International", AIZ:"Arkia Israel Airlines", AJM:"Air Jamaica", AJX:"Air Japan", AKA:"Air Korea Co. Ltd.",
  AKL:"Air Kiribati", ALK:"SriLankan Airlines", ALO:"Allegheny Commuter Airlines", AMC:"Air Malta", AML:"Air Malawi",
  AMT:"ATA Airlines", AMU:"Air Macau", AMV:"AMC Airlines", AMX:"AeroMéxico", ANA:"All Nippon Airways",
  ANE:"Air Nostrum", ANG:"Air Niugini", ANK:"Air Nippon", ANO:"Airnorth", ANT:"Air North Charter - Canada",
  ANU:"Andalus Lineas Aereas", ANZ:"Air New Zealand", APW:"Arrow Air", ARD:"Aerocondor", ARE:"Aires",
  ARF:"Aero Flight", ARG:"Aerolineas Argentinas", ARU:"Aruba Airlines", ASA:"Alaska Airlines", ASD:"Air Sinai",
  ASH:"Mesa Airlines", ASL:"Air Serbia", ASQ:"Atlantic Southeast Airlines", ASZ:"Astrakhan Airlines", ATC:"Air Tanzania",
  ATM:"Airlines Of Tasmania", AUA:"Austrian Airlines", AUB:"Augsburg Airways", AUH:"Abu Dhabi Amiri Flight", AUI:"Ukraine International Airlines",
  AUL:"Aeroflot-Nord", AUR:"Aurigny Air Services", AUT:"Austral Lineas Aereas", AVA:"Avianca - Aerovias Nacionales de Colombia", AVN:"Air Vanuatu",
  AWA:"Asia Wings", AWE:"America West Airlines", AWH:"Aerowest", AWI:"Air Wisconsin", AWM:"Asian Wings Airways", AWQ:"Indonesia AirAsia",
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
  BZH:"Brit Air", CAI:"Corendon Airlines", CAL:"China Airlines", CAN:"Crest Aviation", CAP:"CanXplorer",
  CAW:"Comair", CAY:"Cayman Airways", CBG:"GX Airlines", CCA:"Air China", CCB:"CARICOM AIRWAYS (BARBADOS) INC.",
  CCC:"CCML Airlines", CCG:"Central Connect Airlines", CCM:"Corse-Mediterranee", CDG:"Shandong Airlines", CDN:"Canadian Airlines",
  CDP:"Aero Condor Peru", CEB:"Cebu Pacific", CEL:"CEIBA Intercontinental", CEO:"Comfort Express Virtual Charters", CES:"China Eastern Airlines",
  CEY:"Air Century", CFE:"BA CityFlyer", CFG:"Condor Flugdienst", CGK:"Click Airways", CGP:"Cargo Plus Aviation",
  CHB:"West Air China", CHH:"Hainan Airlines", CHP:"Consorcio Aviaxsa", CHQ:"Chautauqua Airlines", CHW:"Charter Air",
  CHX:"Luftrettung", CIF:"CB Airways UK ( Interliging Flights )", CIM:"Cimber Air", CIX:"City Connexion Airlines", CJC:"Colgan Air",
  CLH:"Lufthansa CityLine", CLI:"Calima Aviacion", CLJ:"Cello Aviation", CLW:"Centralwings", CMI:"Continental Micronesia",
  CMA:"CMG Air Cargo", CMP:"Copa Airlines", CNF:"Canaryfly", CNO:"SAS Braathens", COA:"Continental Airlines", COE:"Comtel Air",
  COM:"Comair", CPA:"Cathay Pacific", CPN:"Caspian Airlines", CPZ:"Compass Airlines", CQH:"Spring Airlines",
  CQN:"Chongqing Airlines", CRK:"Hong Kong Airlines", CRL:"Corsairfly", CRO:"Crown Airways", CSA:"Czech Airlines",
  CSC:"Sichuan Airlines", CSH:"Shanghai Airlines", CSN:"China Southern Airlines", CSW:"Chair Airlines", CSX:"Choice Airways", CSZ:"Shenzhen Airlines",
  CTN:"Croatia Airlines", CUA:"China United Airlines", CUB:"Cubana de Aviación", CUD:"Air Cudlua", CVA:"Air Chathams",
  CWK:"Comores Airlines", CWM:"Air Marshall Islands", CXA:"Xiamen Airlines", CYD:"Access Air", CYH:"Yunnan Airlines",
  CYP:"Cyprus Airways", CZV:"Via Conectia Airlines", DAH:"Air Algerie", DAK:"First Flying", DAL:"Delta Air Lines",
  DAO:"Daallo Airlines", DAT:"Brussels Airlines", DBK:"Dubrovnik Air", DCD:"Air 26", DEA:"Delta Aerotaxi",
  DHI:"Adam Air", DJB:"Djibouti Airlines", DKH:"Juneyao Airlines", DLA:"Air Dolomiti", DLH:"Lufthansa",
  DME:"Royal Flight", DMO:"Domodedovo Airlines", DNL:"Dutch Antilles Express", DNM:"Denim Air", DNV:"Aeroflot-Don",
  DOA:"Dominicana de Aviaci", DOB:"Dobrolet", DRD:"Air Madrid", DRK:"Druk Air", DRU:"Alrosa Mirny Air Enterprise",
  DSM:"LAN Argentina", DSV:"Direct Aero Services", DSY:"Dennis Sky", DTA:"TAAG Angola Airlines", DTR:"DAT Danish Air Transport",
  DWA:"Dense Airways", DWT:"Darwin Airline", DYA:"Dynamic Airways", EAA:"Eastok Avia", EAL:"European Air Express",
  EAV:"Eastern Atlantic Virtual Airlines", ECA:"Eurocypria Airlines", ECU:"Ecuavia", EDW:"Edelweiss Air", EEA:"Empresa Ecuatoriana De Aviacion",
  EEU:"Eurofly Service", EFA:"Far Eastern Air Transport", EFY:"EasyFly", EGF:"American Eagle Airlines", EGH:"BBN-Airways",
  EGS:"Eagles Airlines", EHN:"East Horizon", EIA:"Evergreen International Airlines", EIN:"Aer Lingus", EJA:"NetJets", EJU:"easyJet Europe",
  ELA:"Eastland Air", ELC:"Small Planet Airlines", ELK:"ELK Airways", ELL:"Estonian Air", ELO:"Eurolot",
  ELY:"El Al Israel Airlines", ENJ:"Enerjet", ENY:"Envoy Air", ENZ:"Jota Aviation", ERO:"Sun D'Or",
  ERR:"Era Alaska", ERT:"Eritrean Airlines", ESK:"SkyEurope", ESR:"Eastar Jet", ETD:"Etihad Airways",
  ETH:"Ethiopian Airlines", EUD:"Air Italy Egypt", EUV:"EuropeSky", EVA:"EVA Air", EVC:"Comfort Express Virtual Charters Albany",
  EWG:"Eurowings", EXS:"Jet2.com", EZA:"Eznis Airways", EZE:"Eastern Airways", EZS:"easyJet Switzerland", EZY:"easyJet",
  FAB:"First Air", FBL:"Fly Brasil", FCA:"First Choice Airways", FCB:"COBALT", FCM:"Flybe Finland Oy",
  FDB:"Fly Dubai", FDD:"Feeder Airlines", FEG:"FlyEgypt", FFM:"Firefly", FFT:"Frontier Airlines",
  FFV:"Fly540", FHE:"Hello", FHI:"FlyHigh Airlines Ireland (FH)", FIF:"Air Finland", FIN:"Finnair",
  FIX:"Airfix Aviation", FJI:"Air Pacific", FJM:"Fly Jamaica Airways", FKA:"Flying kangaroo Airline", FLB:"German Air Force - FLB",
  FLG:"Pinnacle Airlines", FLI:"Atlantic Airways", FLO:"Flexjet Operations Malta", FLT:"Flightline", FLZ:"Air Florida", FNA:"Norlandair",
  FOS:"Formosa Airlines", FOX:"FOX Linhas Aereas", FPO:"ASL Airlines France", FPT:"FlyPortugal", FRE:"Freedom Air",
  FRF:"Fleet Air International", FRL:"Freedom Airlines", FTA:"Frontier Flying Service", FVM:"Flugfelag Vestmannaeyja", FWI:"Air Caraïbes",
  FWL:"Florida West International Airways", FXI:"Air Iceland", FXX:"Felix Airways", FYH:"Flyhy Cargo Airlines", FYJ:"FLYJET",
  FZA:"Fuzhou Airlines", FZW:"Fly Africa Zimbabwe", GAC:"GlobeAir", GAI:"Moskovia Airlines", GAO:"Golden Air", GAP:"Air Philippines",
  GBA:"Gulf Air Bahrain", GBK:"Gabon Airlines", GBL:"GB Airways", GCA:"Grand Cru Airlines", GCR:"Tianjin Airlines",
  GDC:"Grand China Air", GDR:"Gadair European Airlines", GEC:"Lufthansa Cargo", GER:"German International Air Lines", GFA:"Gulf Air", GPX:"GP Aviation",
  GFG:"Georgian National Airlines", GFT:"Gulfstream International Airlines", GFY:"Greenfly", GHB:"Ghana International Airlines", GIA:"Garuda Indonesia",
  GIE:"Elysian Airlines", GIP:"Air Guinee Express", GJS:"GoJet Airlines", GLA:"Great Lakes Airlines", GLG:"Aerolineas Galapagos (Aerogal)",
  GLO:"Gol Transportes Aéreos", GLP:"Globus", GMI:"Germania", GMR:"Golden Myanmar Airlines", GNN:"Georgian International Airlines",
  GOW:"Go Air", GRL:"Air Greenland", GSM:"Flyglobespan", GTA:"City Airways", GTI:"Atlas Air",
  GUY:"Air Guyane", GWI:"Germanwings", GWY:"USA3000 Airlines", GXG:"GermanXL", GZP:"Gazpromavia",
  HAG:"Hageland Aviation Services", HAL:"Hawaiian Airlines", HAM:"Haiti Ambassador Airlines", HAY:"Hamburg Airways", HBH:"Hebei Airlines",
  HBR:"Hebradran Air Services", HCC:"Holidays Czech Airlines", HCW:"Star1 Airlines", HDA:"Dragonair", HEJ:"Hellas Jet",
  HER:"Hex'Air", HFR:"Heli France", HHI:"Hamburg International", HKE:"Hong Kong Express Airways", HLF:"Hapagfly",
  HLX:"TUIfly", HMR:"North American Charters", HNX:"Hankook Airline", HPY:"Happy Air", HRM:"Hermes Airlines",
  HSK:"Sky Europe Airlines", HTH:"Helitt Líneas Aéreas", HVK:"Turkish Air Force", HVN:"Vietnam Airlines", HWY:"Highland Airways",
  HYM:"Himalayan Airlines", HZA:"Horizon Airlines", IAA:"Indonesian Airlines", IAC:"Indian Airlines", IAM:"Aeronautica Militare",
  IAW:"Iraqi Airways", IBB:"Binter Canarias", IBE:"Iberia Airlines", IBK:"Norwegian Air International (D8)", IBS:"Iberia Express",
  IBU:"Indigo", IBX:"Ibex Airlines", ICE:"Icelandair", ICL:"CAL Cargo Air Lines", ICV:"Cargolux Italia", IDS:"Indonesia Sky",
  IDX:"Indonesa Air Aisa X", IGO:"IndiGo Airlines", IIA:"AIR INDOCHINE", IIR:"INAVIA Internacional", IKA:"Itek Air",
  ILN:"Interair South Africa", IMP:"Hellenic Imperial Airways", INE:"International Europe", IPV:"Parmiss Airlines (IPV)", IRA:"Iran Air",
  IRC:"Iran Aseman Airlines", IRK:"Kish Air", IRM:"Mahan Air", ISK:"Intersky", ISR:"Israir",
  ISS:"Meridiana", ISV:"Islena De Inversiones", ISW:"Islas Airways", ISX:"Island Spirit", ITY:"ITA Airways", ITK:"Interlink Airlines",
  ITX:"Imair Airlines", IWA:"Apache Air", IWD:"Iberworld", IXO:"OCEAN AIR CARGO", IYE:"Yemenia",
  JAA:"Japan Asia Airways", JAB:"Air Bagan", JAF:"Jetairfly", JAI:"Jet Airways", JAL:"Japan Airlines Domestic",
  JAS:"Japan Air System", JAZ:"JALways", JBA:"Helijet", JBU:"JetBlue Airways", JEF:"Jetflite",
  JET:"Wind Jet", JEX:"JAL Express", JFU:"Jet4You", JGN:"Jagson Airlines", JJA:"Jeju Air",
  JJP:"Jetstar Japan ", JKK:"Spanair", JNA:"Jin Air", JOR:"Blue Air", JOY:"Joy Air",
  JPU:"Jupiter Airlines", JRB:"Jc royal.britannica", JSA:"Jetstar Asia Airways", JSR:"Jusur airways", JST:"Jetstar Airways",
  JTA:"Japan Transocean Air", JTO:"Jettor Airlines", JZA:"Air Canada Jazz", JZR:"Jazeera Airways", KAC:"Kuwait Airways",
  KAL:"Korean Air", KAP:"Cape Air", KBR:"KoralBlue Airlines", KBZ:"Air KBZ", KCU:"Skyline Ulasim Ticaret A.S.",
  KDA:"Kendell Airlines", KEA:"Korea Express Air", KEN:"Kenmore Air", KFR:"Kingfisher Airlines", KGL:"Kogalymavia Air Company",
  KGO:"Korongo Airlines", KHB:"Dalavia", KHK:"Kharkiv Airlines", KIL:"Kuban Airlines", KIN:"Kinloss Flying Training Unit",
  KIS:"Contact Air", KJC:"Krasnojarsky Airlines", KKK:"Atlasjet", KLC:"KLM Cityhopper", KLM:"KLM Royal Dutch Airlines",
  KLS:"Kal Star Aviation", KMF:"Kam Air", KND:"Kan Air", KNE:"Nas Air", KNI:"KD Avia",
  KOL:"SOCHI AIR", KOQ:"Kostromskie avialinii", KOR:"Air Koryo", KQA:"Kenya Airways", KRP:"Carpatair",
  KRY:"Russkie Krylya", KSM:"Kosmos", KSY:"KSY", KSZ:"Sunrise Airways", KUH:"Kush Air",
  KYA:"Alghanim", KZK:"Air Kazakhstan", KZR:"Air Astana", KZU:"Kuzu Airlines Cargo", LAA:"Libyan Arab Airlines",
  LAJ:"British Mediterranean Airways", LAM:"Linhas A", LAN:"LAN Airlines", LAO:"Lao Airlines", LAP:"TAM Mercosur",
  LAV:"AlbaStar", LBC:"Albanian Airlines", LBL:"Line Blue", LBT:"Nouvel Air Tunisie", LDA:"Lauda Air",
  LFA:"Air Alfa", LGL:"Luxair", LGW:"Luftfahrtgesellschaft Walter", LHN:"Express One International", LIA:"Leeward Islands Air Transport",
  LIL:"FlyLal", LIX:"LionXpress", LJJ:"Luchsh Airlines ", LLC:"FlyLAL Charters", LLM:"Yamal Airlines",
  LMM:"LCM AIRLINES", LMU:"AlMasria Universal Airlines", LNE:"Aerolane", LNI:"Lion Mentari Airlines", LOC:"Locair",
  LOF:"Trans States Airlines", LOO:"LSM Airlines", LOT:"LOT Polish Airlines", LPE:"LAN Peru", LPR:"L",
  LRC:"LACSA", LTC:"LatCharter", LTD:"Southern Airways Express", LTE:"LTE International Airways", LTO:"LTU Austria",
  LTR:"Lufttransport", LTU:"Air Lituanica", LTY:"Liberty Airways", LUR:"Atlantis European Airways", LXP:"LAN Express",
  LXR:"Air Luxor", LZB:"Bulgaria Air", MAA:"MasAir", MAC:"Malta Air Charter", MAH:"Malév",
  MAI:"Mauritania Airlines International", MAK:"MAT Macedonian Airlines", MAL:"Morningstar Air Express", MAS:"Malaysia Airlines", MAU:"Air Mauritius",
  MAV:"Maldivo Airlines", MBU:"Marabu Airlines", MCA:"MCA Airlines", MCK:"Macair Airlines", MDA:"Mandarin Airlines", MDG:"Air Madagascar",
  MDL:"Mandala Airlines", MDO:"Domenican Airlines", MDP:"Medallion Air", MDV:"Moldavian Airlines", MDW:"Midway Airlines",
  MEA:"Middle East Airlines", MEP:"Midwest Airlines", MES:"Mesaba Airlines", MGL:"MIAT Mongolian Airlines", MGX:"Montenegro Airlines",
  MIC:"Mint Airways", MJG:"Michael Airlines", MJP:"Air Majoro", MJX:"Euroline", MKD:"MAT Airways",
  MKG:"Air Mekong", MKU:"Island Air (WP)", MLA:"40-Mile Air", MLD:"Air Moldova", MMM:"Myanmar Airways International",
  MNA:"Merpati Nusantara Airlines", MNB:"MNG Airlines", MNO:"Mango", MNP:"Spirit of Manila Airlines", MON:"Monarch Airlines",
  MOV:"VIM Airlines", MPD:"Air Plus Comet", MPE:"Canadian North", MPH:"Martinair", MRS:"Marusya Airways",
  MSE:"EgyptAir Express", MSI:"Motor Sich", MSR:"Egyptair", MTW:"Mauritania Airways", MVD:"Kavminvodyavia",
  MWA:"Midwest Airlines (Egypt)", MWI:"Malaysia Wings", MXA:"Mexicana de Aviaci", MXD:"Malindo Air", MXI:"MexicanaLink",
  MXL:"Maxair", MYA:"Myflug", MYD:"Maya Island Air", MYP:"Mann Yadanarpon Airlines", MYT:"MyTravel Airways",
  NAK:"Arik Niger", NAS:"Nasair", NAX:"Norwegian Air Shuttle", NCF:"Norfolk County Flight College", NCR:"National Air Cargo",
  NDC:"FlyNordic", NDN:"Transportes Aereos Cielos Andinos", NEA:"New England Airlines", NGB:"Nordic Global Airlines", NIA:"Nile Air",
  NIG:"Aero Contractors", NJS:"National Jet Systems", NKF:"Barents AirLink", NKS:"Spirit Airlines", NLH:"Norwegian Long Haul AS",
  NLY:"Niki", NMA:"Nesma Airlines", NMB:"Air Namibia", NMI:"Pacific Wings", NOK:"Nok Air",
  NSE:"SATENA", NSZ:"Norwegian Air Sweden", NTJ:"NextJet", NTM:"North American Airlines", NTW:"Nationwide Airlines",
  NVR:"Novair", NWA:"Northwest Airlines", NXB:"NEXT Brasil", NYT:"Yeti Airlines ", OAB:"Orbit Airlines Azerbaijan",
  OAE:"Omni Air International", OAI:"Orbit International Airlines", OAL:"Olympic Airlines", OAN:"Orbit Atlantic Airways", OAR:"Orbit Regional Airlines",
  OAW:"Helvetic Airways", OBS:"Orbest", OBT:"Orbit Airlines", OCA:"Aserca Airlines", OCN:"Discover Airlines",
  OEA:"Orient Thai Airlines", OGN:"Origin Pacific Airways", OHK:"Oasis Hong Kong Airlines", OHY:"Onur Air", OLA:"Overland Airways",
  OLS:"Sol Lineas Aereas", OLT:"Ostfriesische Lufttransport", OMA:"Oman Air", OME:"Homer Air", ONE:"Oceanair",
  OOM:"Zoom Airlines", ORB:"Orenburg Airlines", ORC:"Orchid Airlines", ORG:"Orenburzhie", OTG:"One Two Go Airlines",
  OTJ:"Fly Romania", OZJ:"Ozjet Airlines", OZW:"Skywest Airlines", PAL:"Philippine Airlines", PAO:"Polynesian Airlines",
  PBA:"PB Air", PBD:"Pobeda", PCO:"Pacific Coastal Airline", PDC:"Potomac Air", PDT:"Piedmont Airlines (1948-1989)",
  PEC:"Pacific East Asia Cargo Airlines", PEL:"Aeropelican Air Services", PEN:"Peninsula Airways", PFL:"Pacific Flier", PGA:"Portugalia",
  PGT:"Pegasus Airlines", PIA:"Pakistan International Airlines", PIC:"Jetstar Pacific", PKV:"Псковавиа", PLI:"Aeroper",
  PLR:"Northwestern Air", PMT:"PMTair", PMW:"Paramount Airways", PNR:"PAN Air", POE:"Porter Airlines",
  POT:"Polet", PPL:"Air Pegasus", PPW:"Royal Phnom Penh Airways", PQW:"PanAm World Airways", PRF:"Precision Air",
  PSA:"Pacific Island Aviation", PSB:"Syrian Pearl Airlines", PTB:"Passaredo Transportes Aereos", PTI:"Privatair", PUA:"PLUNA",
  PYA:"Pouya Air", PYB:"All America BOPY", PZY:"Zapolyarie Airlines", QAX:"QatXpress", QER:"SOCHI AIR CHATER",
  QFA:"Qantas", QFZ:"Fars Air Qeshm", QQQ:"ENTERair", QTR:"Qatar Airways", QXE:"Horizon Air",
  RAB:"Rainbow Air (RAI)", RAC:"Royal Air Cambodge", RAE:"Régional", RAM:"Royal Air Maroc", RAR:"Air Rarotonga",
  RAW:"Royal Airways", RAY:"Rainbow Air Canada", RBA:"Royal Brunei Airlines", RBG:"Air Arabia Egypt", RBY:"Vision Airlines (V2)",
  REA:"Aer Arann", REP:"Regional Paraguaya", REU:"Air Austral", RFJ:"Royal Falcon", RGA:"REGA Swiss Air-Rescue",
  RGG:"TransRussiaAirlines", RIT:"Asian Spirit", RJA:"Royal Jordanian", RJD:"Rotana Jet", RKA:"Air Afrique",
  RLA:"Airlinair", RLN:"Aero Lanka", RLU:"Rusline", RLX:"Go2Sky", RMK:"Simrik Airlines",
  RNA:"Royal Nepal Airlines", RNE:"Air Salone", RNV:"Armavia", RNX:"1Time Airline", RNY:"Rainbow Air US",
  RON:"Nauru Air Corporation", ROT:"Tarom", RPA:"Republic Airlines", RPB:"AeroRep", RPH:"Republic Express Airlines",
  RPO:"Rainbow Air Polynesia", RRJ:"AirRussia", RSD:"Russia State Transport", RSH:"Air Sahara", RSI:"Air Sunshine",
  RSJ:"RusJet", RSP:"Jet Suite", RSR:"Aero-Service", RSU:"Aerosur", RSY:"I-Fly",
  RTE:"Aeronorte", RUE:"Rainbow Air Euro", RUS:"Cirrus Airlines", RWD:"Rwandair Express", RWW:"Fly Europa",
  RWZ:"Red Wings", RXA:"Regional Express", RXR:"REXAIR VIRTUEL", RYA:"Ryan Air Services", RYN:"Ryan International Airlines",
  RYR:"Ryanair", RZO:"SATA International", SAA:"South African Airways", SAE:"SOCHI AIR EXPRESS", SAI:"Shaheen Air International",
  SAL:"Spike Airlines", SAS:"Scandinavian Airlines System", SAT:"SATA Air Acores", SAY:"ScotAirways", SBD:"Snowbird Airlines",
  SBI:"S7 Airlines", SBS:"Seaborne Airlines", SCE:"Scenic Airlines", SCO:"Scoot", SCW:"Malmö Aviation",
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
  SRN:"Sprint Air", SRQ:"South East Asian Airlines", SRY:"ViaAir", SSA:"All America US", SSV:"Skyservice Airlines",
  STP:"STP Airways", STU:"Servicios de Transportes A", SUD:"Sudan Airways", SUW:"Interavia Airlines", SVA:"Saudi Arabian Airlines",
  SVG:"SVG Air", SVR:"Ural Airlines", SWA:"Southwest Airlines", SWD:"Southern Winds Airlines", SWM:"Sky Angkor Airlines (ZA)", SWT:"Swiftair",
  SWR:"Swiss International Air Lines", SWU:"Swiss European Air Lines", SWV:"Swe Fly", SXR:"Sky Express", SXS:"SunExpress",
  SYL:"Aircompany Yakutia", SYR:"Syrian Arab Airlines", SYX:"Skywalk Airlines", SZB:"Aerolineas heredas santa maria", SZZ:"SUR Lineas Aereas",
  TAE:"TAME", TAH:"Air Moorea", TAK:"Tatarstan Airlines", TAM:"TAM Brazilian Airlines", TAN:"Zanair",
  TAO:"Aeromar", TAP:"TAP Portugal", TAR:"Tunisair", TAT:"Grupo TACA", TBZ:"TrasBrasil",
  TCF:"Shuttle America", TCG:"Thai Air Cargo", TCV:"TACV", TCW:"Thomas Cook Airlines", TCX:"Thomas Cook Airlines",
  TDK:"Transavia Denmark", TEZ:"Tez Jet Airlines", TFL:"Arkefly", TFN:"Norwegian Aviation College", TGN:"Trigana Air Service",
  TGW:"Tiger Airways Australia", TGZ:"Georgian Airways", THA:"Thai Airways International", THI:"TransHolding", THK:"Turk Hava Kurumu Hava Taksi Isletmesi",
  THS:"TransBrasil Airlines", THT:"Air Tahiti Nui", THY:"Turkish Airlines", TIB:"TRIP Linhas A", TIL:"Tajikistan International Airlines",
  TJA:"T.J. Air", TJT:"Twin Jet", TKJ:"AJet", TKS:"Tomsk-Avia", TLA:"Translift Airways", TMA:"Trans Mediterranean Airlines",
  TNA:"TransAsia Airways", TNM:"Tiara Air", TNS:"Transilvania", TNU:"TransNusa Air", TOK:"Airlines PNG",
  TOM:"TUI Airways", TOS:"Tropic Air", TPA:"TAMPA", TRA:"Transavia Holland", TRK:"Turkuaz Airlines",
  TRS:"AirTran Airways", TSC:"Air Transat", TSO:"Transaero Airlines", TTZ:"Transair", TUA:"Turkmenistan Airlines",
  TUI:"Tuninter", TUR:"ATUR", TUS:"ABSA - Aerolinhas Brasileiras", TVF:"Transavia France", TVJ:"Thai Vietjet Air",
  TVS:"Travel Service", TWB:"Tway Airlines", TWD:"Turkish Wings Domestic", TWN:"Avialeasing Aviation Company", TXW:"Texas Wings",
  TYR:"Tyrolean Airways", TYS:"TransHolding System", UAC:"United Air Charters", UAE:"Emirates", UAL:"United Airlines",
  UAT:"Ukraine Atlantic", UAY:"University of Birmingham Air Squadron (RAF)", UBA:"Myanma Airways", UBD:"United Airways", UBG:"US-Bangla Airlines",
  UCA:"CommutAir", UDC:"DonbassAero", UDN:"Dniproavia", UGX:"East African", UIA:"Uni Air",
  UJX:"AtlasGlobal Ukraine", UKM:"UM Airlines", UMK:"Yuzhmashavia", UPA:"Air Foyle", URN:"Turan Air",
  USA:"US Airways", USH:"US Helicopter", UTA:"UTair Aviation", UTY:"Alliance Airlines", UWW:"LSM International ",
  UZB:"Uzbekistan Airways", VAS:"ATRAN Cargo Airlines", VAX:"V Air", VBW:"Air Burkina", VCV:"Conviasa",
  VDA:"Volga-Dnepr Airlines", VEX:"Virgin Express", VFC:"Vasco Air", VGN:"Virgin Nigeria Airways", VIA:"VIA Líneas Aéreas",
  VIM:"Air VIA", VIR:"Virgin Atlantic Airways", VIS:"Vision Air International", VJC:"VietJet Air", VJT:"VistaJet", VKH:"Viking Hellas",
  VKG:"Sunclass Airlines", VKJ:"VickJet", VLE:"Volare Airlines", VLG:"Vueling Airlines", VLK:"Vladivostok Air", VLM:"VLM Airlines",
  VLO:"Varig Log", VLU:"Valuair", VNP:"Virgin Pacific", VOE:"VOLOTEA Airways", VOI:"Volaris",
  VOO:"Volotea", VOZ:"Virgin Australia", VQI:"Flyme (VP)", VRD:"Virgin America", VRN:"VRG Linhas Aereas",
  VSP:"VASP", VSV:"Scat Air", VTA:"Air Tahiti", VTI:"Air Vistara", VUE:"AD Aviation",
  VUN:"Air Ivoire", VVC:"VivaColombia", VVM:"Viva Macau", VVN:"88", VWA:"Virginwings",
  WAJ:"AirAsia Japan", WAL:"Western Airlines", WAU:"Wizz Air Ukraine", WBA:"Finncomm Airlines", WEB:"WebJet Linhas A",
  WEN:"WestJet Encore", WER:"AeroWorld ", WFX:"Westfalia Express VA", WIF:"Widerøe", WJA:"WestJet",
  WLC:"Welcome Air", WOA:"World Airways", WON:"Wings Air", WOW:"Air Southwest", WRC:"Wind Rose Aviation",
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
      if (!/\d/.test(callsign)) continue;           // keine Ziffern = Privatmaschine
      if (/^N\d/.test(callsign)) continue;           // US-Register (N358MM etc.)
      const homeKey = `home:${callsign}`;
      if (now - (notifiedCache[homeKey] || 0) < COOLDOWN_MS) continue;
      notifiedCache[homeKey] = now;
      if (!homeStats[todayStr]) homeStats[todayStr] = {};
      homeStats[todayStr][prefix] = (homeStats[todayStr][prefix] || 0) + 1;

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

  if (text.startsWith('/unbekannt')) {
    try {
      // Alle Prefixe aus homeStats sammeln und gegen AIRLINE_NAMES prüfen
      const totals = {};
      for (const dayData of Object.values(homeStats)) {
        for (const [p, c] of Object.entries(dayData)) {
          if (!AIRLINE_NAMES[p]) totals[p] = (totals[p] || 0) + c;
        }
      }
      if (!Object.keys(totals).length) {
        await sendTelegramMessage(chatId, 'Alle Prefixe sind bekannt.');
        return res.json({ ok: true });
      }
      const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
      let reply = `<b>❓ Unbekannte Callsign-Gruppen</b>\n\n`;
      sorted.forEach(([p, c]) => {
        const examples = (unknownCallsigns[p] || []).slice(0, 3).join(', ');
        reply += `<b>${p}</b>: ${c}x${examples ? ' – z.B. ' + examples : ''}\n`;
      });
      await sendTelegramMessage(chatId, reply);
    } catch(e) {
      await sendTelegramMessage(chatId, 'Fehler beim Erstellen des Berichts.');
      console.error('unbekannt error:', e.message);
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
