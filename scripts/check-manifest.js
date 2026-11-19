const fs = require('fs');
const zlib = require('zlib');
const path = 'd:/gemini antigravity chrome extension/cws_build/manifest.json';
const content = fs.readFileSync(path, 'utf8');
const parsed = JSON.parse(content);
console.log('Has key field:', 'key' in parsed);
console.log('Manifest name:', parsed.name);
console.log('Manifest version:', parsed.version);
