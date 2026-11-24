import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'www', 'dictionaries');
const CACHE_DIR = path.join(ROOT_DIR, '.dict-cache');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

function mapEncoding(setVal) {
  if (!setVal) return 'utf-8';
  const norm = setVal.trim().toLowerCase();
  if (norm === 'utf-8' || norm === 'utf8') return 'utf-8';
  if (norm === 'iso8859-1' || norm === 'iso-8859-1' || norm === 'latin1') return 'iso-8859-1';
  if (norm === 'iso8859-2' || norm === 'iso-8859-2') return 'iso-8859-2';
  if (norm === 'iso8859-7' || norm === 'iso-8859-7') return 'iso-8859-7';
  if (norm === 'iso8859-15' || norm === 'iso-8859-15') return 'iso-8859-15';
  if (norm === 'cp1251' || norm === 'windows-1251') return 'windows-1251';
  if (norm === 'koi8-r') return 'koi8-r';
  return norm;
}

async function fetchCached(url, filename) {
  const cachedPath = path.join(CACHE_DIR, filename);
  if (fs.existsSync(cachedPath)) {
    return fs.readFileSync(cachedPath);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(cachedPath, buf);
  return buf;
}

function decodeBuffer(buf, encoding) {
  if (encoding === 'utf-8') {
    const utf = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (!utf.includes('\uFFFD')) return utf;
    return new TextDecoder('iso-8859-1').decode(buf);
  }
  return new TextDecoder(encoding).decode(buf);
}

function parseFlags(flagStr, flagMode) {
  if (!flagStr) return [];
  if (flagMode === 'long') {
    const res = [];
    for (let i = 0; i + 1 < flagStr.length; i += 2) {
      res.push(flagStr.slice(i, i + 2));
    }
    return res;
  }
  if (flagMode === 'num') {
    return flagStr.split(',').filter(Boolean);
  }
  return Array.from(flagStr);
}

function parseAff(affText) {
  const lines = affText.split(/\r?\n/);
  let flagMode = 'char';
  let encoding = null;
  const skipStandaloneFlags = new Set();
  const forbiddenFlags = new Set();
  const pfxRules = new Map();
  const sfxRules = new Map();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const cmd = parts[0];

    if (cmd === 'SET' && parts[1]) {
      encoding = mapEncoding(parts[1]);
    } else if (cmd === 'FLAG' && parts[1]) {
      const m = parts[1].toLowerCase();
      if (m === 'long' || m === 'num' || m === 'utf-8') {
        flagMode = m;
      }
    } else if ((cmd === 'NEEDAFFIX' || cmd === 'ONLYINCOMPOUND') && parts[1]) {
      skipStandaloneFlags.add(parts[1]);
    } else if (cmd === 'FORBIDDENWORD' && parts[1]) {
      forbiddenFlags.add(parts[1]);
    } else if ((cmd === 'PFX' || cmd === 'SFX') && parts.length >= 4) {
      const flag = parts[1];
      const map = cmd === 'PFX' ? pfxRules : sfxRules;
      // Header line: PFX flag Y/N count
      if (parts.length === 4 && (parts[2] === 'Y' || parts[2] === 'N') && /^\d+$/.test(parts[3])) {
        if (!map.has(flag)) {
          map.set(flag, { cross: parts[2] === 'Y', entries: [] });
        }
        continue;
      }
      // Rule line: PFX/SFX flag strip add condition
      if (parts.length >= 5) {
        const group = map.get(flag);
        if (!group) continue;
        const strip = parts[2] === '0' ? '' : parts[2];
        const addRaw = parts[3].split('/')[0];
        const add = addRaw === '0' ? '' : addRaw;
        const cond = parts[4];
        let regex = null;
        if (cond && cond !== '.') {
          try {
            regex = new RegExp(cmd === 'PFX' ? `^${cond}` : `${cond}$`);
          } catch {
            regex = null;
          }
        }
        group.entries.push({ strip, add, regex });
      }
    }
  }

  return { encoding, flagMode, skipStandaloneFlags, forbiddenFlags, pfxRules, sfxRules };
}

function applyPfx(word, entry) {
  if (entry.regex && !entry.regex.test(word)) return null;
  if (entry.strip && !word.startsWith(entry.strip)) return null;
  return entry.add + word.slice(entry.strip.length);
}

function applySfx(word, entry) {
  if (entry.regex && !entry.regex.test(word)) return null;
  if (entry.strip && !word.endsWith(entry.strip)) return null;
  return word.slice(0, word.length - entry.strip.length) + entry.add;
}

