(() => {
  'use strict';

  const SORT_MODES = ['order', 'alpha', 'duplicates'];
  const I18n = window.WordCollectorI18n;
  const DB = window.WordCollectorDB;
  const CATALOG = (window.DICTIONARY_CATALOG && Array.isArray(window.DICTIONARY_CATALOG.languages))
    ? window.DICTIONARY_CATALOG.languages
    : [];

  function findCatalogEntry(code) {
    return CATALOG.find((c) => c.code === code) || null;
  }

  function foldDiacritics(str) {
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ł/g, 'l')
      .replace(/Ł/g, 'L')
      .replace(/ø/g, 'o')
      .replace(/Ø/g, 'O')
      .replace(/ς/g, 'σ');
  }

  function normalizeKey(raw, langMeta) {
    const lower = raw.toLowerCase();
    return langMeta && langMeta.diacriticFold ? foldDiacritics(lower) : lower;
  }

  /** @type {Map<string, string | string[]>} */
  const dictionaryExactMap = new Map();
  /** @type {Map<string, string | string[]>} */
  const dictionaryFoldMap = new Map();
  let currentUniqueWordCount = 0;

  function insertIntoMap(map, key, value) {
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, value);
    } else if (typeof existing === 'string') {
      if (existing !== value) {
        map.set(key, [existing, value]);
      }
    } else if (!existing.includes(value)) {
      existing.push(value);
    }
  }

  let dictionaryLoadPromise = Promise.resolve(true);

  async function loadDictionaryTextIntoMemory(rawText, langMeta) {
    dictionaryExactMap.clear();
    dictionaryFoldMap.clear();

    const exactSet = new Set();
    const useFold = Boolean(langMeta && langMeta.diacriticFold);

    if (typeof rawText === 'string' && rawText.length > 0) {
      const len = rawText.length;
      const CHUNK_LINES = 60000;
      let pos = 0;
      let lineCount = 0;

      while (pos < len) {
        let nextNl = rawText.indexOf('\n', pos);
        if (nextNl === -1) nextNl = len;
        const rawWord = rawText.slice(pos, nextNl);
        pos = nextNl + 1;

        if (!rawWord) continue;
        const lower = rawWord.toLowerCase();
        exactSet.add(lower);
        insertIntoMap(dictionaryExactMap, lower, rawWord);
        if (useFold) {
          insertIntoMap(dictionaryFoldMap, foldDiacritics(lower), rawWord);
        }

        lineCount += 1;
        if (lineCount % CHUNK_LINES === 0 && pos < len) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    currentUniqueWordCount = exactSet.size;
  }

  function resolveFromVariants(variants, cleaned) {
    if (!variants) return null;
    if (typeof variants === 'string') return variants;
    if (variants.includes(cleaned)) return cleaned;
    return variants.find((v) => v === v.toLowerCase()) || variants[0];
  }

  function lookupDictionaryWord(cleaned, langMeta) {
    const lower = cleaned.toLowerCase();
    const exactMatch = dictionaryExactMap.get(lower);
    if (exactMatch) {
      return resolveFromVariants(exactMatch, cleaned);
    }
    if (langMeta && langMeta.diacriticFold) {
      const folded = foldDiacritics(lower);
      const foldMatch = dictionaryFoldMap.get(folded);
      if (foldMatch) {
        return resolveFromVariants(foldMatch, cleaned);
      }
    }
    return null;
  }

  function createWordStore() {
    return {
      words: [],
      duplicateCount: 0,
      index: new Map(),
    };
  }

  const mainStore = createWordStore();
  const timerCache = createWordStore();

  let appLangSetting = 'auto';
  let effectiveUiLang = I18n.resolveEffectiveLang('auto');
  let activeDictLang = 'en';
  let dictBaseUrl = '';
  const DEFAULT_REMOTE_DICT_BASES = [
    'https://celebornart.github.io/Lexory/dictionaries/',
    'https://raw.githubusercontent.com/CelebornArt/Lexory/main/www/dictionaries/',
  ];
  let installedLangs = new Set(['en']);
  let quickLangs = ['en'];
  const downloadingLangs = new Set();

  let activeMode = 'main'; // 'main' | 'timer'
  let sortMode = 'order';
  let pendingUnknownWord = null;
  let lastStatusMeta = { circleState: 'idle', kind: null, word: '', extra: 0, forced: false, showForce: false };
  let drawerCloseTimer = null;

  const timerState = {
    status: 'idle', // 'idle' | 'running' | 'paused' | 'finished'
    durationSeconds: 0,
    remainingSeconds: 0,
    endTimeMs: 0,
    intervalId: null,
  };

  // DOM Elements
  const composerPanel = document.getElementById('composer-panel');
  const timerModePill = document.getElementById('timer-mode-pill');
  const inputShell = document.getElementById('input-shell');
  const wordInput = document.getElementById('word-input');
  const statusCircle = document.getElementById('status-circle');
  const feedbackText = document.getElementById('feedback-text');
  const forceAcceptBtn = document.getElementById('force-accept-btn');
  const totalWordsLabel = document.getElementById('total-words-label');
  const totalWordsCount = document.getElementById('total-words-count');
  const duplicateWordsLabel = document.getElementById('duplicate-words-label');
  const duplicateWordsCount = document.getElementById('duplicate-words-count');

  const quickLangBar = document.getElementById('quick-lang-bar');

  const timerResultPanel = document.getElementById('timer-result-panel');
  const timerResultTitle = document.getElementById('timer-result-title');
  const timerResultSubtitle = document.getElementById('timer-result-subtitle');
  const resultWordsLabel = document.getElementById('result-words-label');
  const resultWordsCount = document.getElementById('result-words-count');
  const resultDuplicatesLabel = document.getElementById('result-duplicates-label');
  const resultDuplicatesCount = document.getElementById('result-duplicates-count');
  const timerResultList = document.getElementById('timer-result-list');
  const timerResultEmpty = document.getElementById('timer-result-empty');
  const timerDownloadTxtBtn = document.getElementById('timer-download-txt-btn');
  const timerDownloadJsonBtn = document.getElementById('timer-download-json-btn');
  const timerNewBtn = document.getElementById('timer-new-btn');
  const timerBackMainBtn = document.getElementById('timer-back-main-btn');

  const timerWrap = document.getElementById('timer-wrap');
  const timerPill = document.getElementById('timer-pill');
  const timerToggleBtn = document.getElementById('timer-toggle-btn');
  const timerLabel = document.getElementById('timer-label');
  const timerActiveActions = document.getElementById('timer-active-actions');
  const timerPauseBtn = document.getElementById('timer-pause-btn');
  const timerPauseIcon = document.getElementById('timer-pause-icon');
  const timerPlayIcon = document.getElementById('timer-play-icon');
  const timerStopBtn = document.getElementById('timer-stop-btn');
  const timerPopover = document.getElementById('timer-popover');
  const timerPopoverTitle = document.getElementById('timer-popover-title');
  const timerPresetBtns = document.querySelectorAll('.timer-preset-btn');

  const openInfoBtn = document.getElementById('open-info-btn');
  const openInfoLabel = document.getElementById('open-info-label');
  const headerWordBadge = document.getElementById('header-word-badge');
  const openSettingsBtn = document.getElementById('open-settings-btn');

  const closeInfoBtn = document.getElementById('close-info-btn');
  const drawerBackdrop = document.getElementById('drawer-backdrop');
  const infoDrawer = document.getElementById('info-drawer');
  const drawerTitle = document.getElementById('drawer-title');
  const drawerSubtitle = document.getElementById('drawer-subtitle');
  const drawerStatTotalLabel = document.getElementById('drawer-stat-total-label');
  const drawerTotalCount = document.getElementById('drawer-total-count');
  const drawerStatDupLabel = document.getElementById('drawer-stat-dup-label');
  const drawerDuplicateCount = document.getElementById('drawer-duplicate-count');
  const drawerStatDictLabel = document.getElementById('drawer-stat-dict-label');
  const drawerDictCount = document.getElementById('drawer-dict-count');
  const listSearchInput = document.getElementById('list-search-input');
  const sortModeBtn = document.getElementById('sort-mode-btn');
  const sortModeLabel = document.getElementById('sort-mode-label');
  const wordListEl = document.getElementById('word-list');
  const emptyListState = document.getElementById('empty-list-state');

  const exportBtn = document.getElementById('export-btn');
  const importBtnLabel = document.getElementById('import-btn-label');
  const importInput = document.getElementById('import-input');
  const resetBtn = document.getElementById('reset-btn');

  const modalBackdrop = document.getElementById('modal-backdrop');
  const resetModal = document.getElementById('reset-modal');
  const resetModalTitle = document.getElementById('reset-modal-title');
  const resetModalDesc = document.getElementById('reset-modal-desc');
  const resetCancelBtn = document.getElementById('reset-cancel-btn');
  const resetConfirmBtn = document.getElementById('reset-confirm-btn');

  const settingsModal = document.getElementById('settings-modal');
  const settingsModalTitle = document.getElementById('settings-modal-title');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const appLangLabel = document.getElementById('app-lang-label');
  const appLangHint = document.getElementById('app-lang-hint');
  const appLanguageSelect = document.getElementById('app-language-select');
  const dictSectionTitle = document.getElementById('dict-section-title');
  const dictSectionHint = document.getElementById('dict-section-hint');
  const dictErrorBanner = document.getElementById('dict-error-banner');
  const dictListEl = document.getElementById('dict-list');
  const quickSectionTitle = document.getElementById('quick-section-title');
  const quickSectionHint = document.getElementById('quick-section-hint');
  const quickOptionsListEl = document.getElementById('quick-options-list');
  const dictNoteTitle = document.getElementById('dict-note-title');
  const dictNoteText = document.getElementById('dict-note-text');
  const dictSourceLabel = document.getElementById('dict-source-label');
  const dictBaseUrlInput = document.getElementById('dict-base-url-input');
  const dictBaseUrlSaveBtn = document.getElementById('dict-base-url-save-btn');

  const listenToggleBtn = document.getElementById('listen-toggle-btn');
  const listenBtnLabel = document.getElementById('listen-btn-label');
  const voiceSettingsBlock = document.getElementById('voice-settings-block');
  const voiceSectionTitle = document.getElementById('voice-section-title');
  const voiceSectionHint = document.getElementById('voice-section-hint');
  const audioFeedbackLabel = document.getElementById('audio-feedback-label');
  const audioFeedbackHint = document.getElementById('audio-feedback-hint');
  const audioFeedbackToggle = document.getElementById('audio-feedback-toggle');
  const voiceModelRow = document.getElementById('voice-model-row');
  const voiceModelLabel = document.getElementById('voice-model-label');
  const voiceModelStatus = document.getElementById('voice-model-status');
  const voiceModelDlBtn = document.getElementById('voice-model-dl-btn');
  const voiceModelRmBtn = document.getElementById('voice-model-rm-btn');
  const voiceErrorBanner = document.getElementById('voice-error-banner');

  const VoiceLib = window.LexoryVoice || null;
  let voiceController = { mode: null, isSupported: () => false };
  let audioFeedbackEnabled = true;
  let voiceModelStatusState = { downloaded: false, downloading: false, progress: 0 };

  function t(key, vars) {
    return I18n.getTranslation(effectiveUiLang, key, vars);
  }

  function formatNumber(n) {
    return n.toLocaleString(effectiveUiLang || 'en');
  }

  function getActiveStore() {
    return activeMode === 'timer' ? timerCache : mainStore;
  }

  function cleanWord(raw) {
    return String(raw || '').trim().replace(/\s+/g, ' ');
  }

  function rebuildIndex(store, langMeta) {
    store.index.clear();
    for (const entry of store.words) {
      entry.normalized = normalizeKey(entry.text, langMeta);
      store.index.set(entry.normalized, entry);
    }
  }

  function clearStore(store) {
    store.words = [];
    store.duplicateCount = 0;
    store.index.clear();
  }

  function sanitizeSavePayload(raw, langMeta) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.words)) {
      return null;
    }

    const sanitizedWords = [];
    const seen = new Set();

    for (const item of raw.words) {
      if (!item || typeof item !== 'object') continue;
      const rawText = cleanWord(item.text);
      if (!rawText) continue;
      const normalized = normalizeKey(rawText, langMeta);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      const forced = Boolean(item.forced);
      const canonical = forced ? rawText : (lookupDictionaryWord(rawText, langMeta) || rawText);
      const repeatCount = Number.isInteger(item.repeatCount) && item.repeatCount >= 0 ? item.repeatCount : 0;

      sanitizedWords.push({
        text: canonical,
        normalized,
        repeatCount,
        forced,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      });
    }

    const computedDuplicateSum = sanitizedWords.reduce((sum, entry) => sum + entry.repeatCount, 0);
    const duplicateCount =
      Number.isInteger(raw.duplicateCount) && raw.duplicateCount >= computedDuplicateSum
        ? raw.duplicateCount
        : computedDuplicateSum;

    return { words: sanitizedWords, duplicateCount };
  }

  async function saveMainState() {
    await DB.putSave(activeDictLang, mainStore.words, mainStore.duplicateCount);
  }

  function loadBuiltinScriptFallback(code) {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = `dictionaries/${code}.js`;
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  }

  async function ensureLanguageLoaded(code) {
    const langMeta = findCatalogEntry(code);
    if (!langMeta) return false;

    let builtinRaw = window.BUILTIN_DICTIONARIES && window.BUILTIN_DICTIONARIES[code];
    if (typeof builtinRaw === 'string' && builtinRaw.length > 0) {
      await loadDictionaryTextIntoMemory(builtinRaw, langMeta);
      return true;
    }

    const cached = await DB.getDictionary(code);
    if (cached && typeof cached.rawText === 'string' && cached.rawText.length > 0) {
      await loadDictionaryTextIntoMemory(cached.rawText, langMeta);
      return true;
    }

    if (langMeta.builtIn) {
      if (typeof fetch === 'function' && location.protocol !== 'file:') {
        try {
          const res = await fetch(langMeta.url);
          if (res.ok) {
            const rawText = await res.text();
            await loadDictionaryTextIntoMemory(rawText, langMeta);
            return true;
          }
        } catch {
          // fallback to script tag
        }
      }
      await loadBuiltinScriptFallback(code);
      builtinRaw = window.BUILTIN_DICTIONARIES && window.BUILTIN_DICTIONARIES[code];
      if (typeof builtinRaw === 'string' && builtinRaw.length > 0) {
        await loadDictionaryTextIntoMemory(builtinRaw, langMeta);
        return true;
      }
    }

    return false;
  }

  async function loadMainSaveForLang(code) {
    const langMeta = findCatalogEntry(code);
    const saved = await DB.getSave(code);
    const sanitized = sanitizeSavePayload(saved, langMeta) || { words: [], duplicateCount: 0 };
    mainStore.words = sanitized.words;
    mainStore.duplicateCount = sanitized.duplicateCount;
    rebuildIndex(mainStore, langMeta);
  }

  async function switchActiveDictLanguage(code, { announce = true } = {}) {
    if (!installedLangs.has(code)) return;
    if (timerState.status === 'finished') {
      await returnToMainMode({ skipFocus: true });
    }

    dictionaryLoadPromise = ensureLanguageLoaded(code);
    const ok = await dictionaryLoadPromise;
    if (!ok) return;

    activeDictLang = code;
    await DB.setMeta('activeDictLang', activeDictLang);
    await loadMainSaveForLang(code);

    if (activeMode === 'timer') {
      const langMeta = findCatalogEntry(code);
      rebuildIndex(timerCache, langMeta);
    }

    if (voiceController.isSupported()) {
      voiceController.setLanguage(code);
    }

    pendingUnknownWord = null;
    wordInput.value = '';
    const langMeta = findCatalogEntry(code);
    if (announce && langMeta) {
      setStatus('idle', { kind: 'langSwitched', word: langMeta.nativeName }, null, false);
    } else {
      setStatus('idle', null, null, false);
    }

    renderQuickLangBar();
    renderSettingsLists();
    updateCounters();
    renderWordList();
    if (!wordInput.disabled && settingsModal.hidden) {
      wordInput.focus();
    }
  }

  function resolveDictionaryFetchUrls(langMeta) {
    if (dictBaseUrl) {
      const normalizedBase = dictBaseUrl.endsWith('/') ? dictBaseUrl : `${dictBaseUrl}/`;
      return [`${normalizedBase}${langMeta.code}.txt`];
    }
    const urls = [langMeta.url];
    for (const base of DEFAULT_REMOTE_DICT_BASES) {
      const normalized = base.endsWith('/') ? base : `${base}/`;
      urls.push(`${normalized}${langMeta.code}.txt`);
    }
    return urls;
  }

  async function downloadLanguagePack(code) {
    const langMeta = findCatalogEntry(code);
    if (!langMeta || downloadingLangs.has(code)) return;

    dictErrorBanner.hidden = true;
    downloadingLangs.add(code);
    renderSettingsLists();

    try {
      const candidateUrls = resolveDictionaryFetchUrls(langMeta);
      let rawText = null;
      let lastErr = null;
      for (const targetUrl of candidateUrls) {
        try {
          const response = await fetch(targetUrl);
          if (!response.ok) {
            lastErr = new Error(`HTTP ${response.status}`);
            continue;
          }
          const text = await response.text();
          if (!text || text.trimStart().startsWith('<')) {
            lastErr = new Error('Unexpected HTML response');
            continue;
          }
          rawText = text;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (rawText === null) {
        throw lastErr || new Error('Download failed');
      }
      await DB.putDictionary(code, rawText, langMeta.wordCount);
      installedLangs.add(code);
      if (!quickLangs.includes(code)) {
        quickLangs.push(code);
        await DB.setMeta('quickLangs', quickLangs);
      }
      renderQuickLangBar();
      renderSettingsLists();
    } catch {
      dictErrorBanner.textContent = t('dictDownloadError');
      dictErrorBanner.hidden = false;
    } finally {
      downloadingLangs.delete(code);
      renderSettingsLists();
    }
  }

  async function removeLanguagePack(code) {
    const langMeta = findCatalogEntry(code);
    if (!langMeta || langMeta.builtIn) return;

    await DB.deleteDictionary(code);
    installedLangs.delete(code);
    quickLangs = quickLangs.filter((c) => c !== code);
    if (quickLangs.length === 0) quickLangs = ['en'];
    await DB.setMeta('quickLangs', quickLangs);

    if (activeDictLang === code) {
      await switchActiveDictLanguage('en', { announce: false });
    } else {
      renderQuickLangBar();
      renderSettingsLists();
    }
  }

  function populateAppLanguageSelect() {
    appLanguageSelect.textContent = '';

    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = t('appLangAuto');
    appLanguageSelect.appendChild(autoOpt);

    for (const lang of I18n.UI_LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.name;
      appLanguageSelect.appendChild(opt);
    }

    appLanguageSelect.value = appLangSetting;
  }

  function renderQuickLangBar() {
    quickLangBar.textContent = '';

    const visibleCodes = quickLangs.filter((c) => installedLangs.has(c));
    if (!visibleCodes.includes(activeDictLang)) {
      visibleCodes.unshift(activeDictLang);
    }

    for (const code of visibleCodes) {
      const meta = findCatalogEntry(code);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `quick-lang-btn${code === activeDictLang ? ' is-active' : ''}`;
      btn.textContent = code.toUpperCase();
      btn.title = meta ? `${meta.nativeName} (${meta.name})` : code.toUpperCase();
      btn.setAttribute('aria-pressed', String(code === activeDictLang));
      btn.addEventListener('click', () => {
        if (code !== activeDictLang) {
          switchActiveDictLanguage(code);
        }
      });
      quickLangBar.appendChild(btn);
    }
  }

  function renderSettingsLists() {
    dictListEl.textContent = '';
    quickOptionsListEl.textContent = '';

    for (const lang of CATALOG) {
      const isInstalled = installedLangs.has(lang.code);
      const isDownloading = downloadingLangs.has(lang.code);
      const isActive = activeDictLang === lang.code;
      const sizeMb = (lang.sizeBytes / 1024 / 1024).toFixed(1);

      const row = document.createElement('div');
      row.className = 'dict-row';

      const info = document.createElement('div');
      info.className = 'dict-row__info';

      const nameDiv = document.createElement('div');
      nameDiv.className = 'dict-row__name';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${lang.nativeName} · ${lang.name}`;
      const codeSpan = document.createElement('span');
      codeSpan.className = 'dict-row__code';
      codeSpan.textContent = lang.code;
      nameDiv.append(nameSpan, codeSpan);

      const metaDiv = document.createElement('div');
      metaDiv.className = 'dict-row__meta';
      const statusLabel = lang.builtIn
        ? t('dictBuiltIn')
        : (isInstalled ? t('dictInstalled') : `${sizeMb} MB`);
      metaDiv.textContent = `${formatNumber(lang.wordCount)} ${t('dictWordsUnit')} · ${statusLabel}`;

      info.append(nameDiv, metaDiv);

      const actions = document.createElement('div');
      actions.className = 'dict-row__actions';

      if (isInstalled) {
        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.className = `dict-btn${isActive ? ' dict-btn--active' : ''}`;
        useBtn.textContent = isActive ? t('dictActiveBadge') : t('dictActivateBtn');
        useBtn.disabled = isActive;
        useBtn.addEventListener('click', () => switchActiveDictLanguage(lang.code));
        actions.appendChild(useBtn);

        if (!lang.builtIn) {
          const rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'dict-btn dict-btn--danger';
          rmBtn.textContent = t('dictDeleteBtn');
          rmBtn.addEventListener('click', () => removeLanguagePack(lang.code));
          actions.appendChild(rmBtn);
        }
      } else {
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'dict-btn';
        dlBtn.textContent = isDownloading ? t('dictDownloading') : t('dictDownloadBtn');
        dlBtn.disabled = isDownloading;
        dlBtn.addEventListener('click', () => downloadLanguagePack(lang.code));
        actions.appendChild(dlBtn);
      }

      row.append(info, actions);
      dictListEl.appendChild(row);

      if (isInstalled) {
        const label = document.createElement('label');
        label.className = 'quick-check-pill';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = quickLangs.includes(lang.code);
        cb.addEventListener('change', async () => {
          if (cb.checked) {
            if (!quickLangs.includes(lang.code)) quickLangs.push(lang.code);
          } else {
            quickLangs = quickLangs.filter((c) => c !== lang.code);
            if (quickLangs.length === 0) {
              quickLangs = [activeDictLang];
              cb.checked = quickLangs.includes(lang.code);
            }
          }
          await DB.setMeta('quickLangs', quickLangs);
          renderQuickLangBar();
        });

        const txt = document.createElement('span');
        txt.textContent = `${lang.code.toUpperCase()} · ${lang.nativeName}`;
        label.append(cb, txt);
        quickOptionsListEl.appendChild(label);
      }
    }
  }

  function triggerPulse(el, className) {
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
  }

  function renderFeedbackStatus() {
    const ariaMap = {
      idle: t('statusReady'),
      new: t('statusNew'),
      duplicate: t('statusDuplicate'),
      unknown: t('statusUnknown'),
    };
    statusCircle.setAttribute('aria-label', ariaMap[lastStatusMeta.circleState] || t('statusReady'));

    let msg = '';
    if (lastStatusMeta.kind === 'new') {
      msg = t(lastStatusMeta.forced ? 'feedbackAddedForced' : 'feedbackAdded', { w: lastStatusMeta.word });
    } else if (lastStatusMeta.kind === 'duplicate') {
      msg = t('feedbackExists', { w: lastStatusMeta.word, n: lastStatusMeta.extra });
    } else if (lastStatusMeta.kind === 'unknown') {
      msg = t('feedbackUnknown', { w: lastStatusMeta.word });
    } else if (lastStatusMeta.kind === 'reset') {
      msg = t('feedbackReset');
    } else if (lastStatusMeta.kind === 'imported') {
      msg = t('feedbackImported', { n: lastStatusMeta.extra });
    } else if (lastStatusMeta.kind === 'importBadFormat') {
      msg = t('feedbackImportBadFormat');
    } else if (lastStatusMeta.kind === 'importReadError') {
      msg = t('feedbackImportReadError');
    } else if (lastStatusMeta.kind === 'langSwitched') {
      msg = t('feedbackLangSwitched', { lang: lastStatusMeta.word });
    }

    feedbackText.textContent = msg;
    forceAcceptBtn.hidden = !lastStatusMeta.showForce;
  }

  function setStatus(circleState, meta, tone, showForceButton) {
    lastStatusMeta = {
      circleState,
      kind: meta ? meta.kind : null,
      word: meta && meta.word ? meta.word : '',
      extra: meta && meta.extra ? meta.extra : 0,
      forced: Boolean(meta && meta.forced),
      showForce: Boolean(showForceButton),
    };

    statusCircle.dataset.state = circleState;
    if (circleState === 'new' || circleState === 'duplicate') {
      triggerPulse(statusCircle, 'is-pulsing');
    } else {
      statusCircle.classList.remove('is-pulsing');
    }

    if (tone) {
      feedbackText.dataset.tone = tone;
    } else {
      delete feedbackText.dataset.tone;
    }

    renderFeedbackStatus();
  }

  function updateCounters() {
    const store = getActiveStore();
    const total = store.words.length;
    const duplicates = store.duplicateCount;

    totalWordsCount.textContent = formatNumber(total);
    duplicateWordsCount.textContent = formatNumber(duplicates);
    headerWordBadge.textContent = formatNumber(total);

    drawerTotalCount.textContent = formatNumber(total);
    drawerDuplicateCount.textContent = formatNumber(duplicates);
    drawerDictCount.textContent = formatNumber(currentUniqueWordCount);

    drawerTitle.textContent = activeMode === 'timer' ? t('drawerTitleTimer') : t('drawerTitleMain');
    drawerStatTotalLabel.textContent = activeMode === 'timer' ? t('statInRound') : t('statInSystem');
    drawerSubtitle.textContent = total === 1
      ? t('drawerSubtitleSingle', { n: formatNumber(total) })
      : t('drawerSubtitlePlural', { n: formatNumber(total) });
  }

  function getFilteredAndSortedEntries(store) {
    const query = cleanWord(listSearchInput.value).toLowerCase();
    const items = [];

    store.words.forEach((entry, index) => {
      if (query && !entry.text.toLowerCase().includes(query) && !entry.normalized.includes(query)) {
        return;
      }
      items.push({ entry, index });
    });

    if (sortMode === 'alpha') {
      items.sort((a, b) => {
        const cmp = a.entry.text.localeCompare(b.entry.text, activeDictLang || effectiveUiLang, { sensitivity: 'base' });
        return cmp !== 0 ? cmp : a.index - b.index;
      });
    } else if (sortMode === 'duplicates') {
      items.sort((a, b) => {
        const diff = b.entry.repeatCount - a.entry.repeatCount;
        return diff !== 0 ? diff : a.index - b.index;
      });
    }

    return items;
  }

  function renderEntriesIntoList(listEl, items) {
    listEl.textContent = '';
    const fragment = document.createDocumentFragment();

    for (const { entry, index } of items) {
      const li = document.createElement('li');
      li.className = 'word-row';

      const left = document.createElement('div');
      left.className = 'word-row__left';

      const idxSpan = document.createElement('span');
      idxSpan.className = 'word-row__index';
      idxSpan.textContent = `${index + 1}.`;

      const textSpan = document.createElement('span');
      textSpan.className = 'word-row__text';
      textSpan.textContent = entry.text;

      left.append(idxSpan, textSpan);

      const badges = document.createElement('div');
      badges.className = 'word-row__badges';

      if (entry.forced) {
        const forcedPill = document.createElement('span');
        forcedPill.className = 'pill pill--forced';
        forcedPill.textContent = t('forcedBadge');
        badges.appendChild(forcedPill);
      }

      if (entry.repeatCount > 0) {
        const repeatPill = document.createElement('span');
        repeatPill.className = 'pill pill--repeat';
        repeatPill.textContent = t('repeatBadge', { n: entry.repeatCount });
        badges.appendChild(repeatPill);
      }

      li.append(left, badges);
      fragment.appendChild(li);
    }

    listEl.appendChild(fragment);
  }

  function renderWordList() {
    const store = getActiveStore();
    const items = getFilteredAndSortedEntries(store);
    renderEntriesIntoList(wordListEl, items);

    if (store.words.length === 0) {
      emptyListState.textContent = t('emptyList');
      emptyListState.hidden = false;
    } else if (items.length === 0) {
      emptyListState.textContent = t('emptyFilter');
      emptyListState.hidden = false;
    } else {
      emptyListState.hidden = true;
    }
  }

  function renderTimerResult() {
    const items = timerCache.words.map((entry, index) => ({ entry, index }));
    resultWordsCount.textContent = formatNumber(timerCache.words.length);
    resultDuplicatesCount.textContent = formatNumber(timerCache.duplicateCount);
    renderEntriesIntoList(timerResultList, items);
    timerResultEmpty.hidden = items.length > 0;
  }

  function updateStageVisibility() {
    const isFinished = activeMode === 'timer' && timerState.status === 'finished';
    composerPanel.hidden = isFinished;
    timerResultPanel.hidden = !isFinished;
    timerModePill.hidden = !(activeMode === 'timer' && !isFinished);
    wordInput.disabled = isFinished;

    if (isFinished) {
      renderTimerResult();
    }
  }

  function updateSortButtonUI() {
    const labelMap = {
      order: t('sortOrder'),
      alpha: t('sortAlpha'),
      duplicates: t('sortDuplicates'),
    };
    const label = labelMap[sortMode];
    sortModeLabel.textContent = label;
    sortModeBtn.dataset.mode = sortMode;
    sortModeBtn.setAttribute('aria-label', t('sortAria', { label }));
  }

  function cycleSortMode() {
    const nextIdx = (SORT_MODES.indexOf(sortMode) + 1) % SORT_MODES.length;
    sortMode = SORT_MODES[nextIdx];
    updateSortButtonUI();
    renderWordList();
  }

  function applyTranslations() {
    document.documentElement.lang = effectiveUiLang;
    document.documentElement.dir = effectiveUiLang === 'ar' ? 'rtl' : 'ltr';
    document.title = t('pageTitle');

    openInfoLabel.textContent = t('wordListBtn');
    openSettingsBtn.setAttribute('aria-label', t('settingsAria'));
    openSettingsBtn.setAttribute('title', t('settingsAria'));

    timerPopoverTitle.textContent = t('timerPopoverTitle');
    timerPresetBtns.forEach((btn) => {
      const key = `preset${btn.dataset.seconds}`;
      btn.textContent = t(key);
    });
    timerStopBtn.setAttribute('aria-label', t('timerStopAria'));

    timerModePill.textContent = t('timerModePill');
    wordInput.placeholder = t('inputPlaceholder');
    wordInput.setAttribute('aria-label', t('inputAria'));
    forceAcceptBtn.textContent = t('forceAccept');
    totalWordsLabel.textContent = t('totalWordsLabel');
    duplicateWordsLabel.textContent = t('duplicateWordsLabel');

    timerResultTitle.textContent = t('resultTitle');
    timerResultSubtitle.textContent = t('resultSubtitle');
    resultWordsLabel.textContent = t('resultWordsLabel');
    resultDuplicatesLabel.textContent = t('resultDuplicatesLabel');
    timerResultEmpty.textContent = t('resultEmpty');
    timerDownloadTxtBtn.textContent = t('downloadTxt');
    timerDownloadJsonBtn.textContent = t('downloadJson');
    timerNewBtn.textContent = t('newTimer');
    timerBackMainBtn.textContent = t('backToMain');

    drawerStatDupLabel.textContent = t('statRepeated');
    drawerStatDictLabel.textContent = t('statDictionary');
    listSearchInput.placeholder = t('filterPlaceholder');
    listSearchInput.setAttribute('aria-label', t('filterAria'));
    exportBtn.textContent = t('exportJson');
    importBtnLabel.textContent = t('importJson');
    resetBtn.textContent = t('resetList');

    resetModalTitle.textContent = t('resetModalTitle');
    resetCancelBtn.textContent = t('resetCancel');
    resetConfirmBtn.textContent = t('resetConfirm');

    settingsModalTitle.textContent = t('settingsTitle');
    appLangLabel.textContent = t('appLangLabel');
    appLangHint.textContent = t('appLangHint');
    dictSectionTitle.textContent = t('dictSectionTitle');
    dictSectionHint.textContent = t('dictSectionHint');
    quickSectionTitle.textContent = t('quickSectionTitle');
    quickSectionHint.textContent = t('quickSectionHint');
    dictNoteTitle.textContent = t('dictNoteTitle');
    dictNoteText.textContent = t('dictNoteText');
    dictSourceLabel.textContent = t('dictSourceLabel');
    dictBaseUrlSaveBtn.textContent = t('dictSourceSave');
    dictBaseUrlInput.value = dictBaseUrl;

    voiceSectionTitle.textContent = t('voiceSectionTitle');
    voiceSectionHint.textContent = t('voiceSectionHint');
    audioFeedbackLabel.textContent = t('audioFeedbackLabel');
    audioFeedbackHint.textContent = t('audioFeedbackHint');
    voiceModelLabel.textContent = t('voiceModelLabel');

    updateListenButtonUI();
    updateVoiceModelUI();
    populateAppLanguageSelect();
    updateSortButtonUI();
    updateTimerUI();
    updateCounters();
    renderWordList();
    renderSettingsLists();
    if (activeMode === 'timer' && timerState.status === 'finished') {
      renderTimerResult();
    }
    renderFeedbackStatus();
  }

  function handleExistingWord(entry, { isSpoken = false } = {}) {
    const store = getActiveStore();
    entry.repeatCount += 1;
    store.duplicateCount += 1;
    pendingUnknownWord = null;
    if (activeMode === 'main') saveMainState();
    updateCounters();
    if (!infoDrawer.hidden) renderWordList();

    if (!isSpoken) wordInput.value = '';
    setStatus('duplicate', { kind: 'duplicate', word: entry.text, extra: entry.repeatCount }, 'duplicate', false);
    if (isSpoken && voiceController.isSupported()) {
      voiceController.playFeedback('duplicate');
    }
  }

  function handleNewWord(cleaned, normalized, forced, { isSpoken = false } = {}) {
    const store = getActiveStore();
    const newEntry = {
      text: cleaned,
      normalized,
      repeatCount: 0,
      forced,
      createdAt: new Date().toISOString(),
    };
    store.words.push(newEntry);
    store.index.set(normalized, newEntry);
    pendingUnknownWord = null;
    if (activeMode === 'main') saveMainState();
    updateCounters();
    if (!infoDrawer.hidden) renderWordList();

    if (!isSpoken) wordInput.value = '';
    setStatus('new', { kind: 'new', word: cleaned, forced }, 'new', false);
    if (isSpoken && voiceController.isSupported()) {
      voiceController.playFeedback('new');
    }
  }

  async function processSingleWord(cleaned, { isSpoken = false } = {}) {
    if (!cleaned || timerState.status === 'finished') return;

    await dictionaryLoadPromise;

    const langMeta = findCatalogEntry(activeDictLang);
    const normalized = normalizeKey(cleaned, langMeta);
    const store = getActiveStore();
    const existing = store.index.get(normalized);

    if (existing) {
      handleExistingWord(existing, { isSpoken });
      return;
    }

    const canonical = lookupDictionaryWord(cleaned, langMeta);
    if (canonical) {
      handleNewWord(canonical, normalized, false, { isSpoken });
      return;
    }

    pendingUnknownWord = cleaned;
    if (!isSpoken) {
      triggerPulse(inputShell, 'is-shake');
    } else if (voiceController.isSupported()) {
      voiceController.playFeedback('unknown');
    }
    setStatus('unknown', { kind: 'unknown', word: cleaned }, 'unknown', true);
  }

  async function handleWordSubmit() {
    if (timerState.status === 'finished') return;
    const cleaned = cleanWord(wordInput.value);
    if (!cleaned) return;
    await processSingleWord(cleaned, { isSpoken: false });
  }

  async function handleVoiceTranscript(rawText) {
    if (!rawText || timerState.status === 'finished' || !VoiceLib) return;
    await dictionaryLoadPromise;
    const langMeta = findCatalogEntry(activeDictLang);
    const words = VoiceLib.extractWordsFromTranscript(rawText, activeDictLang, (candidate) =>
      Boolean(lookupDictionaryWord(candidate, langMeta))
    );
    for (const w of words) {
      await processSingleWord(w, { isSpoken: true });
    }
  }

  function handleForceAccept() {
    if (timerState.status === 'finished') return;

    const cleaned = cleanWord(wordInput.value) || pendingUnknownWord;
    if (!cleaned) return;

    const langMeta = findCatalogEntry(activeDictLang);
    const normalized = normalizeKey(cleaned, langMeta);
    const store = getActiveStore();
    const existing = store.index.get(normalized);
    if (existing) {
      handleExistingWord(existing);
      wordInput.focus();
      return;
    }

    handleNewWord(cleaned, normalized, true);
    if (wordInput.value === cleaned) {
      wordInput.value = '';
    }
    wordInput.focus();
  }

  function updateListenButtonUI() {
    if (!voiceController.isSupported()) {
      listenToggleBtn.hidden = true;
      return;
    }
    listenToggleBtn.hidden = false;
    const isListening = voiceController.isListening();
    const isLoading = voiceController.isLoading();
    const state = isLoading ? 'loading' : (isListening ? 'listening' : 'idle');
    listenToggleBtn.dataset.state = state;
    listenToggleBtn.setAttribute('aria-pressed', String(isListening));
    listenBtnLabel.textContent = isLoading
      ? t('listenBtnLoading')
      : (isListening ? t('listenBtnActive') : t('listenBtnIdle'));
  }

  function updateVoiceModelUI() {
    if (!voiceController.isSupported()) {
      voiceSettingsBlock.hidden = true;
      return;
    }
    voiceSettingsBlock.hidden = false;
    audioFeedbackToggle.checked = audioFeedbackEnabled;

    if (voiceController.mode !== 'android') {
      voiceModelRow.hidden = true;
      return;
    }

    voiceModelRow.hidden = false;
    if (voiceModelStatusState.downloading) {
      voiceModelStatus.textContent = t('voiceModelDownloading', { pct: voiceModelStatusState.progress });
      voiceModelDlBtn.hidden = false;
      voiceModelDlBtn.disabled = true;
      voiceModelDlBtn.textContent = t('dictDownloading');
      voiceModelRmBtn.hidden = true;
    } else if (voiceModelStatusState.downloaded) {
      voiceModelStatus.textContent = t('voiceModelReady');
      voiceModelDlBtn.hidden = true;
      voiceModelRmBtn.hidden = false;
      voiceModelRmBtn.textContent = t('dictDeleteBtn');
    } else {
      voiceModelStatus.textContent = t('voiceModelMissing');
      voiceModelDlBtn.hidden = false;
      voiceModelDlBtn.disabled = false;
      voiceModelDlBtn.textContent = t('dictDownloadBtn');
      voiceModelRmBtn.hidden = true;
    }
  }

  async function refreshVoiceModelStatus() {
    if (!voiceController.isSupported()) return;
    try {
      const status = await voiceController.getModelStatus();
      voiceModelStatusState.downloaded = Boolean(status && status.downloaded);
      voiceModelStatusState.downloading = Boolean(status && status.downloading);
      updateVoiceModelUI();
      updateListenButtonUI();
    } catch {
      // ignore
    }
  }

  function formatTimer(totalSeconds) {
    const safe = Math.max(0, Math.ceil(totalSeconds));
    const mins = Math.floor(safe / 60);
    const secs = safe % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function playTimerChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      [660, 880].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.08, now + idx * 0.16);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.16 + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.16);
        osc.stop(now + idx * 0.16 + 0.26);
      });
    } catch {
      // optional audio
    }
  }

  function updateTimerUI() {
    if (timerState.status === 'idle') {
      timerPill.dataset.state = 'idle';
      timerLabel.textContent = t('timerIdle');
      timerActiveActions.hidden = true;
      return;
    }

    if (timerState.status === 'finished') {
      timerPill.dataset.state = 'urgent';
      timerLabel.textContent = '00:00';
      timerActiveActions.hidden = true;
      return;
    }

    timerLabel.textContent = formatTimer(timerState.remainingSeconds);
    timerActiveActions.hidden = false;

    if (timerState.status === 'paused') {
      timerPill.dataset.state = 'paused';
      timerPauseBtn.setAttribute('aria-label', t('timerResumeAria'));
      timerPauseIcon.hidden = true;
      timerPlayIcon.hidden = false;
    } else {
      timerPill.dataset.state = timerState.remainingSeconds <= 10 ? 'urgent' : 'running';
      timerPauseBtn.setAttribute('aria-label', t('timerPauseAria'));
      timerPauseIcon.hidden = false;
      timerPlayIcon.hidden = true;
    }
  }

  function clearTimerInterval() {
    if (timerState.intervalId !== null) {
      clearInterval(timerState.intervalId);
      timerState.intervalId = null;
    }
  }

  function closeTimerPopover() {
    timerPopover.hidden = true;
    timerToggleBtn.setAttribute('aria-expanded', 'false');
  }

  function openTimerPopover() {
    timerPopover.hidden = false;
    timerToggleBtn.setAttribute('aria-expanded', 'true');
  }

  function toggleTimerPopover() {
    if (timerPopover.hidden) {
      openTimerPopover();
    } else {
      closeTimerPopover();
    }
  }

  function finishTimer() {
    clearTimerInterval();
    if (voiceController.isSupported() && voiceController.isListening()) {
      voiceController.stop().catch(() => {});
    }
    timerState.status = 'finished';
    timerState.remainingSeconds = 0;
    pendingUnknownWord = null;
    wordInput.value = '';
    setStatus('idle', null, null, false);
    updateTimerUI();
    updateStageVisibility();
    if (!infoDrawer.hidden) renderWordList();
    playTimerChime();
  }

  function tickTimer() {
    if (timerState.status !== 'running') return;
    const msLeft = timerState.endTimeMs - Date.now();
    const secsLeft = Math.max(0, Math.ceil(msLeft / 1000));
    timerState.remainingSeconds = secsLeft;
    updateTimerUI();
    if (secsLeft <= 0) {
      finishTimer();
    }
  }

  function startTimer(seconds) {
    clearTimerInterval();
    closeModals();
    closeTimerPopover();

    clearStore(timerCache);
    activeMode = 'timer';
    pendingUnknownWord = null;
    wordInput.value = '';
    setStatus('idle', null, null, false);

    timerState.durationSeconds = seconds;
    timerState.remainingSeconds = seconds;
    timerState.endTimeMs = Date.now() + seconds * 1000;
    timerState.status = 'running';

    updateStageVisibility();
    updateTimerUI();
    updateCounters();
    if (!infoDrawer.hidden) renderWordList();

    timerState.intervalId = setInterval(tickTimer, 250);
    wordInput.focus();
  }

  function togglePauseTimer() {
    if (timerState.status === 'running') {
      clearTimerInterval();
      timerState.status = 'paused';
      updateTimerUI();
    } else if (timerState.status === 'paused') {
      timerState.endTimeMs = Date.now() + timerState.remainingSeconds * 1000;
      timerState.status = 'running';
      updateTimerUI();
      timerState.intervalId = setInterval(tickTimer, 250);
      wordInput.focus();
    }
  }

  function returnToMainMode({ skipFocus = false } = {}) {
    clearTimerInterval();
    closeTimerPopover();
    clearStore(timerCache);
    activeMode = 'main';
    timerState.status = 'idle';
    timerState.remainingSeconds = 0;
    pendingUnknownWord = null;
    wordInput.value = '';
    setStatus('idle', null, null, false);
    updateStageVisibility();
    updateTimerUI();
    updateCounters();
    if (!infoDrawer.hidden) renderWordList();
    if (!skipFocus) wordInput.focus();
  }

  function closeModals() {
    modalBackdrop.hidden = true;
    resetModal.hidden = true;
    settingsModal.hidden = true;
    openSettingsBtn.setAttribute('aria-expanded', 'false');
  }

  function openResetModal() {
    closeModals();
    const store = getActiveStore();
    const total = store.words.length;
    const wordsText = total === 1
      ? t('wordCountSingle')
      : t('wordCountPlural', { n: formatNumber(total) });
    resetModalDesc.textContent = total > 0
      ? t('resetModalDescSome', { words: wordsText })
      : t('resetModalDescEmpty');
    modalBackdrop.hidden = false;
    resetModal.hidden = false;
    resetCancelBtn.focus();
  }

  function openSettingsModal() {
    closeModals();
    closeTimerPopover();
    dictErrorBanner.hidden = true;
    renderSettingsLists();
    modalBackdrop.hidden = false;
    settingsModal.hidden = false;
    openSettingsBtn.setAttribute('aria-expanded', 'true');
    appLanguageSelect.focus();
  }

  function openDrawer() {
    if (drawerCloseTimer) {
      clearTimeout(drawerCloseTimer);
      drawerCloseTimer = null;
    }
    closeTimerPopover();
    renderWordList();

    drawerBackdrop.hidden = false;
    infoDrawer.hidden = false;
    openInfoBtn.setAttribute('aria-expanded', 'true');

    requestAnimationFrame(() => {
      drawerBackdrop.classList.add('is-open');
      infoDrawer.classList.add('is-open');
    });

    closeInfoBtn.focus();
  }

  function closeDrawer() {
    drawerBackdrop.classList.remove('is-open');
    infoDrawer.classList.remove('is-open');
    openInfoBtn.setAttribute('aria-expanded', 'false');

    drawerCloseTimer = setTimeout(() => {
      drawerBackdrop.hidden = true;
      infoDrawer.hidden = true;
      drawerCloseTimer = null;
    }, 240);

    if (!wordInput.disabled) {
      wordInput.focus();
    }
  }

  function triggerDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function exportStoreAsJson(store, prefix) {
    const payload = {
      language: activeDictLang,
      words: store.words,
      duplicateCount: store.duplicateCount,
      exportedAt: new Date().toISOString(),
    };
    triggerDownload(
      `${prefix}-${activeDictLang}-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      'application/json'
    );
  }

  function exportTimerCacheAsTxt() {
    const lines = timerCache.words.map((entry) =>
      entry.repeatCount > 0 ? `${entry.text} (${t('repeatBadge', { n: entry.repeatCount })})` : entry.text
    );
    triggerDownload(
      `timer-words-${activeDictLang}-${new Date().toISOString().slice(0, 10)}.txt`,
      lines.join('\n'),
      'text/plain;charset=utf-8'
    );
  }

  function importDatabase(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result || ''));
        const langMeta = findCatalogEntry(activeDictLang);
        const sanitized = sanitizeSavePayload(parsed, langMeta);
        if (!sanitized) {
          setStatus('unknown', { kind: 'importBadFormat' }, 'unknown', false);
          return;
        }
        const store = getActiveStore();
        store.words = sanitized.words;
        store.duplicateCount = sanitized.duplicateCount;
        rebuildIndex(store, langMeta);
        if (activeMode === 'main') await saveMainState();
        updateCounters();
        renderWordList();
        if (activeMode === 'timer' && timerState.status === 'finished') {
          renderTimerResult();
        }
        setStatus('new', { kind: 'imported', extra: store.words.length }, 'new', false);
      } catch {
        setStatus('unknown', { kind: 'importReadError' }, 'unknown', false);
      } finally {
        importInput.value = '';
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  // Event Listeners
  wordInput.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleWordSubmit();
    }
  });

  wordInput.addEventListener('input', (event) => {
    if (event.isComposing) return;

    const rawValue = wordInput.value;
    if (/\s$/.test(rawValue)) {
      const cleaned = cleanWord(rawValue);
      if (!cleaned) {
        wordInput.value = '';
        return;
      }
      wordInput.value = cleaned;
      handleWordSubmit();
      return;
    }

    if (pendingUnknownWord !== null) {
      pendingUnknownWord = null;
      setStatus('idle', null, null, false);
    }
  });

  forceAcceptBtn.addEventListener('click', handleForceAccept);

  timerToggleBtn.addEventListener('click', toggleTimerPopover);
  timerPauseBtn.addEventListener('click', togglePauseTimer);
  timerStopBtn.addEventListener('click', () => returnToMainMode());
  timerPresetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const secs = Number(btn.dataset.seconds);
      if (secs > 0) startTimer(secs);
    });
  });

  timerDownloadTxtBtn.addEventListener('click', exportTimerCacheAsTxt);
  timerDownloadJsonBtn.addEventListener('click', () => exportStoreAsJson(timerCache, 'timer-words'));
  timerNewBtn.addEventListener('click', openTimerPopover);
  timerBackMainBtn.addEventListener('click', () => returnToMainMode());

  openInfoBtn.addEventListener('click', openDrawer);
  closeInfoBtn.addEventListener('click', closeDrawer);
  drawerBackdrop.addEventListener('click', closeDrawer);

  openSettingsBtn.addEventListener('click', openSettingsModal);
  settingsCloseBtn.addEventListener('click', closeModals);
  appLanguageSelect.addEventListener('change', async () => {
    appLangSetting = appLanguageSelect.value;
    effectiveUiLang = I18n.resolveEffectiveLang(appLangSetting);
    await DB.setMeta('appLangSetting', appLangSetting);
    applyTranslations();
  });

  document.addEventListener('click', (event) => {
    if (!timerPopover.hidden && !timerWrap.contains(event.target) && event.target !== timerNewBtn) {
      closeTimerPopover();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!resetModal.hidden || !settingsModal.hidden) {
      closeModals();
      return;
    }
    if (!timerPopover.hidden) {
      closeTimerPopover();
      return;
    }
    if (!infoDrawer.hidden) {
      closeDrawer();
    }
  });

  listSearchInput.addEventListener('input', renderWordList);
  sortModeBtn.addEventListener('click', cycleSortMode);

  exportBtn.addEventListener('click', () => {
    exportStoreAsJson(getActiveStore(), activeMode === 'timer' ? 'timer-words' : 'word-collector');
  });
  importInput.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    importDatabase(file);
  });

  resetBtn.addEventListener('click', openResetModal);
  modalBackdrop.addEventListener('click', closeModals);
  resetCancelBtn.addEventListener('click', () => {
    closeModals();
    resetBtn.focus();
  });

  resetConfirmBtn.addEventListener('click', async () => {
    const store = getActiveStore();
    clearStore(store);
    pendingUnknownWord = null;
    if (activeMode === 'main') await saveMainState();
    updateCounters();
    renderWordList();
    if (activeMode === 'timer' && timerState.status === 'finished') {
      renderTimerResult();
    }
    closeModals();
    setStatus('idle', { kind: 'reset' }, null, false);
  });

  async function init() {
    await DB.migrateLegacySaveIfNeeded();

    const savedUiSetting = await DB.getMeta('appLangSetting', 'auto');
    appLangSetting = savedUiSetting || 'auto';
    effectiveUiLang = I18n.resolveEffectiveLang(appLangSetting);

    const installedKeys = await DB.listInstalledDictionaries();
    installedLangs = new Set(['en', ...installedKeys]);

    const savedQuick = await DB.getMeta('quickLangs', null);
    if (Array.isArray(savedQuick) && savedQuick.length > 0) {
      quickLangs = savedQuick.filter((c) => installedLangs.has(c));
    }
    if (quickLangs.length === 0) quickLangs = ['en'];

    const savedActive = await DB.getMeta('activeDictLang', 'en');
    activeDictLang = installedLangs.has(savedActive) ? savedActive : 'en';

    const savedBaseUrl = await DB.getMeta('dictBaseUrl', '');
    dictBaseUrl = typeof savedBaseUrl === 'string' ? savedBaseUrl.trim() : '';
    dictBaseUrlInput.value = dictBaseUrl;

    dictBaseUrlSaveBtn.addEventListener('click', async () => {
      dictBaseUrl = dictBaseUrlInput.value.trim();
      await DB.setMeta('dictBaseUrl', dictBaseUrl);
      dictErrorBanner.hidden = true;
    });

    const savedAudioFb = await DB.getMeta('audioFeedbackEnabled', true);
    audioFeedbackEnabled = savedAudioFb !== false;

    if (VoiceLib) {
      voiceController = VoiceLib.createVoiceController({
        onTranscript: (text) => handleVoiceTranscript(text),
        onStateChange: () => updateListenButtonUI(),
        onModelProgress: (pct) => {
          voiceModelStatusState.downloading = pct < 100;
          voiceModelStatusState.progress = pct;
          updateVoiceModelUI();
        },
        onError: (msg) => {
          voiceErrorBanner.textContent = msg;
          voiceErrorBanner.hidden = false;
          updateListenButtonUI();
        },
      });
      if (voiceController.isSupported()) {
        voiceController.setAudioFeedbackEnabled(audioFeedbackEnabled);
      }
    }

    listenToggleBtn.addEventListener('click', async () => {
      if (!voiceController.isSupported()) return;
      voiceErrorBanner.hidden = true;
      if (voiceController.isListening() || voiceController.isLoading()) {
        await voiceController.stop();
        return;
      }
      if (voiceController.mode === 'android') {
        const status = await voiceController.getModelStatus();
        if (!status.downloaded) {
          openSettingsModal();
          return;
        }
      }
      try {
        await voiceController.start(activeDictLang);
      } catch (err) {
        if (err && String(err.message).includes('MODEL_NOT_DOWNLOADED')) {
          openSettingsModal();
        } else {
          voiceErrorBanner.textContent = err && err.message ? err.message : 'Voice start failed';
          voiceErrorBanner.hidden = false;
          openSettingsModal();
        }
      }
    });

    audioFeedbackToggle.addEventListener('change', async () => {
      audioFeedbackEnabled = audioFeedbackToggle.checked;
      await DB.setMeta('audioFeedbackEnabled', audioFeedbackEnabled);
      if (voiceController.isSupported()) {
        voiceController.setAudioFeedbackEnabled(audioFeedbackEnabled);
      }
    });

    voiceModelDlBtn.addEventListener('click', async () => {
      if (!voiceController.isSupported()) return;
      voiceErrorBanner.hidden = true;
      voiceModelStatusState.downloading = true;
      voiceModelStatusState.progress = 0;
      updateVoiceModelUI();
      try {
        await voiceController.downloadModel();
        voiceModelStatusState.downloaded = true;
      } catch {
        voiceErrorBanner.textContent = t('voiceModelDownloadError');
        voiceErrorBanner.hidden = false;
      } finally {
        voiceModelStatusState.downloading = false;
        updateVoiceModelUI();
      }
    });

    voiceModelRmBtn.addEventListener('click', async () => {
      if (!voiceController.isSupported()) return;
      await voiceController.removeModel();
      voiceModelStatusState.downloaded = false;
      updateVoiceModelUI();
      updateListenButtonUI();
    });

    await loadMainSaveForLang(activeDictLang);

    updateStageVisibility();
    renderQuickLangBar();
    applyTranslations();
    await refreshVoiceModelStatus();

    dictionaryLoadPromise = ensureLanguageLoaded(activeDictLang).then(() => {
      updateCounters();
    });

    if (navigator.serviceWorker && typeof navigator.serviceWorker.register === 'function' && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  init();
})();
