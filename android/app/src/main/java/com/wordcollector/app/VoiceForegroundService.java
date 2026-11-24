package com.wordcollector.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult;
import com.k2fsa.sherpa.onnx.OfflineStream;
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig;

import java.io.File;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class VoiceForegroundService extends Service {
    private static final String TAG = "LexoryVoice";
    private static final String CHANNEL_ID = "lexory_voice_channel";
    private static final int NOTIFICATION_ID = 4102;

    public static final String ACTION_START = "com.wordcollector.app.voice.START";
    public static final String ACTION_STOP = "com.wordcollector.app.voice.STOP";
    public static final String ACTION_SET_LANG = "com.wordcollector.app.voice.SET_LANG";
    public static final String EXTRA_LANGUAGE = "language";

    private static final int SAMPLE_RATE = 16000;
    private static final int FRAME_SAMPLES = 480; // 30ms
    private static final int PREROLL_FRAMES = 10; // 300ms
    private static final int SILENCE_FRAMES_END = 22; // ~660ms
    private static final int MAX_SPEECH_SAMPLES = SAMPLE_RATE * 4 + SAMPLE_RATE / 2; // 4.5s
    private static final int MIN_SPEECH_SAMPLES = SAMPLE_RATE / 4; // 0.25s
    private static final float SPEECH_RMS_THRESHOLD = 0.015f;

    private static final AtomicBoolean running = new AtomicBoolean(false);
    private static volatile String activeLanguage = "en";

    private PowerManager.WakeLock wakeLock;
    private AudioRecord audioRecord;
    private Thread captureThread;
    private ExecutorService decodeExecutor;
    private OfflineRecognizer recognizer;
    private String recognizerLang = "";

    public static boolean isRunning() {
        return running.get();
    }

    public static File getModelDir(Context context) {
        return new File(context.getFilesDir(), "whisper-tiny");
    }

    public static boolean isModelDownloaded(Context context) {
        File dir = getModelDir(context);
        return new File(dir, "tiny-encoder.int8.onnx").exists()
                && new File(dir, "tiny-decoder.int8.onnx").exists()
                && new File(dir, "tiny-tokens.txt").exists();
    }

    public static void playFeedbackIfAllowed(Context context, String tone) {
        AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (am != null && am.isMusicActive()) {
            return;
        }

        new Thread(() -> {
            try {
                int sr = 16000;
                double[] freqs;
                double durSec;
                if ("new".equals(tone)) {
                    freqs = new double[]{660.0, 880.0};
                    durSec = 0.085;
                } else if ("duplicate".equals(tone)) {
                    freqs = new double[]{310.0};
                    durSec = 0.14;
                } else {
                    freqs = new double[]{440.0, 440.0};
                    durSec = 0.065;
                }

                int samplesPerTone = (int) (sr * durSec);
                int gapSamples = (int) (sr * 0.03);
                int totalSamples = freqs.length * samplesPerTone + Math.max(0, freqs.length - 1) * gapSamples;
                short[] pcm = new short[totalSamples];

                int offset = 0;
                for (int t = 0; t < freqs.length; t++) {
                    double freq = freqs[t];
                    for (int i = 0; i < samplesPerTone; i++) {
                        double env = Math.sin(Math.PI * i / samplesPerTone);
                        double val = Math.sin(2.0 * Math.PI * freq * i / sr) * env * 0.18;
                        pcm[offset + i] = (short) (val * 32767.0);
                    }
                    offset += samplesPerTone + gapSamples;
                }

                AudioTrack track = new AudioTrack.Builder()
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                                .build())
                        .setAudioFormat(new AudioFormat.Builder()
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .setSampleRate(sr)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                                .build())
                        .setBufferSizeInBytes(pcm.length * 2)
                        .setTransferMode(AudioTrack.MODE_STATIC)
                        .build();

                track.write(pcm, 0, pcm.length);
                track.play();
                Thread.sleep((long) (totalSamples * 1000L / sr) + 60L);
                track.stop();
                track.release();
            } catch (Throwable ignored) {
            }
        }, "LexoryTone").start();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        decodeExecutor = Executors.newSingleThreadExecutor();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;

        if (ACTION_STOP.equals(action)) {
            stopListeningInternal();
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent != null && intent.hasExtra(EXTRA_LANGUAGE)) {
            String lang = intent.getStringExtra(EXTRA_LANGUAGE);
            if (lang != null && !lang.isEmpty()) {
                activeLanguage = lang;
            }
        }

        if (ACTION_SET_LANG.equals(action)) {
            return START_STICKY;
        }

        startForegroundNotification();
        if (!running.get()) {
            startListeningInternal();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopListeningInternal();
        if (decodeExecutor != null) {
            decodeExecutor.shutdownNow();
            decodeExecutor = null;
        }
        if (recognizer != null) {
            try {
                recognizer.release();
            } catch (Throwable ignored) {
            }
            recognizer = null;
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Lexory Voice Listening",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Background microphone capture for Lexory");
            channel.setSound(null, null);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void startForegroundNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPending = PendingIntent.getActivity(
                this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        Intent stopIntent = new Intent(this, VoiceForegroundService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
                this, 1, stopIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Lexory")
                .setContentText("Listening with built-in microphone…")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .setContentIntent(openPending)
                .addAction(android.R.drawable.ic_media_pause, "Stop", stopPending)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private synchronized OfflineRecognizer ensureRecognizer(String lang) {
        if (recognizer != null && lang.equals(recognizerLang)) {
            return recognizer;
        }
        if (recognizer != null) {
            try {
                recognizer.release();
            } catch (Throwable ignored) {
            }
            recognizer = null;
        }

        File modelDir = getModelDir(this);
        OfflineWhisperModelConfig whisperConfig = new OfflineWhisperModelConfig();
        whisperConfig.setEncoder(new File(modelDir, "tiny-encoder.int8.onnx").getAbsolutePath());
        whisperConfig.setDecoder(new File(modelDir, "tiny-decoder.int8.onnx").getAbsolutePath());
        whisperConfig.setLanguage(lang);
        whisperConfig.setTask("transcribe");

        OfflineModelConfig modelConfig = new OfflineModelConfig();
        modelConfig.setWhisper(whisperConfig);
        modelConfig.setTokens(new File(modelDir, "tiny-tokens.txt").getAbsolutePath());
        modelConfig.setNumThreads(4);
        modelConfig.setProvider("cpu");
        modelConfig.setDebug(false);

        FeatureConfig featConfig = new FeatureConfig();
        featConfig.setSampleRate(SAMPLE_RATE);
        featConfig.setFeatureDim(80);

        OfflineRecognizerConfig recConfig = new OfflineRecognizerConfig();
        recConfig.setFeatConfig(featConfig);
        recConfig.setModelConfig(modelConfig);
        recConfig.setDecodingMethod("greedy_search");

        recognizer = new OfflineRecognizer(null, recConfig);
        recognizerLang = lang;
        return recognizer;
    }

    private AudioDeviceInfo findBuiltInMic(AudioManager audioManager) {
        if (audioManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return null;
        }
        AudioDeviceInfo[] inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS);
        for (AudioDeviceInfo dev : inputs) {
            if (dev.getType() == AudioDeviceInfo.TYPE_BUILTIN_MIC) {
                return dev;
            }
        }
        return null;
    }

    private void startListeningInternal() {
        if (!isModelDownloaded(this)) {
            VoiceListenerPlugin.onErrorFromService("Voice model is not downloaded");
            stopSelf();
            return;
        }

        int minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
        );
        int bufSize = Math.max(minBuf, SAMPLE_RATE * 2);

        try {
            audioRecord = new AudioRecord(
                    MediaRecorder.AudioSource.MIC,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufSize
            );
        } catch (SecurityException se) {
            VoiceListenerPlugin.onErrorFromService("Microphone permission denied");
            stopSelf();
            return;
        }

        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            VoiceListenerPlugin.onErrorFromService("Failed to initialize microphone");
            stopSelf();
            return;
        }

        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        AudioDeviceInfo builtinMic = findBuiltInMic(am);
        if (builtinMic != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            audioRecord.setPreferredDevice(builtinMic);
        }

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Lexory::VoiceListen");
            wakeLock.acquire();
        }

        running.set(true);
        VoiceListenerPlugin.onStateChangedFromService(true);

        // Pre-warm recognizer on background executor
        decodeExecutor.execute(() -> {
            try {
                ensureRecognizer(activeLanguage);
            } catch (Throwable t) {
                Log.e(TAG, "Recognizer init failed", t);
                VoiceListenerPlugin.onErrorFromService("Failed to load voice model: " + t.getMessage());
            }
        });

        captureThread = new Thread(this::captureLoop, "LexoryAudioCapture");
        captureThread.start();
    }

    private void stopListeningInternal() {
        boolean wasRunning = running.getAndSet(false);
        if (audioRecord != null) {
            try {
                audioRecord.stop();
            } catch (Throwable ignored) {
            }
            try {
                audioRecord.release();
            } catch (Throwable ignored) {
            }
            audioRecord = null;
        }
        if (captureThread != null) {
            try {
                captureThread.join(500);
            } catch (InterruptedException ignored) {
            }
            captureThread = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Throwable ignored) {
            }
            wakeLock = null;
        }
        if (wasRunning) {
            VoiceListenerPlugin.onStateChangedFromService(false);
        }
    }

    private void captureLoop() {
        short[] frame = new short[FRAME_SAMPLES];
        float[][] preRoll = new float[PREROLL_FRAMES][];
        int preRollPos = 0;
        boolean preRollFilled = false;

        ArrayList<Float> speechSamples = new ArrayList<>(SAMPLE_RATE * 2);
        boolean inSpeech = false;
        int silenceFrames = 0;

        try {
            audioRecord.startRecording();
        } catch (Throwable t) {
            VoiceListenerPlugin.onErrorFromService("Could not start recording: " + t.getMessage());
            stopSelf();
            return;
        }

        while (running.get() && audioRecord != null) {
            int read = audioRecord.read(frame, 0, FRAME_SAMPLES);
            if (read <= 0) continue;

            float[] floats = new float[read];
            double sumSq = 0.0;
            for (int i = 0; i < read; i++) {
                float v = frame[i] / 32768.0f;
                floats[i] = v;
                sumSq += v * v;
            }
            float rms = (float) Math.sqrt(sumSq / read);

            if (!inSpeech) {
                if (rms >= SPEECH_RMS_THRESHOLD) {
                    inSpeech = true;
                    silenceFrames = 0;
                    speechSamples.clear();

                    int count = preRollFilled ? PREROLL_FRAMES : preRollPos;
                    int start = preRollFilled ? preRollPos : 0;
                    for (int k = 0; k < count; k++) {
                        float[] pf = preRoll[(start + k) % PREROLL_FRAMES];
                        if (pf != null) {
                            for (float s : pf) speechSamples.add(s);
                        }
                    }
                    for (float s : floats) speechSamples.add(s);
                } else {
                    preRoll[preRollPos] = floats;
                    preRollPos = (preRollPos + 1) % PREROLL_FRAMES;
                    if (preRollPos == 0) preRollFilled = true;
                }
            } else {
                for (float s : floats) speechSamples.add(s);
                if (rms < SPEECH_RMS_THRESHOLD) {
                    silenceFrames++;
                } else {
                    silenceFrames = 0;
                }

                if (silenceFrames >= SILENCE_FRAMES_END || speechSamples.size() >= MAX_SPEECH_SAMPLES) {
                    if (speechSamples.size() >= MIN_SPEECH_SAMPLES) {
                        float[] segment = new float[speechSamples.size()];
                        for (int i = 0; i < segment.length; i++) {
                            segment[i] = speechSamples.get(i);
                        }
                        submitSegmentForDecode(segment);
                    }
                    speechSamples.clear();
                    inSpeech = false;
                    silenceFrames = 0;
                    preRollPos = 0;
                    preRollFilled = false;
                }
            }
        }
    }

    private void submitSegmentForDecode(float[] samples) {
        if (decodeExecutor == null || decodeExecutor.isShutdown()) return;
        final String lang = activeLanguage;
        decodeExecutor.execute(() -> {
            try {
                OfflineRecognizer rec = ensureRecognizer(lang);
                OfflineStream stream = rec.createStream();
                stream.acceptWaveform(samples, SAMPLE_RATE);
                rec.decode(stream);
                OfflineRecognizerResult result = rec.getResult(stream);
                stream.release();
                String text = result != null ? result.getText() : "";
                if (text != null && !text.trim().isEmpty()) {
                    VoiceListenerPlugin.onTranscriptFromService(text.trim());
                }
            } catch (Throwable t) {
                Log.e(TAG, "Decode failed", t);
            }
        });
    }
}
