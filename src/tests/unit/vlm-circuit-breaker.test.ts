import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildCircuitBreakerKey,
  checkCircuit,
  recordSuccess,
  recordTransportFailure,
  getCircuitBreakerStats,
  resetCircuitBreakers,
} from '../../onboarding/vlm-circuit-breaker';

// ─── closed state ──────────────────────────────────────────────────────────────

describe('VLM circuit breaker', () => {
  beforeEach(() => {
    resetCircuitBreakers();
    delete process.env.BAYSTATE_CMS_VLM_BREAKER_COOLDOWN_MS;
  });

  afterEach(() => {
    resetCircuitBreakers();
    delete process.env.BAYSTATE_CMS_VLM_BREAKER_COOLDOWN_MS;
  });

  it('allows calls on an unseen route (closed)', () => {
    const decision = checkCircuit(buildCircuitBreakerKey('http://localhost:11434', 'm1'));
    expect(decision).toEqual({ allowed: true, state: 'closed' });
  });

  it('does not trip below the threshold of 3 consecutive transport failures', () => {
    const key = buildCircuitBreakerKey('http://localhost:11434', 'under');
    recordTransportFailure(key);
    recordTransportFailure(key);
    expect(checkCircuit(key)).toEqual({ allowed: true, state: 'closed' });
  });

  it('trips open after 3 consecutive transport-class failures and denies calls', () => {
    const key = buildCircuitBreakerKey('http://localhost:11434', 'trip');
    recordTransportFailure(key);
    recordTransportFailure(key);
    recordTransportFailure(key);
    expect(checkCircuit(key)).toEqual({ allowed: false, state: 'open' });
  });

  it('success resets the failure streak so scattered failures never trip it', () => {
    const key = buildCircuitBreakerKey('http://localhost:11434', 'reset-streak');
    recordTransportFailure(key);
    recordTransportFailure(key);
    recordSuccess(key);
    recordTransportFailure(key);
    recordTransportFailure(key);
    expect(checkCircuit(key)).toEqual({ allowed: true, state: 'closed' });
  });

  it('keys routes independently (frozen route bucket is separate)', () => {
    const legacy = buildCircuitBreakerKey('http://localhost:11434', 'qwen2.5vl:latest');
    const frozen = buildCircuitBreakerKey('http://127.0.0.1:11434', 'qwen2.5vl:latest');
    for (let i = 0; i < 3; i++) recordTransportFailure(legacy);
    expect(checkCircuit(legacy).allowed).toBe(false);
    expect(checkCircuit(frozen)).toEqual({ allowed: true, state: 'closed' });
  });

  // ─── cooldown → half-open → probe resolution ────────────────────────────────

  it('transitions to half-open after the cooldown and grants exactly ONE probe', async () => {
    process.env.BAYSTATE_CMS_VLM_BREAKER_COOLDOWN_MS = '10';
    const key = buildCircuitBreakerKey('http://localhost:11434', 'half-open');
    for (let i = 0; i < 3; i++) recordTransportFailure(key);
    expect(checkCircuit(key).allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 25)); // cooldown elapses
    expect(checkCircuit(key)).toEqual({ allowed: true, state: 'half-open' }); // probe granted
    // Concurrent callers are denied while the single probe is in flight.
    expect(checkCircuit(key)).toEqual({ allowed: false, state: 'half-open' });
  });

  it('re-opens immediately when the half-open probe fails', async () => {
    process.env.BAYSTATE_CMS_VLM_BREAKER_COOLDOWN_MS = '10';
    const key = buildCircuitBreakerKey('http://localhost:11434', 'probe-fail');
    for (let i = 0; i < 3; i++) recordTransportFailure(key);
    await new Promise((r) => setTimeout(r, 25));
    expect(checkCircuit(key).state).toBe('half-open'); // grant the probe
    recordTransportFailure(key); // probe fails
    expect(checkCircuit(key)).toEqual({ allowed: false, state: 'open' });
  });

  it('closes and resets when the half-open probe succeeds', async () => {
    process.env.BAYSTATE_CMS_VLM_BREAKER_COOLDOWN_MS = '10';
    const key = buildCircuitBreakerKey('http://localhost:11434', 'probe-ok');
    for (let i = 0; i < 3; i++) recordTransportFailure(key);
    await new Promise((r) => setTimeout(r, 25));
    expect(checkCircuit(key).state).toBe('half-open'); // grant the probe
    recordSuccess(key);
    expect(checkCircuit(key)).toEqual({ allowed: true, state: 'closed' });
    // Streak was reset — two more failures still do not trip.
    recordTransportFailure(key);
    recordTransportFailure(key);
    expect(checkCircuit(key)).toEqual({ allowed: true, state: 'closed' });
  });

  it('uses the default 60s cooldown when no env override is set', () => {
    const key = buildCircuitBreakerKey('http://localhost:11434', 'default-cooldown');
    for (let i = 0; i < 3; i++) recordTransportFailure(key);
    expect(checkCircuit(key).allowed).toBe(false); // well within 60s
  });

  // ─── observability & reset ────────────────────────────────────────────────

  it('exposes a stats snapshot with state, streak, openedAtMs and cooldown', () => {
    const key = buildCircuitBreakerKey('http://localhost:11434', 'stats');
    recordTransportFailure(key);
    recordTransportFailure(key);
    recordTransportFailure(key);
    const stats = getCircuitBreakerStats();
    expect(stats[key]).toBeDefined();
    expect(stats[key].state).toBe('open');
    expect(stats[key].consecutiveTransportFailures).toBe(3);
    expect(typeof stats[key].openedAtMs).toBe('number');
    expect(stats[key].cooldownMs).toBe(60_000);
  });

  it('resetCircuitBreakers clears all state (test isolation)', () => {
    const key = buildCircuitBreakerKey('http://localhost:11434', 'wipe');
    for (let i = 0; i < 3; i++) recordTransportFailure(key);
    expect(checkCircuit(key).allowed).toBe(false);
    resetCircuitBreakers();
    expect(checkCircuit(key)).toEqual({ allowed: true, state: 'closed' });
    expect(getCircuitBreakerStats()).toEqual({});
  });
});