function expandHunspell(affBuf, dicBuf, { maxWords = 350000, wordRegex = null, includeCross = true } = {}) {
  // Detect encoding from aff first
  const affPreliminary = affBuf.toString('latin1');
  const setMatch = affPreliminary.match(/^\s*SET\s+(\S+)/m);
  const encoding = setMatch ? mapEncoding(setMatch[1]) : 'utf-8';
  const affText = decodeBuffer(affBuf, encoding);
  const aff = parseAff(affText);
  const dicText = decodeBuffer(dicBuf, aff.encoding || encoding);

  const lines = dicText.split(/\r?\n/);
  const words = new Set();

  function addCandidate(w) {
    if (!w || w.length > 48) return;
    if (wordRegex && !wordRegex.test(w)) return;
    words.add(w);
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#') || (i === 0 && /^\d+$/.test(raw))) continue;
    // Strip morphological fields after tab or space
    const token = raw.split(/\s+/)[0];
    const slashIdx = token.indexOf('/');
    const stem = slashIdx === -1 ? token : token.slice(0, slashIdx);
    const flagPart = slashIdx === -1 ? '' : token.slice(slashIdx + 1);
    if (!stem) continue;

    const flags = parseFlags(flagPart, aff.flagMode);
    if (flags.some((f) => aff.forbiddenFlags.has(f))) continue;

    const skipBase = flags.some((f) => aff.skipStandaloneFlags.has(f));
    if (!skipBase) {
      addCandidate(stem);
    }

    if (words.size >= maxWords) continue;

    const pfxOut = [];
    for (const f of flags) {
      const pGroup = aff.pfxRules.get(f);
      if (pGroup) {
        for (const rule of pGroup.entries) {
          const derived = applyPfx(stem, rule);
          if (derived) {
            addCandidate(derived);
            if (includeCross && pGroup.cross) {
              pfxOut.push(derived);
            }
          }
        }
      }
      const sGroup = aff.sfxRules.get(f);
      if (sGroup) {
        for (const rule of sGroup.entries) {
          const derived = applySfx(stem, rule);
          if (derived) addCandidate(derived);
        }
      }
    }

    if (includeCross && pfxOut.length > 0 && words.size < maxWords) {
      for (const f of flags) {
        const sGroup = aff.sfxRules.get(f);
        if (!sGroup || !sGroup.cross) continue;
        for (const pWord of pfxOut) {
          for (const rule of sGroup.entries) {
            const derived = applySfx(pWord, rule);
            if (derived) addCandidate(derived);
            if (words.size >= maxWords) break;
          }
          if (words.size >= maxWords) break;
        }
      }
    }
  }

  return words;
}

