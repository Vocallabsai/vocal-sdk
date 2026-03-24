package com.vocallabs.audioeffects;

import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioFormat;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.AutomaticGainControl;
import android.media.audiofx.NoiseSuppressor;
import android.content.Context;
import android.util.Log;
import android.util.Base64;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

public class VocalLabsAudioEffectsModule extends ReactContextBaseJavaModule {
    private static final String TAG = "VocalLabsAudioEffects";
    private static final String NATIVE_MODULE_NAME = "VocalLabsAudioEffects";

    private AcousticEchoCanceler acousticEchoCanceler;
    private NoiseSuppressor noiseSuppressor;
    private AutomaticGainControl automaticGainControl;
    private AudioManager audioManager;
    private int currentAudioSessionId = -1;
    private boolean isAecEnabled = false;
    private boolean isNsEnabled = false;
    private boolean isAgcEnabled = false;

    private AudioRecord recorder;
    private Thread recordingThread;
    private volatile boolean isRecording = false;

    private int sampleRateHz = 8000;
    private int channelCount = 1;
    private int channelConfig = AudioFormat.CHANNEL_IN_MONO;
    private int audioFormat = AudioFormat.ENCODING_PCM_16BIT;
    private int bufferLengthFrames = 160;
    private int minBufferBytes = 0;

    public VocalLabsAudioEffectsModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.audioManager = (AudioManager) reactContext.getSystemService(Context.AUDIO_SERVICE);
    }

    @Override
    public String getName() {
        return NATIVE_MODULE_NAME;
    }

    /**
     * Initialize audio effects for a given AudioRecord session
     */
    @ReactMethod
    public void initializeAudioEffects(int audioSessionId, Promise promise) {
        try {
            this.currentAudioSessionId = audioSessionId;
            releaseAudioEffects();

            // Set audio mode to IN_COMMUNICATION for proper routing
            if (audioManager != null) {
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            }

            // Create and enable audio effects only for a valid session id.
            boolean initialized = false;
            if (audioSessionId > 0) {
                initialized = createAudioEffects(audioSessionId);
            } else {
                Log.w(TAG, "Invalid audioSessionId: " + audioSessionId + ". Audio effects require the actual AudioRecord session id.");
            }

            WritableMap response = Arguments.createMap();
            response.putInt("audioSessionId", audioSessionId);
            response.putBoolean("success", initialized);
            response.putBoolean("aecEnabled", isAecEnabled);
            response.putBoolean("nsEnabled", isNsEnabled);
            response.putBoolean("agcEnabled", isAgcEnabled);
            promise.resolve(response);
        } catch (Exception e) {
            Log.e(TAG, "Error initializing audio effects: " + e.getMessage(), e);
            promise.reject("INIT_ERROR", "Failed to initialize audio effects: " + e.getMessage());
        }
    }

    /**
     * Start native AudioRecord capture and emit base64 PCM16 chunks to JS.
     */
    @ReactMethod
    public void startNativeRecording(ReadableMap options, Promise promise) {
        try {
            if (isRecording) {
                promise.resolve(true);
                return;
            }

            if (options != null) {
                if (options.hasKey("sampleRate")) {
                    sampleRateHz = options.getInt("sampleRate");
                }
                if (options.hasKey("bufferLength")) {
                    bufferLengthFrames = options.getInt("bufferLength");
                }
                if (options.hasKey("channelCount")) {
                    channelCount = Math.max(1, options.getInt("channelCount"));
                }
            }

            channelConfig = channelCount > 1
                ? AudioFormat.CHANNEL_IN_STEREO
                : AudioFormat.CHANNEL_IN_MONO;

            minBufferBytes = AudioRecord.getMinBufferSize(sampleRateHz, channelConfig, audioFormat);
            if (minBufferBytes <= 0) {
                promise.reject("RECORDER_INIT_ERROR", "Invalid min buffer size for native recorder");
                return;
            }

            int requestedBytes = Math.max(bufferLengthFrames * channelCount * 2, minBufferBytes);

            if (audioManager != null) {
                audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
                audioManager.setSpeakerphoneOn(true);
            }

            recorder = new AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                sampleRateHz,
                channelConfig,
                audioFormat,
                requestedBytes
            );

            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                recorder.release();
                recorder = null;
                promise.reject("RECORDER_INIT_ERROR", "AudioRecord failed to initialize");
                return;
            }

            currentAudioSessionId = recorder.getAudioSessionId();
            releaseAudioEffects();
            createAudioEffects(currentAudioSessionId);

            recorder.startRecording();
            isRecording = true;

            recordingThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    readAudioLoop();
                }
            }, "VocalLabsNativeRecorderThread");
            recordingThread.start();

            WritableMap response = Arguments.createMap();
            response.putBoolean("success", true);
            response.putInt("audioSessionId", currentAudioSessionId);
            response.putBoolean("aecEnabled", isAecEnabled);
            response.putBoolean("nsEnabled", isNsEnabled);
            response.putBoolean("agcEnabled", isAgcEnabled);
            response.putInt("sampleRate", sampleRateHz);
            response.putInt("channelCount", channelCount);
            promise.resolve(response);
        } catch (Exception e) {
            Log.e(TAG, "Error starting native recording: " + e.getMessage(), e);
            stopNativeRecordingInternal();
            promise.reject("RECORDER_START_ERROR", "Failed to start native recording: " + e.getMessage());
        }
    }

    /**
     * Stop native AudioRecord capture.
     */
    @ReactMethod
    public void stopNativeRecording(Promise promise) {
        try {
            stopNativeRecordingInternal();
            promise.resolve(true);
        } catch (Exception e) {
            Log.e(TAG, "Error stopping native recording: " + e.getMessage(), e);
            promise.reject("RECORDER_STOP_ERROR", "Failed to stop native recording: " + e.getMessage());
        }
    }

    /**
     * Return whether native recorder is currently active.
     */
    @ReactMethod
    public void isNativeRecording(Promise promise) {
        promise.resolve(isRecording);
    }

    /**
     * Enable or disable Acoustic Echo Canceler
     */
    @ReactMethod
    public void setAcousticEchoCanceler(boolean enabled, Promise promise) {
        try {
            if (acousticEchoCanceler != null) {
                acousticEchoCanceler.setEnabled(enabled);
                isAecEnabled = enabled;
                Log.d(TAG, "AcousticEchoCanceler set to: " + enabled);
                promise.resolve(true);
            } else {
                promise.resolve(false);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error setting AEC: " + e.getMessage(), e);
            promise.reject("AEC_ERROR", "Failed to set AEC: " + e.getMessage());
        }
    }

    /**
     * Enable or disable Noise Suppressor
     */
    @ReactMethod
    public void setNoiseSuppressor(boolean enabled, Promise promise) {
        try {
            if (noiseSuppressor != null) {
                noiseSuppressor.setEnabled(enabled);
                isNsEnabled = enabled;
                Log.d(TAG, "NoiseSuppressor set to: " + enabled);
                promise.resolve(true);
            } else {
                promise.resolve(false);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error setting NS: " + e.getMessage(), e);
            promise.reject("NS_ERROR", "Failed to set NS: " + e.getMessage());
        }
    }

    /**
     * Enable or disable Automatic Gain Control
     */
    @ReactMethod
    public void setAutomaticGainControl(boolean enabled, Promise promise) {
        try {
            if (automaticGainControl != null) {
                automaticGainControl.setEnabled(enabled);
                isAgcEnabled = enabled;
                Log.d(TAG, "AutomaticGainControl set to: " + enabled);
                promise.resolve(true);
            } else {
                promise.resolve(false);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error setting AGC: " + e.getMessage(), e);
            promise.reject("AGC_ERROR", "Failed to set AGC: " + e.getMessage());
        }
    }

    /**
     * Get status of all audio effects
     */
    @ReactMethod
    public void getAudioEffectsStatus(Promise promise) {
        try {
            WritableMap status = Arguments.createMap();
            status.putBoolean("aecAvailable", AcousticEchoCanceler.isAvailable());
            status.putBoolean("aecEnabled", isAecEnabled);
            status.putBoolean("nsAvailable", NoiseSuppressor.isAvailable());
            status.putBoolean("nsEnabled", isNsEnabled);
            status.putBoolean("agcAvailable", AutomaticGainControl.isAvailable());
            status.putBoolean("agcEnabled", isAgcEnabled);
            status.putInt("audioSessionId", currentAudioSessionId);
            status.putBoolean("initialized", isAecEnabled || isNsEnabled || isAgcEnabled);
            promise.resolve(status);
        } catch (Exception e) {
            Log.e(TAG, "Error getting status: " + e.getMessage(), e);
            promise.reject("STATUS_ERROR", "Failed to get audio effects status: " + e.getMessage());
        }
    }

    /**
     * Clean up and release all audio effects
     */
    @ReactMethod
    public void releaseAudioEffectsMethod(Promise promise) {
        try {
            releaseAudioEffects();
            promise.resolve(true);
        } catch (Exception e) {
            Log.e(TAG, "Error releasing effects: " + e.getMessage(), e);
            promise.reject("RELEASE_ERROR", "Failed to release audio effects: " + e.getMessage());
        }
    }

    // Private helper methods

    private boolean createAudioEffects(int audioSessionId) {
        boolean createdAny = false;
        try {
            // Create AcousticEchoCanceler if available
            if (AcousticEchoCanceler.isAvailable()) {
                acousticEchoCanceler = AcousticEchoCanceler.create(audioSessionId);
                if (acousticEchoCanceler != null) {
                    acousticEchoCanceler.setEnabled(true);
                    isAecEnabled = true;
                    createdAny = true;
                    Log.d(TAG, "AcousticEchoCanceler created and enabled");
                } else {
                    Log.w(TAG, "AcousticEchoCanceler.create returned null for session: " + audioSessionId);
                }
            } else {
                Log.w(TAG, "AcousticEchoCanceler is not available on this device");
            }

            // Create NoiseSuppressor if available
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(audioSessionId);
                if (noiseSuppressor != null) {
                    noiseSuppressor.setEnabled(true);
                    isNsEnabled = true;
                    createdAny = true;
                    Log.d(TAG, "NoiseSuppressor created and enabled");
                } else {
                    Log.w(TAG, "NoiseSuppressor.create returned null for session: " + audioSessionId);
                }
            } else {
                Log.w(TAG, "NoiseSuppressor is not available on this device");
            }

            // Create AutomaticGainControl if available
            if (AutomaticGainControl.isAvailable()) {
                automaticGainControl = AutomaticGainControl.create(audioSessionId);
                if (automaticGainControl != null) {
                    automaticGainControl.setEnabled(true);
                    isAgcEnabled = true;
                    createdAny = true;
                    Log.d(TAG, "AutomaticGainControl created and enabled");
                } else {
                    Log.w(TAG, "AutomaticGainControl.create returned null for session: " + audioSessionId);
                }
            } else {
                Log.w(TAG, "AutomaticGainControl is not available on this device");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error creating audio effects: " + e.getMessage(), e);
        }
        return createdAny;
    }

    private void releaseAudioEffects() {
        try {
            if (acousticEchoCanceler != null) {
                acousticEchoCanceler.release();
                acousticEchoCanceler = null;
                isAecEnabled = false;
            }
            if (noiseSuppressor != null) {
                noiseSuppressor.release();
                noiseSuppressor = null;
                isNsEnabled = false;
            }
            if (automaticGainControl != null) {
                automaticGainControl.release();
                automaticGainControl = null;
                isAgcEnabled = false;
            }
            Log.d(TAG, "Audio effects released");
        } catch (Exception e) {
            Log.e(TAG, "Error releasing audio effects: " + e.getMessage(), e);
        }
    }

    private void readAudioLoop() {
        if (recorder == null) {
            return;
        }

        int frameBytes = Math.max(1, bufferLengthFrames * channelCount * 2);
        byte[] audioBuffer = new byte[frameBytes];

        while (isRecording && recorder != null) {
            int bytesRead = recorder.read(audioBuffer, 0, audioBuffer.length);
            if (bytesRead > 0) {
                emitAudioChunk(audioBuffer, bytesRead);
            } else if (bytesRead < 0) {
                Log.w(TAG, "AudioRecord read returned error: " + bytesRead);
            }
        }
    }

    private void emitAudioChunk(byte[] buffer, int length) {
        try {
            byte[] payload = buffer;
            if (length != buffer.length) {
                payload = new byte[length];
                System.arraycopy(buffer, 0, payload, 0, length);
            }

            String base64Chunk = Base64.encodeToString(payload, Base64.NO_WRAP);
            WritableMap params = Arguments.createMap();
            params.putString("base64", base64Chunk);
            params.putInt("sampleRate", sampleRateHz);
            params.putInt("channelCount", channelCount);
            params.putInt("bytesPerSample", 2);
            params.putInt("byteLength", length);

            ReactApplicationContext context = getReactApplicationContext();
            if (context != null && context.hasActiveCatalystInstance()) {
                context
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit("VocalLabsAudioEffectsNativeChunk", params);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to emit native audio chunk: " + e.getMessage(), e);
        }
    }

    private void stopNativeRecordingInternal() {
        isRecording = false;

        if (recordingThread != null) {
            try {
                recordingThread.interrupt();
                recordingThread.join(150);
            } catch (Exception ignored) {
            }
            recordingThread = null;
        }

        if (recorder != null) {
            try {
                recorder.stop();
            } catch (Exception ignored) {
            }
            try {
                recorder.release();
            } catch (Exception ignored) {
            }
            recorder = null;
        }

        if (audioManager != null) {
            try {
                audioManager.setMode(AudioManager.MODE_NORMAL);
            } catch (Exception ignored) {
            }
        }

        releaseAudioEffects();
    }
}
