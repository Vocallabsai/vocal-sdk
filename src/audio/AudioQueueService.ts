/**
 * Audio Queue Service
 * Built-in audio service for React Native applications
 * Handles WebSocket audio streaming, queue management, and recording
 */

import { AudioContext, AudioBufferSourceNode, GainNode } from 'react-native-audio-api';
import { Platform, PermissionsAndroid } from 'react-native';
// @ts-ignore - dynamic import
import LiveAudioStream from 'react-native-live-audio-stream';
import { decode as atob, encode as btoa } from 'base-64';

interface AudioStats {
  receivedChunks: number;
  playedChunks: number;
  queueSize: number;
  isPlaying: boolean;
  isProcessingQueue: boolean;
  audioContextState: string;
  droppedFrames?: number;
}

interface SendingStats {
  sentChunks: number;
  totalSentBytes: number;
  lastSentTime: number;
  isRecording: boolean;
  isMuted: boolean;
  sampleRate: number;
  bufferSize: number;
  isAudioInitialized: boolean;
}

interface WebSocketMessage {
  event: string;
  media?: {
    contentType?: string;
    sampleRate?: number;
    payload?: string;
  };
}

interface AudioStreamOptions {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  wavFile?: string;
  bufferSize?: number;
  audioSource?: number;
}

type LogType = 'info' | 'error' | 'warning';
type AudioFormat = 'audio/x-l16' | 'audio/x-mulaw';
type StatsCallback = (stats: { sentChunks: number; receivedChunks: number; queueSize: number }) => void;
type LogCallback = (message: string, type: LogType) => void;
type ConnectionCallback = (connected: boolean) => void;
type MuteCallback = (muted: boolean) => void;
type UserConnectedCallback = (connected: boolean) => void;

class ReactNativeAudioQueue {
  private static readonly INPUT_SAMPLE_RATE = 8000;
  private sampleRate: number;
  private audioContext: AudioContext | null;
  private initializePromise: Promise<void> | null;
  private currentSourceNode: AudioBufferSourceNode | null;
  private gainNode: GainNode | null;
  private isPlaying: boolean;
  private isInitialized: boolean;
  
  // Statistics
  private receivedChunks: number;
  private playedChunks: number;
  
  // Buffering for continuous playback - OPTIMIZED FOR MOBILE
  private playbackQueue: Float32Array[] = [];
  private isProcessingQueue: boolean;
  private nextPlayTime: number;
  public targetLatency: number;
  private static readonly MAX_QUEUE_FRAMES = 20; // Keep queue short and predictable
  private static readonly MAX_SCHEDULE_AHEAD = 0.5;
  private queueProcessTimer: any = null; // Fallback queue processor
  private lastOverflowLogTime: number = 0;
  private overflowSuppressedCount: number = 0;
  private lastAheadDropLogTime: number = 0;
  
  // Mobile-specific optimizations
  public maxQueueSize: number = 4;
  public isLowLatencyMode: boolean = false;
  private audioFormat: AudioFormat = 'audio/x-l16';
  private droppedFrames: number = 0;

  constructor(sampleRate: number = 8000) {
    this.sampleRate = sampleRate;
    this.audioContext = null;
    this.initializePromise = null;
    this.currentSourceNode = null;
    this.gainNode = null;
    this.isPlaying = false;
    this.isInitialized = false;
    
    this.receivedChunks = 0;
    this.playedChunks = 0;
    
    this.playbackQueue = [];
    this.isProcessingQueue = false;
    this.nextPlayTime = 0;
    this.targetLatency = 0.2;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    this.initializePromise = (async () => {
      try {
        this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }

        if (this.audioContext.sampleRate !== this.sampleRate) {
          console.warn(
            `⚠️ Requested ${this.sampleRate}Hz but got ${this.audioContext.sampleRate}Hz output. Conversion will be applied only when needed.`
          );
        } else {
          console.log(`✅ AudioContext created at requested ${this.sampleRate}Hz`);
        }

        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.value = 1.0;
        this.gainNode.connect(this.audioContext.destination);

        this.isInitialized = true;
        console.log(`✅ AudioContext initialized - State: ${this.audioContext.state}, Sample Rate: ${this.audioContext.sampleRate}, GainNode connected`);
        
        // Start fallback queue processor
        this.startQueueProcessor();
      } catch (error) {
        console.error('❌ Failed to initialize AudioContext:', error);
        throw error;
      } finally {
        this.initializePromise = null;
      }
    })();

