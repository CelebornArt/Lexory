# Lexory

Minimalist multi-language word-memory and vocabulary app with curated offline dictionaries, per-language saves, duplicate tracking, timed cache rounds, PWA support, Android APK (Capacitor + Sherpa-ONNX), and Native PC build (Tauri 2 + Rust + Sherpa-ONNX).

## Targets & Commands

### 1. Webapp & Mobile PWA (HTTPS / GitHub Pages)
- Static web root: `www/` ([www/index.html](www/index.html))
- Local dev server:
  ```bash
  npm run dev
  ```
- GitHub Pages deployment workflow: `.github/workflows/pages.yml` automatically deploys `www/` (including all 14 curated dictionaries) on push to `main`.

### 2. Curated Language Dictionaries (14 languages)
Built-in default: **English (US & UK)**.
Optional offline packs (stored locally in `IndexedDB` and downloaded on demand in native builds from GitHub Pages / GitHub Raw, or custom URL): German (`de`), French (`fr`), Spanish (`es`), Italian (`it`), Portuguese (`pt`), Dutch (`nl`), Polish (`pl`), Russian (`ru`), Greek (`el`), Mandarin Chinese (`zh`), Japanese (`ja`), Korean (`ko`), Bengali (`bn`).
- Rebuild dictionaries:
  ```bash
  npm run build:dicts
  ```

### 3. Android App (`.apk` / `.aab`) via Capacitor
- Bundles English (`en`) only; downloads remaining 13 language packs + optional Whisper-Tiny speech recognition model on demand.
- Sync web assets into Android project (and strip optional dictionaries):
  ```bash
  npm run cap:sync
  ```
- Build Debug APK (split by ABI: `arm64-v8a` & `x86_64` in `android/app/build/outputs/apk/debug/`):
  ```bash
  npm run android:apk
  ```

### 4. Native PC App (for Steam / Windows) via Tauri 2
- Launch desktop app locally:
  ```bash
  npm run pc:start
  ```
- Build Windows executable + NSIS installer (`src-tauri/target/release/`):
  ```bash
  npm run pc:build
  ```

## Credits & Sources
- [LibreOffice Dictionaries](https://github.com/LibreOffice/dictionaries)
- [davidak/wortliste](https://github.com/davidak/wortliste)
- [FrequencyWords](https://github.com/hermitdave/FrequencyWords)
- [Sherpa-ONNX](https://github.com/k2-fsa/sherpa-onnx)
