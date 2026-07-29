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
  resolveTransportAsync,
  samplesPerPacket,
  type ResolveTransportOptions,
  type ResolvedTransport,
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

/**
 * A decoded frame together with the rate it was decoded at.
 *
 * The rate MUST travel with the samples. Resampling reads
 * `contextRate / inputSampleRate`, and `inputSampleRate` tracks the last rate
 * the server declared — so a rate change while frames are waiting in the queue
 * would resample that backlog by the new ratio and pitch-shift audio that was
 * captured at the old one. Barely audible when the queue held ~0 frames; a
 * clearly alien burst once a jitter buffer holds a few hundred ms.
 */
interface QueuedFrame {
  samples: Float32Array;
  rate: number;
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
  private playbackQueue: QueuedFrame[] = [];
  private isProcessingQueue: boolean;
  private nextPlayTime: number;
  /**
   * Base jitter buffer depth in seconds — the starting cushion, and the floor
   * the adaptive target never drops below.
   */
  public targetLatency: number;
  /**
   * The cushion actually in force. Starts at `targetLatency` and grows on every
   * underrun, because a buffer that keeps running dry is a buffer that is too
   * small for this connection's jitter. Refilling to the same depth that just
   * failed only buys another stall a second later.
   */
  private currentPrebuffer: number = 0.2;
  /** Extra depth for the very first fill: Android's audio session is still settling. */
  private static readonly FIRST_FILL_BONUS = 0.1;
  private static readonly UNDERRUN_STEP = 0.06;
  private static readonly MAX_PREBUFFER = 0.45;
  private hasFilledOnce: boolean = false;
  /**
   * The server does not send 20ms packets — observed frames are 60-130 samples,
   * i.e. 2-5ms each. One AudioBufferSourceNode per frame would mean ~300 nodes
   * and ~300 `onended` hops across the bridge every second, which on Android
   * costs more than the audio it schedules. Frames are merged up to this much
   * audio per node instead.
   */
  private static readonly COALESCE_SECONDS = 0.06;
  /** Hard cap on buffered audio. Beyond this the oldest frames are dropped. */
  private static readonly MAX_BUFFERED_SECONDS = 1.0;
  private static readonly MAX_SCHEDULE_AHEAD = 0.5;
  /** Bounds work per processQueue() call; the schedule-ahead window is the real limit. */
  private static readonly MAX_NODES_PER_PASS = 8;
  /** Seconds of audio sitting in playbackQueue, kept in step with pushes/shifts. */
  private queuedSeconds: number = 0;
  /**
   * True while filling the jitter buffer. Nothing is scheduled until
   * `targetLatency` of audio is queued, so network jitter has a cushion to eat
   * into. Set again whenever the queue runs dry, which is also what an
   * end-of-utterance looks like.
   */
  private isPrebuffering: boolean = true;
  /** Quiet period after which a partial buffer is played out rather than held. */
  private static readonly FLUSH_IDLE_MS = 250;
  private lastChunkAtMs: number = 0;
  private queueProcessTimer: any = null; // Fallback queue processor
  private lastOverflowLogTime: number = 0;
  private overflowSuppressedCount: number = 0;
  private lastAheadDropLogTime: number = 0;
  private lastUnderrunLogTime: number = 0;
  private underrunCount: number = 0;
  
  // Mobile-specific optimizations
  public maxQueueSize: number = 4;
  public isLowLatencyMode: boolean = false;
  private audioFormat: AudioFormat = 'audio/x-l16';
  private droppedFrames: number = 0;
  private firstChunkLogged: boolean = false;
  /** Last rate the server actually declared. Sticky across frames that omit it. */
  private serverDeclaredRate: number | null = null;

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
    this.firstChunkLogged = false;
    this.serverDeclaredRate = null;
    
    this.playbackQueue = [];
    this.isProcessingQueue = false;
    this.nextPlayTime = 0;
    this.queuedSeconds = 0;
    this.isPrebuffering = true;
    this.targetLatency = 0.2;
    this.currentPrebuffer = this.targetLatency;
    this.hasFilledOnce = false;
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
        if (this.playbackQueue.length === 0 || this.isProcessingQueue) {
          return;
        }

        // An utterance shorter than the prebuffer target — or the tail left over
        // after an underrun — would otherwise sit in the queue forever waiting
        // for a cushion that no more audio is coming to fill. Once the stream
        // has been quiet this long, play out what we have.
        if (
          this.isPrebuffering &&
          Date.now() - this.lastChunkAtMs >= ReactNativeAudioQueue.FLUSH_IDLE_MS
        ) {
          this.isPrebuffering = false;
          if (this.audioContext) {
            this.nextPlayTime = this.audioContext.currentTime;
          }
        }

