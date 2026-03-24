import { Platform } from 'react-native';

// @ts-ignore - NativeModules is available at runtime on React Native
let NativeModules: any = {};
try {
  // Dynamic require to avoid TypeScript errors in non-RN environments
  const rn = require('react-native');
  NativeModules = rn.NativeModules || {};
} catch (e) {
  // Ignore error in non-RN environments
}

export interface AudioEffectsStatus {
  aecAvailable: boolean;
  aecEnabled: boolean;
  nsAvailable: boolean;
  nsEnabled: boolean;
  agcAvailable: boolean;
  agcEnabled: boolean;
  audioSessionId: number;
  initialized?: boolean;
}

export interface NativeRecordingOptions {
  sampleRate: number;
  bufferLength: number;
  channelCount: number;
}

export interface NativeAudioChunkEvent {
  base64: string;
  sampleRate: number;
  channelCount: number;
  bytesPerSample: number;
  byteLength: number;
}

interface AudioEffectsResponse {
  audioSessionId?: number;
  success?: boolean;
  aecEnabled?: boolean;
  nsEnabled?: boolean;
  agcEnabled?: boolean;
}

class VocalLabsAudioEffects {
  private nativeModule: any;
  private isInitialized: boolean = false;
  private nativeChunkSubscription: any = null;

  constructor() {
    // Only available on Android
    if (Platform.OS === 'android') {
      this.nativeModule = NativeModules.VocalLabsAudioEffects;
      if (!this.nativeModule) {
        console.warn('VocalLabsAudioEffects native module not found. Audio effects will be unavailable.');
      }
    }
  }

  /**
   * Initialize audio effects with an AudioRecord session ID
   * @param audioSessionId The audio session ID from AudioRecord.getAudioSessionId()
   */
  async initializeAudioEffects(audioSessionId: number): Promise<boolean> {
    if (!this.nativeModule) {
      console.warn('Audio effects not available on this platform');
      return false;
    }

    if (!audioSessionId || audioSessionId <= 0) {
      // AEC/NS/AGC must be created with the real AudioRecord session id.
      console.warn('[AudioEffects] Skipping init: invalid audio session id', audioSessionId);
      this.isInitialized = false;
      return false;
    }

    try {
      const response: AudioEffectsResponse = await this.nativeModule.initializeAudioEffects(audioSessionId);
      this.isInitialized = response.success ?? false;
      if (this.isInitialized) {
        console.log('[AudioEffects] Initialized with session', audioSessionId, '- Success:', this.isInitialized);
      } else {
        console.warn('[AudioEffects] Init did not enable effects for session', audioSessionId);
      }
      return this.isInitialized;
    } catch (error) {
      console.error('[AudioEffects] Initialization failed:', error);
      return false;
    }
  }

  async startNativeRecording(options: NativeRecordingOptions): Promise<boolean> {
    if (!this.nativeModule || Platform.OS !== 'android') {
      return false;
    }

    try {
      const result = await this.nativeModule.startNativeRecording(options);
      this.isInitialized = !!(result?.aecEnabled || result?.nsEnabled || result?.agcEnabled);
      console.log('[AudioEffects] Native recording started', result);
      return !!result?.success;
    } catch (error) {
      console.error('[AudioEffects] Failed to start native recording:', error);
      return false;
    }
  }

  async stopNativeRecording(): Promise<boolean> {
    if (!this.nativeModule || Platform.OS !== 'android') {
      return false;
    }

    try {
      await this.nativeModule.stopNativeRecording();
      console.log('[AudioEffects] Native recording stopped');
      return true;
    } catch (error) {
      console.error('[AudioEffects] Failed to stop native recording:', error);
      return false;
    }
  }

  subscribeNativeChunks(callback: (event: NativeAudioChunkEvent) => void): () => void {
    if (Platform.OS !== 'android') {
      return () => {};
    }

    let deviceEventEmitter: any;
    try {
      const rn = require('react-native');
      deviceEventEmitter = rn.DeviceEventEmitter;
    } catch (e) {
      return () => {};
    }

    if (!deviceEventEmitter) {
      return () => {};
    }

    this.nativeChunkSubscription = deviceEventEmitter.addListener(
      'VocalLabsAudioEffectsNativeChunk',
      callback
    );

    return () => {
      if (this.nativeChunkSubscription) {
        this.nativeChunkSubscription.remove();
        this.nativeChunkSubscription = null;
      }
    };
  }

