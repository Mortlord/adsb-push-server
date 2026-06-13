const https = require('https');

const SERVER = 'web-production-a6fc8.up.railway.app/poll?key=a2ddffc9de2594279918e76cddac5f2f0ba5829fdb47db93';

// Triggert den Web-Server zum Pollen -- hält ihn dabei auch wach
https.get(`https://${SERVER}/poll`, res => {
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
