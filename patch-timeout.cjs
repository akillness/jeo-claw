const fs = require('fs');
let code = fs.readFileSync('discord/bot.ts', 'utf-8');
code = code.replace(/const DEFAULT_CONTROL_EVENT_TIMEOUT_MS = 2_500;/g, 'const DEFAULT_CONTROL_EVENT_TIMEOUT_MS = 15_000;');
fs.writeFileSync('discord/bot.ts', code);