  /**
   * Enable or disable Acoustic Echo Cancellation
   */
  async setAcousticEchoCanceler(enabled: boolean): Promise<boolean> {
    if (!this.nativeModule || !this.isInitialized) {
      console.warn('Audio effects not initialized');
      return false;
    }

    try {
      const result = await this.nativeModule.setAcousticEchoCanceler(enabled);
      console.log('[AudioEffects] AEC set to:', enabled);
      return result;
    } catch (error) {
      console.error('[AudioEffects] Failed to set AEC:', error);
      return false;
    }
  }

  /**
   * Enable or disable Noise Suppression
   */
  async setNoiseSuppressor(enabled: boolean): Promise<boolean> {
    if (!this.nativeModule || !this.isInitialized) {
      console.warn('Audio effects not initialized');
      return false;
    }

    try {
      const result = await this.nativeModule.setNoiseSuppressor(enabled);
      console.log('[AudioEffects] NS set to:', enabled);
      return result;
    } catch (error) {
      console.error('[AudioEffects] Failed to set NS:', error);
      return false;
    }
  }

  /**
   * Enable or disable Automatic Gain Control
   */
  async setAutomaticGainControl(enabled: boolean): Promise<boolean> {
    if (!this.nativeModule || !this.isInitialized) {
      console.warn('Audio effects not initialized');
      return false;
    }

    try {
      const result = await this.nativeModule.setAutomaticGainControl(enabled);
      console.log('[AudioEffects] AGC set to:', enabled);
      return result;
    } catch (error) {
      console.error('[AudioEffects] Failed to set AGC:', error);
      return false;
    }
  }

  /**
   * Get status of all audio effects
   */
  async getStatus(): Promise<AudioEffectsStatus | null> {
    if (!this.nativeModule || !this.isInitialized) {
      return null;
    }

    try {
      const status: AudioEffectsStatus = await this.nativeModule.getAudioEffectsStatus();
      console.log('[AudioEffects] Status:', status);
      return status;
    } catch (error) {
      console.error('[AudioEffects] Failed to get status:', error);
      return null;
    }
  }

  /**
   * Enable all audio effects
   */
  async enableAllEffects(): Promise<boolean> {
    if (!this.isInitialized) return false;

    const [aec, ns, agc] = await Promise.all([
      this.setAcousticEchoCanceler(true),
      this.setNoiseSuppressor(true),
      this.setAutomaticGainControl(true),
    ]);

    const anyEnabled = aec || ns || agc;
    if (anyEnabled) {
      console.log('[AudioEffects] Enabled effects:', { aec, ns, agc });
    } else {
      console.warn('[AudioEffects] No native audio effects were enabled');
    }
    return anyEnabled;
  }

  /**
   * Disable all audio effects
   */
  async disableAllEffects(): Promise<boolean> {
    if (!this.isInitialized) return false;

    try {
      await this.setAcousticEchoCanceler(false);
      await this.setNoiseSuppressor(false);
      await this.setAutomaticGainControl(false);
      console.log('[AudioEffects] All effects disabled');
      return true;
    } catch (error) {
      console.error('[AudioEffects] Failed to disable all effects:', error);
      return false;
    }
  }

  /**
   * Release all audio effects resources
   */
  async release(): Promise<boolean> {
    if (!this.nativeModule) {
      return false;
    }

    try {
      if (this.nativeChunkSubscription) {
        this.nativeChunkSubscription.remove();
        this.nativeChunkSubscription = null;
      }

      await this.stopNativeRecording();
      const result = await this.nativeModule.releaseAudioEffectsMethod();
      this.isInitialized = false;
      console.log('[AudioEffects] Released');
      return result;
    } catch (error) {
      console.error('[AudioEffects] Failed to release:', error);
      return false;
    }
  }

  isAvailable(): boolean {
    return !!this.nativeModule && Platform.OS === 'android';
  }

  isActive(): boolean {
    return this.isInitialized;
  }
}

export default new VocalLabsAudioEffects();
