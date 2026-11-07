import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const at = (path) => new URL(path, import.meta.url);
const read = (path) => readFileSync(at(path), 'utf8');
const core = read('../src/core.js');
const snippet = read('../src/snippet.js').replace(/^import .*\n/gm, '');
const bundle = (extension) => `(() => {\nconst EXTENSION = ${extension};\n${core.replace(/^export /gm, '')}\n${snippet}})();\n`;

mkdirSync(at('../dist/'), { recursive: true });
mkdirSync(at('../extension/vendor/'), { recursive: true });
writeFileSync(at('../dist/3d-inspector.js'), bundle(false));
writeFileSync(at('../extension/inspector.js'), bundle(true));
writeFileSync(at('../extension/core.js'), core);
['acorn', 'astring'].forEach((name) => {
  copyFileSync(at(`../node_modules/${name}/dist/${name}.mjs`), at(`../extension/vendor/${name}.js`));
  copyFileSync(at(`../node_modules/${name}/LICENSE`), at(`../extension/vendor/${name}.LICENSE`));
});
