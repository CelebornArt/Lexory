import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const KEEP_FILES = new Set(['en.txt', 'en.js', 'manifest.json', 'manifest.js']);

function stripDir(targetDir) {
  if (!fs.existsSync(targetDir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(targetDir)) {
    if (!KEEP_FILES.has(name) && name.endsWith('.txt')) {
      fs.unlinkSync(path.join(targetDir, name));
      removed += 1;
    }
  }
  return removed;
}

const androidDictDir = path.join(ROOT_DIR, 'android', 'app', 'src', 'main', 'assets', 'public', 'dictionaries');
const removedAndroid = stripDir(androidDictDir);
console.log(`Stripped ${removedAndroid} optional dictionary files from Android assets (kept en only).`);
