/**
 * VocalLabs SDK
 * Simplified SDK for direct WebSocket connection to VocalLabs calls
 * Built-in audio support for React Native applications
 * 
 * @example
 * import VocalLabsSDK from 'vocal-native-sdk';
 * 
 * const sdk = new VocalLabsSDK({
 *   sampleRate: 8000,
 *   enableLogs: true,
 * });
 * 
 * // Connect with websocket URL
 * await sdk.connect('wss://call.vocallabs.ai/ws/?agent=..._callId_web_8000');
 * // or
 * await sdk.connect('wss://rupture2.vocallabs.ai/ws?callId=test-call-123&sampleRate=8000');
 * 
 * // Toggle mute
 * sdk.toggleMute();
 * 
 * // Disconnect
 * sdk.disconnect();
 */

import { 
  SDKConfig, 
  SDKState, 
  EventListeners, 
  EventType, 
  EventCallback,
  CallData,
  SDKError,
  ErrorCode,
  AudioStats,
  SendingStats,
  AudioProcessingConfig,
  AudioProcessingMode,
} from './types';
import { DEFAULT_CONFIG } from './config/constants';
import { Logger } from './utils/logger';
import { CallManager } from './call/CallManager';
import { AudioManager } from './audio/AudioManager';

export class VocalLabsSDK {
  // Core managers
  private callManager: CallManager;
  private audioManager: AudioManager;
  private logger: Logger;

  // Configuration
  private config: SDKConfig & { sampleRate: number; enableLogs: boolean };

  // State
  private state: SDKState = {
    isInitialized: false,
    isConnected: false,
    currentCallId: null,
    isMuted: false,
  };

  // Event listeners
  private listeners: EventListeners = {
    onAudioConnected: [],
    onAudioDisconnected: [],
    onUserConnected: [],
    onUserDisconnected: [],
    onMuteChanged: [],
    onStatsUpdate: [],
    onError: [],
    onLog: [],
  };

  constructor(config?: SDKConfig) {
    // Setup configuration with defaults
    this.config = {
      sampleRate: config?.sampleRate || DEFAULT_CONFIG.SAMPLE_RATE,
      enableLogs: config?.enableLogs !== false,
      audioProcessing: config?.audioProcessing,
    };

    // Initialize logger
    this.logger = new Logger(this.config.enableLogs);
    this.logger.setLogCallback((message, type) => {
      this._emit('onLog', { message, type });
    });

    // Initialize managers
    this.callManager = new CallManager(this.logger);

    this.audioManager = new AudioManager(
      this.logger
    );

    if (this.config.audioProcessing) {
      this.audioManager.setAudioProcessingConfig(this.config.audioProcessing);
    }

    this.setupAudioCallbacks();

    this.logger.info('🚀 VocalLabs SDK initialized with built-in audio support');
    this.state.isInitialized = true;
  }

  /**
   * Setup audio manager callbacks
   */
  private setupAudioCallbacks() {
    this.audioManager.onConnected(() => {
      this.state.isConnected = true;
      this._emit('onAudioConnected');
    });

    this.audioManager.onDisconnected(() => {
      this.state.isConnected = false;
      this._emit('onAudioDisconnected');
    });

    this.audioManager.onMuteChanged((isMuted) => {
      this.state.isMuted = isMuted;
      this._emit('onMuteChanged', isMuted);
    });

    this.audioManager.onUserConnected((connected) => {
      if (connected) {
        this._emit('onUserConnected', true);
      } else {
        this._emit('onUserDisconnected', false);
      }
    });

    this.audioManager.onStatsUpdate((stats) => {
      this._emit('onStatsUpdate', stats);
    });
  }

