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

### 3) iOS setup

Add the native pod to your `ios/Podfile` inside the `target` block:

```ruby
pod 'VocalLabsAudioEffects', :path => '../node_modules/vocallabsai-sdk/ios'
```

Then run:

```bash
cd ios && pod install
```

Add the microphone permission to `ios/<YourApp>/Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>This app needs access to your microphone for voice calls.</string>
```

### 4) Android permissions

Add these permissions in your app `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
```

Also request `RECORD_AUDIO` permission at runtime.

### 5) Linking

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

### 6) Rebuild app

```bash
cd android && ./gradlew clean
```

## Features

- Direct WebSocket call connection
- Real-time microphone streaming + remote playback
- Built-in mute/unmute and volume control
- Speaker / earpiece toggle on Android
- Event-driven API for connection and call state
- Live stats for sent/received audio
- TypeScript support out of the box
- Android: `MODE_IN_COMMUNICATION` + `STREAM_VOICE_CALL` audio routing — echo cancellation, hardware volume buttons, Bluetooth HFP, speaker toggle
- iOS: `allowBluetoothHFP` audio session option for Bluetooth headset support

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

## Native Audio (Android)

The SDK uses `AudioManager.MODE_IN_COMMUNICATION` and requests audio focus on `STREAM_VOICE_CALL`. This gives you:

- **Echo cancellation** — `MODE_IN_COMMUNICATION` enables hardware AEC automatically
- **Hardware volume buttons** — control call volume via `STREAM_VOICE_CALL`
- **Speaker / earpiece toggle** — `setSpeakerphoneOn` via the SDK
- **Bluetooth HFP** — audio routed through Bluetooth headsets when connected

### Speaker Toggle

```ts
// Switch to loudspeaker
await sdk.setSpeakerphone(true);

// Switch back to earpiece
await sdk.setSpeakerphone(false);
```

### Audio Effects (AEC / NS / AGC)

Fine-grained control over hardware audio processing:

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

- Grant `RECORD_AUDIO` permission at runtime.
- Keep `MODIFY_AUDIO_SETTINGS` in AndroidManifest.
- For Bluetooth headset support, add `BLUETOOTH` / `BLUETOOTH_CONNECT` permissions.
- The SDK sets `MODE_IN_COMMUNICATION` on call start and resets to `MODE_NORMAL` on stop.
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
  const [speaker, setSpeaker] = useState(false);

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
  const toggleSpeaker = async () => {
    const next = !speaker;
    await sdkRef.current?.setSpeakerphone(next);
    setSpeaker(next);
  };

  return (
    <View>
      <Text>Connected: {connected ? 'Yes' : 'No'}</Text>
      <Text>Muted: {muted ? 'Yes' : 'No'}</Text>
      <Text>Speaker: {speaker ? 'On' : 'Earpiece'}</Text>
      <Button title="Start" onPress={start} />
      <Button title="Toggle Mute" onPress={toggle} />
      <Button title="Toggle Speaker" onPress={toggleSpeaker} />
      <Button title="End" onPress={end} />
    </View>
  );
}
```

## License

MIT