    await this.initializePromise;
  }

  private startQueueProcessor(): void {
    if (this.queueProcessTimer) {
      return; // Already running
    }
    
    // Lower frequency fallback keeps CPU lower while onended handles most draining.
    this.queueProcessTimer = setInterval(() => {
      try {
        if (this.playbackQueue.length > 0 && !this.isProcessingQueue) {
          this.processQueue();
        }
      } catch (error) {
        console.error('❌ Error in fallback queue processor:', error);
      }
    }, 100);
    
    console.log('✅ Fallback queue processor started (100ms interval)');
  }

  private logOverflowWarning(): void {
    const nowMs = Date.now();
    if (nowMs - this.lastOverflowLogTime >= 10000) {
      const suffix = this.overflowSuppressedCount > 0
        ? ` (suppressed ${this.overflowSuppressedCount} similar warnings)`
        : '';
      console.warn(
        `⚠️ Queue full (${this.playbackQueue.length}/${ReactNativeAudioQueue.MAX_QUEUE_FRAMES}), dropping oldest frame. Total dropped: ${this.droppedFrames}${suffix}`
      );
      this.lastOverflowLogTime = nowMs;
      this.overflowSuppressedCount = 0;
    } else {
      this.overflowSuppressedCount++;
    }
  }

  private stopQueueProcessor(): void {
    if (this.queueProcessTimer) {
      clearInterval(this.queueProcessTimer);
      this.queueProcessTimer = null;
      console.log('✅ Fallback queue processor stopped');
    }
  }

  async addChunk(base64Audio: string): Promise<void> {
    try {
      this.receivedChunks++;

      if (!this.isInitialized || !this.audioContext) {
        await this.initialize();
        if (this.audioContext) {
          this.nextPlayTime = this.audioContext.currentTime;
          console.log(`✅ Initialized - AudioContext state: ${this.audioContext.state}, nextPlayTime: ${this.nextPlayTime}`);
        }
      }

      const pcmData = this.base64ToPCMData(base64Audio);
      if (!pcmData) return;

      // Drop if too much already scheduled
      const now = this.audioContext!.currentTime;
      if (this.nextPlayTime - now > 0.8) {
        this.droppedFrames++;
        const aheadNowMs = Date.now();
        if (aheadNowMs - this.lastAheadDropLogTime >= 10000) {
          console.warn(`⚠️ Playback queue too far ahead (${(this.nextPlayTime - now).toFixed(2)}s), dropping frames to recover`);
          this.lastAheadDropLogTime = aheadNowMs;
        }
        return;
      }

      // More aggressive queue size limit to prevent memory buildup
      if (this.playbackQueue.length >= ReactNativeAudioQueue.MAX_QUEUE_FRAMES) {
        try {
          this.playbackQueue.shift();
          this.droppedFrames++;
          this.logOverflowWarning();
        } catch (dropError) {
          console.error('❌ Error dropping frame:', dropError);
          return;
        }
      }

      this.playbackQueue.push(pcmData);
      
      // Log status periodically to identify scheduling issues
      if (this.receivedChunks % 500 === 0) {
        const audioState = this.audioContext?.state;
        console.log(`📊 Queue status: ${this.playbackQueue.length} frames | Played: ${this.playedChunks} | Received: ${this.receivedChunks} | AudioContext: ${audioState}`);
      }
      
      this.processQueue();

    } catch (error) {
      console.error('❌ Error adding audio chunk:', error);
      this.droppedFrames++;
    }
  }

  scheduleOneFrame(pcmFloat32: Float32Array) {
    try {
      if (!this.audioContext) {
        console.warn('⚠️ AudioContext not available for scheduling');
        return;
      }

      const ctx = this.audioContext;
      
      if (ctx.state === 'closed') {
        console.error('❌ AudioContext is closed, cannot schedule frame');
        this.droppedFrames++;
        return;
      }

      const contextRate = ctx.sampleRate || this.sampleRate;
      const samples = this.convertForContextRate(pcmFloat32, contextRate);

      // Validate samples
      if (!samples || samples.length === 0) {
        console.warn('⚠️ Invalid samples after decode/resample');
        this.droppedFrames++;
        return;
      }

      let buffer: any;
      try {
        buffer = ctx.createBuffer(1, samples.length, contextRate);
        // Prefer channel-data writes to avoid copyToChannel bridge issues on some RN builds.
        const channelData = typeof (buffer as any).getChannelData === 'function'
          ? (buffer as any).getChannelData(0)
          : null;

        if (channelData && typeof channelData.set === 'function') {
          channelData.set(samples);
        } else if (typeof (buffer as any).copyToChannel === 'function') {
          (buffer as any).copyToChannel(Array.from(samples), 0);
        } else {
          throw new Error('AudioBuffer channel write API unavailable');
        }
      } catch (bufferError) {
        console.error('❌ Error creating audio buffer:', bufferError);
        this.droppedFrames++;
        return;
      }

      let source: AudioBufferSourceNode;
      try {
        source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode || ctx.destination);
      } catch (sourceError) {
        console.error('❌ Error creating buffer source:', sourceError);
        this.droppedFrames++;
        return;
      }

      try {
        const startTime = Math.max(this.nextPlayTime, ctx.currentTime);
        source.start(startTime);

        this.nextPlayTime = startTime + buffer.duration;
        this.playedChunks++;
        
        if (this.playedChunks % 500 === 0) {
          console.log(`▶️ Scheduled frame ${this.playedChunks} at ${startTime.toFixed(3)}s | Queue: ${this.playbackQueue.length}`);
        }

        source.onended = () => {
          try {
            source.disconnect();
          } catch {
            // no-op cleanup
          }
          if (this.currentSourceNode === source) {
            this.currentSourceNode = null;
          }
          this.processQueue();
        };
        this.currentSourceNode = source;
      } catch (startError) {
        console.error('❌ Error starting audio playback:', startError);
        this.droppedFrames++;
      }
    } catch (outerError) {
      console.error('❌ Critical error in scheduleOneFrame:', outerError);
      this.droppedFrames++;
    }
  }

  private convertForContextRate(input: Float32Array, contextRate: number): Float32Array {
    if (input.length === 0 || contextRate <= 0 || contextRate === this.sampleRate) {
      return input;
    }

    const ratio = contextRate / ReactNativeAudioQueue.INPUT_SAMPLE_RATE;

    // Common mobile path: 8k -> 48k.
    if (ratio === 6) {
      const out = new Float32Array(input.length * 6);
      let outIndex = 0;
      for (let i = 0; i < input.length; i++) {
        const current = input[i];
        const next = i + 1 < input.length ? input[i + 1] : current;

        out[outIndex++] = current;
        out[outIndex++] = current + (next - current) * (1 / 6);
        out[outIndex++] = current + (next - current) * (2 / 6);
        out[outIndex++] = current + (next - current) * (3 / 6);
        out[outIndex++] = current + (next - current) * (4 / 6);
        out[outIndex++] = current + (next - current) * (5 / 6);
      }
      return out;
    }

    // Fallback for uncommon ratios.
    const outLength = Math.max(1, Math.floor(input.length * ratio));
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const src = i / ratio;
      const low = Math.floor(src);
      const high = Math.min(low + 1, input.length - 1);
      const t = src - low;
      out[i] = input[low] * (1 - t) + input[high] * t;
    }

    return out;
  }

  processQueue() {
    try {
      if (!this.audioContext) return;
      
      if (this.isProcessingQueue) return;

      this.isProcessingQueue = true;

      const ctx = this.audioContext;
      
      try {
        // Bounded scheduling loop avoids recursive churn during bursty traffic.
        let scheduledCount = 0;
        while (this.playbackQueue.length > 0) {
          const now = ctx.currentTime;
          if (this.nextPlayTime < now) {
            this.nextPlayTime = now;
          }
          if (this.nextPlayTime - now > ReactNativeAudioQueue.MAX_SCHEDULE_AHEAD) {
            break;
          }

          const frame = this.playbackQueue.shift();
          if (!frame) break;

          this.scheduleOneFrame(frame);
          scheduledCount++;

          if (scheduledCount >= 3) {
            break;
          }
        }
      } catch (error) {
        console.error('❌ Error in processQueue scheduling:', error);
        this.isProcessingQueue = false;
        return;
      }
      
      this.isProcessingQueue = false;
    } catch (outerError) {
      console.error('❌ Critical error in processQueue:', outerError);
      this.isProcessingQueue = false;
    }
  }

  base64ToPCMData(base64Audio: string): Float32Array | null {
    try {
      const binary = atob(base64Audio);
      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      // ---------- μ-LAW (FIXED) ----------
      if (this.audioFormat === 'audio/x-mulaw') {
        const floatArray = new Float32Array(bytes.length);

        for (let i = 0; i < bytes.length; i++) {
          let mu = ~bytes[i] & 0xff;

          const sign = (mu & 0x80) ? -1 : 1;
          const exponent = (mu >> 4) & 0x07;
          const mantissa = mu & 0x0F;

          // ✅ Correct G.711 decode
          let sample = ((mantissa << 4) + 0x08) << exponent;
          sample = sign * sample;

          floatArray[i] = sample / 32768;
        }

        return floatArray;
      }

      // ---------- L16 (KEEP YOURS) ----------
      const byteLength = bytes.length;

      if (byteLength % 2 === 0) {
        const samples = byteLength / 2;
        const floatArray = new Float32Array(samples);

        for (let i = 0; i < samples; i++) {
          const idx = i * 2;

          const sample = (bytes[idx] << 8) | bytes[idx + 1];
          const signedSample = sample > 32767 ? sample - 65536 : sample;

          floatArray[i] = signedSample / 32768;
        }

        return floatArray;
      }

      const floatArray = new Float32Array(byteLength);
      for (let i = 0; i < byteLength; i++) {
        floatArray[i] = (bytes[i] - 128) / 128;
      }

      return floatArray;

    } catch (error) {
      console.error('❌ Error converting base64 to PCM:', error);
      return null;
    }
  }

  setAudioFormat(format: AudioFormat): void {
    this.audioFormat = format;
  }

  setVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  clear(): void {
    this.stopQueueProcessor();
    
    if (this.currentSourceNode) {
      try {
        this.currentSourceNode.stop();
      } catch (error) {
        console.log('Note: Source node already stopped');
      }
      this.currentSourceNode = null;
    }

    this.playbackQueue = [];
    this.isPlaying = false;
    this.isProcessingQueue = false;
    this.nextPlayTime = 0;
    this.receivedChunks = 0;
    this.playedChunks = 0;
  }

  async dispose(): Promise<void> {
    this.stopQueueProcessor();
    this.clear();
    
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch (error) {
        console.log('Note: AudioContext already closed');
      }
      this.audioContext = null;
    }
    
    this.isInitialized = false;
    this.initializePromise = null;
  }

  getStats(): AudioStats {
    return {
      receivedChunks: this.receivedChunks,
      playedChunks: this.playedChunks,
      queueSize: this.playbackQueue.length,
      isPlaying: this.isPlaying,
      isProcessingQueue: this.isProcessingQueue,
      audioContextState: this.audioContext?.state || 'not initialized',
      droppedFrames: this.droppedFrames
    };
  }
}

