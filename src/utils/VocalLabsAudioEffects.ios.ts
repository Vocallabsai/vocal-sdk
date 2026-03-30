import { NativeModules } from 'react-native/Libraries/BatchedBridge/NativeModules';
const { VocalLabsAudioEffectsModule } = NativeModules;

export default {
  initialize: () => VocalLabsAudioEffectsModule.initialize(),
  startEffect: (effectName: string) => VocalLabsAudioEffectsModule.startEffect(effectName),
  stopEffect: () => VocalLabsAudioEffectsModule.stopEffect(),
  setGain: (gain: number) => VocalLabsAudioEffectsModule.setGain(gain),
  isNativeRecording: () => VocalLabsAudioEffectsModule.isNativeRecording(),
  startNativeRecording: (options?: object) => VocalLabsAudioEffectsModule.startNativeRecording(options || {}),
  stopNativeRecording: () => VocalLabsAudioEffectsModule.stopNativeRecording(),
  addAudioChunkListener: (callback: (event: any) => void) => {
    const { NativeEventEmitter } = require('react-native');
    const emitter = new NativeEventEmitter(VocalLabsAudioEffectsModule);
    return emitter.addListener('onNativeAudioChunk', callback);
  },
};
