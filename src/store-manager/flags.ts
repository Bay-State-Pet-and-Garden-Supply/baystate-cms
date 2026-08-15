/**
 * Store Manager operations-console runtime feature flags (operations console,
 * Issue 4).
 *
 * All new automation defaults OFF: schedules, event triggers, playbooks, bulk
 * review, and the notifications surface are inert until explicitly enabled.
 * The already-shipped chat/runtime surface is NOT gated by these flags. The
 * kill switch dominates execution: when true, no new schedule/event/playbook/
 * replay run may start and the scheduler stops taking claims, while reads and
 * history remain available and normal catalog/onboarding behavior is never
 * affected.
 *
 * Environment names use the `BAYSTATE_CMS_STORE_MANAGER_*` prefix and are
 * re-read on every load so a restart applies changes without redeploys.
 * `overrideStoreManagerFlags()` swaps the effective values in memory (tests,
 * future settings surface).
 *
 * @see docs/plans/store-manager-operations-console-plan.md (Locked Decision 15)
 */

export interface StoreManagerFlags {
  /** Master gate for the operations-console surfaces (not chat itself). */
  operationsConsoleEnabled: boolean;
  /** Scheduled read-only runs + scheduler polling. */
  schedulesEnabled: boolean;
  /** Event-triggered read-only runs. */
  eventTriggersEnabled: boolean;
  /** Saved playbook definitions + execution. */
  playbooksEnabled: boolean;
  /** Homogeneous bulk review. */
  bulkReviewEnabled: boolean;
  /** Durable in-app notifications + threshold rules. */
  notificationsEnabled: boolean;
  /** Global kill switch: stops new runs/claims; leaves history/inbox readable. */
  killSwitch: boolean;
}

export const DEFAULT_STORE_MANAGER_FLAGS: StoreManagerFlags = {
  operationsConsoleEnabled: true,
  schedulesEnabled: true,
  eventTriggersEnabled: true,
  playbooksEnabled: true,
  bulkReviewEnabled: true,
  notificationsEnabled: true,
  killSwitch: false,
};

const STORE_MANAGER_FLAG_ENV: Record<keyof StoreManagerFlags, string> = {
  operationsConsoleEnabled: 'BAYSTATE_CMS_STORE_MANAGER_OPERATIONS_CONSOLE_ENABLED',
  schedulesEnabled: 'BAYSTATE_CMS_STORE_MANAGER_SCHEDULES_ENABLED',
  eventTriggersEnabled: 'BAYSTATE_CMS_STORE_MANAGER_EVENT_TRIGGERS_ENABLED',
  playbooksEnabled: 'BAYSTATE_CMS_STORE_MANAGER_PLAYBOOKS_ENABLED',
  bulkReviewEnabled: 'BAYSTATE_CMS_STORE_MANAGER_BULK_REVIEW_ENABLED',
  notificationsEnabled: 'BAYSTATE_CMS_STORE_MANAGER_NOTIFICATIONS_ENABLED',
  killSwitch: 'BAYSTATE_CMS_STORE_MANAGER_KILL_SWITCH',
};

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  // Fail closed on unparseable values rather than guessing.
  return fallback;
}

/** Load flags from env, fail-closed on malformed values. */
export function loadStoreManagerFlags(
  env: Record<string, string | undefined> = process.env,
): StoreManagerFlags {
  const flags: StoreManagerFlags = {
    operationsConsoleEnabled: parseBooleanEnv(
      env[STORE_MANAGER_FLAG_ENV.operationsConsoleEnabled],
      DEFAULT_STORE_MANAGER_FLAGS.operationsConsoleEnabled,
    ),
    schedulesEnabled: parseBooleanEnv(
      env[STORE_MANAGER_FLAG_ENV.schedulesEnabled],
      DEFAULT_STORE_MANAGER_FLAGS.schedulesEnabled,
    ),
    eventTriggersEnabled: parseBooleanEnv(
      env[STORE_MANAGER_FLAG_ENV.eventTriggersEnabled],
      DEFAULT_STORE_MANAGER_FLAGS.eventTriggersEnabled,
    ),
    playbooksEnabled: parseBooleanEnv(
      env[STORE_MANAGER_FLAG_ENV.playbooksEnabled],
      DEFAULT_STORE_MANAGER_FLAGS.playbooksEnabled,
    ),
    bulkReviewEnabled: parseBooleanEnv(
      env[STORE_MANAGER_FLAG_ENV.bulkReviewEnabled],
      DEFAULT_STORE_MANAGER_FLAGS.bulkReviewEnabled,
    ),
    notificationsEnabled: parseBooleanEnv(
      env[STORE_MANAGER_FLAG_ENV.notificationsEnabled],
      DEFAULT_STORE_MANAGER_FLAGS.notificationsEnabled,
    ),
    killSwitch: parseBooleanEnv(
      env[STORE_MANAGER_FLAG_ENV.killSwitch],
      DEFAULT_STORE_MANAGER_FLAGS.killSwitch,
    ),
  };
  return flags;
}

// ---------------------------------------------------------------------------
// In-memory runtime override (tests, future settings UI)
// ---------------------------------------------------------------------------

let runtimeOverride: Partial<StoreManagerFlags> | null = null;

/** Apply an in-memory override of the effective flags. Returns the new flags. */
export function overrideStoreManagerFlags(next: Partial<StoreManagerFlags>): StoreManagerFlags {
  runtimeOverride = { ...runtimeOverride, ...next };
  return getStoreManagerFlags();
}

/** Clear any in-memory override. */
export function resetStoreManagerFlagsOverride(): void {
  runtimeOverride = null;
}

/** Effective flags: env-derived defaults merged with the in-memory override. */
export function getStoreManagerFlags(): StoreManagerFlags {
  const base = loadStoreManagerFlags();
  return runtimeOverride ? { ...base, ...runtimeOverride } : base;
}
