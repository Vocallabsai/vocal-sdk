# vocallabsai-sdk

React Native SDK for real-time VocalLabs voice calls over WebSocket.

## Setup

### 1) Install

```bash
npm install vocallabsai-sdk
```

### 2) Install peer dependencies (if your app does not already have them)

Peer dependencies used by this SDK:

- react
- react-native
- react-native-audio-api
- base-64

### 3) Android permissions

Add these permissions in your app `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

Also request microphone permission at runtime.

### 4) Linking

For React Native 0.60+, autolinking should work automatically.

If not linked, add manual linking:

`android/settings.gradle`

```gradle
include ':vocallabs-audio-effects'
project(':vocallabs-audio-effects').projectDir = new File(rootProject.projectDir, '../node_modules/vocallabsai-sdk/android')
```

`android/app/build.gradle`

```gradle
dependencies {
  implementation project(':vocallabs-audio-effects')
}
```

### 5) Rebuild app

```bash
cd android && ./gradlew clean
```

## Features

- Direct WebSocket call connection
- Real-time microphone streaming + remote playback
- Built-in mute/unmute and volume control
- Event-driven API for connection and call state
- Live stats for sent/received audio
- TypeScript support out of the box
- Android native call-audio effects support (AEC, NS, AGC)

## Quick Start

```ts
import VocalLabsSDK from 'vocallabsai-sdk';

const sdk = new VocalLabsSDK({
  sampleRate: 8000,
  enableLogs: true,
});

sdk.on('onAudioConnected', () => {
  console.log('Audio connected');
});

sdk.on('onAudioDisconnected', () => {
  console.log('Audio disconnected');
});

sdk.on('onUserConnected', (connected) => {
  console.log('User connected:', connected);
});

sdk.on('onMuteChanged', (isMuted) => {
  console.log('Muted:', isMuted);
});

sdk.on('onError', (error) => {
  console.error('SDK error:', error);
});

await sdk.connect('wss://rupture2.vocallabs.ai/ws?callId=test-call-123&sampleRate=8000');

sdk.toggleMute();
sdk.setVolume(0.9);

const stats = sdk.getStats();
console.log(stats);

sdk.disconnect();
```

## Configuration

```ts
interface SDKConfig {
  sampleRate?: number;   // default: 8000
  enableLogs?: boolean;  // default: true
  audioProcessing?: {
    mode?: 'off' | 'balanced' | 'aggressive';
    remoteActiveWindowMs?: number;
    noiseGateQuiet?: number;
    noiseGateRemote?: number;
    halfDuplexRms?: number;
    halfDuplexPeak?: number;
    duckLow?: number;
    duckHigh?: number;
    duckPivotRms?: number;
    dcBlockerR?: number;
  };
}
```

## Core API

### Connection

```ts
await sdk.connect(websocketUrl: string);
sdk.disconnect();
```

### Mic + Playback Controls

```ts
const muted = sdk.toggleMute();
sdk.setVolume(0.0 - 1.0);
```

### State + Stats

```ts
const state = sdk.getState();
const stats = sdk.getStats();
const call = sdk.getCurrentCall();
```

### Cleanup

```ts
await sdk.dispose();
```

## Native Audio Effects (Android)

These methods allow controlling Android native call-audio processing.

```ts
await sdk.setAcousticEchoCanceler(true);
await sdk.setNoiseSuppressor(true);
await sdk.setAutomaticGainControl(true);

const available = sdk.isNativeAudioEffectsAvailable();
const status = await sdk.getNativeAudioEffectsStatus();
```

Example status object:

```ts
{
  aecAvailable: true,
  aecEnabled: true,
  nsAvailable: true,
  nsEnabled: true,
  agcAvailable: true,
  agcEnabled: true,
  audioSessionId: 123
}
```

## Events

Supported events:

- onAudioConnected
- onAudioDisconnected
- onUserConnected
- onUserDisconnected
- onMuteChanged
- onStatsUpdate
- onError
- onLog

Example:

```ts
sdk.on('onStatsUpdate', ({ audio, sending }) => {
  console.log('Queue:', audio.queueSize);
  console.log('Sent chunks:', sending.sentChunks);
});
```

## Android Notes

- Grant RECORD_AUDIO permission at runtime.
- Keep MODIFY_AUDIO_SETTINGS permission in AndroidManifest.
- Prefer autolinking first; use manual linking only if needed.

## Minimal React Native Example

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { View, Button, Text } from 'react-native';
import VocalLabsSDK from 'vocallabsai-sdk';

export default function CallScreen() {
  const sdkRef = useRef<VocalLabsSDK | null>(null);
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const sdk = new VocalLabsSDK({ sampleRate: 8000, enableLogs: true });

    sdk.on('onAudioConnected', () => setConnected(true));
    sdk.on('onAudioDisconnected', () => setConnected(false));
    sdk.on('onMuteChanged', (m) => setMuted(m));

    sdkRef.current = sdk;

    return () => {
      sdk.dispose();
    };
  }, []);

  const start = async () => {
    await sdkRef.current?.connect('wss://rupture2.vocallabs.ai/ws?callId=test-call-123&sampleRate=8000');
  };

  const end = () => sdkRef.current?.disconnect();
  const toggle = () => sdkRef.current?.toggleMute();

  return (
    <View>
      <Text>Connected: {connected ? 'Yes' : 'No'}</Text>
      <Text>Muted: {muted ? 'Yes' : 'No'}</Text>
      <Button title="Start" onPress={start} />
      <Button title="Toggle Mute" onPress={toggle} />
      <Button title="End" onPress={end} />
    </View>
  );
}
```

## License

MIT
