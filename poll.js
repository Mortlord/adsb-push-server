const https = require('https');

const SERVER = 'web-production-a6fc8.up.railway.app';

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
  process.exit(1);
});
