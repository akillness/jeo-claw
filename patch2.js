import fs from 'fs';
let rw = fs.readFileSync('claws/repo-work.ts', 'utf8');
rw = rw.replace('--model gemini-3.1-pro-low', '--provider gemini');
fs.writeFileSync('claws/repo-work.ts', rw);
