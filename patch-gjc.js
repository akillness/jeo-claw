import fs from 'fs';
let code = fs.readFileSync('claws/repo-work.ts', 'utf-8');

const search = /const agentResult = await \$\`cd \$\{tempDir\} && bunx --bun gajae-code -p \$\{request\}\`\.nothrow\(\);/;

const replace = `const fakeHome = tempDir + "/.home";
    await $\`mkdir -p \${fakeHome}/.jeo\`;
    await $\`cp /root/.jeo/config.json \${fakeHome}/.jeo/config.json || true\`.nothrow();
    const agentResult = await $\`cd \${tempDir} && HOME=\${fakeHome} bunx --bun gajae-code -p \${request}\`.nothrow();`;

if (!search.test(code)) {
  console.error("NOT FOUND");
  process.exit(1);
}

code = code.replace(search, () => replace);
fs.writeFileSync('claws/repo-work.ts', code);
console.log("PATCHED GJC EXECUTION");