export class AudioQueueService {
  private ws: WebSocket | null;
  public audioQueue: ReactNativeAudioQueue | null;
  
  // State
  public isConnected: boolean;
  public isMuted: boolean;
  private isRecording: boolean;
  private sampleRate: number;
  
  // Statistics
  private sentChunks: number;
  private lastSentTime: number;
  private totalSentBytes: number;
  private lastLogTime: number = 0;
  private sendFrameCount: number = 0;
  
  // Callbacks
  private statsCallback: StatsCallback | null;
  private logCallback: LogCallback | null;
  private connectionCallback: ConnectionCallback | null;
  private muteCallback: MuteCallback | null;
  private userConnectedCallback: UserConnectedCallback | null;
  
  // Audio stream
  private audioStreamBuffer: any[];
  private isAudioInitialized: boolean;
  private hasReceivedFirstData: boolean;
  private audioDataHandler: ((data: string) => void) | null;

  constructor() {
    this.ws = null;
    this.audioQueue = null;
    
    this.isConnected = false;
    this.isMuted = false;
    this.isRecording = false;
    this.sampleRate = 8000; // Hardcoded to 8000 Hz
    
    this.sentChunks = 0;
    this.lastSentTime = 0;
    this.totalSentBytes = 0;
    
    this.statsCallback = null;
    this.logCallback = null;
    this.connectionCallback = null;
    this.muteCallback = null;
    this.userConnectedCallback = null;
    
    this.audioStreamBuffer = [];
    this.isAudioInitialized = false;
    this.hasReceivedFirstData = false;
    this.audioDataHandler = null;

    this.initializeAudioQueue();
  }

