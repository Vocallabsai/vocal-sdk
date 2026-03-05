# VocalLabs SDK

A lightweight React Native SDK for VocalLabs audio calls with built-in audio streaming. Connect directly to calls using call ID and WebSocket URL - no API polling, no authentication, just simple direct connections.

## Features

- 🎤 **Direct Connection** - Connect directly with call ID and WebSocket URL
- 🎧 **Audio Streaming** - Real-time audio with WebSocket support
- 🔇 **Mute Control** - Built-in mute/unmute functionality
- 📈 **Statistics** - Real-time audio and sending stats
- 🎯 **Event-Driven** - Comprehensive event system for all actions
- 📝 **TypeScript** - Full TypeScript support with type definitions
- ⚡ **Lightweight** - No authentication, no polling, minimal overhead

## Installation

```bash
npm install vocal-native-sdk
# or
yarn add vocal-native-sdk
```

## Quick Start

```typescript
import VocalLabsSDK from 'vocal-native-sdk';

// 1. Initialize SDK (optional config)
const sdk = new VocalLabsSDK({
  sampleRate: 8000,
  enableLogs: true,
});

// 2. Setup event listeners
sdk.on('onAudioConnected', () => {
  console.log('Audio connected!');
});

sdk.on('onUserConnected', (connected) => {
  console.log('User connected:', connected);
});

sdk.on('onMuteChanged', (isMuted) => {
  console.log('Mute status:', isMuted);
});

// 3. Connect with either callId, websocketUrl, or both
// If both provided, websocketUrl is used (prioritized)

// Option 1: Just websocket URL (callId extracted from query params)
await sdk.connect({ websocketUrl: 'wss://rupture2.vocallabs.ai/ws?callId=test-call-123&sampleRate=8000' });

// Option 2: Just call ID
await sdk.connect({ callId: 'test-call-123' });

// Option 3: Both (websocketUrl takes priority)
await sdk.connect({ 
  callId: 'test-call-123', 
  websocketUrl: 'wss://rupture2.vocallabs.ai/ws?callId=test-call-123&sampleRate=8000' 
});

// 4. Control the call
sdk.toggleMute();              // Toggle mute
sdk.setVolume(0.8);           // Set volume
const stats = sdk.getStats(); // Get statistics

// 5. Disconnect when done
sdk.disconnect();
```

## Configuration

### SDK Configuration Options

```typescript
interface SDKConfig {
  sampleRate?: number;       // Optional: Audio sample rate (default: 8000)
  enableLogs?: boolean;      // Optional: Enable console logs (default: true)
}
```

### Example with Custom Configuration

```typescript
const sdk = new VocalLabsSDK({
  sampleRate: 16000,
  enableLogs: false,
});
```

## API Reference

### Main Methods

#### `initializeAudioService(audioService)`
Initialize the SDK with your AudioAPIService instance. **Must be called before connecting audio.**

```typescript
const audioService = new AudioAPIService();
sdk.initializeAudioService(audioService);
```

#### `connect({ callId?, websocketUrl? })`
Connect directly to a call. Provide either callId, websocketUrl, or both. If both are provided, websocketUrl takes priority.

```typescript
// With just websocket URL (callId extracted from query params)
await sdk.connect({ websocketUrl: 'wss://rupture2.vocallabs.ai/ws?callId=test-123&sampleRate=8000' });

// With just call ID
await sdk.connect({ callId: 'test-123' });

// With both (websocket URL is prioritized)
await sdk.connect({ 
  callId: 'test-123', 
  websocketUrl: 'wss://rupture2.vocallabs.ai/ws?callId=test-123&sampleRate=8000' 
});
```

#### `disconnect()`
Disconnect from the current call and clean up.

```typescript
sdk.disconnect();
```

#### `toggleMute()`
Toggle microphone mute state.

```typescript
const isMuted = sdk.toggleMute();
console.log('Muted:', isMuted);
```

#### `setVolume(volume)`
Set audio volume (0.0 to 1.0).

```typescript
sdk.setVolume(0.8);
```

#### `getState()`
Get current SDK state.

```typescript
const state = sdk.getState();
console.log(state.isConnected, state.isMuted, state.currentCallId);
```

