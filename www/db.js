(() => {
  'use strict';

  const DB_NAME = 'WordCollectorDB';
  const DB_VERSION = 1;
  const LEGACY_SAVE_KEY = 'wortSammler.v1';

  let dbPromise = null;
  const memoryFallback = {
    dictionaries: new Map(),
    saves: new Map(),
    meta: new Map(),
  };

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }

      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains('dictionaries')) {
            db.createObjectStore('dictionaries', { keyPath: 'code' });
          }
          if (!db.objectStoreNames.contains('saves')) {
            db.createObjectStore('saves', { keyPath: 'langCode' });
          }
          if (!db.objectStoreNames.contains('meta')) {
            db.createObjectStore('meta', { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });

    return dbPromise;
  }

  async function idbGet(storeName, key) {
    const db = await openDB();
    if (!db) return memoryFallback[storeName].get(key) || null;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function idbPut(storeName, record, keyField) {
    const db = await openDB();
    if (!db) {
      memoryFallback[storeName].set(record[keyField], record);
      return;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async function idbDelete(storeName, key) {
    const db = await openDB();
    if (!db) {
      memoryFallback[storeName].delete(key);
      return;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async function idbGetAllKeys(storeName) {
    const db = await openDB();
    if (!db) return [...memoryFallback[storeName].keys()];

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAllKeys();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  async function getMeta(key, defaultValue = null) {
    const rec = await idbGet('meta', key);
    return rec ? rec.value : defaultValue;
  }

  async function setMeta(key, value) {
    await idbPut('meta', { key, value }, 'key');
  }

  async function getSave(langCode) {
    const rec = await idbGet('saves', langCode);
    if (rec && Array.isArray(rec.words)) {
      return { words: rec.words, duplicateCount: rec.duplicateCount || 0 };
    }
    return { words: [], duplicateCount: 0 };
  }

  async function putSave(langCode, words, duplicateCount) {
    await idbPut(
      'saves',
      {
        langCode,
        words,
        duplicateCount,
        updatedAt: new Date().toISOString(),
      },
      'langCode'
    );
  }

  async function getDictionary(code) {
    return idbGet('dictionaries', code);
  }

  async function putDictionary(code, rawText, wordCount) {
    await idbPut(
      'dictionaries',
      {
        code,
        rawText,
        wordCount,
        updatedAt: new Date().toISOString(),
      },
      'code'
    );
  }

  async function deleteDictionary(code) {
    await idbDelete('dictionaries', code);
  }

  async function listInstalledDictionaries() {
    return idbGetAllKeys('dictionaries');
  }

  async function migrateLegacySaveIfNeeded() {
    try {
      const migrated = await getMeta('migratedLegacyV1', false);
      if (migrated) return;
      if (typeof localStorage === 'undefined') return;
      const legacyRaw = localStorage.getItem(LEGACY_SAVE_KEY);
      if (legacyRaw) {
        const parsed = JSON.parse(legacyRaw);
        if (parsed && Array.isArray(parsed.words) && parsed.words.length > 0) {
          const existingDe = await idbGet('saves', 'de');
          if (!existingDe || !Array.isArray(existingDe.words) || existingDe.words.length === 0) {
            await putSave('de', parsed.words, parsed.duplicateCount || 0);
          }
        }
      }
      await setMeta('migratedLegacyV1', true);
    } catch {
      // ignore migration errors
    }
  }

  window.WordCollectorDB = {
    getMeta,
    setMeta,
    getSave,
    putSave,
    getDictionary,
    putDictionary,
    deleteDictionary,
    listInstalledDictionaries,
    migrateLegacySaveIfNeeded,
  };
})();
