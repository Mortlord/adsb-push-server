const https = require('https');

const HOST = 'web-production-a6fc8.up.railway.app';
const KEY  = process.env.ADMIN_SECRET;

if (!KEY) {
  console.error('ADMIN_SECRET fehlt in der Umgebung -- Poll nicht ausgeloest.');
  process.exit(0);
}

// Key per Header statt URL-Parameter, damit er nicht in Logs landet.
const opts = { headers: { 'X-Admin-Secret': KEY } };

// Triggert den Web-Server zum Pollen -- haelt ihn dabei auch wach.
https.get(`https://${HOST}/poll`, opts, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    console.log('Poll triggered:', data);
    process.exit(0);
  });
}).on('error', e => {
  console.error('Error:', e.message);
  process.exit(0); // Kein Crash -- Timeout ist kein fataler Fehler
});