#### `getStats()`
Get audio and sending statistics.

```typescript
const stats = sdk.getStats();
console.log('Sent chunks:', stats.sending.sentChunks);
console.log('Received chunks:', stats.audio.receivedChunks);
```

#### `dispose()`
Clean up all resources.

```typescript
await sdk.dispose();
```

## Events

The SDK provides a comprehensive event system:

### Audio Events
- `onAudioConnected` - Audio stream connected
- `onAudioDisconnected` - Audio stream disconnected
- `onUserConnected` - Other user connected to the call
- `onUserDisconnected` - Other user disconnected
- `onMuteChanged` - Mute state changed
- `onStatsUpdate` - Statistics updated

### General Events
- `onError` - General error occurred
- `onLog` - Log message (if logging enabled)

### Event Usage Example

```typescript
sdk.on('onAudioConnected', () => {
  console.log('Audio connected successfully');
});

sdk.on('onUserConnected', (connected) => {
  if (connected) {
    console.log('Other user joined the call');
  }
});
});

sdk.on('onStatsUpdate', ({ audio, sending }) => {
  console.log(`Queue size: ${audio.queueSize}`);
  console.log(`Sent chunks: ${sending.sentChunks}`);
});
```

## Complete Example with React Native Component

```typescript
import React, { useEffect, useRef, useState } from 'react';
import { View, Button, Text } from 'react-native';
import SubspaceCallSDK from 'subspace-call-sdk';
import AudioAPIService from './services/AudioService';

const CallScreen = ({ userId, friendId }) => {
  const sdkRef = useRef<VocalLabsSDK | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    // Initialize SDK
    const sdk = new VocalLabsSDK({
      sampleRate: 8000,
      enableLogs: true,
    });

    // Setup listeners
    sdk.on('onAudioConnected', () => {
      setIsConnected(true);
      console.log('Audio connected');
    });

    sdk.on('onAudioDisconnected', () => {
      setIsConnected(false);
    });

    sdk.on('onMuteChanged', (muted) => {
      setIsMuted(muted);
    });

    sdkRef.current = sdk;

    return () => {
      sdk.dispose();
    };websocketUrl: string) => {
    if (!sdkRef.current) return;
    
    try {
      // Just provide the websocket URL
      await sdkRef.current.connect({ websocketUrl }
    try {
      // Provide either callId, websocketUrl, or both
      await sdkRef.current.connect(callId, websocketUrl);
    } catch (error) {
      console.error('Failed to connect:', error);
    }
  };

  const endCall = () => {
    sdkRef.current?.disconnect();
  };

  const toggleMute = () => {
    sdkRef.current?.toggleMute();
  };

  return (
    <View>
      <Text>Connected: {isConnected ? 'Yes' : 'No'}</Text>
      <Text>Muted: {isMuted ? 'Yes' : 'No'}</Text>
      
      <Button 
        title="Start Call" 
        onPress={() => startCall('wss://rupture2.vocallabs.ai/ws?callId=test-123&sampleRate=8000')} 
      />
      <Button title="Toggle Mute" onPress={toggleMute} />
      <Button title="End Call" onPress={endCall} />
    </View>
  );
};

export default CallScreen;
```

## Error Handling

The SDK provides detailed error information:

```typescript
import { SDKError, ErrorCode } from 'vocal-native-sdk';

try {
  await sdk.connect({ websocketUrl: 'wss://rupture2.vocallabs.ai/ws?callId=test-123&sampleRate=8000' });
} catch (error) {
  if (error instanceof SDKError) {
    switch (error.code) {
      case ErrorCode.INVALID_CONFIG:
        console.log('Invalid configuration or URL');
        break;
      case ErrorCode.AUDIO_CONNECTION_FAILED:
        console.log('Audio connection failed');
        break;
      // ... handle other error codes
    }
  }
}
```

## TypeScript Support

The SDK is written in TypeScript and provides full type definitions:

```typescript
import VocalLabsSDK, { 
  CallData,
  SDKState,
  AudioStats,
  SendingStats 
} from 'vocal-native-sdk';
```

## Requirements

- React Native >= 0.60.0
- React >= 16.8.0

## License

MIT

## Support

For issues and questions, please open an issue on GitHub.
