/**
 * Audio Manager
 * Handles audio connections and streaming
 * Built-in audio service for React Native applications
 */

import { AudioStats, SendingStats, AudioConnectionOptions, SDKError, ErrorCode } from '../types';
import { Logger } from '../utils/logger';
import { DEFAULT_CONFIG } from '../config/constants';
import { AudioQueueService } from './AudioQueueService';

export class AudioManager {
  private audioService: AudioQueueService;
  private logger: Logger;
  private sampleRate: number;
  private isInitialized: boolean = false;
  
  // Callbacks
  private onConnectedCallback?: () => void;
  private onDisconnectedCallback?: () => void;
  private onMuteChangedCallback?: (isMuted: boolean) => void;
  private onUserConnectedCallback?: (connected: boolean) => void;
  private onStatsUpdateCallback?: (stats: { audio: AudioStats; sending: SendingStats }) => void;

  constructor(logger: Logger, sampleRate: number = DEFAULT_CONFIG.SAMPLE_RATE) {
    this.logger = logger;
    this.sampleRate = sampleRate;
    
    // Auto-initialize built-in audio service
    this.audioService = new AudioQueueService();
    this.isInitialized = true;
    this.setupCallbacks();
    this.logger.info('AudioManager initialized with built-in AudioQueueService');
  }

  /**
   * Check if audio service is initialized
   */
  isServiceInitialized(): boolean {
    return this.isInitialized && this.audioService !== null;
  }

  /**
   * Setup audio service callbacks
   */
  private setupCallbacks() {
    this.audioService.setConnectionCallback((isConnected: boolean) => {
      if (isConnected) {
        this.logger.info('✅ Audio connected');
        this.onConnectedCallback?.();
      } else {
        this.logger.info('❌ Audio disconnected');
        this.onDisconnectedCallback?.();
      }
    });

    this.audioService.setMuteCallback((isMuted: boolean) => {
      this.logger.info(`🔇 Mute state: ${isMuted}`);
      this.onMuteChangedCallback?.(isMuted);
    });

    this.audioService.setUserConnectedCallback((connected: boolean) => {
      this.logger.info(`👤 User connected: ${connected}`);
      this.onUserConnectedCallback?.(connected);
    });

    this.audioService.setStatsCallback((_stats: any) => {
      if (this.onStatsUpdateCallback && this.audioService?.audioQueue) {
        this.onStatsUpdateCallback({
          audio: this.audioService.audioQueue.getStats(),
          sending: this.audioService.getSendingStats(),
        });
      }
    });

    this.audioService.setLogCallback((message: string, type: string) => {
      switch (type) {
        case 'error':
          this.logger.error(message);
          break;
        case 'warning':
          this.logger.warning(message);
          break;
        default:
          this.logger.info(message);
      }
    });
  }

  /**
   * Connect to audio stream
   */
  async connect(options: AudioConnectionOptions): Promise<void> {
    if (!this.audioService || !this.isInitialized) {
      throw new SDKError(
        'Audio service not initialized. Call initializeWithService() first.',
        ErrorCode.NOT_INITIALIZED
      );
    }

    this.logger.info(`Connecting audio for call: ${options.callId}`);

    try {
      const sampleRate = options.sampleRate || this.sampleRate;

      if (options.wsUrl) {
        await this.audioService.connectWithCustomUrl(
          options.callId,
          sampleRate,
          options.wsUrl
        );
      } else {
        await this.audioService.connectMobile(options.callId, sampleRate);
      }

      this.logger.info('✅ Audio connection successful');

    } catch (error) {
      this.logger.error('❌ Audio connection failed:', error);
      throw new SDKError(
        'Failed to connect audio',
        ErrorCode.AUDIO_CONNECTION_FAILED,
        error
      );
    }
  }

  /**
   * Disconnect audio
   */
  disconnect(): void {
    this.logger.info('Disconnecting audio...');
    this.audioService.disconnect();
  }

  /**
   * Toggle mute
   */
  toggleMute(): boolean {
    this.audioService.toggleMute();
    return this.audioService.isMuted;
  }

  /**
   * Check if muted
   */
  isMuted(): boolean {
    return this.audioService.isMuted;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.audioService.isConnected;
  }

  /**
   * Set volume
   */
  setVolume(volume: number): void {
    this.audioService.setVolume(volume);
  }

  /**
   * Clear audio queue
   */
  clearQueue(): void {
    this.audioService.clearAudioQueue();
  }

  /**
   * Get audio stats
   */
  getStats(): { audio: AudioStats; sending: SendingStats } {
    return {
      audio: this.audioService.getStats(),
      sending: this.audioService.getSendingStats(),
    };
  }

  /**
   * Set event callbacks
   */
  onConnected(callback: () => void) {
    this.onConnectedCallback = callback;
  }

  onDisconnected(callback: () => void) {
    this.onDisconnectedCallback = callback;
  }

  onMuteChanged(callback: (isMuted: boolean) => void) {
    this.onMuteChangedCallback = callback;
  }

  onUserConnected(callback: (connected: boolean) => void) {
    this.onUserConnectedCallback = callback;
  }

  onStatsUpdate(callback: (stats: { audio: AudioStats; sending: SendingStats }) => void) {
    this.onStatsUpdateCallback = callback;
  }

  /**
   * Cleanup
   */
  async dispose(): Promise<void> {
    this.logger.info('Disposing audio manager...');
    await this.audioService.dispose();
    this.isInitialized = false;
  }
}
