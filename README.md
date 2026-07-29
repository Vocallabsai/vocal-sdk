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
  // omit sampleRate to let the network decide
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

## Sample rate

By default the SDK picks the rate from the network at connect time. The
`_web_<rate>` token in the call URL is treated as a suggestion, not a command —
`_web_48000` on a 3g phone connects at 8000.

To pin a rate instead, set it in the config:

```ts
const sdk = new VocalLabsSDK({ sampleRate: 32000 }); // always 32000
const sdk = new VocalLabsSDK({});                    // network decides
```

| connection | rate |
|---|---|
| cellular `5g` | 48000 |
| cellular `4g` | 32000 |
| wifi / ethernet | 32000 |
| cellular, generation unknown | 16000 |
| cellular `3g` / `2g` | 8000 |
| anything else, or NetInfo not installed | 32000 |

**The call URL is rewritten to match whatever was chosen.** The server reads its
outbound rate and codec from the `_web_<rate>` token, so if the client picked
8000 while the URL still said `_web_48000`, the server would keep streaming
44100 and the audio would play at `receiveRate / sendRate` speed — 5.5x fast, not
a clean failure. Rewriting the token keeps both ends on one profile.

> **Check before deploying:** this assumes the server parses the rate off the end
> of the `agent=<agent>_<callId>_web_<rate>` string. If that string is signed or
> looked up whole, rewriting it will break the lookup.

Read this before relying on detection:

- **`cellularGeneration` is the radio technology, not the speed.** A phone on 5G
  with one bar still reports `'5g'`. NetInfo gives no throughput or latency
  estimate to check it against, so the low tiers (`2g`/`3g` really does mean
  slow) are trustworthy while the top tier is an optimistic guess.
- **Wifi is never promoted to 48000.** iOS reports no wifi throughput at all, and
  plenty of wifi is a congested hotspot, so there is no evidence to promote on.
- **The rate is chosen once**, before the socket opens, because the handshake
  announces it. It does not adapt mid-call.
- **`isConnectionExpensive` is reported but not acted on** — on most devices every
  cellular connection is "expensive", so demoting on it would pin all mobile
  traffic to narrowband. It means metered, not slow.

### Using your own signal

Detection needs [`@react-native-community/netinfo`](https://github.com/react-native-netinfo/react-native-netinfo),
which is **not** a dependency of this SDK. If your app already has it, the SDK
picks it up at runtime and there is nothing to do. If it doesn't, calls resolve
to 32000 and nothing breaks.

To skip NetInfo entirely — or to fold in a signal the SDK can't see, like your
own latency probe or a server hint — supply a picker:

```ts
import NetInfo from '@react-native-community/netinfo';
import { setNetworkRatePicker } from 'vocallabsai-sdk';

setNetworkRatePicker(async () => {
  const state = await NetInfo.fetch();
  return state.type === 'wifi' ? 48000 : 32000;
});
```

Return `8000 | 16000 | 32000 | 48000`, or `{ rate, reason }` to label it in the
logs. Anything else falls back to detection rather than a failed negotiation.

## Configuration

```ts
interface SDKConfig {
  sampleRate?: number;   // default: unset — network decides
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
    const sdk = new VocalLabsSDK({ enableLogs: true });

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
