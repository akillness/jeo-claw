const fs = require('fs');
const secret = JSON.parse(fs.readFileSync('secrets/live.json')).JEO_CONTROL_EVENT_SECRET;
fetch('http://127.0.0.1:8787/', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + secret,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({type: 'request', runtime: 'zeroclaw', instruction: '다시 테스트 진행하고 모니터링해서 개선해', repo: 'jeo-claw'})
}).then(res => res.text()).then(console.log);
