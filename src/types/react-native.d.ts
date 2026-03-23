/**
 * Type declarations for React Native modules
 * These are peer dependencies that will be provided by the consuming app
 */

declare module 'react-native-audio-api' {
  export type IOSCategory = 'record' | 'ambient' | 'playback' | 'multiRoute' | 'soloAmbient' | 'playAndRecord';
  export type IOSMode = 'default' | 'gameChat' | 'videoChat' | 'voiceChat' | 'measurement' | 'voicePrompt' | 'spokenAudio' | 'moviePlayback' | 'videoRecording';
  export type IOSOption =
    | 'duckOthers'
    | 'allowAirPlay'
    | 'mixWithOthers'
    | 'defaultToSpeaker'
    | 'allowBluetoothHFP'
    | 'allowBluetoothA2DP'
    | 'overrideMutedMicrophoneInterruption'
    | 'interruptSpokenAudioAndMixWithOthers';

  export interface SessionOptions {
    iosMode?: IOSMode;
    iosOptions?: IOSOption[];
    iosCategory?: IOSCategory;
    iosAllowHaptics?: boolean;
  }

  export interface PermissionStatus {
    status: 'Undetermined' | 'Denied' | 'Granted';
  }

  export class AudioContext {
    constructor(options?: { sampleRate?: number });
    readonly state: 'suspended' | 'running' | 'closed';
    readonly currentTime: number;
    readonly sampleRate: number;
    readonly destination: AudioDestinationNode;
    resume(): Promise<void>;
    close(): Promise<void>;
    createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
    createBufferSource(): AudioBufferSourceNode;
    createGain(): GainNode;
  }

  export interface AudioBuffer {
    readonly length: number;
    readonly duration: number;
    readonly sampleRate: number;
    readonly numberOfChannels: number;
    getChannelData(channel: number): Float32Array;
    copyToChannel(source: Float32Array, channelNumber: number, startInChannel?: number): void;
  }

  export interface OnAudioReadyEventType {
    buffer: AudioBuffer;
    numFrames: number;
    when: number;
  }

  export interface AudioRecorderCallbackOptions {
    sampleRate: number;
    bufferLength: number;
    channelCount: number;
  }

  export type RecorderResult<T = {}> = ({ status: 'success' } & T) | { status: 'error'; message: string };

  export class AudioRecorder {
    constructor();
    start(): RecorderResult<{ path: string }>;
    stop(): RecorderResult<{ path: string; size: number; duration: number }>;
    connect(node: AudioNode): void;
    disconnect(): void;
    clearOnAudioReady(): void;
    clearOnError(): void;
    onError(callback: (error: { message: string }) => void): void;
    onAudioReady(
      options: AudioRecorderCallbackOptions,
      callback: (event: OnAudioReadyEventType) => void
    ): RecorderResult<void>;
  }

  export const AudioManager: {
    setAudioSessionOptions(options: SessionOptions): void;
    setAudioSessionActivity(enabled: boolean): Promise<boolean>;
    requestRecordingPermissions(): Promise<PermissionStatus>;
    checkRecordingPermissions(): Promise<PermissionStatus>;
  };

  export interface AudioNode {
    connect(destination: AudioNode | AudioDestinationNode): void;
    disconnect(): void;
  }

  export interface AudioDestinationNode extends AudioNode {}

  export interface AudioBufferSourceNode extends AudioNode {
    buffer: AudioBuffer | null;
    onended: (() => void) | null;
    start(when?: number, offset?: number, duration?: number): void;
    stop(when?: number): void;
  }

  export interface GainNode extends AudioNode {
    readonly gain: AudioParam;
  }

  export interface AudioParam {
    value: number;
  }
}

declare module 'base-64' {
  export function encode(input: string): string;
  export function decode(input: string): string;
}

declare module 'react-native' {
  export const Platform: {
    OS: 'ios' | 'android' | 'windows' | 'macos' | 'web';
    select<T>(specifics: { ios?: T; android?: T; default?: T }): T;
  };

  export class PermissionsAndroid {
    static PERMISSIONS: {
      RECORD_AUDIO: string;
    };
    static RESULTS: {
      GRANTED: string;
      DENIED: string;
      NEVER_ASK_AGAIN: string;
    };
    static request(
      permission: string,
      rationale?: {
        title: string;
        message: string;
        buttonPositive?: string;
        buttonNegative?: string;
        buttonNeutral?: string;
      }
    ): Promise<string>;
  }
}
