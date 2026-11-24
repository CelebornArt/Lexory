use libloading::{Library, Symbol};
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_float, c_int, c_void};
use std::path::{Path, PathBuf};
use std::ptr;

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxFeatureConfig {
    sample_rate: i32,
    feature_dim: i32,
}

#[repr(C)]
struct SherpaOnnxOfflineTransducerModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    joiner: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineParaformerModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineNemoEncDecCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineWhisperModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    language: *const c_char,
    task: *const c_char,
    tail_paddings: i32,
    enable_token_timestamps: i32,
    enable_segment_timestamps: i32,
}

#[repr(C)]
struct SherpaOnnxOfflineTdnnModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineLMConfig {
    model: *const c_char,
    scale: c_float,
}

#[repr(C)]
struct SherpaOnnxOfflineSenseVoiceModelConfig {
    model: *const c_char,
    language: *const c_char,
    use_itn: i32,
}

#[repr(C)]
struct SherpaOnnxOfflineMoonshineModelConfig {
    preprocessor: *const c_char,
    encoder: *const c_char,
    uncached_decoder: *const c_char,
    cached_decoder: *const c_char,
    merged_decoder: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineFireRedAsrModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineDolphinModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineZipformerCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineCanaryModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    src_lang: *const c_char,
    tgt_lang: *const c_char,
    use_pnc: i32,
}