  initializeAudioQueue(): void {
    this.audioQueue = new ReactNativeAudioQueue(8000);
  }

  // Callback setters
  setStatsCallback(callback: StatsCallback): void {
    this.statsCallback = callback;
  }

  setLogCallback(callback: LogCallback): void {
    this.logCallback = callback;
  }

  setConnectionCallback(callback: ConnectionCallback): void {
    this.connectionCallback = callback;
  }

  setMuteCallback(callback: MuteCallback): void {
    this.muteCallback = callback;
  }

  setUserConnectedCallback(callback: UserConnectedCallback): void {
    this.userConnectedCallback = callback;
  }

  log(message: string, type: LogType = 'info'): void {
    if (this.logCallback) {
      this.logCallback(message, type);
    }
  }

  updateStats(): void {
    if (this.statsCallback && this.audioQueue) {
      const audioStats = this.audioQueue.getStats();
      this.statsCallback({
        sentChunks: this.sentChunks,
        receivedChunks: audioStats.receivedChunks,
        queueSize: audioStats.queueSize,
      });
    }
  }

  updateConnectionState(connected: boolean): void {
    this.isConnected = connected;
    if (this.connectionCallback) {
      this.connectionCallback(connected);
    }
  }

  updateMuteState(muted: boolean): void {
    this.isMuted = muted;
    if (this.muteCallback) {
      this.muteCallback(muted);
    }
  }

