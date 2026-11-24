(() => {
  'use strict';

  function getDesktopBridge() {
    if (window.LexoryDesktop && typeof window.LexoryDesktop.transcribePcm === 'function') {
      return window.LexoryDesktop;
    }
    if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
      return {
        initVoice: (language) => window.__TAURI__.core.invoke('init_voice', { language }),
        transcribePcm: (samples, language) =>
          window.__TAURI__.core.invoke('transcribe_pcm', {
            samples: Array.from(samples),
            language,
          }),
      };
    }
    return null;
  }

  function getPlatformMode() {
    if (getDesktopBridge()) {
      return 'desktop';
    }
    if (
      window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' &&
      window.Capacitor.isNativePlatform() &&
      window.Capacitor.Plugins &&
      window.Capacitor.Plugins.VoiceListener
    ) {
      return 'android';
    }
    return null;
  }

  function getAndroidPlugin() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.VoiceListener
      ? window.Capacitor.Plugins.VoiceListener
      : null;
  }

  function cleanTranscriptText(raw) {
    if (!raw) return '';
    return String(raw)
      .replace(/\[[^\]]*\]|\([^)]*\)|♪[^♪]*♪/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function segmentCjkToken(token, lookupFn) {
    if (!token) return [];
    if (typeof lookupFn === 'function' && lookupFn(token)) {
      return [token];
    }

    const chars = Array.from(token);
    if (chars.length <= 1) return [token];

    const out = [];
    let i = 0;
    const maxWordLen = Math.min(8, chars.length);

    while (i < chars.length) {
      let matched = null;
      const limit = Math.min(maxWordLen, chars.length - i);
      for (let len = limit; len >= 2; len--) {
        const cand = chars.slice(i, i + len).join('');
        if (typeof lookupFn === 'function' && lookupFn(cand)) {
          matched = cand;
          break;
        }
      }
      if (matched) {
        out.push(matched);
        i += Array.from(matched).length;
      } else {
        out.push(chars[i]);
        i += 1;
      }
    }

    return out;
  }

  function extractWordsFromTranscript(rawText, langCode, lookupFn) {
    const cleaned = cleanTranscriptText(rawText);
    if (!cleaned) return [];

    const parts = cleaned.split(/[\s,.;:!?¡¿"„“”«»()[\]{}、。！？「」『』・]+/).filter(Boolean);
    const words = [];

    for (const part of parts) {
      const trimmed = part.replace(/^['-]+|['-]+$/g, '');
      if (!trimmed) continue;

      if ((langCode === 'zh' || langCode === 'ja') && /^[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u30FC]+$/.test(trimmed)) {
        words.push(...segmentCjkToken(trimmed, lookupFn));
      } else {
        words.push(trimmed);
      }
    }

    return words;
  }

  function downsampleTo16k(input, inputRate) {
    if (inputRate === 16000) return new Float32Array(input);
    const ratio = inputRate / 16000;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = input[idx] || 0;
      const s1 = input[Math.min(idx + 1, input.length - 1)] || s0;
      out[i] = s0 + (s1 - s0) * frac;
    }
    return out;
  }

  function createVoiceController(callbacks) {
    const mode = getPlatformMode();
    if (!mode) {
      return {
        mode: null,
        isSupported: () => false,
      };
    }

    let listening = false;
    let loading = false;
    let activeLang = 'en';
    let audioFeedbackEnabled = true;

    // Desktop audio capture state
    let mediaStream = null;
    let audioCtx = null;
    let processorNode = null;
    let sourceNode = null;
    let desktopQueue = Promise.resolve();

    // Android listener handles
    let androidBound = false;

    function playDesktopTone(tone) {
      if (!audioFeedbackEnabled) return;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const now = ctx.currentTime;
        const notes = tone === 'new' ? [660, 880] : tone === 'duplicate' ? [310] : [440, 440];
        const dur = tone === 'duplicate' ? 0.14 : 0.08;
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.06, now + idx * 0.1);
          gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.1 + dur);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + idx * 0.1);
          osc.stop(now + idx * 0.1 + dur + 0.02);
        });
        setTimeout(() => ctx.close().catch(() => {}), 500);
      } catch {
        // optional feedback
      }
    }

    async function playFeedback(tone) {
      if (!audioFeedbackEnabled) return;
      if (mode === 'desktop') {
        playDesktopTone(tone);
      } else if (mode === 'android') {
        const plugin = getAndroidPlugin();
        if (plugin) {
          plugin.playFeedback({ tone }).catch(() => {});
        }
      }
    }

    function bindAndroidListeners() {
      if (androidBound || mode !== 'android') return;
      const plugin = getAndroidPlugin();
      if (!plugin) return;
      androidBound = true;

      plugin.addListener('transcript', (data) => {
        if (data && data.text && callbacks.onTranscript) {
          callbacks.onTranscript(data.text);
        }
      });

      plugin.addListener('stateChange', (data) => {
        listening = Boolean(data && data.listening);
        loading = false;
        if (callbacks.onStateChange) callbacks.onStateChange({ listening, loading });
      });

      plugin.addListener('voiceError', (data) => {
        listening = false;
        loading = false;
        if (callbacks.onStateChange) callbacks.onStateChange({ listening, loading });
        if (callbacks.onError) callbacks.onError((data && data.message) || 'Voice error');
      });

      plugin.addListener('modelProgress', (data) => {
        if (callbacks.onModelProgress && data) {
          callbacks.onModelProgress(data.percent || 0, data.file || '');
        }
      });

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          plugin.drainPendingTranscripts().then((res) => {
            if (res && Array.isArray(res.items)) {
              for (const txt of res.items) {
                if (txt && callbacks.onTranscript) callbacks.onTranscript(txt);
              }
            }
          }).catch(() => {});
        }
      });
    }

    async function startDesktopListening() {
      loading = true;
      if (callbacks.onStateChange) callbacks.onStateChange({ listening: false, loading: true });

      const bridge = getDesktopBridge();
      try {
        await bridge.initVoice(activeLang);
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioCtx();
        sourceNode = audioCtx.createMediaStreamSource(mediaStream);
        processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

        const PREROLL_MAX = 5; // ~300-400ms
        const preRoll = [];
        let speechChunks = [];
        let speechSampleCount = 0;
        let inSpeech = false;
        let silenceChunks = 0;
        const RMS_THRESHOLD = 0.014;
        const SILENCE_CHUNKS_END = 3; // ~650-750ms at 4096/48kHz
        const MAX_SAMPLES_16K = 16000 * 4.5;
        const MIN_SAMPLES_16K = 16000 * 0.25;

        function flushSpeech() {
          if (speechSampleCount < MIN_SAMPLES_16K) {
            speechChunks = [];
            speechSampleCount = 0;
            return;
          }
          const combined = new Float32Array(speechSampleCount);
          let off = 0;
          for (const c of speechChunks) {
            combined.set(c, off);
            off += c.length;
          }
          speechChunks = [];
          speechSampleCount = 0;

          const langSnapshot = activeLang;
          desktopQueue = desktopQueue.then(async () => {
            if (!listening) return;
            const text = await bridge.transcribePcm(combined, langSnapshot);
            if (text && callbacks.onTranscript) {
              callbacks.onTranscript(text);
            }
          }).catch(() => {});
        }

        processorNode.onaudioprocess = (ev) => {
          if (!listening) return;
          const raw = ev.inputBuffer.getChannelData(0);
          const samples16 = downsampleTo16k(raw, audioCtx.sampleRate);

          let sumSq = 0;
          for (let i = 0; i < samples16.length; i++) {
            sumSq += samples16[i] * samples16[i];
          }
          const rms = Math.sqrt(sumSq / samples16.length);

          if (!inSpeech) {
            if (rms >= RMS_THRESHOLD) {
              inSpeech = true;
              silenceChunks = 0;
              speechChunks = [...preRoll, samples16];
              speechSampleCount = speechChunks.reduce((s, c) => s + c.length, 0);
            } else {
              preRoll.push(samples16);
              if (preRoll.length > PREROLL_MAX) preRoll.shift();
            }
          } else {
            speechChunks.push(samples16);
            speechSampleCount += samples16.length;
            if (rms < RMS_THRESHOLD) {
              silenceChunks += 1;
            } else {
              silenceChunks = 0;
            }

            if (silenceChunks >= SILENCE_CHUNKS_END || speechSampleCount >= MAX_SAMPLES_16K) {
              inSpeech = false;
              silenceChunks = 0;
              preRoll.length = 0;
              flushSpeech();
            }
          }
        };

        sourceNode.connect(processorNode);
        processorNode.connect(audioCtx.destination);

        listening = true;
        loading = false;
        if (callbacks.onStateChange) callbacks.onStateChange({ listening: true, loading: false });
      } catch (err) {
        stopDesktopListening();
        loading = false;
        if (callbacks.onStateChange) callbacks.onStateChange({ listening: false, loading: false });
        if (callbacks.onError) callbacks.onError(err && err.message ? err.message : 'Microphone unavailable');
      }
    }

    function stopDesktopListening() {
      listening = false;
      loading = false;
      if (processorNode) {
        try { processorNode.disconnect(); } catch {}
        processorNode = null;
      }
      if (sourceNode) {
        try { sourceNode.disconnect(); } catch {}
        sourceNode = null;
      }
      if (audioCtx) {
        try { audioCtx.close(); } catch {}
        audioCtx = null;
      }
      if (mediaStream) {
        for (const track of mediaStream.getTracks()) {
          try { track.stop(); } catch {}
        }
        mediaStream = null;
      }
      if (callbacks.onStateChange) callbacks.onStateChange({ listening: false, loading: false });
    }

    async function start(language) {
      activeLang = language || 'en';
      if (listening || loading) return;

      if (mode === 'desktop') {
        await startDesktopListening();
      } else if (mode === 'android') {
        bindAndroidListeners();
        const plugin = getAndroidPlugin();
        loading = true;
        if (callbacks.onStateChange) callbacks.onStateChange({ listening: false, loading: true });
        try {
          await plugin.startListening({ language: activeLang });
          listening = true;
          loading = false;
          if (callbacks.onStateChange) callbacks.onStateChange({ listening: true, loading: false });
        } catch (err) {
          listening = false;
          loading = false;
          if (callbacks.onStateChange) callbacks.onStateChange({ listening: false, loading: false });
          throw err;
        }
      }
    }

    async function stop() {
      if (mode === 'desktop') {
        stopDesktopListening();
      } else if (mode === 'android') {
        const plugin = getAndroidPlugin();
        if (plugin) {
          await plugin.stopListening().catch(() => {});
        }
        listening = false;
        loading = false;
        if (callbacks.onStateChange) callbacks.onStateChange({ listening: false, loading: false });
      }
    }

    async function setLanguage(language) {
      activeLang = language || 'en';
      if (mode === 'android') {
        const plugin = getAndroidPlugin();
        if (plugin) {
          await plugin.setLanguage({ language: activeLang }).catch(() => {});
        }
      } else if (mode === 'desktop' && listening) {
        const bridge = getDesktopBridge();
        if (bridge) await bridge.initVoice(activeLang).catch(() => {});
      }
    }

    async function getModelStatus() {
      if (mode === 'desktop') {
        return { downloaded: true, downloading: false, listening, bundled: true };
      }
      const plugin = getAndroidPlugin();
      if (!plugin) return { downloaded: false, downloading: false, listening: false };
      bindAndroidListeners();
      return plugin.getModelStatus();
    }

    async function downloadModel() {
      if (mode !== 'android') return { downloaded: true };
      bindAndroidListeners();
      const plugin = getAndroidPlugin();
      return plugin.downloadModel();
    }

    async function removeModel() {
      if (mode !== 'android') return { downloaded: true };
      const plugin = getAndroidPlugin();
      return plugin.removeModel();
    }

    return {
      mode,
      isSupported: () => true,
      isListening: () => listening,
      isLoading: () => loading,
      setAudioFeedbackEnabled: (enabled) => { audioFeedbackEnabled = Boolean(enabled); },
      start,
      stop,
      setLanguage,
      getModelStatus,
      downloadModel,
      removeModel,
      playFeedback,
    };
  }

  window.LexoryVoice = {
    getPlatformMode,
    extractWordsFromTranscript,
    createVoiceController,
  };
})();
