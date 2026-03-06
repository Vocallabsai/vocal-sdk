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
type StatsCallback = (stats: { sentChunks: number; receivedChunks: number; queueSize: number }) => void;
type LogCallback = (message: string, type: LogType) => void;
type ConnectionCallback = (connected: boolean) => void;
type MuteCallback = (muted: boolean) => void;
type UserConnectedCallback = (connected: boolean) => void;

class ReactNativeAudioQueue {
  private sampleRate: number;
  private audioContext: AudioContext | null;
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
  private static readonly MAX_QUEUE_FRAMES = 20;
  private static readonly MAX_SCHEDULE_AHEAD = 0.5;
  
  // Mobile-specific optimizations
  public maxQueueSize: number = 20;
  public isLowLatencyMode: boolean = false;

  constructor(sampleRate: number = 8000) {
    this.sampleRate = sampleRate;
    this.audioContext = null;
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
    try {
      if (this.isInitialized) {
        return;
      }

      this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 1.0;
      this.gainNode.connect(this.audioContext.destination);

      this.isInitialized = true;
    } catch (error) {
      console.error('❌ Failed to initialize AudioContext:', error);
      throw error;
    }
  }

  async addChunk(base64Audio: string): Promise<void> {
    try {
      this.receivedChunks++;

      if (!this.isInitialized || !this.audioContext) {
        await this.initialize();
        if (this.audioContext) {
          this.nextPlayTime = this.audioContext.currentTime;
        }
      }

      const pcmData = this.base64ToPCMData(base64Audio);
      if (!pcmData) return;

      // Drop if too much already scheduled
      const now = this.audioContext!.currentTime;
      if (this.nextPlayTime - now > 0.8) {
        return;
      }

      // Hard cap JS queue
      if (this.playbackQueue.length >= ReactNativeAudioQueue.MAX_QUEUE_FRAMES) {
        this.playbackQueue.shift();
      }

      this.playbackQueue.push(pcmData);
      this.processQueue();

    } catch (error) {
      console.error('❌ Error adding audio chunk:', error);
    }
  }

  scheduleOneFrame(pcmFloat32: Float32Array) {
    if (!this.audioContext) return;

    const ctx = this.audioContext;

    const buffer = ctx.createBuffer(1, pcmFloat32.length, ctx.sampleRate);
    buffer.copyToChannel(pcmFloat32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startTime = this.nextPlayTime;
    source.start(startTime);

    this.nextPlayTime = startTime + buffer.duration;

    source.onended = () => {
      this.processQueue();
    };
  }

  processQueue() {
    if (!this.audioContext) return;
    if (this.isProcessingQueue) return;

    this.isProcessingQueue = true;

    const ctx = this.audioContext;
    const now = ctx.currentTime;

    if (this.nextPlayTime < now) {
      this.nextPlayTime = now;
    }

    if (this.nextPlayTime - now > ReactNativeAudioQueue.MAX_SCHEDULE_AHEAD) {
      this.isProcessingQueue = false;
      return;
    }

    const frame = this.playbackQueue.shift();
    if (!frame) {
      this.isProcessingQueue = false;
      return;
    }

    this.scheduleOneFrame(frame);
    this.isProcessingQueue = false;
  }

  base64ToPCMData(base64Audio: string): Float32Array | null {
    try {
      const binaryString = atob(base64Audio);
      const byteLength = binaryString.length;
      
      if (byteLength % 2 === 0) {
        const samples = byteLength / 2;
        const floatArray = new Float32Array(samples);
        
        for (let i = 0; i < samples; i++) {
          const byteIndex = i * 2;
          const sample = (binaryString.charCodeAt(byteIndex + 1) << 8) | binaryString.charCodeAt(byteIndex);
          const signedSample = sample > 32767 ? sample - 65536 : sample;
          floatArray[i] = signedSample / 32768.0;
        }
        
        return floatArray;
      } else {
        const floatArray = new Float32Array(byteLength);
        for (let i = 0; i < byteLength; i++) {
          floatArray[i] = (binaryString.charCodeAt(i) - 128) / 128.0;
        }
        
        return floatArray;
      }
      
    } catch (error) {
      console.error('❌ Error converting base64 to PCM:', error);
      return null;
    }
  }

  setVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  clear(): void {
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
  }

  getStats(): AudioStats {
    return {
      receivedChunks: this.receivedChunks,
      playedChunks: this.playedChunks,
      queueSize: this.playbackQueue.length,
      isPlaying: this.isPlaying,
      isProcessingQueue: this.isProcessingQueue,
      audioContextState: this.audioContext?.state || 'not initialized'
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

  constructor() {
    this.ws = null;
    this.audioQueue = null;
    
    this.isConnected = false;
    this.isMuted = false;
    this.isRecording = false;
    this.sampleRate = 8000;
    
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

    this.initializeAudioQueue();
  }

  initializeAudioQueue(): void {
    this.audioQueue = new ReactNativeAudioQueue(this.sampleRate);
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
    console.log(`[AudioQueueService] ${message}`);
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
        if (!this.hasReceivedFirstData && !(/^A+=*$/.test(message.media.payload))) {
          this.hasReceivedFirstData = true;
          this.startRecording();
          console.log('✅ First audio data received');
          if (this.userConnectedCallback) {
            this.userConnectedCallback(true);
          }
        }
        this.audioQueue.addChunk(message.media.payload);
        this.updateStats();
      }
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
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
        console.error('❌ Cannot start recording - WebSocket not connected');
        return;
      }
      
      const permission = await this.requestAudioPermissions();
      if (!permission) {
        console.error('❌ Audio permission denied');
        return;
      }
      
      const options: Partial<AudioStreamOptions> & { sampleRate: number; channels: number; bitsPerSample: number; wavFile: string } = {
        sampleRate: this.sampleRate,
        channels: 1,
        bitsPerSample: 16,
        wavFile: 'audio.wav',
        bufferSize: 320,
        audioSource: 6, // VOICE_COMMUNICATION for echo cancellation
      };

      LiveAudioStream.init(options);
      
      LiveAudioStream.on('data', (data: string) => {
        this.handleRealTimeAudioData(data);
      });

      LiveAudioStream.start();
      
      this.isRecording = true;
      this.audioStreamBuffer = [];
      
      console.log('✅ Live audio streaming started with echo cancellation');
      
    } catch (error) {
      console.error('❌ Error starting live audio stream:', error);
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
        return;
      }
      
      if (data && data.length > 0) {
        this.processAndSendAudioFrames(data);
      }
      
    } catch (error) {
      console.error('❌ Error handling real-time audio data:', error);
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
      if (sampleCount === 0) return;
      
      const samples = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = (bytes[i * 2 + 1] << 8) | bytes[i * 2];
      }
            
