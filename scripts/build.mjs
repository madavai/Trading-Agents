// Bundles each entry into one file under dist/, so a person who clones the repository runs it with no install.
import { build } from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const entries = { 'desk-tools': 'src/tools/main.ts', robinhood: 'src/robinhood/cli.ts' };

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
console.log('built', Object.keys(entries).map((n) => `dist/${n}.mjs`).join(', '));
