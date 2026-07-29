import type { NetworkRatePicker } from '../config/networkRate';

/**
 * VocalLabs SDK Types
 * All TypeScript interfaces and types for the SDK
 */

// ============= SDK Configuration =============

export interface SDKConfig {
  /**
   * Pin the transport rate to one of 8000 | 16000 | 32000 | 48000.
   *
   * Leave it unset — the default — and the SDK picks from network conditions at
   * connect time, ignoring whatever rate the call URL's `_web_<rate>` token
   * names. Set it and that choice is skipped entirely.
   *
   * Either way the URL's token is rewritten to match, because the server reads
   * its outbound rate and codec from it; letting the two disagree plays the
   * incoming stream at `receiveRate / sendRate` speed.
   */
  sampleRate?: number;

  /**
   * Select a transport at connect time — from `sampleRate` if set, otherwise
   * from the network — and rewrite the URL's `_web_<rate>` token to match.
   * Default true.
   *
   * Set false to leave the URL completely untouched and use the rate the URL
   * already names (or `sampleRate` if you set one). That is the opt-out: it
   * also means the client and server can end up on different rates, which
   * plays the incoming stream at the wrong speed.
   */
  autoTransport?: boolean;

  /**
   * Supply your own rate selection instead of reading NetInfo. Same contract as
   * `setNetworkRatePicker`, but scoped to this SDK instance.
   */
  networkRatePicker?: NetworkRatePicker;

  enableLogs?: boolean;
  audioProcessing?: AudioProcessingConfig;
  /** Base WS URL used when a `human-transfer` event hands the call to an agent. */
  transferBaseUrl?: string;
}

export type AudioProcessingMode = 'off' | 'balanced' | 'aggressive';

export interface AudioProcessingConfig {
  mode?: AudioProcessingMode;
  remoteActiveWindowMs?: number;
  noiseGateQuiet?: number;
  noiseGateRemote?: number;
  halfDuplexRms?: number;
  halfDuplexPeak?: number;
  duckLow?: number;
  duckHigh?: number;
  duckPivotRms?: number;
  dcBlockerR?: number;
}

// ============= Call Management =============

export interface CallData {
  call_id: string;
  websocket?: string;
}

// ============= Audio Management =============

export interface AudioStats {
  receivedChunks: number;
  playedChunks: number;
  queueSize: number;
  isPlaying: boolean;
  isProcessingQueue: boolean;
  audioContextState: string;
}

export interface SendingStats {
  sentChunks: number;
  totalSentBytes: number;
  lastSentTime: number;
  isRecording: boolean;
  isMuted: boolean;
  /** Capture/send rate, from the `_web_<rate>` token in the call URL. */
  sampleRate: number;
  /** Rate the server streams back at — not necessarily `sampleRate`. */
  receiveSampleRate: number;
  /** Codec the server streams back in. Outgoing audio is always `audio/x-l16`. */
  receiveFormat: 'audio/x-l16' | 'audio/x-mulaw';
  bufferSize: number;
  isAudioInitialized: boolean;
}

export interface AudioConnectionOptions {
  sampleRate?: number;
  autoTransport?: boolean;
  networkRatePicker?: NetworkRatePicker;
  wsUrl: string;
  transferBaseUrl?: string;
}

// ============= Event Callbacks =============

/** Raw `hangup` message from the server, with whatever fields it carries. */
export type HangupPayload = Record<string, any>;

export type EventType =
  | 'onAudioConnected'
  | 'onAudioDisconnected'
  | 'onUserConnected'
  | 'onUserDisconnected'
  | 'onMuteChanged'
  | 'onStatsUpdate'
  | 'onHangup'
  | 'onError'
  | 'onLog';

export type EventCallback<T = any> = (data: T) => void;

export interface EventListeners {
  onAudioConnected: EventCallback<void>[];
  onAudioDisconnected: EventCallback<void>[];
  onUserConnected: EventCallback<boolean>[];
  onUserDisconnected: EventCallback<boolean>[];
  onMuteChanged: EventCallback<boolean>[];
  onStatsUpdate: EventCallback<{ audio: AudioStats; sending: SendingStats }>[];
  /** Server ended the call. Fires before `onAudioDisconnected`. */
  onHangup: EventCallback<HangupPayload>[];
  onError: EventCallback<Error>[];
  onLog: EventCallback<{ message: string; type: 'info' | 'warning' | 'error' }>[];
}

// ============= SDK State =============

export interface SDKState {
  isInitialized: boolean;
  isConnected: boolean;
  currentCallId: string | null;
  isMuted: boolean;
}

// ============= Error Types =============

export class SDKError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'SDKError';
  }
}

export enum ErrorCode {
  AUDIO_CONNECTION_FAILED = 'AUDIO_CONNECTION_FAILED',
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  INVALID_CALL_ID = 'INVALID_CALL_ID',
  NETWORK_ERROR = 'NETWORK_ERROR',
  INVALID_CONFIG = 'INVALID_CONFIG',
}
