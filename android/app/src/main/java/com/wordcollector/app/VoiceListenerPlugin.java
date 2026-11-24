package com.wordcollector.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(
        name = "VoiceListener",
        permissions = {
                @Permission(strings = {Manifest.permission.RECORD_AUDIO}, alias = "microphone"),
                @Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "notifications")
        }
)
public class VoiceListenerPlugin extends Plugin {
    private static final String BASE_MODEL_URL = "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/resolve/main/";
    private static final String[] MODEL_FILES = {
            "tiny-encoder.int8.onnx",
            "tiny-decoder.int8.onnx",
            "tiny-tokens.txt"
    };

    private static volatile VoiceListenerPlugin instance;
    private static final List<String> pendingTranscripts = new ArrayList<>();
    private final Object downloadLock = new Object();
    private volatile boolean isDownloading = false;

    @Override
    public void load() {
        super.load();
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) {
            instance = null;
        }
        super.handleOnDestroy();
    }

    public static void onTranscriptFromService(String text) {
        synchronized (pendingTranscripts) {
            VoiceListenerPlugin plugin = instance;
            if (plugin != null && plugin.hasListeners("transcript")) {
                JSObject data = new JSObject();
                data.put("text", text);
                plugin.notifyListeners("transcript", data);
            } else {
                pendingTranscripts.add(text);
            }
        }
    }

    public static void onStateChangedFromService(boolean listening) {
        VoiceListenerPlugin plugin = instance;
        if (plugin != null) {
            JSObject data = new JSObject();
            data.put("listening", listening);
            plugin.notifyListeners("stateChange", data);
        }
    }

    public static void onErrorFromService(String message) {
        VoiceListenerPlugin plugin = instance;
        if (plugin != null) {
            JSObject data = new JSObject();
            data.put("message", message);
            plugin.notifyListeners("voiceError", data);
        }
    }

    @PluginMethod
    public void getModelStatus(PluginCall call) {
        Context ctx = getContext();
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        JSObject ret = new JSObject();
        ret.put("downloaded", VoiceForegroundService.isModelDownloaded(ctx));
        ret.put("downloading", isDownloading);
        ret.put("listening", VoiceForegroundService.isRunning());
        ret.put("musicActive", am != null && am.isMusicActive());
        call.resolve(ret);
    }

    @PluginMethod
    public void downloadModel(PluginCall call) {
        synchronized (downloadLock) {
            if (isDownloading) {
                call.reject("Model download already in progress");
                return;
            }
            isDownloading = true;
        }

        new Thread(() -> {
            try {
                File dir = VoiceForegroundService.getModelDir(getContext());
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new RuntimeException("Could not create model directory");
                }

                long totalExpected = 103609903L;
                long totalDownloaded = 0L;

                for (String filename : MODEL_FILES) {
                    File finalFile = new File(dir, filename);
                    if (finalFile.exists() && finalFile.length() > 0) {
                        totalDownloaded += finalFile.length();
                        emitProgress((int) Math.min(99, (totalDownloaded * 100L) / totalExpected), filename);
                        continue;
                    }

                    File tmpFile = new File(dir, filename + ".tmp");
                    HttpURLConnection conn = (HttpURLConnection) new URL(BASE_MODEL_URL + filename).openConnection();
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setInstanceFollowRedirects(true);
                    conn.connect();

                    int code = conn.getResponseCode();
                    if (code < 200 || code >= 300) {
                        throw new RuntimeException("HTTP " + code + " downloading " + filename);
                    }

                    try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(tmpFile)) {
                        byte[] buf = new byte[32768];
                        int read;
                        long lastNotify = 0;
                        while ((read = in.read(buf)) != -1) {
                            out.write(buf, 0, read);
                            totalDownloaded += read;
                            long now = System.currentTimeMillis();
                            if (now - lastNotify > 200) {
                                lastNotify = now;
                                int pct = (int) Math.min(99, (totalDownloaded * 100L) / totalExpected);
                                emitProgress(pct, filename);
                            }
                        }
                    }

                    if (finalFile.exists()) finalFile.delete();
                    if (!tmpFile.renameTo(finalFile)) {
                        throw new RuntimeException("Could not finalize " + filename);
                    }
                }

                emitProgress(100, "ready");
                JSObject ret = new JSObject();
                ret.put("downloaded", true);
                call.resolve(ret);
            } catch (Throwable t) {
                call.reject("Download failed: " + t.getMessage());
            } finally {
                isDownloading = false;
            }
        }, "LexoryModelDownload").start();
    }

    private void emitProgress(int percent, String file) {
        JSObject data = new JSObject();
        data.put("percent", percent);
        data.put("file", file);
        notifyListeners("modelProgress", data);
    }

    @PluginMethod
    public void removeModel(PluginCall call) {
        if (VoiceForegroundService.isRunning()) {
            Intent stopIntent = new Intent(getContext(), VoiceForegroundService.class);
            stopIntent.setAction(VoiceForegroundService.ACTION_STOP);
            getContext().startService(stopIntent);
        }
        File dir = VoiceForegroundService.getModelDir(getContext());
        if (dir.exists()) {
            File[] files = dir.listFiles();
            if (files != null) {
                for (File f : files) f.delete();
            }
            dir.delete();
        }
        JSObject ret = new JSObject();
        ret.put("downloaded", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void startListening(PluginCall call) {
        if (!VoiceForegroundService.isModelDownloaded(getContext())) {
            call.reject("MODEL_NOT_DOWNLOADED");
            return;
        }

        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermissionCallback");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notifPermissionCallback");
            return;
        }

        launchForegroundService(call);
    }

    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && getPermissionState("notifications") != PermissionState.GRANTED) {
                requestPermissionForAlias("notifications", call, "notifPermissionCallback");
            } else {
                launchForegroundService(call);
            }
        } else {
            call.reject("Microphone permission is required for Listen mode");
        }
    }

    @PermissionCallback
    private void notifPermissionCallback(PluginCall call) {
        launchForegroundService(call);
    }

    private void launchForegroundService(PluginCall call) {
        String lang = call.getString("language", "en");
        Intent intent = new Intent(getContext(), VoiceForegroundService.class);
        intent.setAction(VoiceForegroundService.ACTION_START);
        intent.putExtra(VoiceForegroundService.EXTRA_LANGUAGE, lang);
        ContextCompat.startForegroundService(getContext(), intent);

        JSObject ret = new JSObject();
        ret.put("listening", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        Intent intent = new Intent(getContext(), VoiceForegroundService.class);
        intent.setAction(VoiceForegroundService.ACTION_STOP);
        getContext().startService(intent);

        JSObject ret = new JSObject();
        ret.put("listening", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void setLanguage(PluginCall call) {
        String lang = call.getString("language", "en");
        Intent intent = new Intent(getContext(), VoiceForegroundService.class);
        intent.setAction(VoiceForegroundService.ACTION_SET_LANG);
        intent.putExtra(VoiceForegroundService.EXTRA_LANGUAGE, lang);
        if (VoiceForegroundService.isRunning()) {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void playFeedback(PluginCall call) {
        String tone = call.getString("tone", "new");
        VoiceForegroundService.playFeedbackIfAllowed(getContext(), tone);
        call.resolve();
    }

    @PluginMethod
    public void drainPendingTranscripts(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (pendingTranscripts) {
            for (String item : pendingTranscripts) {
                arr.put(item);
            }
            pendingTranscripts.clear();
        }
        JSObject ret = new JSObject();
        ret.put("items", arr);
        call.resolve(ret);
    }
}
