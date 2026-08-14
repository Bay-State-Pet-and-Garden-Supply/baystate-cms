import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_STORE_MANAGER_FLAGS,
  loadStoreManagerFlags,
  overrideStoreManagerFlags,
  resetStoreManagerFlagsOverride,
  getStoreManagerFlags,
} from '../../store-manager/flags';

/**
 * Store Manager console flags (Issue 4). Pure unit tests — no DB, no network.
 */

describe('Store Manager console flags (Issue 4)', () => {
  afterEach(() => {
    resetStoreManagerFlagsOverride();
  });

  it('ships the operations console enabled; defaults every automation flag OFF (chat surface is never gated)', () => {
    const flags = loadStoreManagerFlags({});
    expect(flags.operationsConsoleEnabled).toBe(true);
    expect(flags.schedulesEnabled).toBe(false);
    expect(flags.eventTriggersEnabled).toBe(false);
    expect(flags.playbooksEnabled).toBe(false);
    expect(flags.bulkReviewEnabled).toBe(false);
    expect(flags.notificationsEnabled).toBe(false);
    expect(flags.killSwitch).toBe(false);
  });

  it('parses env booleans with the BAYSTATE_CMS_STORE_MANAGER_* names', () => {
    const flags = loadStoreManagerFlags({
      BAYSTATE_CMS_STORE_MANAGER_SCHEDULES_ENABLED: 'true',
      BAYSTATE_CMS_STORE_MANAGER_NOTIFICATIONS_ENABLED: '1',
      BAYSTATE_CMS_STORE_MANAGER_KILL_SWITCH: 'yes',
    });
    expect(flags.schedulesEnabled).toBe(true);
    expect(flags.notificationsEnabled).toBe(true);
    expect(flags.killSwitch).toBe(true);
    expect(flags.playbooksEnabled).toBe(false);
  });

  it('fails closed on unparseable env values (never guesses)', () => {
    const flags = loadStoreManagerFlags({
      BAYSTATE_CMS_STORE_MANAGER_SCHEDULES_ENABLED: 'maybe',
      BAYSTATE_CMS_STORE_MANAGER_EVENT_TRIGGERS_ENABLED: 'banana',
    });
    expect(flags.schedulesEnabled).toBe(false);
    expect(flags.eventTriggersEnabled).toBe(false);
  });

  it('empty/undefined env keeps defaults', () => {
    expect(loadStoreManagerFlags({ BAYSTATE_CMS_STORE_MANAGER_SCHEDULES_ENABLED: '' }).schedulesEnabled).toBe(false);
    expect(loadStoreManagerFlags({ BAYSTATE_CMS_STORE_MANAGER_SCHEDULES_ENABLED: undefined }).schedulesEnabled).toBe(false);
  });

  it('override swaps effective values in memory and reset restores env', () => {
    overrideStoreManagerFlags({ schedulesEnabled: true, killSwitch: false });
    const effective = getStoreManagerFlags();
    expect(effective.schedulesEnabled).toBe(true);
    // env remains off
    expect(loadStoreManagerFlags({}).schedulesEnabled).toBe(false);
    resetStoreManagerFlagsOverride();
    expect(getStoreManagerFlags().schedulesEnabled).toBe(false);
  });

  it('kill switch dominance is representable: enabled schedules + killSwitch', () => {
    overrideStoreManagerFlags({ schedulesEnabled: true, killSwitch: true });
    const flags = getStoreManagerFlags();
    // The scheduler treats killSwitch as dominant (execution refuses even
    // when schedulesEnabled is true); flags just expose the state.
    expect(flags.schedulesEnabled).toBe(true);
    expect(flags.killSwitch).toBe(true);
  });

  it('defaults are immutable (no shared mutation)', () => {
    expect(DEFAULT_STORE_MANAGER_FLAGS.schedulesEnabled).toBe(false);
    expect(DEFAULT_STORE_MANAGER_FLAGS.killSwitch).toBe(false);
  });
});
