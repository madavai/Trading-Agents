// Bundles each entry into one file under dist/, so a person who clones the repository runs it with no install.
import { build } from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const entries = { 'desk-tools': 'src/tools/main.ts', robinhood: 'src/robinhood/cli.ts', terminal: 'src/terminal/main.ts' };

for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${name}.mjs`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    define: { __VERSION__: JSON.stringify(pkg.version) },
    banner: { js: `// Built from ${entry} by scripts/build.mjs - do not edit; change the source and run npm run build.\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);` },
    legalComments: 'eof',
    logLevel: 'warning',
  });
}

// The dashboard's page: one script, one stylesheet (the House theme, then the dashboard's own sizes), the HTML and the fonts,
// all under dist/terminal so the server reads them from beside itself and the person installs nothing.
const ui = 'src/terminal/ui', out = 'dist/terminal';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(`${out}/fonts`, { recursive: true });
await build({ entryPoints: [`${ui}/main.ts`], outfile: `${out}/app.js`, bundle: true, platform: 'browser', format: 'iife', target: 'es2022', legalComments: 'none', logLevel: 'warning' });
fs.writeFileSync(`${out}/app.css`, fs.readFileSync(`${ui}/house.css`, 'utf8') + '\n' + fs.readFileSync(`${ui}/dashboard.css`, 'utf8'));
fs.copyFileSync(`${ui}/index.html`, `${out}/index.html`);
for (const f of fs.readdirSync(`${ui}/fonts`)) fs.copyFileSync(`${ui}/fonts/${f}`, `${out}/fonts/${f}`);
console.log('built', Object.keys(entries).map((n) => `dist/${n}.mjs`).join(', '), 'and dist/terminal/');