async function buildEnglish() {
  const usAff = await fetchCached('https://raw.githubusercontent.com/LibreOffice/dictionaries/master/en/en_US.aff', 'en_US.aff');
  const usDic = await fetchCached('https://raw.githubusercontent.com/LibreOffice/dictionaries/master/en/en_US.dic', 'en_US.dic');
  const gbAff = await fetchCached('https://raw.githubusercontent.com/LibreOffice/dictionaries/master/en/en_GB.aff', 'en_GB.aff');
  const gbDic = await fetchCached('https://raw.githubusercontent.com/LibreOffice/dictionaries/master/en/en_GB.dic', 'en_GB.dic');

  const regex = /^[A-Za-z][A-Za-z'-]*$/;
  const us = expandHunspell(usAff, usDic, { maxWords: 220000, wordRegex: regex });
  const gb = expandHunspell(gbAff, gbDic, { maxWords: 220000, wordRegex: regex });
  return new Set([...us, ...gb]);
}

async function buildGerman() {
  const wortBuf = await fetchCached('https://raw.githubusercontent.com/davidak/wortliste/master/wortliste.txt', 'de_wortliste.txt');
  const dicBuf = await fetchCached('https://raw.githubusercontent.com/LibreOffice/dictionaries/master/de/de_DE_frami.dic', 'de_DE_frami.dic');

  const wortLines = wortBuf.toString('utf8').split(/\r?\n/).map((w) => w.trim()).filter(Boolean);
  const wortMap = new Map();
  for (const w of wortLines) {
    const low = w.toLowerCase();
    if (!wortMap.has(low)) wortMap.set(low, []);
    if (!wortMap.get(low).includes(w)) wortMap.get(low).push(w);
  }

  const dicLines = dicBuf.toString('latin1').split(/\r?\n/);
  const dicStandalone = new Map();
  for (const line of dicLines) {
    if (!line || line.startsWith('#') || /^\d+$/.test(line)) continue;
    const [wordRaw, flags = ''] = line.split('/');
    const word = wordRaw.trim();
    if (!word || /[ohd]/.test(flags)) continue;
    const low = word.toLowerCase();
    if (!dicStandalone.has(low)) dicStandalone.set(low, []);
    if (!dicStandalone.get(low).includes(word)) dicStandalone.get(low).push(word);
  }

  const finalSet = new Set();
  for (const [low, variants] of wortMap) {
    for (const v of dicStandalone.get(low) || variants) finalSet.add(v);
  }
  for (const [low, variants] of dicStandalone) {
    if (!wortMap.has(low)) {
      for (const v of variants) finalSet.add(v);
    }
  }
  return finalSet;
}

async function buildHunspellLang(sources, opts) {
  const combined = new Set();
  for (const src of sources) {
    const affBuf = await fetchCached(src.aff, `${src.name}.aff`);
    const dicBuf = await fetchCached(src.dic, `${src.name}.dic`);
    const set = expandHunspell(affBuf, dicBuf, opts);
    for (const w of set) combined.add(w);
  }
  return combined;
}

async function buildFreqLang(url, cacheName, { regex, minFreq = 2, maxWords = 100000 }) {
  const buf = await fetchCached(url, cacheName);
  const lines = buf.toString('utf8').split(/\r?\n/);
  const words = new Set();
  for (const line of lines) {
    if (!line) continue;
    const sp = line.lastIndexOf(' ');
    if (sp <= 0) continue;
    const word = line.slice(0, sp).trim();
    const freq = Number(line.slice(sp + 1));
    if (!word || Number.isNaN(freq) || freq < minFreq) continue;
    if (!regex.test(word)) continue;
    words.add(word);
    if (words.size >= maxWords) break;
  }
  return words;
}

const LANGUAGES = [
  {
    code: 'en',
    name: 'English (US & UK)',
    nativeName: 'English',
    diacriticFold: false,
    builtIn: true,
    build: buildEnglish,
  },
  {
    code: 'de',
    name: 'German',
    nativeName: 'Deutsch',
    diacriticFold: false, // ä/ö/ü distinguish words in German
    builtIn: false,
    build: buildGerman,
  },
  {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',
    diacriticFold: true,
    builtIn: false,
    build: () =>
      buildHunspellLang(
        [{
          name: 'fr',
          aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/fr_FR/dictionaries/fr.aff',
          dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/fr_FR/dictionaries/fr.dic',
        }],
        { maxWords: 280000, wordRegex: /^[\p{L}][\p{L}'-]*$/u }
      ),
  },
  {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',
    diacriticFold: true,
    builtIn: false,
    build: () =>
      buildHunspellLang(
        [{
          name: 'es_ES',
          aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/es/es_ES.aff',
          dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/es/es_ES.dic',
        }],
        { maxWords: 280000, wordRegex: /^[\p{L}][\p{L}-]*$/u }
      ),
  },
  {
    code: 'it',
    name: 'Italian',
    nativeName: 'Italiano',
    diacriticFold: true,
    builtIn: false,
    build: () =>
      buildHunspellLang(
        [{
          name: 'it_IT',
          aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/it_IT/it_IT.aff',
          dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/it_IT/it_IT.dic',
        }],
        { maxWords: 280000, wordRegex: /^[\p{L}][\p{L}'-]*$/u }
      ),
  },
  {
    code: 'pt',
    name: 'Portuguese',
    nativeName: 'Português',
    diacriticFold: true,
    builtIn: false,
    build: () =>
      buildHunspellLang(
        [
          {
            name: 'pt_PT',
            aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/pt_PT/pt_PT.aff',
            dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/pt_PT/pt_PT.dic',
          },
          {
            name: 'pt_BR',
            aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/pt_BR/pt_BR.aff',
            dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/pt_BR/pt_BR.dic',
          },
        ],
        { maxWords: 260000, wordRegex: /^[\p{L}][\p{L}-]*$/u }
      ),
  },
  {
    code: 'nl',
    name: 'Dutch',
    nativeName: 'Nederlands',
    diacriticFold: true,
    builtIn: false,
    build: () =>
      buildHunspellLang(
        [{
          name: 'nl_NL',
          aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/nl_NL/nl_NL.aff',
          dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/nl_NL/nl_NL.dic',
        }],
        { maxWords: 280000, wordRegex: /^[\p{L}][\p{L}'-]*$/u }
      ),
  },
  {
    code: 'pl',
    name: 'Polish',
    nativeName: 'Polski',
    diacriticFold: true,
    builtIn: false,
    build: () =>
      buildHunspellLang(
        [{
          name: 'pl_PL',
          aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/pl_PL/pl_PL.aff',
          dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/pl_PL/pl_PL.dic',
        }],
        { maxWords: 320000, wordRegex: /^[\p{L}][\p{L}-]*$/u, includeCross: false }
      ),
  },
  {
    code: 'ru',
    name: 'Russian',
    nativeName: 'Русский',
    diacriticFold: true, // folds ё -> е
    builtIn: false,
    build: () =>
      buildHunspellLang(
        [{
          name: 'ru_RU',
          aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/ru_RU/ru_RU.aff',
          dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/ru_RU/ru_RU.dic',
        }],
        { maxWords: 320000, wordRegex: /^[\u0400-\u04FF][\u0400-\u04FF-]*$/, includeCross: false }
      ),
  },
  {
    code: 'el',
    name: 'Greek',
    nativeName: 'Ελληνικά',
    diacriticFold: true, // folds monotonic/polytonic accents
    builtIn: false,
    build: () =>
      buildHunspellLang(
        [{
          name: 'el_GR',
          aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/el_GR/el_GR.aff',
          dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/el_GR/el_GR.dic',
        }],
        { maxWords: 300000, wordRegex: /^[\u0370-\u03FF\u1F00-\u1FFF]+$/ }
      ),
  },
  {
    code: 'zh',
    name: 'Mandarin Chinese',
    nativeName: '中文',
    diacriticFold: false,
    builtIn: false,
    build: () =>
      buildFreqLang(
        'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/zh_cn/zh_cn_full.txt',
        'zh_cn_full.txt',
        { regex: /^[\u4E00-\u9FFF]+$/, minFreq: 3, maxWords: 120000 }
      ),
  },
  {
    code: 'ja',
    name: 'Japanese',
    nativeName: '日本語',
    diacriticFold: false,
    builtIn: false,
    build: () =>
      buildFreqLang(
        'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/ja/ja_full.txt',
        'ja_full.txt',
        { regex: /^[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u30FC]+$/, minFreq: 1, maxWords: 120000 }
      ),
  },
  {
    code: 'ko',
    name: 'Korean',
    nativeName: '한국어',
    diacriticFold: false,
    builtIn: false,
    build: async () => {
      const hun = await buildHunspellLang(
        [{
          name: 'ko_KR',
          aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/ko_KR/ko_KR.aff',
          dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/ko_KR/ko_KR.dic',
        }],
        { maxWords: 180000, wordRegex: /^[\uAC00-\uD7AF]+$/, includeCross: false }
      );
      const freq = await buildFreqLang(
        'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/ko/ko_50k.txt',
        'ko_50k.txt',
        { regex: /^[\uAC00-\uD7AF]+$/, minFreq: 2, maxWords: 50000 }
      );
      return new Set([...hun, ...freq]);
    },
  },
  {
    code: 'bn',
    name: 'Bengali',
    nativeName: 'বাংলা',
    diacriticFold: false,
    builtIn: false,
    build: async () => {
      const hun = await buildHunspellLang(
        [{
          name: 'bn_BD',
          aff: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/bn_BD/bn_BD.aff',
          dic: 'https://raw.githubusercontent.com/LibreOffice/dictionaries/master/bn_BD/bn_BD.dic',
        }],
        { maxWords: 180000, wordRegex: /^[\u0980-\u09FF]+$/ }
      );
      const freq = await buildFreqLang(
        'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/bn/bn_50k.txt',
        'bn_50k.txt',
        { regex: /^[\u0980-\u09FF]+$/, minFreq: 2, maxWords: 50000 }
      );
      return new Set([...hun, ...freq]);
    },
  },
];

async function main() {
  const manifest = [];
  for (const lang of LANGUAGES) {
    process.stdout.write(`Building ${lang.code} (${lang.name})... `);
    const set = await lang.build();
    const sorted = [...set].sort((a, b) => a.localeCompare(b, lang.code));
    const uniqueLower = new Set(sorted.map((w) => w.toLowerCase())).size;
    const rawText = sorted.join('\n');
    const txtPath = path.join(OUT_DIR, `${lang.code}.txt`);
    fs.writeFileSync(txtPath, rawText, 'utf8');
    const bytes = Buffer.byteLength(rawText, 'utf8');

    if (lang.builtIn) {
      const jsPath = path.join(OUT_DIR, `${lang.code}.js`);
      fs.writeFileSync(
        jsPath,
        `window.BUILTIN_DICTIONARIES = window.BUILTIN_DICTIONARIES || {};\nwindow.BUILTIN_DICTIONARIES[${JSON.stringify(lang.code)}] = ${JSON.stringify(rawText)};\n`,
        'utf8'
      );
    }

    manifest.push({
      code: lang.code,
      name: lang.name,
      nativeName: lang.nativeName,
      diacriticFold: lang.diacriticFold,
      builtIn: lang.builtIn,
      wordCount: uniqueLower,
      formCount: sorted.length,
      sizeBytes: bytes,
      url: `./dictionaries/${lang.code}.txt`,
    });

    console.log(`${uniqueLower} words (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
  }

  const manifestJson = JSON.stringify({ languages: manifest }, null, 2);
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), manifestJson, 'utf8');
  fs.writeFileSync(
    path.join(OUT_DIR, 'manifest.js'),
    `window.DICTIONARY_CATALOG = ${manifestJson};\n`,
    'utf8'
  );

  console.log('\nDone! Manifest written to www/dictionaries/manifest.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