      const samplesPer20ms = this.sampleRate === 8000 ? 160 : 320;
            
      for (let i = 0; i < samples.length; i += samplesPer20ms) {
        const slice = samples.subarray(i, Math.min(i + samplesPer20ms, samples.length));
        const frameBase64 = this.samplesToBase64(slice);
        
        if (frameBase64) {
          this.sendAudioChunk(frameBase64);
        }
      }      
    } catch (error) {
      console.error('❌ Error processing audio frames:', error);
    }
  }

  sendAudioChunk(base64AudioData: string): boolean {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      if (this.isMuted) {
        return false;
      }

      const message: WebSocketMessage = {
        event: 'media',
        media: {
          contentType: 'audio/x-l16',
          sampleRate: this.sampleRate,
          payload: base64AudioData
        }
      };

      this.ws.send(JSON.stringify(message));
      
      this.sentChunks++;
      this.lastSentTime = Date.now();
      this.totalSentBytes += base64AudioData.length;
      this.updateStats();
      
      return true;
    } catch (error) {
      console.error('❌ Error sending chunk:', error);
      return false;
    }
  }

  async stopRecording(): Promise<void> {
    try {
      if (this.isRecording) {
        LiveAudioStream.stop();
        this.isRecording = false;
        this.audioStreamBuffer = [];
        console.log('✅ Live streaming stopped');
      }
    } catch (error) {
      console.error('❌ Error stopping recording:', error);
    }
  }

  async connectWithCustomUrl(callId: string, sampleRate: number, wsUrl: string): Promise<void> {
    this.sampleRate = sampleRate;
    
    if (this.audioQueue) {
      await this.audioQueue.dispose();
    }
    this.initializeAudioQueue();
    this.hasReceivedFirstData = false;

    console.log(`🔗 Connecting to WebSocket for call ${callId}: ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      console.log('✅ WebSocket connected');
      this.updateConnectionState(true);
    };
    
    this.ws.onmessage = (event: any) => {
      this.handleWebSocketMessage(event);
    };
    
    this.ws.onclose = (event: any) => {
      console.log(`❌ WebSocket disconnected: ${event.code} ${event.reason}`);
      if (this.isRecording) {
        this.stopRecording();
      }
      this.updateConnectionState(false);
    };
    
    this.ws.onerror = (error: Event) => {
      console.error('❌ WebSocket error:', error);
      if (this.isRecording) {
        this.stopRecording();
      }
      this.updateConnectionState(false);
    };
  }

  async connectMobile(callId: string, sampleRate: number = 8000): Promise<boolean> {
    const wsUrl = `wss://rupture2.vocallabs.ai/ws?callId=${callId}&sampleRate=${sampleRate}`;
    await this.connectWithCustomUrl(callId, sampleRate, wsUrl);
    return true;
  }

  disconnect(): void {
    console.log('🔌 Disconnecting...');
    
    if (this.ws) {
      this.ws.close();
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
    this.disconnect();
    
    try {
      LiveAudioStream.stop();
    } catch (error) {
      // Already stopped
    }
    
    if (this.audioQueue) {
      await this.audioQueue.dispose();
      this.audioQueue = null;
    }
    
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