  /**
   * Connect directly to a call using websocket URL
   * 
   * @param websocketUrl - The websocket URL for the call (required)
   */
  async connect(websocketUrl: string): Promise<void> {
    try {
      if (!this.state.isInitialized) {
        throw new SDKError('SDK not initialized', ErrorCode.NOT_INITIALIZED);
      }

      if (!websocketUrl) {
        throw new SDKError(
          'WebsocketUrl must be provided',
          ErrorCode.INVALID_CONFIG
        );
      }

      // Extract callId from websocketUrl if possible
      let callId = `call-${Date.now()}`;
      try {
        const url = new URL(websocketUrl);
        
        // Try to extract from callId parameter first
        let callIdParam = url.searchParams.get('callId');
        if (callIdParam) {
          callId = callIdParam;
          this.logger.info(`Extracted callId from URL: ${callId}`);
        } else {
          // Try to extract from agent parameter (format: <something>_<callId>_web_<sampleRate>)
          const agentParam = url.searchParams.get('agent');
          if (agentParam) {
            const parts = agentParam.split('_');
            if (parts.length >= 2) {
              // The callId is the second part (index 1)
              callId = parts[1];
              this.logger.info(`Extracted callId from agent parameter: ${callId}`);
            }
          }
        }
      } catch (e) {
        this.logger.warning('Could not parse URL, using generated callId');
      }

      this.logger.info(`Connecting to call: ${callId}`);

      // Set current call
      const callData: CallData = {
        call_id: callId,
        websocket: websocketUrl,
      };
      this.callManager.setCurrentCall(callData);
      this.state.currentCallId = callId;

      // Connect audio with websocket URL
      await this.audioManager.connect({
        sampleRate: this.config.sampleRate,
        wsUrl: websocketUrl,
      });

      this.logger.info('✅ Connected successfully');

    } catch (error) {
      this._emit('onError', error as Error);
      throw error;
    }
  }

  /**
   * Disconnect from current call
   */
  disconnect(): void {
    this.logger.info('Disconnecting...');

    // Disconnect audio
    this.audioManager.disconnect();

    // Clear call
    this.callManager.clearCurrentCall();

    // Reset state
    this.state.isConnected = false;
    this.state.currentCallId = null;
    this.state.isMuted = false;

    this.logger.info('✅ Disconnected');
  }

  /**
   * Toggle mute
   */
  toggleMute(): boolean {
    try {
      const isMuted = this.audioManager.toggleMute();
      this.state.isMuted = isMuted;
      return isMuted;
    } catch (error) {
      this._emit('onError', error as Error);
      throw error;
    }
  }

  /**
   * Set volume (0.0 to 1.0)
   */
  setVolume(volume: number): void {
    this.audioManager.setVolume(volume);
  }

  /**
   * Set built-in capture processing mode.
   */
  setAudioProcessingMode(mode: AudioProcessingMode): void {
    this.audioManager.setAudioProcessingMode(mode);
  }

  /**
   * Set detailed capture processing controls.
   */
  setAudioProcessingConfig(config: AudioProcessingConfig): void {
    this.audioManager.setAudioProcessingConfig(config);
  }

  /**
   * Get current capture processing controls.
   */
  getAudioProcessingConfig(): Required<AudioProcessingConfig> {
    return this.audioManager.getAudioProcessingConfig();
  }

  /**
   * Clear audio queue
   */
  clearAudioQueue(): void {
    this.audioManager.clearQueue();
  }

  /**
   * Get current SDK state
   */
  getState(): SDKState {
    return { ...this.state };
  }

  /**
   * Get current call data
   */
  getCurrentCall(): CallData | null {
    return this.callManager.getCurrentCall();
  }

  /**
   * Get audio statistics
   */
  getStats(): { audio: AudioStats | null; sending: SendingStats | null } {
    return this.audioManager.getStats();
  }

  /**
   * Check if muted
   */
  isMuted(): boolean {
    return this.state.isMuted;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state.isConnected;
  }

  /**
   * Register an event listener
   */
  on<T = any>(event: EventType, callback: EventCallback<T>): void {
    if (this.listeners[event]) {
      (this.listeners[event] as EventCallback<any>[]).push(callback);
    } else {
      this.logger.warning(`Unknown event: ${event}`);
    }
  }

  /**
   * Unregister an event listener
   */
  off<T = any>(event: EventType, callback: EventCallback<T>): void {
    if (this.listeners[event]) {
      this.listeners[event] = (this.listeners[event] as EventCallback<any>[]).filter(
        (cb) => cb !== callback
      );
    }
  }

  /**
   * Emit an event
   */
  private _emit<T = any>(event: EventType, data?: T): void {
    if (this.listeners[event]) {
      this.listeners[event].forEach((callback) => {
        try {
          (callback as any)(data);
        } catch (error) {
          this.logger.error(`Error in ${event} listener:`, error);
        }
      });
    }
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    this.logger.info('Disposing SDK...');

    // Disconnect if connected
    if (this.state.isConnected) {
      this.disconnect();
    }

    // Dispose managers
    this.callManager.dispose();
    await this.audioManager.dispose();

    // Clear listeners
    Object.keys(this.listeners).forEach((key) => {
      this.listeners[key as EventType] = [];
    });

    // Reset state
    this.state = {
      isInitialized: false,
      isConnected: false,
      currentCallId: null,
      isMuted: false,
    };

    this.logger.info('✅ SDK disposed');
  }
}

export default VocalLabsSDK;
