mod sherpa;

use sherpa::SherpaEngine;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

struct VoiceState {
    engine: Arc<Mutex<Option<SherpaEngine>>>,
}

fn resolve_paths(app: &AppHandle) -> (PathBuf, PathBuf) {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));

    let resource_dir = app.path().resource_dir().unwrap_or_else(|_| exe_dir.clone());

    let lib_dir = if exe_dir.join("sherpa-onnx-c-api.dll").exists() {
        exe_dir.clone()
    } else if resource_dir.join("sherpa-onnx-c-api.dll").exists() {
        resource_dir.clone()
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("libs")
    };

    let model_dir = if resource_dir.join("models").join("whisper-tiny").exists() {
        resource_dir.join("models").join("whisper-tiny")
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or(Path::new("."))
            .join("models")
            .join("whisper-tiny")
    };

    (lib_dir, model_dir)
}

#[tauri::command]
async fn init_voice(app: AppHandle, state: tauri::State<'_, VoiceState>, language: String) -> Result<bool, String> {
    let engine_arc = state.engine.clone();
    let (lib_dir, model_dir) = resolve_paths(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = engine_arc.lock().map_err(|_| "Voice lock poisoned".to_string())?;
        if let Some(ref mut eng) = *guard {
            eng.ensure_language(&language)?;
        } else {
            let eng = SherpaEngine::load(&lib_dir, &model_dir, &language)?;
            *guard = Some(eng);
        }
        Ok(true)
    })
    .await
    .map_err(|e| format!("Voice task failed: {e}"))?
}

#[tauri::command]
async fn transcribe_pcm(
    app: AppHandle,
    state: tauri::State<'_, VoiceState>,
    samples: Vec<f32>,
    language: String,
) -> Result<String, String> {
    let engine_arc = state.engine.clone();
    let (lib_dir, model_dir) = resolve_paths(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = engine_arc.lock().map_err(|_| "Voice lock poisoned".to_string())?;
        if guard.is_none() {
            let eng = SherpaEngine::load(&lib_dir, &model_dir, &language)?;
            *guard = Some(eng);
        }
        guard
            .as_mut()
            .expect("initialized above")
            .transcribe(&samples, &language)
    })
    .await
    .map_err(|e| format!("Transcribe task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(VoiceState {
            engine: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![init_voice, transcribe_pcm])
        .run(tauri::generate_context!())
        .expect("error while running Lexory");
}