        this.processQueue();
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
        `⚠️ Queue over ${ReactNativeAudioQueue.MAX_BUFFERED_SECONDS}s ` +
        `(${(this.queuedSeconds * 1000).toFixed(0)}ms buffered), dropping oldest frame. ` +
        `Total dropped: ${this.droppedFrames}${suffix}`
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
        // Every chunk that arrives before initialize() resolves lands here, so
        // this must stay silent — logging it once per chunk buried the console
        // under ~200 identical lines. initialize() logs the outcome itself.
        await this.initialize();
      }

      const pcmData = this.base64ToPCMData(base64Audio);
      if (!pcmData) return;

      // One-shot forensic dump of the first real frame. Everything needed to tell
      // a rate problem from a scheduling problem, in one place:
      //   - what the server said vs what we negotiated
      //   - what AudioContext we actually got (Android often refuses the ask)
      //   - the resample ratio that will be applied
      // If `implied rate @20ms` disagrees with `decoding as`, the stream is not
      // the rate we think it is and playback speed will be off by that factor.
      if (!this.firstChunkLogged && pcmData.length > 0) {
        this.firstChunkLogged = true;
        const bytesPerSample = this.audioFormat === 'audio/x-mulaw' ? 1 : 2;
        const byteLength = Math.ceil((base64Audio.length * 3) / 4);
        const frameMs = (pcmData.length / this.inputSampleRate) * 1000;
        const ctxRate = this.audioContext?.sampleRate ?? 0;
        console.log(
          '🔬 FIRST AUDIO CHUNK\n' +
          `   base64 chars     : ${base64Audio.length}  (~${byteLength} bytes)\n` +
          `   codec            : ${this.audioFormat} (${bytesPerSample} byte/sample)\n` +
          `   samples decoded  : ${pcmData.length}\n` +
          `   negotiated recv  : ${this.negotiatedReceiveRate} Hz\n` +
          `   decoding as      : ${this.inputSampleRate} Hz` +
            `${this.inputSampleRate !== this.negotiatedReceiveRate ? '  ← server overrode it' : ''}\n` +
          // Framing is the server's choice and is not fixed — 2-5ms frames are
          // normal. Do NOT infer the sample rate from one frame's length; an
          // earlier version assumed 20ms packets here and cried rate mismatch
          // on a stream that was perfectly in tune.
          `   frame duration   : ${frameMs.toFixed(1)} ms  (server framing, not a rate signal)\n` +
          `   AudioContext rate: ${ctxRate} Hz` +
            `${ctxRate !== this.negotiatedReceiveRate ? '  ← device refused the requested rate' : ''}\n` +
          `   resample ratio   : ${ctxRate ? (ctxRate / this.inputSampleRate).toFixed(4) : 'n/a'}x\n` +
          `   jitter buffer    : ${(this.targetLatency * 1000).toFixed(0)} ms prebuffer, ` +
            `${(ReactNativeAudioQueue.COALESCE_SECONDS * 1000).toFixed(0)} ms per node`
        );
      }

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

      // Tag the frame with the rate it was decoded at, here and now.
      const frameRate = this.inputSampleRate;
      this.playbackQueue.push({ samples: pcmData, rate: frameRate });
      this.queuedSeconds += pcmData.length / frameRate;
      this.lastChunkAtMs = Date.now();

      // Cap the backlog by DURATION, not frame count. The old 20-frame cap was
      // written for 20ms packets; against 3ms frames it capped the buffer at
      // ~60ms and threw away audio the jitter buffer needs.
      while (
        this.queuedSeconds > ReactNativeAudioQueue.MAX_BUFFERED_SECONDS &&
        this.playbackQueue.length > 1
      ) {
        const dropped = this.playbackQueue.shift();
        if (!dropped) break;
        this.queuedSeconds = Math.max(0, this.queuedSeconds - dropped.samples.length / dropped.rate);
        this.droppedFrames++;
        this.logOverflowWarning();
      }

      // Log status periodically to identify scheduling issues
      if (this.receivedChunks % 500 === 0) {
        const audioState = this.audioContext?.state;
        console.log(
          `📊 Queue status: ${this.playbackQueue.length} frames / ${(this.queuedSeconds * 1000).toFixed(0)}ms | ` +
          `Played: ${this.playedChunks} | Received: ${this.receivedChunks} | ` +
          `Underruns: ${this.underrunCount} | Cushion: ${(this.prebufferTarget() * 1000).toFixed(0)}ms | ` +
          `AudioContext: ${audioState}`
        );
      }
      
      this.processQueue();

    } catch (error) {
      console.error('❌ Error adding audio chunk:', error);
      this.droppedFrames++;
    }
  }

  scheduleOneFrame(pcmFloat32: Float32Array, frameRate?: number, sourceFrames: number = 1) {
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
      const samples = this.convertForContextRate(
        pcmFloat32,
        contextRate,
        frameRate ?? this.inputSampleRate
      );

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
        const before = this.playedChunks;
        this.playedChunks += sourceFrames;

        // Every 500 server frames, not every 500 nodes — coalescing means those
        // are no longer the same thing.
        if (Math.floor(before / 500) !== Math.floor(this.playedChunks / 500)) {
          console.log(
            `▶️ Scheduled frame ${this.playedChunks} at ${startTime.toFixed(3)}s | ` +
            `Lead: ${((startTime - ctx.currentTime) * 1000).toFixed(0)}ms | ` +
            `Queue: ${(this.queuedSeconds * 1000).toFixed(0)}ms`
          );
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

  private convertForContextRate(
    input: Float32Array,
    contextRate: number,
    inputRate: number
  ): Float32Array {
    if (input.length === 0 || contextRate <= 0 || inputRate <= 0 || contextRate === inputRate) {
      return input;
    }

    const ratio = contextRate / inputRate;

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

  /**
   * Pull up to `COALESCE_SECONDS` of audio off the queue as ONE array.
   *
   * Returns the source frame count alongside it so `playedChunks` keeps counting
   * server frames and stays comparable with `receivedChunks`.
   */
  private takeCoalescedFrame(): { samples: Float32Array; rate: number; frames: number } | null {
    if (this.playbackQueue.length === 0) {
      return null;
    }

    // One node carries one rate, so a batch stops at any rate change.
    const rate = this.playbackQueue[0].rate;
    const maxSamples = Math.max(1, Math.round(ReactNativeAudioQueue.COALESCE_SECONDS * rate));

    const taken: Float32Array[] = [];
    let total = 0;

    while (this.playbackQueue.length > 0) {
      const head = this.playbackQueue[0];
      if (head.rate !== rate) {
        break;
      }
      // Always take at least one frame, even if it alone exceeds the budget.
      if (taken.length > 0 && total + head.samples.length > maxSamples) {
        break;
      }
      this.playbackQueue.shift();
      taken.push(head.samples);
      total += head.samples.length;
      if (total >= maxSamples) {
        break;
      }
    }

    this.queuedSeconds = Math.max(0, this.queuedSeconds - total / rate);

    if (taken.length === 1) {
      return { samples: taken[0], rate, frames: 1 };
    }

    const merged = new Float32Array(total);
    let offset = 0;
    for (const frame of taken) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    return { samples: merged, rate, frames: taken.length };
  }

  /** Cushion required before playback (re)starts. Deeper on the first fill. */
  private prebufferTarget(): number {
    const base = Math.max(this.currentPrebuffer, this.targetLatency);
    return this.hasFilledOnce ? base : base + ReactNativeAudioQueue.FIRST_FILL_BONUS;
  }

  private noteUnderrun(): void {
    this.underrunCount++;

    // Grow the cushion, but only for a dry-out that interrupts speech. A queue
    // that empties after a quiet gap is just the end of an utterance, and
    // inflating latency for those would make every reply arrive later for no
    // reason.
    const midSpeech = Date.now() - this.lastChunkAtMs < ReactNativeAudioQueue.FLUSH_IDLE_MS;
    if (midSpeech) {
      this.currentPrebuffer = Math.min(
        ReactNativeAudioQueue.MAX_PREBUFFER,
        Math.max(this.currentPrebuffer, this.targetLatency) + ReactNativeAudioQueue.UNDERRUN_STEP
      );
    }

    const nowMs = Date.now();
    // Draining is also what the end of an utterance looks like, so this is
    // informational and heavily throttled rather than a warning per gap.
    if (nowMs - this.lastUnderrunLogTime >= 10000) {
      console.log(
        `🔈 Playback buffer ran dry (${this.underrunCount} so far` +
        `${midSpeech ? ', mid-speech' : ', end of utterance'}) — cushion now ` +
        `${(this.prebufferTarget() * 1000).toFixed(0)}ms.`
      );
      this.lastUnderrunLogTime = nowMs;
    }
  }

  processQueue() {
    try {
      if (!this.audioContext) return;

      if (this.isProcessingQueue) return;

      this.isProcessingQueue = true;

      const ctx = this.audioContext;

      try {
        // Hold everything back until there is a cushion to play out of.
        // Without this, frames were scheduled the instant they landed, so the
        // output followed network jitter exactly: every late packet became a
        // silent gap. That is what the choppiness was.
        if (this.isPrebuffering) {
          if (this.queuedSeconds < this.prebufferTarget()) {
            this.isProcessingQueue = false;
            return;
          }
          this.isPrebuffering = false;
          this.hasFilledOnce = true;
          this.nextPlayTime = ctx.currentTime;
        }

        // Bounded scheduling loop avoids recursive churn during bursty traffic.
        let scheduledCount = 0;
        while (this.playbackQueue.length > 0) {
          const now = ctx.currentTime;

          if (this.nextPlayTime < now) {
            // The audio clock overtook us: the cushion is gone. Rebuild it
            // instead of scheduling into the past, which only produced a gap
            // and left us just as exposed to the next late packet.
            this.noteUnderrun();
            this.nextPlayTime = now;
            this.isPrebuffering = true;
            break;
          }

          if (this.nextPlayTime - now > ReactNativeAudioQueue.MAX_SCHEDULE_AHEAD) {
            break;
          }

          const batch = this.takeCoalescedFrame();
          if (!batch) break;

          this.scheduleOneFrame(batch.samples, batch.rate, batch.frames);
          scheduledCount++;

          if (scheduledCount >= ReactNativeAudioQueue.MAX_NODES_PER_PASS) {
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
      if (candidateRate !== this.inputSampleRate) {
        console.log(
          `🎚️ Incoming rate now ${candidateRate}Hz (was ${this.inputSampleRate}Hz, negotiated ${this.negotiatedReceiveRate}Hz)`
        );
      }
      this.inputSampleRate = candidateRate;
      this.serverDeclaredRate = candidateRate;
      if (candidateRate !== this.negotiatedReceiveRate) {
        this.logRateMismatch(candidateRate);
      }
    } else {
      // This frame carried no rate. That is NOT a signal to change anything —
      // servers commonly declare the rate on the first frame (or on a format
      // change) and omit it thereafter. Resetting to the negotiated rate here
      // made `inputSampleRate` oscillate between two values mid-stream, and
      // since every frame is resampled by `contextRate / inputSampleRate`, the
      // ratio flipped frame to frame: audio that is intermittently too fast,
      // too slow, and full of discontinuities at the frame joins.
      // Stick with whatever the server last told us.
      this.inputSampleRate = this.serverDeclaredRate ?? this.negotiatedReceiveRate;
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
    this.queuedSeconds = 0;
    this.isPrebuffering = true;
    this.currentPrebuffer = this.targetLatency;
    this.hasFilledOnce = false;
    this.lastChunkAtMs = 0;
    this.underrunCount = 0;
    this.receivedChunks = 0;
    this.playedChunks = 0;
    this.firstChunkLogged = false;
    this.serverDeclaredRate = null;
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
  private lastTransport: ResolvedTransport | null = null;
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

    // The socket this start belongs to. Permission prompts and native setup are
    // async, so it can close underneath us — see the guard at the end.
    const startedForWs = this.ws;

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
          await this.stopIfSocketGone(startedForWs);
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
      await this.stopIfSocketGone(startedForWs);

    } catch (error) {
      const errorMsg = `Error starting microphone capture: ${error}`;
      console.error('❌ ' + errorMsg);
      this.log(errorMsg, 'error');
    }
  }

  /**
   * Undo a start whose socket died while it was still starting.
   *
   * `onclose`/`onerror` only call `stopRecording()` when `isRecording` is already
   * true, and the eager start on `ws.onopen` means it usually is not yet. A
   * socket rejected right after the start event (close 1006) therefore left the
   * microphone running with nowhere to send — an endless "WebSocket not ready,
   * dropping audio data" — and the leaked capture session then made the NEXT
   * call's recorder report no audio session id, silently costing it AEC/NS.
   */
  private async stopIfSocketGone(startedForWs: WebSocket | null): Promise<boolean> {
    if (this.ws === startedForWs && startedForWs?.readyState === WebSocket.OPEN) {
      return false;
    }

    console.warn('⚠️ WebSocket closed while recording was starting — stopping the microphone');
    await this.stopRecording();
    return true;
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

  async connectWithCustomUrl(
    wsUrl: string,
    transferBaseUrl?: string,
    transportOptions?: ResolveTransportOptions
  ) {
    // The network chooses the rate unless the URL pins one with `sampleRate=<n>`.
    // The URL comes back rewritten so the server lands on the same profile —
    // the server streams back at its own rate and codec, and a mismatch plays
    // the incoming audio at the wrong speed rather than failing outright.
    const resolved = await resolveTransportAsync(wsUrl, transportOptions ?? {});
    this.transport = resolved.profile;
    this.lastTransport = resolved;
    wsUrl = resolved.url;
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

  /** The transport resolved for the live call — rate, codec, URL and why. */
  getTransportInfo(): (ResolvedTransport & { url: string }) | null {
    return this.lastTransport;
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
