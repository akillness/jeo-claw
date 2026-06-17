const fs = require('fs');
const d = JSON.parse(fs.readFileSync('secrets/live.json', 'utf8'));
console.log(d['github-token-rw']);
