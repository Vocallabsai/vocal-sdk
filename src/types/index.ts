/**
 * VocalLabs SDK Types
 * All TypeScript interfaces and types for the SDK
 */

// ============= SDK Configuration =============

export interface SDKConfig {
  sampleRate?: number;
  enableLogs?: boolean;
  audioProcessing?: AudioProcessingConfig;
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
  sampleRate: number;
  bufferSize: number;
  isAudioInitialized: boolean;
}

export interface AudioConnectionOptions {
  sampleRate?: number;
  wsUrl: string;
}

// ============= Event Callbacks =============

export type EventType = 
  | 'onAudioConnected'
  | 'onAudioDisconnected'
  | 'onUserConnected'
  | 'onUserDisconnected'
  | 'onMuteChanged'
  | 'onStatsUpdate'
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
