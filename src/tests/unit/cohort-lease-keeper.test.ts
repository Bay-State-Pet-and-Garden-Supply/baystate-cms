import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CohortLeaseKeeper } from '../../onboarding/cohort-lease-keeper';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';

let heartbeatMockResult = true;
let heartbeatCalls: Array<{ runId: string; workerId: string; leaseTtlMs: number }> = [];

vi.mock('../../db/repositories/classification-cohort-run-repo', () => ({
  heartbeatCohortRun: (runId: string, workerId: string, leaseTtlMs: number) => {
    heartbeatCalls.push({ runId, workerId, leaseTtlMs });
    return heartbeatMockResult;
  },
}));

describe('CohortLeaseKeeper', () => {
  const RUN_ID = 'run-123';
  const WORKER_ID = 'worker-abc';
  const LEASE_TTL_MS = 300; // interval = 100ms

  beforeEach(() => {
    heartbeatMockResult = true;
    heartbeatCalls = [];
  });

  it('calculates intervalMs correctly (Math.max(1, Math.floor(leaseTtlMs / 3)))', () => {
    const keeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, 300);
    // Access private intervalMs for assertion via cast
    expect((keeper as any).intervalMs).toBe(100);

    const keeperSmall = new CohortLeaseKeeper(RUN_ID, WORKER_ID, 2);
    expect((keeperSmall as any).intervalMs).toBe(1);

    const keeperZero = new CohortLeaseKeeper(RUN_ID, WORKER_ID, 0);
    expect((keeperZero as any).intervalMs).toBe(1);
  });

  it('start() performs initial synchronous renewal and sets timer when heartbeat succeeds', () => {
    const keeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, LEASE_TTL_MS);
    const result = keeper.start();

    expect(result).toBe(keeper);
    expect(heartbeatCalls).toHaveLength(1);
    expect(heartbeatCalls[0]).toEqual({
      runId: RUN_ID,
      workerId: WORKER_ID,
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect((keeper as any).timer).not.toBeNull();
    expect((keeper as any).lost).toBe(false);

    keeper.stop();
  });

  it('start() is idempotent when called multiple times', () => {
    const keeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, LEASE_TTL_MS);
    keeper.start();
    const timerRef = (keeper as any).timer;

    expect(heartbeatCalls).toHaveLength(1);

    const secondResult = keeper.start();
    expect(secondResult).toBe(keeper);
    expect(heartbeatCalls).toHaveLength(1);
    expect((keeper as any).timer).toBe(timerRef);

    keeper.stop();
  });

  it('start() throws HeartbeatLostError immediately and sets lost=true if initial renewal fails', () => {
    heartbeatMockResult = false;
    const keeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, LEASE_TTL_MS);

    expect(() => keeper.start()).toThrow(HeartbeatLostError);
    expect(heartbeatCalls).toHaveLength(1);
    expect((keeper as any).lost).toBe(true);
    expect((keeper as any).timer).toBeNull();
  });

  it('periodically renews lease via interval timer', async () => {
    const shortTtl = 30; // interval = 10ms
    const keeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, shortTtl);
    keeper.start();

    expect(heartbeatCalls).toHaveLength(1); // initial start renewal

    // Wait for at least 2 timer ticks
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(heartbeatCalls.length).toBeGreaterThanOrEqual(3);

    keeper.stop();
  });

  it('renew() updates lost state when heartbeat fails', () => {
    const keeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, LEASE_TTL_MS);

    expect(keeper.renew()).toBe(true);
    expect(heartbeatCalls).toHaveLength(1);
    expect((keeper as any).lost).toBe(false);

    heartbeatMockResult = false;
    expect(keeper.renew()).toBe(false);
    expect(heartbeatCalls).toHaveLength(2);
    expect((keeper as any).lost).toBe(true);
  });

  it('renew() short-circuits when stopped or lost', () => {
    const keeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, LEASE_TTL_MS);

    // Stop keeper
    keeper.stop();
    expect(keeper.renew()).toBe(false);
    expect(heartbeatCalls).toHaveLength(0);

    // Lost keeper
    const lostKeeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, LEASE_TTL_MS);
    (lostKeeper as any).lost = true;
    expect(lostKeeper.renew()).toBe(false);
    expect(heartbeatCalls).toHaveLength(0);
  });

  it('assertHeld() succeeds when lease renewal succeeds', () => {
    const keeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, LEASE_TTL_MS);
    keeper.start();

    expect(() => keeper.assertHeld()).not.toThrow();
    expect(heartbeatCalls).toHaveLength(2); // start + assertHeld

    keeper.stop();
  });

  it('assertHeld() throws HeartbeatLostError when lease renewal fails during execution', () => {
    const keeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, LEASE_TTL_MS);
    keeper.start();

    heartbeatMockResult = false;
    expect(() => keeper.assertHeld()).toThrow(HeartbeatLostError);
    expect((keeper as any).lost).toBe(true);

    keeper.stop();
  });

  it('assertHeld() throws HeartbeatLostError when previously marked lost', () => {
    const keeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, LEASE_TTL_MS);
    (keeper as any).lost = true;

    expect(() => keeper.assertHeld()).toThrow(HeartbeatLostError);
    expect(heartbeatCalls).toHaveLength(0);
  });

  it('stop() clears renewal timer and marks stopped=true', async () => {
    const shortTtl = 30; // interval = 10ms
    const keeper = new CohortLeaseKeeper(RUN_ID, WORKER_ID, shortTtl);
    keeper.start();

    expect(heartbeatCalls).toHaveLength(1);

    keeper.stop();
    expect((keeper as any).stopped).toBe(true);
    expect((keeper as any).timer).toBeNull();

    const callCountAfterStop = heartbeatCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(heartbeatCalls).toHaveLength(callCountAfterStop);
  });
});
