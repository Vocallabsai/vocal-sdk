/**
 * Audio Queue Service
 * Built-in audio service for React Native applications
 * Handles WebSocket audio streaming, queue management, and recording
 */

import { AudioContext, AudioBuffer, AudioBufferSourceNode, GainNode, AudioRecorder, OnAudioReadyEventType, AudioManager, SessionOptions } from 'react-native-audio-api';
import { Platform, PermissionsAndroid } from 'react-native';
import { decode as atob, encode as btoa } from 'base-64';
import { AudioProcessingConfig, AudioProcessingMode } from '../types';
import {
  DEFAULT_CONFIG,
  TRANSPORT_PROFILES,
  resolveTransportProfile,
  samplesPerPacket,
  type TransportProfile,
} from '../config/constants';
import VocalLabsAudioEffects, { type AudioEffectsStatus, type NativeAudioChunkEvent } from '../utils/VocalLabsAudioEffects';

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
  /** Capture/send rate. */
  sampleRate: number;
  /** Rate the server streams back at — not necessarily `sampleRate`. */
  receiveSampleRate: number;
  receiveFormat: AudioFormat;
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
  humanId?: string;
  name?: string;
}

type LogType = 'info' | 'error' | 'warning';
type AudioFormat = 'audio/x-l16' | 'audio/x-mulaw';
type StatsCallback = (stats: { sentChunks: number; receivedChunks: number; queueSize: number }) => void;
type LogCallback = (message: string, type: LogType) => void;
type ConnectionCallback = (connected: boolean) => void;
type MuteCallback = (muted: boolean) => void;
type UserConnectedCallback = (connected: boolean) => void;
type HangupCallback = (message: Record<string, any>) => void;

class ReactNativeAudioQueue {
  /** Playback context rate — the rate the SERVER sends at, not the capture rate. */
  private sampleRate: number;
  /** Rate of the stream currently arriving; defaults to the negotiated receive rate. */
  private inputSampleRate: number;
  /** Negotiated fallbacks, used whenever a media frame omits its own format/rate. */
  private readonly negotiatedReceiveRate: number;
  private readonly negotiatedFormat: AudioFormat;
  private isLittleEndianL16: boolean;
  /** Trailing byte of an L16 payload that ended mid-sample. See base64ToPCMData. */
  private pendingByte: number | null = null;
  private lastRateMismatchLogTime: number = 0;
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

  constructor(profile: TransportProfile) {
    // Playback runs at the server's rate, never at the capture rate.
    this.sampleRate = profile.receiveRate;
    this.inputSampleRate = profile.receiveRate;
    this.negotiatedReceiveRate = profile.receiveRate;
    this.negotiatedFormat = profile.receiveFormat;
    this.audioFormat = profile.receiveFormat;
    this.isLittleEndianL16 = profile.receiveFormat === 'audio/x-l16';
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
    if (input.length === 0 || contextRate <= 0 || this.inputSampleRate <= 0 || contextRate === this.inputSampleRate) {
      return input;
    }

    const ratio = contextRate / this.inputSampleRate;

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
          const mu = ~bytes[i] & 0xff;
          const sign = mu & 0x80;
          const exponent = (mu >> 4) & 0x07;
          const mantissa = mu & 0x0f;

          // ITU-T G.711 mu-law decode
          let sample = ((mantissa << 3) + 0x84) << exponent;
          sample = sign ? (0x84 - sample) : (sample - 0x84);

          floatArray[i] = sample / 32768;
        }