#[repr(C)]
struct SherpaOnnxOfflineWenetCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineOmnilingualAsrCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineMedAsrCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineFunASRNanoModelConfig {
    encoder_adaptor: *const c_char,
    llm: *const c_char,
    embedding: *const c_char,
    tokenizer: *const c_char,
    system_prompt: *const c_char,
    user_prompt: *const c_char,
    max_new_tokens: i32,
    temperature: c_float,
    top_p: c_float,
    seed: i32,
    language: *const c_char,
    itn: i32,
    hotwords: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineFireRedAsrCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineQwen3ASRModelConfig {
    conv_frontend: *const c_char,
    encoder: *const c_char,
    decoder: *const c_char,
    tokenizer: *const c_char,
    max_total_len: i32,
    max_new_tokens: i32,
    temperature: c_float,
    top_p: c_float,
    seed: i32,
    hotwords: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineCohereTranscribeModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    language: *const c_char,
    use_punct: i32,
    use_itn: i32,
}

#[repr(C)]
struct SherpaOnnxOfflineModelConfig {
    transducer: SherpaOnnxOfflineTransducerModelConfig,
    paraformer: SherpaOnnxOfflineParaformerModelConfig,
    nemo_ctc: SherpaOnnxOfflineNemoEncDecCtcModelConfig,
    whisper: SherpaOnnxOfflineWhisperModelConfig,
    tdnn: SherpaOnnxOfflineTdnnModelConfig,
    tokens: *const c_char,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
    model_type: *const c_char,
    modeling_unit: *const c_char,
    bpe_vocab: *const c_char,
    telespeech_ctc: *const c_char,
    sense_voice: SherpaOnnxOfflineSenseVoiceModelConfig,
    moonshine: SherpaOnnxOfflineMoonshineModelConfig,
    fire_red_asr: SherpaOnnxOfflineFireRedAsrModelConfig,
    dolphin: SherpaOnnxOfflineDolphinModelConfig,
    zipformer_ctc: SherpaOnnxOfflineZipformerCtcModelConfig,
    canary: SherpaOnnxOfflineCanaryModelConfig,
    wenet_ctc: SherpaOnnxOfflineWenetCtcModelConfig,
    omnilingual: SherpaOnnxOfflineOmnilingualAsrCtcModelConfig,
    medasr: SherpaOnnxOfflineMedAsrCtcModelConfig,
    funasr_nano: SherpaOnnxOfflineFunASRNanoModelConfig,
    fire_red_asr_ctc: SherpaOnnxOfflineFireRedAsrCtcModelConfig,
    qwen3_asr: SherpaOnnxOfflineQwen3ASRModelConfig,
    cohere_transcribe: SherpaOnnxOfflineCohereTranscribeModelConfig,
}

#[repr(C)]
struct SherpaOnnxHomophoneReplacerConfig {
    dict_dir: *const c_char,
    lexicon: *const c_char,
    rule_fsts: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOfflineCtcFstDecoderConfig {
    graph: *const c_char,
    max_active: i32,
}

#[repr(C)]
struct SherpaOnnxOfflineRecognizerConfig {
    feat_config: SherpaOnnxFeatureConfig,
    model_config: SherpaOnnxOfflineModelConfig,
    lm_config: SherpaOnnxOfflineLMConfig,
    decoding_method: *const c_char,
    max_active_paths: i32,
    hotwords_file: *const c_char,
    hotwords_score: c_float,
    rule_fsts: *const c_char,
    rule_fars: *const c_char,
    blank_penalty: c_float,
    hr: SherpaOnnxHomophoneReplacerConfig,
    ctc_fst_decoder_config: SherpaOnnxOfflineCtcFstDecoderConfig,
}

#[repr(C)]
struct SherpaOnnxOfflineRecognizerResult {
    text: *const c_char,
}

type FnCreateRecognizer = unsafe extern "C" fn(*const SherpaOnnxOfflineRecognizerConfig) -> *const c_void;
type FnDestroyRecognizer = unsafe extern "C" fn(*const c_void);
type FnCreateStream = unsafe extern "C" fn(*const c_void) -> *const c_void;
type FnDestroyStream = unsafe extern "C" fn(*const c_void);
type FnAcceptWaveform = unsafe extern "C" fn(*const c_void, c_int, *const c_float, c_int);
type FnDecodeStream = unsafe extern "C" fn(*const c_void, *const c_void);
type FnGetResult = unsafe extern "C" fn(*const c_void) -> *const SherpaOnnxOfflineRecognizerResult;
type FnDestroyResult = unsafe extern "C" fn(*const SherpaOnnxOfflineRecognizerResult);

pub struct SherpaEngine {
    _deps: Vec<Library>,
    lib: Library,
    recognizer: *const c_void,
    current_lang: String,
    model_dir: PathBuf,
}

unsafe impl Send for SherpaEngine {}

impl Drop for SherpaEngine {
    fn drop(&mut self) {
        if !self.recognizer.is_null() {
            unsafe {
                if let Ok(destroy) = self.lib.get::<FnDestroyRecognizer>(b"SherpaOnnxDestroyOfflineRecognizer\0") {
                    destroy(self.recognizer);
                }
            }
            self.recognizer = ptr::null();
        }
    }
}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|e| format!("Invalid string: {e}"))
}

fn zeroed_config() -> SherpaOnnxOfflineRecognizerConfig {
    unsafe { std::mem::zeroed() }
}

impl SherpaEngine {
    pub fn load(lib_dir: &Path, model_dir: &Path, language: &str) -> Result<Self, String> {
        let mut deps = Vec::new();
        for dep in ["onnxruntime_providers_shared.dll", "onnxruntime.dll"] {
            let p = lib_dir.join(dep);
            if p.exists() {
                unsafe {
                    if let Ok(l) = Library::new(&p) {
                        deps.push(l);
                    }
                }
            }
        }

        let api_path = lib_dir.join("sherpa-onnx-c-api.dll");
        let lib = unsafe { Library::new(&api_path) }
            .map_err(|e| format!("Failed to load {}: {e}", api_path.display()))?;

        let mut engine = Self {
            _deps: deps,
            lib,
            recognizer: ptr::null(),
            current_lang: String::new(),
            model_dir: model_dir.to_path_buf(),
        };
        engine.ensure_language(language)?;
        Ok(engine)
    }

