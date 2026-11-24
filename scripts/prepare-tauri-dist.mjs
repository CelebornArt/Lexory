import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_WWW = path.join(ROOT_DIR, 'www');
const OUT_DIST = path.join(ROOT_DIR, 'dist-web');

const KEEP_DICT_FILES = new Set(['en.txt', 'en.js', 'manifest.json', 'manifest.js']);

fs.rmSync(OUT_DIST, { recursive: true, force: true });
fs.cpSync(SRC_WWW, OUT_DIST, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(SRC_WWW, src).replace(/\\/g, '/');
    if (rel.startsWith('dictionaries/') && rel !== 'dictionaries') {
      const base = path.basename(rel);
      if (base.endsWith('.txt') && !KEEP_DICT_FILES.has(base)) {
        return false;
      }
    }
    return true;
  },
});

console.log('Prepared slim Tauri frontend dist in dist-web/ (en bundled, 13 optional dictionaries stripped).');
