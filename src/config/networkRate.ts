/**
 * Network-based transport rate selection for the `_web_anysamplerate` token.
 *
 * The web SDK reads `navigator.connection`, which does not exist in React
 * Native. The equivalent here is `@react-native-community/netinfo`, which trades
 * one weakness for another:
 *
 *   - It *does* report a real '5g' generation, which the browser API never does.
 *   - But `cellularGeneration` is the radio technology, NOT the observed speed.
 *     A phone on 5G with one bar in a basement still reports '5g'. NetInfo
 *     exposes no throughput or latency estimate to sanity-check it against.
 *
 * So the low end ('2g'/'3g' means slow) is trustworthy and the high end is a
 * guess. Tiers stay conservative accordingly.
 */

/** Rates the server has profiles for. Anything else has no receive-rate mapping. */
export type TransportRate = 8000 | 16000 | 32000 | 48000;

export interface NetworkRatePick {
  rate: TransportRate;
  /** Human-readable explanation of the choice, for logs. */
  reason: string;
  /** Raw NetInfo readings, or null when unavailable. */
  metrics: {
    type?: string;
    cellularGeneration?: string | null;
    isConnectionExpensive?: boolean;
    isInternetReachable?: boolean | null;
  } | null;
}

/**
 * Rate used when nothing can be determined — no NetInfo, no picker, or a
 * connection type we have no opinion about.
 *
 * 32000 rather than the SDK's legacy 8000 default: it is the recommended,
 * best-tested profile, and a device we cannot measure is far more likely to be
 * on wifi or LTE than on a link that genuinely needs narrowband.
 */
export const AUTO_RATE_FALLBACK: TransportRate = 32000;

/** A caller-supplied override. May be sync or async. */
export type NetworkRatePicker = () =>
  | TransportRate
  | NetworkRatePick
  | Promise<TransportRate | NetworkRatePick>;

let cachedPicker: NetworkRatePicker | null = null;

/**
 * Supply your own rate selection, bypassing NetInfo entirely.
 *
 * This is the recommended path for apps that already depend on NetInfo: the SDK
 * never imports it, so there is no optional-dependency resolution to go wrong,
 * and you can fold in signals the SDK cannot see (your own latency probe, a
 * server hint, a user setting).
 *
 *   import NetInfo from '@react-native-community/netinfo';
 *   setNetworkRatePicker(async () => {
 *     const s = await NetInfo.fetch();
 *     return s.type === 'wifi' ? 48000 : 32000;
 *   });
 */
export function setNetworkRatePicker(picker: NetworkRatePicker | null): void {
  cachedPicker = picker;
}

let netInfoLoadAttempted = false;
let netInfoModule: any = null;

/**
 * Load NetInfo if the app happens to have it installed.
 *
 * The module name is held in a variable on purpose. Metro resolves `require()`
 * calls with string literals at *bundle* time, so a literal here would break the
 * build of every app that has not installed NetInfo — a try/catch cannot save
 * you from a bundler error the way it can in Node. Going through a variable
 * defeats that static analysis, leaving a runtime failure this catch can handle.
 * Metro may log a dynamic-require warning; that is the intended trade.
 */
function loadNetInfo(): any {
  if (netInfoLoadAttempted) {
    return netInfoModule;
  }
  netInfoLoadAttempted = true;

  const moduleName = '@react-native-community/netinfo';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(moduleName);
    netInfoModule = mod?.default ?? mod ?? null;
  } catch {
    netInfoModule = null;
  }
  return netInfoModule;
}

/** Normalise whatever a picker returned into a validated pick, or null. */
function coercePick(result: unknown): NetworkRatePick | null {
  const pick =
    typeof result === 'number'
      ? { rate: result, reason: 'networkRatePicker', metrics: null }
      : (result as NetworkRatePick | null);

  if (!pick || !isKnownRate(pick.rate)) {
    return null;
  }
  return {
    rate: pick.rate,
    reason: pick.reason || 'networkRatePicker',
    metrics: pick.metrics ?? null,
  };
}

function isKnownRate(rate: unknown): rate is TransportRate {
  return rate === 8000 || rate === 16000 || rate === 32000 || rate === 48000;
}

/** Map a NetInfo state object onto a tier. Exported for testing. */
export function rateFromNetInfoState(state: any): NetworkRatePick {
  if (!state) {
    return { rate: AUTO_RATE_FALLBACK, reason: 'no NetInfo state', metrics: null };
  }

  const type = state.type;
  const details = state.details ?? {};
  const cellularGeneration = details.cellularGeneration ?? null;
  const metrics = {
    type,
    cellularGeneration,
    // Reported but deliberately not acted on: on most devices every cellular
    // connection is "expensive", so demoting on it would pin all mobile traffic
    // to narrowband. It means metered, not slow.
    isConnectionExpensive: details.isConnectionExpensive,
    isInternetReachable: state.isInternetReachable,
  };

  if (type === 'none' || state.isConnected === false) {
    // The call is going to fail regardless; don't also saddle it with a
    // narrowband profile in case connectivity returns a moment later.
    return { rate: AUTO_RATE_FALLBACK, reason: 'no connectivity', metrics };
  }

  if (type === 'wifi' || type === 'ethernet') {
    // NetInfo reports no wifi throughput on iOS and only a coarse strength on
    // Android, so wifi cannot be promoted to the top tier on evidence — plenty
    // of wifi is a congested hotspot. The recommended profile is the honest
    // answer here.
    return { rate: AUTO_RATE_FALLBACK, reason: `${type}, assuming good`, metrics };
  }

  if (type === 'cellular') {
    switch (cellularGeneration) {
      case '2g':
      case '3g':
        return { rate: 8000, reason: `cellular ${cellularGeneration}`, metrics };
      case '4g':
        return { rate: 32000, reason: 'cellular 4g', metrics };
      case '5g':
        return { rate: 48000, reason: 'cellular 5g', metrics };
      default:
        // Cellular of unknown generation is the one case worth being cautious
        // about — it is the connection type most likely to actually be weak.
        return { rate: 16000, reason: 'cellular, unknown generation', metrics };
    }
  }

  return { rate: AUTO_RATE_FALLBACK, reason: `unhandled type ${type}`, metrics };
}

/**
 * Resolve a rate for `_web_anysamplerate`: the caller's picker if one is set,
 * otherwise NetInfo, otherwise the fallback. Never throws.
 */
export async function pickTransportRateFromNetwork(
  override?: NetworkRatePicker
): Promise<NetworkRatePick> {
  const picker = override ?? cachedPicker;
  if (picker) {
    try {
      const pick = coercePick(await picker());
      if (pick) {
        return pick;
      }
      console.warn(
        '⚠️ networkRatePicker returned an unsupported rate — falling back to NetInfo. ' +
          'Supported: 8000, 16000, 32000, 48000.'
      );
    } catch (error) {
      console.warn(`⚠️ networkRatePicker threw (${error}) — falling back to NetInfo.`);
    }
  }

  const NetInfo = loadNetInfo();
  if (!NetInfo?.fetch) {
    return {
      rate: AUTO_RATE_FALLBACK,
      reason: '@react-native-community/netinfo not installed',
      metrics: null,
    };
  }

  try {
    return rateFromNetInfoState(await NetInfo.fetch());
  } catch (error) {
    return { rate: AUTO_RATE_FALLBACK, reason: `NetInfo.fetch failed: ${error}`, metrics: null };
  }
}
