/**
 * VLM circuit breaker (packaging-OCR overhaul P1-T2).
 *
 * Module-level, in-memory, per-process registry keyed by `${baseUrl}|${model}`
 * so frozen run-bound routes get their own bucket separate from the mutable
 * legacy route. States: closed → open → half-open.
 *
 * - Trip: N consecutive TRANSPORT-CLASS failures (timeout / http_error /
 *   transport_error). Parse, coercion, image, and policy failures never
 *   count — they are deterministic and must not deny the route.
 * - Cooldown: after tripping, no calls are allowed for `cooldownMs`
 *   (env BAYSTATE_CMS_VLM_BREAKER_COOLDOWN_MS, default 60_000).
 * - Half-open: after cooldown, a SINGLE probe is allowed; concurrent callers
 *   are denied until the probe resolves. The probe reservation carries a
 *   time-based lease so an abandoned probe (crash between checkCircuit and a
 *   record* call on a non-transport early exit such as an image-load
 *   failure) cannot wedge the breaker permanently.
 * - Success resets the breaker to closed with a zero failure streak.
 *
 * Deliberately NOT inside callVlm — that transport stays a raw,
 * test-pinned primitive. The orchestration layer (packaging-ocr) checks the
 * circuit BEFORE insertModelCallStart so an open circuit produces a coded
 * `circuit_open` result with NO started audit row written.
 */

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitDecision {
  allowed: boolean;
  state: CircuitBreakerState;
}

interface BreakerEntry {
  state: CircuitBreakerState;
  consecutiveTransportFailures: number;
  /** Timestamp (Date.now()) when the breaker opened; null when closed. */
  openedAtMs: number | null;
  /** Timestamp when a half-open probe was granted; null when none held. */
  probeGrantedAtMs: number | null;
}

const breakers = new Map<string, BreakerEntry>();

/** Consecutive transport-class failures required to trip the breaker. */
const TRIP_THRESHOLD = 3;

/** Lease for a granted half-open probe — longer than the VLM transport
 *  timeout (120s) so a live probe is never double-granted, but bounded so an
 *  abandoned probe self-heals. */
const PROBE_LEASE_MS = 180_000;

const DEFAULT_COOLDOWN_MS = 60_000;

function getCooldownMs(): number {
  const raw = process.env.BAYSTATE_CMS_VLM_BREAKER_COOLDOWN_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_COOLDOWN_MS;
}

/** Stable breaker key for a VLM route. */
export function buildCircuitBreakerKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`;
}

/**
 * Check whether a call to this route may proceed. In half-open state this
 * GRANTS the single probe to the caller (subsequent checks are denied until
 * recordSuccess/recordTransportFailure resolves it or the lease expires).
 */
export function checkCircuit(key: string): CircuitDecision {
  const entry = breakers.get(key);
  if (!entry) return { allowed: true, state: 'closed' };

  if (entry.state === 'open') {
    if (entry.openedAtMs !== null && Date.now() - entry.openedAtMs >= getCooldownMs()) {
      // Cooldown elapsed — transition to half-open and grant the probe below.
      entry.state = 'half-open';
      entry.probeGrantedAtMs = null;
    } else {
      return { allowed: false, state: 'open' };
    }
  }

  if (entry.state === 'half-open') {
    const probing =
      entry.probeGrantedAtMs !== null && Date.now() - entry.probeGrantedAtMs < PROBE_LEASE_MS;
    if (probing) return { allowed: false, state: 'half-open' };
    entry.probeGrantedAtMs = Date.now();
    return { allowed: true, state: 'half-open' };
  }

  return { allowed: true, state: 'closed' };
}

/** A transport attempt succeeded (or resolved non-transport): reset streak. */
export function recordSuccess(key: string): void {
  const entry = breakers.get(key);
  if (!entry) return;
  entry.state = 'closed';
  entry.consecutiveTransportFailures = 0;
  entry.openedAtMs = null;
  entry.probeGrantedAtMs = null;
}

/**
 * A TRANSPORT-CLASS failure occurred (timeout / http_error / transport_error).
 * Non-transport failures (parse/coercion/image/policy) must NOT be recorded.
 */
export function recordTransportFailure(key: string): void {
  let entry = breakers.get(key);
  if (!entry) {
    entry = {
      state: 'closed',
      consecutiveTransportFailures: 0,
      openedAtMs: null,
      probeGrantedAtMs: null,
    };
    breakers.set(key, entry);
  }
  entry.probeGrantedAtMs = null;

  if (entry.state === 'half-open') {
    // The probe failed — re-open immediately with a fresh cooldown.
    entry.state = 'open';
    entry.openedAtMs = Date.now();
    entry.consecutiveTransportFailures += 1;
    return;
  }

  entry.consecutiveTransportFailures += 1;
  if (entry.state === 'closed' && entry.consecutiveTransportFailures >= TRIP_THRESHOLD) {
    entry.state = 'open';
    entry.openedAtMs = Date.now();
  }
}

export interface CircuitBreakerRouteStats {
  state: CircuitBreakerState;
  consecutiveTransportFailures: number;
  openedAtMs: number | null;
  cooldownMs: number;
}

/** Observability snapshot of every tracked route. */
export function getCircuitBreakerStats(): Record<string, CircuitBreakerRouteStats> {
  const snapshot: Record<string, CircuitBreakerRouteStats> = {};
  for (const [key, entry] of breakers) {
    snapshot[key] = {
      state: entry.state,
      consecutiveTransportFailures: entry.consecutiveTransportFailures,
      openedAtMs: entry.openedAtMs,
      cooldownMs: getCooldownMs(),
    };
  }
  return snapshot;
}

/** Reset all breaker state (primarily for test suite isolation). */
export function resetCircuitBreakers(): void {
  breakers.clear();
}