  handleWebSocketMessage(event: any): void {
    try {
      const message: WebSocketMessage = JSON.parse(event.data as string);
      
      if (message.event === 'playAudio' && message.media && message.media.payload && this.audioQueue) {
        try {
          if (!this.hasReceivedFirstData && !(/^A+=*$/.test(message.media.payload))) {
            this.hasReceivedFirstData = true;
            this.startRecording();
            console.log('✅ First audio data received');
            this.log('First audio data received, starting recording', 'info');
            if (this.userConnectedCallback) {
              this.userConnectedCallback(true);
            }
          }
        } catch (startError) {
          console.error('❌ Error handling first data:', startError);
        }
        
        try {
          // Detect and set audio format
          const contentType = message.media.contentType as AudioFormat || 'audio/x-l16';
          if (this.audioQueue) {
            this.audioQueue.setAudioFormat(contentType);
          }
        } catch (formatError) {
          console.error('❌ Error setting audio format:', formatError);
        }
        
        try {
          // Log less frequently to avoid JS thread pressure in long calls.
          if (this.audioQueue) {
            const stats = this.audioQueue.getStats();
            if (stats.receivedChunks % 500 === 0) {
              console.log(`🔊 Audio received: ${stats.receivedChunks} chunks | Queue: ${stats.queueSize} | Played: ${stats.playedChunks}`);
            }
          }
          this.audioQueue.addChunk(message.media.payload);
          this.updateStats();
        } catch (addError) {
          console.error('❌ Error adding audio chunk:', addError);
        }
      }
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
      this.log(`WebSocket message error: ${error}`, 'error');
    }
  }