        return floatArray;
      }

      // ---------- L16 ----------
      // A payload can carry an odd number of bytes, splitting a 16-bit sample
      // across two frames. Carry the orphan byte into the next payload —
      // dropping it byte-shifts every sample after it into noise.
      let data = bytes;

      if (this.pendingByte !== null) {
        const merged = new Uint8Array(data.length + 1);
        merged[0] = this.pendingByte;
        merged.set(data, 1);
        data = merged;
        this.pendingByte = null;
      }

      if (data.length % 2 === 1) {
        this.pendingByte = data[data.length - 1];
        data = data.subarray(0, data.length - 1);
      }

      if (data.length === 0) {
        return null;
      }

      const samples = data.length / 2;
      const floatArray = new Float32Array(samples);

      for (let i = 0; i < samples; i++) {
        const idx = i * 2;

        const hi = this.isLittleEndianL16 ? data[idx + 1] : data[idx];
        const lo = this.isLittleEndianL16 ? data[idx] : data[idx + 1];
        const sample = (hi << 8) | lo;
        const signedSample = sample > 32767 ? sample - 65536 : sample;

        floatArray[i] = signedSample / 32768;
      }

      return floatArray;

    } catch (error) {
      console.error('❌ Error converting base64 to PCM:', error);
      return null;
    }
  }

  /**
   * Apply the format of an incoming media frame. Anything the frame does not
   * state falls back to the negotiated transport, never to a hardcoded default
   * — assuming L16 on a mulaw transport decodes to static.
   */
  setAudioFormat(contentType?: string, sampleRate?: number): void {
    const normalizedContentType = (contentType || '').toLowerCase();

    let nextFormat: AudioFormat;
    if (normalizedContentType.includes('mulaw') || normalizedContentType.includes('pcmu')) {
      nextFormat = 'audio/x-mulaw';
    } else if (normalizedContentType.includes('l16') || normalizedContentType.includes('pcm')) {
      nextFormat = 'audio/x-l16';
    } else {
      nextFormat = this.negotiatedFormat;
    }

    if (nextFormat !== this.audioFormat) {
      // A codec switch invalidates any half sample we were holding.
      this.pendingByte = null;
      this.audioFormat = nextFormat;
    }

    // All L16 from this server is little-endian.
    this.isLittleEndianL16 = nextFormat === 'audio/x-l16';

    const rateMatch = normalizedContentType.match(/(?:rate|sample[-_]?rate)\s*=\s*(\d{4,6})/);
    const parsedRate = rateMatch ? Number(rateMatch[1]) : NaN;
    const candidateRate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : parsedRate;

    if (Number.isFinite(candidateRate) && candidateRate >= 4000 && candidateRate <= 96000) {
      this.inputSampleRate = candidateRate;
      if (candidateRate !== this.negotiatedReceiveRate) {
        this.logRateMismatch(candidateRate);
      }
    } else {
      this.inputSampleRate = this.negotiatedReceiveRate;
    }
  }

  private logRateMismatch(actualRate: number): void {
    const nowMs = Date.now();
    if (nowMs - this.lastRateMismatchLogTime < 10000) {
      return;
    }
    this.lastRateMismatchLogTime = nowMs;
    console.warn(
      `⚠️ Server is streaming ${actualRate}Hz but the transport negotiated ${this.negotiatedReceiveRate}Hz. ` +
        `Following the frame; playback would be ${(actualRate / this.negotiatedReceiveRate).toFixed(4)}x off otherwise.`
    );
  }

  /**
   * Drop continuity state tied to one socket. Called on a human transfer, where
   * the playback queue is deliberately kept alive across the swap.
   */
  resetIncomingStream(): void {
    this.pendingByte = null;
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
    this.pendingByte = null;
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
  /** Capture/send rate. Independent of the rate the server streams back. */
  private sendRate: number;
  private transport: TransportProfile;
  /** Samples left over from the last capture buffer, held to keep 20ms framing exact. */
  private sendResidual: Int16Array;
  private transferBaseUrl: string;
  
  // Statistics
  private sentChunks: number;
  private lastSentTime: number;
  private totalSentBytes: number;
  private sendFrameCount: number = 0;
  
  // Callbacks
  private statsCallback: StatsCallback | null;
  private logCallback: LogCallback | null;
  private connectionCallback: ConnectionCallback | null;
  private muteCallback: MuteCallback | null;
  private userConnectedCallback: UserConnectedCallback | null;
  private hangupCallback: HangupCallback | null;
  
  // Audio stream
  private audioStreamBuffer: any[];
  private audioRecorder: AudioRecorder | null;
  private nativeChunkUnsubscribe: (() => void) | null;
  private isAudioInitialized: boolean;
  private hasReceivedFirstData: boolean;
  private audioProcessingConfig: Required<AudioProcessingConfig>;

  // Native audio effects (Android only)
  private nativeAudioEffectsInitialized: boolean;

  private static readonly AUDIO_PROCESSING_PRESETS: Record<AudioProcessingMode, Required<AudioProcessingConfig>> = {
    off: {
      mode: 'off',
      remoteActiveWindowMs: 250,
      noiseGateQuiet: 0,
      noiseGateRemote: 0,
      halfDuplexRms: 1,
      halfDuplexPeak: 1,
      duckLow: 1,
      duckHigh: 1,
      duckPivotRms: 1,
      dcBlockerR: 0.995,
    },
    balanced: {
      mode: 'balanced',
      remoteActiveWindowMs: 280,
      noiseGateQuiet: 0.012,
      noiseGateRemote: 0.022,
      halfDuplexRms: 0.055,
      halfDuplexPeak: 0.16,
      duckLow: 0.35,
      duckHigh: 0.58,
      duckPivotRms: 0.085,
      dcBlockerR: 0.995,
    },
    aggressive: {
      mode: 'aggressive',
      remoteActiveWindowMs: 360,
      noiseGateQuiet: 0.015,
      noiseGateRemote: 0.028,
      halfDuplexRms: 0.07,
      halfDuplexPeak: 0.2,
      duckLow: 0.22,
      duckHigh: 0.45,
      duckPivotRms: 0.095,
      dcBlockerR: 0.996,
    },
  };

  private readonly callSessionOptions: SessionOptions = {
    iosCategory: 'playAndRecord',
    iosMode: 'voiceChat',
    // Keep speaker route while using voice processing mode where available.
    iosOptions: ['allowBluetoothHFP'],
  };

  constructor() {
    this.ws = null;
    this.audioQueue = null;
    
    this.isConnected = false;
    this.isMuted = false;
    this.isRecording = false;
    // Replaced by the URL-negotiated profile in connectWithCustomUrl().
    this.transport = TRANSPORT_PROFILES[DEFAULT_CONFIG.SAMPLE_RATE];
    this.sendRate = this.transport.sendRate;
    this.sendResidual = new Int16Array(0);
    this.transferBaseUrl = DEFAULT_CONFIG.TRANSFER_BASE_URL;
    
    this.sentChunks = 0;
    this.lastSentTime = 0;
    this.totalSentBytes = 0;
    
    this.statsCallback = null;
    this.logCallback = null;
    this.connectionCallback = null;
    this.muteCallback = null;
    this.userConnectedCallback = null;
    this.hangupCallback = null;

    this.audioStreamBuffer = [];
    this.audioRecorder = null;
    this.nativeChunkUnsubscribe = null;
    this.isAudioInitialized = false;
    this.hasReceivedFirstData = false;
    this.audioProcessingConfig = { ...AudioQueueService.AUDIO_PROCESSING_PRESETS.balanced };
    this.nativeAudioEffectsInitialized = false;

    this.initializeAudioQueue();
  }

  initializeAudioQueue(): void {
    this.audioQueue = new ReactNativeAudioQueue(this.transport);
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

  setHangupCallback(callback: HangupCallback): void {
    this.hangupCallback = callback;
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

      if (message.event === 'humanTransfer') {
        this.handleHumanTransfer(message);
        return;
      }

      if (message.event === 'hangup') {
        this.handleHangup(message);
        return;
      }

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
          // Detect and set audio format. Pass contentType through as-is —
          // an absent one must fall back to the negotiated codec, not to L16.
          const incomingRate = typeof message.media.sampleRate === 'number' ? message.media.sampleRate : undefined;
          if (this.audioQueue) {
            this.audioQueue.setAudioFormat(message.media.contentType, incomingRate);
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
    console.log('🎤 Starting microphone capture with AudioRecorder...');
    
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

      await this.configureCallAudioSession();

      // Enable iOS hardware Voice Processing I/O on the shared audio engine
      // BEFORE the recorder attaches its sink node. This routes mic input
      // through AEC/NS/AGC and prevents speakerphone echo. No-op on Android
      // (Android already gets AEC via MODE_IN_COMMUNICATION).
      if (
        Platform.OS === 'ios' &&
        typeof (VocalLabsAudioEffects as any).enableVoiceProcessing === 'function'
      ) {
        try {
          const vpResult = await (VocalLabsAudioEffects as any).enableVoiceProcessing();
          this.log(`Voice processing: ${JSON.stringify(vpResult)}`, 'info');
        } catch (e) {
          this.log(`enableVoiceProcessing threw: ${e}`, 'warning');
        }
      }

      // One 20ms packet at the capture rate: 160/320/640/960 samples,
      // i.e. 320/640/1280/1920 bytes of mono little-endian L16.
      const bufferSize = samplesPerPacket(this.sendRate);

      if (Platform.OS === 'android' && VocalLabsAudioEffects.isAvailable()) {
        const started = await VocalLabsAudioEffects.startNativeRecording({
          sampleRate: this.sendRate,
          bufferLength: bufferSize,
          channelCount: 1,
        });

        if (started) {
          this.nativeChunkUnsubscribe = VocalLabsAudioEffects.subscribeNativeChunks(
            (event: NativeAudioChunkEvent) => {
              this.handleNativeRecorderChunk(event);
            }
          );

          this.isRecording = true;
          this.audioStreamBuffer = [];
          this.sendResidual = new Int16Array(0);
          this.nativeAudioEffectsInitialized = VocalLabsAudioEffects.isActive();
          console.log('✅ Native Android recording started with built-in audio effects');
          return;
        }
      }
      
      console.log(`🎤 Recording Configuration - Sample Rate: ${this.sendRate}Hz, Buffer Size: ${bufferSize} samples (${bufferSize * 2} raw bytes)`);

      if (!this.audioRecorder) {
        this.audioRecorder = new AudioRecorder();
      }

      this.audioRecorder.clearOnAudioReady();
      this.audioRecorder.clearOnError();

      this.audioRecorder.onError((event) => {
        const errorMsg = `AudioRecorder error: ${event.message}`;
        console.error('❌ ' + errorMsg);
        this.log(errorMsg, 'error');
      });

      const onAudioReadyResult = this.audioRecorder.onAudioReady(
        {
          sampleRate: this.sendRate,
          bufferLength: bufferSize,
          channelCount: 1,
        },
        (event: OnAudioReadyEventType) => {
          this.handleRecorderAudioReady(event);
        }
      );

      if (onAudioReadyResult.status === 'error') {
        throw new Error(onAudioReadyResult.message);
      }

      const startResult = this.audioRecorder.start();
      if (startResult.status === 'error') {
        throw new Error(startResult.message);
      }
      
      this.isRecording = true;
      this.audioStreamBuffer = [];
      this.sendResidual = new Int16Array(0);

      // Initialize native audio effects (Android only)
      if (Platform.OS === 'android' && VocalLabsAudioEffects.isAvailable()) {
        try {
          const recorderAny = this.audioRecorder as any;
          const sessionIdRaw = typeof recorderAny?.getAudioSessionId === 'function'
            ? recorderAny.getAudioSessionId()
            : null;
          const sessionId = typeof sessionIdRaw === 'number' ? sessionIdRaw : -1;

          const success = await VocalLabsAudioEffects.initializeAudioEffects(sessionId);
          if (success) {
            this.nativeAudioEffectsInitialized = true;
            const enabled = await VocalLabsAudioEffects.enableAllEffects();
            if (enabled) {
              console.log('✅ Native audio effects enabled');
            } else {
              this.nativeAudioEffectsInitialized = false;
              console.warn('⚠️ Native audio effects not enabled for this audio session');
            }
          } else {
            this.nativeAudioEffectsInitialized = false;
            console.warn('⚠️ Native audio effects init skipped: recorder session id unavailable');
          }
        } catch (error) {
          console.warn('⚠️ Failed to initialize native audio effects:', error);
          this.nativeAudioEffectsInitialized = false;
        }
      }
      
      console.log('✅ AudioRecorder capture started');
      
    } catch (error) {
      const errorMsg = `Error starting microphone capture: ${error}`;
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

  private handleRecorderAudioReady(event: OnAudioReadyEventType): void {
    try {
      if (!this.isRecording || this.isMuted) {
        return;
      }
      
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.warn('⚠️ WebSocket not ready, dropping audio data');
        return;
      }

      if (!event?.buffer) {
        return;
      }

      this.processRecorderBuffer(event.buffer);
      
    } catch (error) {
      console.error('❌ Error handling recorder audio data:', error);
      this.log(`Error handling audio: ${error}`, 'error');
    }
  }

  private processRecorderBuffer(buffer: AudioBuffer): void {
    try {
      const mono = this.downmixToMono(buffer);
      if (mono.length === 0) {
        return;
      }

      const resampled = this.resampleFloat32(mono, buffer.sampleRate, this.sendRate);
      if (resampled.length === 0) {
        return;
      }

      const int16 = this.float32ToInt16(resampled);
      this.sendInt16Frames(int16);
    } catch (error) {
      console.error('❌ Error processing recorder buffer:', error);
      this.log(`Error processing recorder buffer: ${error}`, 'error');
    }
  }

  private handleNativeRecorderChunk(event: NativeAudioChunkEvent): void {
    try {
      if (!this.isRecording || this.isMuted) {
        return;
      }

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (!event?.base64) {
        return;
      }

      const binary = atob(event.base64);
      const byteLength = binary.length;
      if (byteLength < 2) {
        return;
      }

      const sampleCount = Math.floor(byteLength / 2);
      const pcmInt16 = new Int16Array(sampleCount);

      for (let i = 0; i < sampleCount; i++) {
        const low = binary.charCodeAt(i * 2) & 0xff;
        const high = binary.charCodeAt(i * 2 + 1);
        const value = (high << 8) | low;
        pcmInt16[i] = value > 0x7fff ? value - 0x10000 : value;
      }

      const downmixed = this.downmixInt16ToMono(pcmInt16, event.channelCount || 1);
      const float = this.int16ToFloat32(downmixed);
      const resampled = this.resampleFloat32(float, event.sampleRate || this.sendRate, this.sendRate);
      const int16 = this.float32ToInt16(resampled);
      this.sendInt16Frames(int16);
    } catch (error) {
      this.log(`Error handling native recorder chunk: ${error}`, 'warning');
    }
  }

  private downmixInt16ToMono(input: Int16Array, channelCount: number): Int16Array {
    if (channelCount <= 1) {
      return input;
    }

    const frameCount = Math.floor(input.length / channelCount);
    const mono = new Int16Array(frameCount);

    for (let frame = 0; frame < frameCount; frame++) {
      let sum = 0;
      for (let ch = 0; ch < channelCount; ch++) {
        sum += input[frame * channelCount + ch] || 0;
      }
      mono[frame] = Math.max(-32768, Math.min(32767, Math.round(sum / channelCount)));
    }

    return mono;
  }

  private int16ToFloat32(input: Int16Array): Float32Array {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      output[i] = input[i] / 32768;
    }
    return output;
  }

  private downmixToMono(buffer: AudioBuffer): Float32Array {
    const channelCount = Math.max(1, buffer.numberOfChannels || 1);
    const frameCount = buffer.length;

    if (frameCount <= 0) {
      return new Float32Array(0);
    }

    if (channelCount === 1) {
      return buffer.getChannelData(0);
    }

    const mono = new Float32Array(frameCount);
    for (let channel = 0; channel < channelCount; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < frameCount; i++) {
        mono[i] += data[i] || 0;
      }
    }

    for (let i = 0; i < frameCount; i++) {
      mono[i] /= channelCount;
    }

    return mono;
  }

  private resampleFloat32(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
    if (input.length === 0) {
      return input;
    }

    if (!inputRate || inputRate === outputRate) {
      return input;
    }

    const ratio = outputRate / inputRate;
    const outLength = Math.max(1, Math.floor(input.length * ratio));
    const output = new Float32Array(outLength);

    for (let i = 0; i < outLength; i++) {
      const sourceIndex = i / ratio;
      const low = Math.floor(sourceIndex);
      const high = Math.min(low + 1, input.length - 1);
      const t = sourceIndex - low;
      output[i] = input[low] * (1 - t) + input[high] * t;
    }

    return output;
  }

  private float32ToInt16(input: Float32Array): Int16Array {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      output[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }
    return output;
  }

  /**
   * Emit whole 20ms packets at the capture rate, holding the remainder for the
   * next buffer. Resampling an arbitrary device rate down to the send rate
   * rarely lands on a packet boundary, and emitting the short tail as its own
   * packet would put a runt frame on the wire every buffer.
   */
  private sendInt16Frames(samples: Int16Array): void {
    const packetSamples = samplesPerPacket(this.sendRate);

    let pending: Int16Array;
    if (this.sendResidual.length > 0) {
      pending = new Int16Array(this.sendResidual.length + samples.length);
      pending.set(this.sendResidual, 0);
      pending.set(samples, this.sendResidual.length);
    } else {
      pending = samples;
    }

    let offset = 0;
    while (pending.length - offset >= packetSamples) {
      const slice = pending.subarray(offset, offset + packetSamples);
      const frameBase64 = this.samplesToBase64(slice);

      if (frameBase64) {
        if (!this.sendAudioChunk(frameBase64)) {
          console.warn(`⚠️ Failed to send packet at offset ${offset}`);
        }
      }
      offset += packetSamples;
    }

    // slice() copies — `pending` may be a view onto a transient capture buffer.
    this.sendResidual = offset < pending.length ? pending.slice(offset) : new Int16Array(0);
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
          sampleRate: this.sendRate,
          payload: base64AudioData
        }
      };
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
        if (this.nativeChunkUnsubscribe) {
          this.nativeChunkUnsubscribe();
          this.nativeChunkUnsubscribe = null;
        }

        if (Platform.OS === 'android' && VocalLabsAudioEffects.isAvailable()) {
          await VocalLabsAudioEffects.stopNativeRecording();
        }

        if (this.audioRecorder) {
          this.audioRecorder.clearOnAudioReady();
          this.audioRecorder.clearOnError();
          const stopResult = this.audioRecorder.stop();
          if (stopResult.status === 'error') {
            this.log(`AudioRecorder stop error: ${stopResult.message}`, 'warning');
          }
          try {
            this.audioRecorder.disconnect();
          } catch (e) {}
          this.audioRecorder = null;
        }

        // Release native audio effects
        if (this.nativeAudioEffectsInitialized && VocalLabsAudioEffects.isAvailable()) {
          try {
            await VocalLabsAudioEffects.release();
            this.nativeAudioEffectsInitialized = false;
            console.log('✅ Native audio effects released');
          } catch (error) {
            console.warn('⚠️ Failed to release native audio effects:', error);
          }
        }

        this.isRecording = false;
        this.audioStreamBuffer = [];
        this.sendResidual = new Int16Array(0);
        // Keep AVAudioSession active across calls — see disconnect() comment.
        console.log('✅ Microphone capture stopped');
        this.log('Recording stopped', 'info');
      }
    } catch (error) {
      const errorMsg = `Error stopping recording: ${error}`;
      console.error('❌ ' + errorMsg);
      this.log(errorMsg, 'error');
    }
  }

  async connectWithCustomUrl(wsUrl: string, transferBaseUrl?: string) {
    // The `_web_<rate>` token names the capture rate; the server streams back at
    // its own rate and codec. Both come from the profile — never derive one
    // from the other.
    this.transport = resolveTransportProfile(wsUrl);
    this.sendRate = this.transport.sendRate;
    this.sendResidual = new Int16Array(0);

    if (transferBaseUrl) {
      this.transferBaseUrl = transferBaseUrl;
    }

    console.log(
      `🎯 Transport negotiated — send ${this.transport.sendRate}Hz audio/x-l16, ` +
        `receive ${this.transport.receiveRate}Hz ${this.transport.receiveFormat}`
    );

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
              sampleRate: this.sendRate
            }
          }
        };
        this.ws?.send(JSON.stringify(startEvent));
        console.log(`📤 Sent start event with sample rate: ${this.sendRate}Hz`);
        
        // Send hangup_source event
        const hangupEvent = {
          event: 'hangup_source',
          source: 'in_progress'
        };
        this.ws?.send(JSON.stringify(hangupEvent));
        console.log('📤 Sent hangup_source event');
        // PATCH: eager-start — don't wait for server first non-silence frame
        if (!this.hasReceivedFirstData) {
          this.hasReceivedFirstData = true;
          console.log('⚡ Eager start: launching recording on ws.onopen');
          this.startRecording().catch((e) => {
            console.error('❌ Eager startRecording failed:', e);
          });
          if (this.userConnectedCallback) {
            this.userConnectedCallback(true);
          }
        }
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

  /**
   * The server ended the call. Notify the app first — the teardown that follows
   * flips connection state and would otherwise land before the reason for it.
   */
  private handleHangup(message: WebSocketMessage): void {
    console.log('📴 Server signalled hangup');
    this.log('Call ended by server', 'info');

    if (this.hangupCallback) {
      try {
        this.hangupCallback(message as Record<string, any>);
      } catch (error) {
        this.log(`Error in hangup callback: ${error}`, 'error');
      }
    }

    // notifyServer: false — the server hung up, so echoing an `end` back at it
    // would report a user-initiated hangup for a call it already terminated.
    this.disconnect(false).catch((error) => {
      console.error('❌ Error tearing down after hangup:', error);
      this.log(`Hangup teardown error: ${error}`, 'error');
    });
  }

  /**
   * Hand the live call off to a human agent. Opens a new socket for `humanId`,
   * routes audio to it, then quietly closes the previous socket. Recording, the
   * playback queue, and connection state are left untouched so the call continues.
   */
  private handleHumanTransfer(message: WebSocketMessage): void {
    let transferUrl: string;
    try {
      transferUrl = this.buildTransferUrl(message.humanId);
    } catch (error) {
      this.log(`Invalid human-transfer event: ${error}`, 'error');
      return;
    }

    console.log(`🔀 Human transfer requested → ${transferUrl}`);
    this.log(`Human transfer to ${message.name || message.humanId}`, 'info');

    this.switchWebSocket(transferUrl).catch((error) => {
      // Switch failed — the original socket is still live, so the call continues.
      console.error('❌ Human transfer failed:', error);
      this.log(`Human transfer failed: ${error}`, 'error');
    });
  }

  /**
   * Build the human-transfer endpoint from the configured transfer base URL,
   * carrying only `callId` (the agent's id) and the session sample rate. Any
   * query params already on `transferBaseUrl` are discarded.
   */
  private buildTransferUrl(humanId?: string): string {
    if (!humanId || typeof humanId !== 'string') {
      throw new Error('missing humanId');
    }
    const base = this.transferBaseUrl.split('?')[0];
    return `${base}?callId=${encodeURIComponent(humanId)}&sampleRate=${this.sendRate}`;
  }

  /**
   * Open `newUrl`, route the live audio stream to it, and close the old socket
   * once the new one is open. On failure the old socket is left intact.
   */
  private switchWebSocket(newUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const oldWs = this.ws;
      const newWs = new WebSocket(newUrl);
      let settled = false;

      const timeout = setTimeout(() => {
        if (newWs.readyState !== WebSocket.OPEN) {
          try { newWs.close(); } catch (e) {}
          if (!settled) {
            settled = true;
            reject(new Error('Human transfer connection timed out'));
          }
        }
      }, 5000);

      newWs.onopen = () => {
        clearTimeout(timeout);
        console.log('✅ Human transfer WebSocket connected');
        this.log('Human transfer socket connected', 'info');

        // Send the same handshake the primary connection uses.
        try {
          newWs.send(JSON.stringify({
            event: 'start',
            start: {
              streamId: 'inbound',
              mediaFormat: { Encoding: 'audio/x-l16', sampleRate: this.sendRate },
            },
          }));
          newWs.send(JSON.stringify({ event: 'hangup_source', source: 'in_progress' }));
        } catch (error) {
          this.log(`Error sending transfer handshake: ${error}`, 'error');
        }

        // The playback queue survives the swap, but a half sample held from the
        // old socket does not belong to the new stream.
        this.audioQueue?.resetIncomingStream();

        // Route audio to the new socket and wire its handlers *before* tearing
        // down the old one, so no media is lost mid-swap.
        this.ws = newWs;
        this.attachTransferHandlers(newWs);

        // Detach the old socket's handlers first so its close does not stop
        // recording or flip connection state, then close it.
        if (oldWs && oldWs !== newWs) {
          oldWs.onopen = null;
          oldWs.onmessage = null;
          oldWs.onclose = null;
          oldWs.onerror = null;
          try { oldWs.close(); } catch (e) {}
        }

        if (!settled) {
          settled = true;
          resolve();
        }
      };

      newWs.onerror = () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error('Human transfer connection failed'));
        }
      };
    });
  }

  /**
   * Wire the long-lived message/close/error handlers onto the post-transfer
   * socket. Close/error from a socket already swapped out are ignored.
   */
  private attachTransferHandlers(ws: WebSocket): void {
    ws.onmessage = (event: any) => {
      try {
        this.handleWebSocketMessage(event);
      } catch (error) {
        console.error('❌ Error in onmessage handler:', error);
        this.log(`Message handler error: ${error}`, 'error');
      }
    };

    ws.onclose = (event: any) => {
      if (ws !== this.ws) return;
      const closeMsg = `WebSocket disconnected: ${event.code} ${event.reason}`;
      console.log('❌ ' + closeMsg);
      this.log(closeMsg, 'info');
      if (this.isRecording) {
        this.stopRecording();
      }
      this.updateConnectionState(false);
    };

    ws.onerror = (error: any) => {
      if (ws !== this.ws) return;
      console.error('❌ WebSocket error:', error);
      this.log(`WebSocket error: ${JSON.stringify(error)}`, 'error');
    };
  }



  /**
   * @param notifyServer Send an `end` event before closing. Pass false when the
   *   server is the one that ended the call.
   */
  async disconnect(notifyServer: boolean = true): Promise<void> {
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
    if (notifyServer && this.ws && this.ws.readyState === WebSocket.OPEN) {
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
      await this.stopRecording();
    }

    if (this.audioQueue) {
      this.audioQueue.clear();
    }

    this.sentChunks = 0;
    this.totalSentBytes = 0;
    this.lastSentTime = 0;
    this.audioStreamBuffer = [];
    this.sendResidual = new Int16Array(0);
    this.hasReceivedFirstData = false;

    // NOTE: do not deactivate iOS AVAudioSession here. react-native-audio-api's input
    // node loses its 0Hz format if the session is deactivated, and the next start() throws
    // "input hw format invalid" / Exception in HostFunction. Keeping the session active
    // keeps the recorder format valid for the next call.

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
      sampleRate: this.sendRate,
      receiveSampleRate: this.transport.receiveRate,
      receiveFormat: this.transport.receiveFormat,
      bufferSize: this.audioStreamBuffer.length,
      isAudioInitialized: this.isAudioInitialized
    };
  }

  async dispose() {
    console.log('🗑️ Disposing AudioQueueService...');
    this.log('Disposing service', 'info');

    await this.disconnect();

    await this.deactivateCallAudioSession();

    if (this.audioRecorder) {
      try {
        this.audioRecorder.clearOnAudioReady();
        this.audioRecorder.clearOnError();
        this.audioRecorder.stop();
        this.audioRecorder.disconnect();
      } catch (error) {
        this.log(`AudioRecorder cleanup error: ${error}`, 'warning');
      } finally {
        this.audioRecorder = null;
      }
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

  setAudioProcessingMode(mode: AudioProcessingMode): void {
    this.audioProcessingConfig = {
      ...AudioQueueService.AUDIO_PROCESSING_PRESETS[mode],
      mode,
    };
    this.log(`Audio processing mode set to ${mode}`, 'info');
  }

  setAudioProcessingConfig(config: AudioProcessingConfig): void {
    const nextMode = config.mode || this.audioProcessingConfig.mode;
    const base = AudioQueueService.AUDIO_PROCESSING_PRESETS[nextMode];
    this.audioProcessingConfig = {
      ...base,
      ...this.audioProcessingConfig,
      ...config,
      mode: nextMode,
    };
    this.log('Audio processing config updated', 'info');
  }

  getAudioProcessingConfig(): Required<AudioProcessingConfig> {
    return { ...this.audioProcessingConfig };
  }

  // Native Audio Effects Control (Android only)

  /**
   * Enable or disable Acoustic Echo Cancellation
   */
  async setAcousticEchoCanceler(enabled: boolean): Promise<boolean> {
    if (!this.nativeAudioEffectsInitialized) {
      console.warn('Native audio effects not initialized');
      return false;
    }
    try {
      const result = await VocalLabsAudioEffects.setAcousticEchoCanceler(enabled);
      this.log(`Acoustic Echo Canceller ${enabled ? 'enabled' : 'disabled'}`, 'info');
      return result;
    } catch (error) {
      this.log(`Failed to set AEC: ${error}`, 'warning');
      return false;
    }
  }

  /**
   * Enable or disable Noise Suppression
   */
  async setNoiseSuppressor(enabled: boolean): Promise<boolean> {
    if (!this.nativeAudioEffectsInitialized) {
      console.warn('Native audio effects not initialized');
      return false;
    }
    try {
      const result = await VocalLabsAudioEffects.setNoiseSuppressor(enabled);
      this.log(`Noise Suppressor ${enabled ? 'enabled' : 'disabled'}`, 'info');
      return result;
    } catch (error) {
      this.log(`Failed to set NS: ${error}`, 'warning');
      return false;
    }
  }

  /**
   * Enable or disable Automatic Gain Control
   */
  async setAutomaticGainControl(enabled: boolean): Promise<boolean> {
    if (!this.nativeAudioEffectsInitialized) {
      console.warn('Native audio effects not initialized');
      return false;
    }
    try {
      const result = await VocalLabsAudioEffects.setAutomaticGainControl(enabled);
      this.log(`Automatic Gain Control ${enabled ? 'enabled' : 'disabled'}`, 'info');
      return result;
    } catch (error) {
      this.log(`Failed to set AGC: ${error}`, 'warning');
      return false;
    }
  }

  /**
   * Get status of all native audio effects
   */
  async getNativeAudioEffectsStatus(): Promise<AudioEffectsStatus | null> {
    if (!this.nativeAudioEffectsInitialized) {
      return null;
    }
    try {
      return await VocalLabsAudioEffects.getStatus();
    } catch (error) {
      this.log(`Failed to get audio effects status: ${error}`, 'warning');
      return null;
    }
  }

  /**
   * Toggle speaker (loudspeaker) vs earpiece on Android.
   * true → speaker, false → earpiece
   */
  async setSpeakerphone(enabled: boolean): Promise<boolean> {
    try {
      const result = await VocalLabsAudioEffects.setSpeakerphone(enabled);
      this.log(`Speakerphone ${enabled ? 'on' : 'off (earpiece)'}`, 'info');
      return result;
    } catch (error) {
      this.log(`Failed to set speakerphone: ${error}`, 'warning');
      return false;
    }
  }

  /**
   * Check if native audio effects are available and initialized
   */
  isNativeAudioEffectsAvailable(): boolean {
    return VocalLabsAudioEffects.isAvailable() && this.nativeAudioEffectsInitialized;
  }

  private async configureCallAudioSession(): Promise<void> {
    try {
      if (Platform.OS !== 'ios') {
        return;
      }

      AudioManager.setAudioSessionOptions(this.callSessionOptions);
      await AudioManager.setAudioSessionActivity(true);
      this.log('iOS audio session configured for voice chat mode', 'info');
    } catch (error) {
      this.log(`Failed to configure call audio session: ${error}`, 'warning');
    }
  }

  private async deactivateCallAudioSession(): Promise<void> {
    try {
      if (Platform.OS !== 'ios') {
        return;
      }

      await AudioManager.setAudioSessionActivity(false);
    } catch (error) {
      this.log(`Failed to deactivate audio session: ${error}`, 'warning');
    }
  }
}
