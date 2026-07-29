/**
 * VocalLabs SDK
 * Main entry point
 */

export { VocalLabsSDK as default } from './VocalLabsSDK';
export { VocalLabsSDK } from './VocalLabsSDK';

// Export types
export * from './types';

// Export managers (if needed for advanced usage)
export { CallManager } from './call/CallManager';
export { AudioManager } from './audio/AudioManager';

// Export utilities
export { Logger } from './utils/logger';
export { DEFAULT_CONFIG } from './config/constants';

// Network-based rate selection (`_web_anysamplerate`)
export {
  AUTO_RATE_FALLBACK,
  pickTransportRateFromNetwork,
  rateFromNetInfoState,
  setNetworkRatePicker,
} from './config/networkRate';
export type { NetworkRatePick, NetworkRatePicker, TransportRate } from './config/networkRate';