  async requestAudioPermissions(): Promise<boolean> {
    try {
      console.log('🔐 Requesting microphone permissions...');
      
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Audio Recording Permission',
            message: 'This app needs access to your microphone to record audio for the call.',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          }
        );
        
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        return true;
      }
    } catch (error) {
      console.error('❌ Permission request failed:', error);
      return false;
    }
  }

  async startRecording(): Promise<void> {
    console.log('🎤 Starting live audio stream...');
    
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        const errorMsg = 'Cannot start recording - WebSocket not connected';
        console.error('❌ ' + errorMsg);
        this.log(errorMsg, 'error');
        return;
      }
      
      const permission = await this.requestAudioPermissions();
      if (!permission) {
        const errorMsg = 'Audio permission denied';
        console.error('❌ ' + errorMsg);
        this.log(errorMsg, 'error');
        return;
      }
      
      // Hardcode to 8000 Hz, 320 bytes per packet (160 samples = 20ms)
      const bufferSize = 160;
      
      console.log(`🎤 Recording Configuration - Sample Rate: 8000Hz, Buffer Size: ${bufferSize} samples (320 raw bytes)`);
      
      const options: Partial<AudioStreamOptions> & { sampleRate: number; channels: number; bitsPerSample: number; wavFile: string } = {
        sampleRate: 8000,
        channels: 1,
        bitsPerSample: 16,
        wavFile: 'audio.wav',
        bufferSize: bufferSize,
        audioSource: 7, // VOICE_COMMUNICATION for echo cancellation
      };

      LiveAudioStream.init(options);
      
      // Create handler to avoid duplicate listeners on restart
      this.audioDataHandler = (data: string) => {
        this.handleRealTimeAudioData(data);
      };
      
      LiveAudioStream.on('data', this.audioDataHandler);

      LiveAudioStream.start();
      
      this.isRecording = true;
      this.audioStreamBuffer = [];
      
      console.log('✅ Live audio streaming started with echo cancellation');
      
    } catch (error) {
      const errorMsg = `Error starting live audio stream: ${error}`;
      console.error('❌ ' + errorMsg);
      this.log(errorMsg, 'error');
    }
  }

  private samplesToBase64(samples: Int16Array): string {
    try {
      const bytes = new Uint8Array(samples.length * 2);
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        bytes[i * 2] = sample & 0xFF;
        bytes[i * 2 + 1] = (sample >> 8) & 0xFF;
      }
      
      let binaryString = '';
      for (let i = 0; i < bytes.length; i++) {
        binaryString += String.fromCharCode(bytes[i]);
      }
      return btoa(binaryString);
    } catch (error) {
      console.error('❌ Error converting samples to base64:', error);
      return '';
    }
  }

  handleRealTimeAudioData(data: string): void {
    try {
      if (!this.isRecording || this.isMuted) {
        return;
      }
      
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.warn('⚠️ WebSocket not ready, dropping audio data');
        return;
      }
      
      if (data && data.length > 0) {
        this.processAndSendAudioFrames(data);
      }
      
    } catch (error) {
      console.error('❌ Error handling real-time audio data:', error);
      this.log(`Error handling audio: ${error}`, 'error');
    }
  }

  private processAndSendAudioFrames(base64AudioData: string): void {
    try {
      const binaryString = atob(base64AudioData);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const sampleCount = Math.floor(bytes.length / 2);
      if (sampleCount === 0) {
        console.warn('⚠️ No samples to process');
        return;
      }
      
      const samples = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = (bytes[i * 2 + 1] << 8) | bytes[i * 2];
      }
            
      // Send packets of 320 raw bytes = 160 samples (Krisp denoiser requires 160 samples)
      const samplesPerPacket = 160;
      
      // Log input size and frame count less frequently
      if (!this.lastLogTime || Date.now() - this.lastLogTime > 15000) {
        this.lastLogTime = Date.now();
      }
            
      let packetsSent = 0;
      for (let i = 0; i < samples.length; i += samplesPerPacket) {
        const slice = samples.subarray(i, Math.min(i + samplesPerPacket, samples.length));
        const frameBase64 = this.samplesToBase64(slice);
        
        if (frameBase64) {
          if (!this.sendAudioChunk(frameBase64)) {
            console.warn(`⚠️ Failed to send packet at offset ${i}`);
          } else {
            packetsSent++;
          }
        }
      }
    } catch (error) {
      console.error('❌ Error processing audio frames:', error);
      this.log(`Error processing frames: ${error}`, 'error');
    }
  }

  sendAudioChunk(base64AudioData: string): boolean {
    try {
      if (!this.ws) {
        console.warn('⚠️ WebSocket is null');
        return false;
      }
      
      if (this.ws.readyState !== WebSocket.OPEN) {
        console.warn(`⚠️ WebSocket state: ${this.ws.readyState} (expected OPEN)`);
        return false;
      }

      if (this.isMuted) {
        return false;
      }

      const message: WebSocketMessage = {
        event: 'media',
        media: {
          contentType: 'audio/x-l16',
          sampleRate: 8000,
          payload: base64AudioData
        }
      };
      console.log(`📤 Sending message: ${JSON.stringify(message)}`);
      try {
        this.ws.send(JSON.stringify(message));
      } catch (sendError) {
        console.error('❌ Error sending WebSocket message:', sendError);
        return false;
      }
      
      this.sentChunks++;
      this.sendFrameCount++;
      this.lastSentTime = Date.now();
      this.totalSentBytes += base64AudioData.length;
      

      
      return true;
    } catch (error) {
      console.error('❌ Error sending chunk:', error);
      this.log(`Error sending audio: ${error}`, 'error');
      return false;
    }
  }

  async stopRecording(): Promise<void> {
    try {
      if (this.isRecording) {
        LiveAudioStream.stop();
        this.isRecording = false;
        this.audioStreamBuffer = [];
        this.audioDataHandler = null;
        console.log('✅ Live streaming stopped');
        this.log('Recording stopped', 'info');
      }
    } catch (error) {
      const errorMsg = `Error stopping recording: ${error}`;
      console.error('❌ ' + errorMsg);
      this.log(errorMsg, 'error');
    }
  }

  async connectWithCustomUrl(wsUrl: string) {
    // Hardcode sending sample rate to 8000 Hz
    this.sampleRate = 8000;
    
    console.log(`🎯 Hardcoded Sample Rate: 8000Hz`);
    
    // Clean up old WebSocket
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch (error) {
        console.log('Note: WebSocket already closed');
      }
      this.ws = null;
    }
    
    if (this.audioQueue) {
      await this.audioQueue.dispose();
    }
    this.initializeAudioQueue();
    this.hasReceivedFirstData = false;

    console.log(`🔗 Connecting to WebSocket: ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);
    const currentWs = this.ws;
    let socketClosed = false;
    let closeCode: number | null = null;
    
    this.ws.onopen = () => {
      console.log('✅ WebSocket connected');
      this.log('WebSocket connection established', 'info');
      this.updateConnectionState(true);
      
      // Send initial events after connection
      try {
        // Send start event
        const startEvent = {
          event: 'start',
          start: {
            streamId: 'inbound',
            mediaFormat: {
              Encoding: 'audio/x-l16',
              sampleRate: 8000
            }
          }
        };
        this.ws?.send(JSON.stringify(startEvent));
        console.log(`📤 Sent start event with sample rate: 8000Hz`);
        
        // Send hangup_source event
        const hangupEvent = {
          event: 'hangup_source',
          source: 'in_progress'
        };
        this.ws?.send(JSON.stringify(hangupEvent));
        console.log('📤 Sent hangup_source event');
      } catch (error) {
        const errorMsg = `Error sending initial events: ${error}`;
        console.error('❌ ' + errorMsg);
        this.log(errorMsg, 'error');
      }
    };
    
    this.ws.onmessage = (event: any) => {
      try {
        this.handleWebSocketMessage(event);
      } catch (error) {
        console.error('❌ Error in onmessage handler:', error);
        this.log(`Message handler error: ${error}`, 'error');
      }
    };
    
    this.ws.onclose = (event: any) => {
      const closeMsg = `WebSocket disconnected: ${event.code} ${event.reason}`;
      console.log('❌ ' + closeMsg);
      this.log(closeMsg, 'info');
      socketClosed = true;
      closeCode = typeof event?.code === 'number' ? event.code : null;
      if (this.isRecording) {
        this.stopRecording();
      }
      this.updateConnectionState(false);
    };
    
    this.ws.onerror = (error: Event) => {
      console.error('❌ WebSocket error:', error);
      this.log(`WebSocket error: ${JSON.stringify(error)}`, 'error');
      if (this.isRecording) {
        this.stopRecording();
      }

      setTimeout(() => {
        if (this.ws !== currentWs) {
          return;
        }

        const isNormalNoStatusClose = socketClosed && closeCode === 1005;
        const alreadyDisconnected = !this.isConnected || this.ws?.readyState === WebSocket.CLOSED;

        if (isNormalNoStatusClose || alreadyDisconnected) {
          return;
        }

        this.updateConnectionState(false);
      }, 75);
    };
  }



  disconnect(): void {
    console.log('🔌 Disconnecting...');
    this.log('Starting disconnect', 'info');
    
    // Remove WebSocket listeners
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
    }
    
    // Send end event before closing
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ event: 'end', reason: 'user' }));
        console.log('📤 Sent end event');
      } catch (error) {
        console.error('❌ Error sending end event:', error);
        this.log(`Error sending end event: ${error}`, 'error');
      }
    }
    
    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        console.error('❌ Error closing WebSocket:', error);
        this.log(`Error closing WebSocket: ${error}`, 'error');
      }
      this.ws = null;
    }
    
    if (this.isRecording) {
      this.stopRecording();
    }
    
    if (this.audioQueue) {
      this.audioQueue.clear();
    }
    
    this.sentChunks = 0;
    this.totalSentBytes = 0;
    this.lastSentTime = 0;
    this.audioStreamBuffer = [];
    this.hasReceivedFirstData = false;
    
    this.updateConnectionState(false);
    this.log('Disconnected', 'info');
    console.log('✅ Disconnected');
  }

  toggleMute(): void {
    this.isMuted = !this.isMuted;
    this.updateMuteState(this.isMuted);
    console.log(`🔇 Microphone ${this.isMuted ? 'muted' : 'unmuted'}`);
  }

  clearAudioQueue(): void {
    if (this.audioQueue) {
      this.audioQueue.clear();
    }
    this.audioStreamBuffer = [];
    this.updateStats();
  }

  setVolume(volume: number): void {
    if (this.audioQueue) {
      this.audioQueue.setVolume(volume);
    }
  }

  getSendingStats(): SendingStats {
    return {
      sentChunks: this.sentChunks,
      totalSentBytes: this.totalSentBytes,
      lastSentTime: this.lastSentTime,
      isRecording: this.isRecording,
      isMuted: this.isMuted,
      sampleRate: this.sampleRate,
      bufferSize: this.audioStreamBuffer.length,
      isAudioInitialized: this.isAudioInitialized
    };
  }

  async dispose() {
    console.log('🗑️ Disposing AudioQueueService...');
    this.log('Disposing service', 'info');
    
    // Clean up audio listener
    this.audioDataHandler = null;
    
    this.disconnect();
    
    try {
      LiveAudioStream.stop();
    } catch (error) {
      console.log('Note: LiveAudioStream already stopped or not running');
      this.log(`LiveAudioStream stop error: ${error}`, 'error');
    }
    
    if (this.audioQueue) {
      try {
        await this.audioQueue.dispose();
      } catch (error) {
        console.error('❌ Error disposing audio queue:', error);
        this.log(`Audio queue dispose error: ${error}`, 'error');
      }
      this.audioQueue = null;
    }
    
    this.log('Service disposal complete', 'info');
    console.log('✅ AudioQueueService disposed');
  }

  getStats() {
    return this.audioQueue?.getStats() || {
      receivedChunks: 0,
      playedChunks: 0,
      queueSize: 0,
      isPlaying: false,
      isProcessingQueue: false,
      audioContextState: 'not initialized'
    };
  }
}
