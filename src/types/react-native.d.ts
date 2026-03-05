/**
 * Type declarations for React Native modules
 * These are peer dependencies that will be provided by the consuming app
 */

declare module 'react-native-audio-api' {
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
    copyToChannel(source: Float32Array, channelNumber: number, startInChannel?: number): void;
  }

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

declare module 'react-native-live-audio-stream' {
  export interface AudioStreamOptions {
    sampleRate?: number;
    channels?: number;
    bitsPerSample?: number;
    wavFile?: string;
    bufferSize?: number;
    audioSource?: number;
  }

  export default class LiveAudioStream {
    static init(options: AudioStreamOptions): void;
    static start(): void;
    static stop(): void;
    static on(event: 'data', callback: (data: string) => void): void;
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
