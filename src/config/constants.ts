/**
 * SDK Constants and Configuration
 */

export const DEFAULT_CONFIG = {
  SAMPLE_RATE: 8000,
  ENABLE_LOGS: true,
  TRANSFER_BASE_URL: 'wss://rupture2.chatwoot.store/ws',
};

export type ReceiveFormat = 'audio/x-l16' | 'audio/x-mulaw';

/**
 * A transport's two independent rates.
 *
 * The `_web_<rate>` token in the websocket URL names the *capture* rate only.
 * The server streams back at a different rate, and in one case a different
 * codec. Playing the incoming stream at the capture rate shifts it by exactly
 * receiveRate / sendRate — 32000 plays 1.333x fast, 48000 plays 1.0884x fast.
 */
export interface TransportProfile {
  /** Rate we capture and send at — the rate named by the `_web_<rate>` token. */
  sendRate: number;
  /** Rate the server streams back at. NOT the same as sendRate. */
  receiveRate: number;
  /** Codec the server streams back in. Outgoing audio is always L16. */
  receiveFormat: ReceiveFormat;
}

export const TRANSPORT_PROFILES: Record<number, TransportProfile> = {
  8000: { sendRate: 8000, receiveRate: 8000, receiveFormat: 'audio/x-mulaw' },
  16000: { sendRate: 16000, receiveRate: 16000, receiveFormat: 'audio/x-l16' },
  32000: { sendRate: 32000, receiveRate: 24000, receiveFormat: 'audio/x-l16' },
  48000: { sendRate: 48000, receiveRate: 44100, receiveFormat: 'audio/x-l16' },
};

/**
 * Best-tested transport: L16 both directions, and no 44.1kHz playback for the
 * device to resample. Selected by the `_web_32000` token in the call URL.
 */
export const RECOMMENDED_SAMPLE_RATE = 32000;

/** Mono samples in one 20ms packet at `rate`. */
export function samplesPerPacket(rate: number): number {
  return Math.round(rate / 50);
}

/** Bytes in one 20ms L16 packet at `rate`: 320 @ 8k, 640 @ 16k, 1280 @ 32k, 1920 @ 48k. */
export function bytesPerPacket(rate: number): number {
  return samplesPerPacket(rate) * 2;
}

/**
 * Read the negotiated rate out of a call URL. Handles both documented shapes:
 *
 *   wss://call.vocallabs.ai/ws/?agent=<agent>_<callId>_web_32000
 *   wss://rupture2.vocallabs.ai/ws?callId=<callId>&sampleRate=32000
 *
 * Matched against the raw string rather than URL/searchParams, which are
 * unevenly polyfilled across React Native versions.
 */
export function parseNegotiatedRate(wsUrl: string): number | null {
  if (!wsUrl) {
    return null;
  }

  const webToken = wsUrl.match(/_web_(\d{4,6})/);
  if (webToken) {
    return Number(webToken[1]);
  }

  const rateParam = wsUrl.match(/[?&]sampleRate=(\d{4,6})/i);
  if (rateParam) {
    return Number(rateParam[1]);
  }

  return null;
}

/**
 * Resolve the send/receive profile for a call URL. Falls back to the 8000
 * profile when the URL carries no rate, preserving pre-1.1.9 behaviour.
 */
export function resolveTransportProfile(wsUrl: string): TransportProfile {
  const rate = parseNegotiatedRate(wsUrl);

  if (rate === null) {
    return TRANSPORT_PROFILES[DEFAULT_CONFIG.SAMPLE_RATE];
  }

  const profile = TRANSPORT_PROFILES[rate];
  if (profile) {
    return profile;
  }

  // Unknown rate: we have no receive-rate mapping for it, so assume symmetric
  // L16 rather than silently applying some other transport's numbers.
  console.warn(
    `⚠️ Unrecognised transport rate ${rate}Hz — assuming ${rate}Hz L16 both directions. ` +
      `Known rates: ${Object.keys(TRANSPORT_PROFILES).join(', ')}.`
  );
  return { sendRate: rate, receiveRate: rate, receiveFormat: 'audio/x-l16' };
}