    pub fn ensure_language(&mut self, language: &str) -> Result<(), String> {
        let target = if language.trim().is_empty() { "en" } else { language.trim() };
        if !self.recognizer.is_null() && self.current_lang == target {
            return Ok(());
        }

        if !self.recognizer.is_null() {
            unsafe {
                let destroy: Symbol<FnDestroyRecognizer> = self.lib
                    .get(b"SherpaOnnxDestroyOfflineRecognizer\0")
                    .map_err(|e| e.to_string())?;
                destroy(self.recognizer);
            }
            self.recognizer = ptr::null();
        }

        let encoder_p = self.model_dir.join("tiny-encoder.int8.onnx");
        let decoder_p = self.model_dir.join("tiny-decoder.int8.onnx");
        let tokens_p = self.model_dir.join("tiny-tokens.txt");

        let c_encoder = cstr(&encoder_p.to_string_lossy())?;
        let c_decoder = cstr(&decoder_p.to_string_lossy())?;
        let c_tokens = cstr(&tokens_p.to_string_lossy())?;
        let c_lang = cstr(target)?;
        let c_task = cstr("transcribe")?;
        let c_provider = cstr("cpu")?;
        let c_decoding = cstr("greedy_search")?;

        let mut cfg = zeroed_config();
        cfg.feat_config.sample_rate = 16000;
        cfg.feat_config.feature_dim = 80;
        cfg.model_config.whisper.encoder = c_encoder.as_ptr();
        cfg.model_config.whisper.decoder = c_decoder.as_ptr();
        cfg.model_config.whisper.language = c_lang.as_ptr();
        cfg.model_config.whisper.task = c_task.as_ptr();
        cfg.model_config.tokens = c_tokens.as_ptr();
        cfg.model_config.num_threads = 4;
        cfg.model_config.provider = c_provider.as_ptr();
        cfg.model_config.debug = 0;
        cfg.decoding_method = c_decoding.as_ptr();

        let recognizer = unsafe {
            let create: Symbol<FnCreateRecognizer> = self.lib
                .get(b"SherpaOnnxCreateOfflineRecognizer\0")
                .map_err(|e| e.to_string())?;
            create(&cfg)
        };

        if recognizer.is_null() {
            return Err("SherpaOnnxCreateOfflineRecognizer returned null".to_string());
        }

        self.recognizer = recognizer;
        self.current_lang = target.to_string();
        Ok(())
    }

    pub fn transcribe(&mut self, samples: &[f32], language: &str) -> Result<String, String> {
        if samples.is_empty() {
            return Ok(String::new());
        }
        self.ensure_language(language)?;

        unsafe {
            let create_stream: Symbol<FnCreateStream> = self.lib.get(b"SherpaOnnxCreateOfflineStream\0").map_err(|e| e.to_string())?;
            let accept: Symbol<FnAcceptWaveform> = self.lib.get(b"SherpaOnnxAcceptWaveformOffline\0").map_err(|e| e.to_string())?;
            let decode: Symbol<FnDecodeStream> = self.lib.get(b"SherpaOnnxDecodeOfflineStream\0").map_err(|e| e.to_string())?;
            let get_result: Symbol<FnGetResult> = self.lib.get(b"SherpaOnnxGetOfflineStreamResult\0").map_err(|e| e.to_string())?;
            let destroy_result: Symbol<FnDestroyResult> = self.lib.get(b"SherpaOnnxDestroyOfflineRecognizerResult\0").map_err(|e| e.to_string())?;
            let destroy_stream: Symbol<FnDestroyStream> = self.lib.get(b"SherpaOnnxDestroyOfflineStream\0").map_err(|e| e.to_string())?;

            let stream = create_stream(self.recognizer);
            if stream.is_null() {
                return Err("Failed to create offline stream".to_string());
            }

            accept(stream, 16000, samples.as_ptr(), samples.len() as c_int);
            decode(self.recognizer, stream);
            let res_ptr = get_result(stream);

            let text = if !res_ptr.is_null() && !(*res_ptr).text.is_null() {
                CStr::from_ptr((*res_ptr).text).to_string_lossy().into_owned()
            } else {
                String::new()
            };

            if !res_ptr.is_null() {
                destroy_result(res_ptr);
            }
            destroy_stream(stream);
            Ok(text)
        }
    }
}
