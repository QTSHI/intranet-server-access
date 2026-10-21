import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ entryPoints: [root + 'scripts/editor-source.mjs'], outfile: root + 'public/editor.mjs', bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, legalComments: 'eof', sourcemap: false });
console.log('Built self-hosted editor.');
