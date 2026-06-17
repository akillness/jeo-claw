import fs from 'fs';
let code = fs.readFileSync('claws/repo-work.ts', 'utf-8');

const search = /bunx --bun gajae-code -p \$\{request\}/;
const replace = `bunx --bun gajae-code --model gemini-3.1-pro-high -p "$ooo $ralph \${request}"`;

if (!search.test(code)) {
  console.error("NOT FOUND");
  process.exit(1);
}

code = code.replace(search, replace);
fs.writeFileSync('claws/repo-work.ts', code);
console.log("PATCHED MODEL");
