const express  = require('express');
const cors     = require('cors');
const https    = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN || '';
const COOLDOWN_MS   = 5 * 60 * 1000; // 5 Minuten pro Callsign pro Chat-ID
const notifiedCache = {}; // { chatId_callsign: timestamp }

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

// Endpunkt: Chat-ID ermitteln (nach /start im Bot)
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

// Endpunkt: Notification senden
app.post('/notify', async (req, res) => {
  const { chat_id, callsigns = [] } = req.body;
  if (!chat_id || !callsigns.length) return res.json({ ok: false });

  const now        = Date.now();
  const newMatches = callsigns.filter(cs =>
    now - (notifiedCache[`${chat_id}:${cs}`] || 0) > COOLDOWN_MS
  );

  console.log(`Notify [${chat_id}]: callsigns=${callsigns}, new=${newMatches}`);

  if (!newMatches.length) return res.json({ ok: true, cooldown: true });

  const text = '✈ ' + newMatches.sort().join(', ') + ' ist in deinem Radar!';
  try {
    await sendTelegramMessage(chat_id, text);
    newMatches.forEach(cs => { notifiedCache[`${chat_id}:${cs}`] = now; });
    console.log(`Telegram sent: ${text}`);
    res.json({ ok: true, notified: newMatches });
  } catch(e) {
    console.error(`Telegram error: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: !!BOT_TOKEN });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
