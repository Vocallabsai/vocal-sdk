/**
 * SDK Constants and Configuration
 */

import { pickTransportRateFromNetwork } from './networkRate';
import type { NetworkRatePick, NetworkRatePicker } from './networkRate';

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
 * Does this URL ask the client to choose the rate from network conditions?
 *
 * Accepts `_web_anysamplerate` and `&sampleRate=any`. Both need a trailing
 * boundary so a longer word starting with the token is not mistaken for one.
 *
 * Mostly documentation now — network selection is the default for any URL that
 * does not pin a rate, so an explicit auto token is no longer required to get it.
 */
export function isAutoRateUrl(wsUrl: string): boolean {
  if (!wsUrl) {
    return false;
  }
  return (
    /_web_anysamplerate(?![a-z0-9])/i.test(wsUrl) ||
    /[?&]sampleRate=any(?![a-z0-9])/i.test(wsUrl)
  );
}

/**
 * Point an existing `_web_<token>` at `rate` so the server streams back the
 * matching profile. URLs with no token are returned untouched — inventing one
 * risks breaking a server that never expected it.
 */
export function rewriteRateToken(wsUrl: string, rate: number): string {
  const rewritten = wsUrl.replace(/_web_(?:\d{4,6}|anysamplerate(?![a-z0-9]))/i, `_web_${rate}`);
  if (rewritten !== wsUrl) {
    const was = (wsUrl.match(/_web_\w+/) || ['?'])[0];
    console.log(`🔀 Connect URL token rewritten: ${was} → _web_${rate}`);
  } else if (!/_web_\w+/.test(wsUrl)) {
    console.log(`ℹ️ URL carries no _web_ token — nothing to rewrite; the server is not told the rate.`);
  }
  return rewritten;
}

export interface ResolvedTransport {
  profile: TransportProfile;
  /** The URL to actually connect to — rewritten when the rate changed. */
  url: string;
  /** What the network reading chose, or null when the rate was pinned or auto is off. */
  pick: NetworkRatePick | null;
}

export interface ResolveTransportOptions {
  /** `SDKConfig.sampleRate` — skips network selection when set. */
  pinnedRate?: number;
  /** `SDKConfig.autoTransport` — false leaves the URL untouched. Default true. */
  autoTransport?: boolean;
  /** Per-call override for how the rate is chosen. */
  networkRatePicker?: NetworkRatePicker;
}

/**
 * Decide the transport for a call, and return the URL to actually open.
 *
 * The network reading is the default: whatever rate the `_web_<rate>` token
 * names is treated as a suggestion. `SDKConfig.sampleRate` is the one thing that
 * outranks it — setting it is how a caller pins a rate deliberately.
 *
 * Because the server picks its outbound rate and codec from the URL token,
 * overriding it locally would desync the two directions and play the incoming
 * stream at `receiveRate / sendRate` speed. So the token is rewritten to
 * whatever was chosen, keeping both ends on the same profile.
 *
 * Async because NetInfo's `fetch()` is.
 *
 * @param pinnedRate `SDKConfig.sampleRate`, or undefined to let the network decide.
 */
export async function resolveTransportAsync(
  wsUrl: string,
  options: ResolveTransportOptions | number = {}
): Promise<ResolvedTransport> {
  // Back-compat: this used to take the pinned rate as a bare number.
  const { pinnedRate, autoTransport = true, networkRatePicker } =
    typeof options === 'number' ? { pinnedRate: options, autoTransport: true, networkRatePicker: undefined } : options;

  if (autoTransport === false) {
    // Opt-out: never touch the URL. Use the pinned rate if there is one,
    // otherwise whatever the URL already names.
    const rate = pinnedRate ?? parseNegotiatedRate(wsUrl) ?? DEFAULT_CONFIG.SAMPLE_RATE;
    const profile = TRANSPORT_PROFILES[rate] ?? {
      sendRate: rate,
      receiveRate: rate,
      receiveFormat: 'audio/x-l16' as ReceiveFormat,
    };
    const urlRate = parseNegotiatedRate(wsUrl);
    console.log(`🚫 autoTransport off — using ${rate}Hz, URL left untouched`);
    if (urlRate !== null && urlRate !== rate) {
      console.warn(
        `⚠️ MISMATCH: the URL asks for ${urlRate}Hz but this client runs at ${rate}Hz. ` +
          `The server streams what the URL says, so playback will run at the wrong speed.`
      );
    }
    return { profile, url: wsUrl, pick: null };
  }

  if (pinnedRate !== undefined && TRANSPORT_PROFILES[pinnedRate]) {
    console.log(`📌 Transport ${pinnedRate}Hz — pinned by the sampleRate option`);
    return {
      profile: TRANSPORT_PROFILES[pinnedRate],
      url: rewriteRateToken(wsUrl, pinnedRate),
      pick: null,
    };
  }
  if (pinnedRate !== undefined) {
    console.warn(
      `⚠️ sampleRate ${pinnedRate} is not a known transport ` +
        `(${Object.keys(TRANSPORT_PROFILES).join(', ')}); using the network instead.`
    );
  }

  const pick = await pickTransportRateFromNetwork(networkRatePicker);
  console.log(`🌐 Transport ${pick.rate}Hz — network: ${pick.reason}`);
  if (pick.metrics) {
    // The raw readings, so a surprising choice can be traced back to what NetInfo
    // actually said rather than taken on trust.
    console.log('   NetInfo:', JSON.stringify(pick.metrics));
  }
  // Every rate the picker can return has a profile, so this cannot miss.
  return { profile: TRANSPORT_PROFILES[pick.rate], url: rewriteRateToken(wsUrl, pick.rate), pick };
}

/**
 * @deprecated Resolves the profile only, ignoring the network and returning the
 * URL's own rate. Use `resolveTransportAsync`, which also returns the URL to
 * connect to. Kept so existing callers keep compiling.
 */
export async function resolveTransportProfileAsync(wsUrl: string): Promise<TransportProfile> {
  return (await resolveTransportAsync(wsUrl)).profile;
}

/**
 * Resolve the send/receive profile for a call URL. Falls back to the 8000
 * profile when the URL carries no rate, preserving pre-1.1.9 behaviour.
 *
 * Cannot honour `_web_anysamplerate` — network detection is async. Use
 * `resolveTransportProfileAsync` for that; this returns the 8000 fallback.
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
