/**
 * Packaging-OCR stage runtime feature flags (packaging-ocr overhaul P2-T3).
 *
 * The packaging-OCR classification stage (`packaging_ocr`) ships flag-gated
 * so legacy OCR behavior remains byte-identical until the measured rollout
 * completes. Flags can be flipped at runtime without a redeploy:
 * - environment variables are re-read on every `loadOcrStageFlags()` call,
 *   so a process restart or env change applies without code changes;
 * - `overrideOcrStageFlags()` swaps the effective values in memory
 *   (used by tests today, by a settings surface later).
 *
 * Flag semantics (plan §3):
 * - OFF (default): every consumer keeps calling the legacy freeze
 *   pull-forward path unchanged; the stage never runs.
 * - ON + shadow-only (default shadow ON): the stage may execute but its
 *   results can never become authoritative (shadow comparisons only).
 *   Consumers that need AUTHORITATIVE stage output (e.g. the cohort freeze
 *   delegation) additionally require shadow-only to be OFF.
 * - Dual-run compare: run legacy AND stage paths and record comparison rows;
 *   requires the master flag ON — a disabled stage returns inert empty
 *   output and writes nothing, so there is no stage side to compare.
 * - Retries: bounded transport-class retry inside the OCR core; off by
 *   default until golden-set evaluation (P3) validates it.
 *
 * Kill-switch dominance (precedence documented here):
 * `BAYSTATE_CMS_OCR_KILL_SWITCH` is parsed with the same fail-closed boolean
 * rule the Product Intelligence program used for its global kill switch
 * ('true'|'1'|'yes' → set, 'false'|'0'|'no'/unset/garbage → not set). When
 * set, the OCR kill switch forces the legacy pipeline everywhere, so `packagingOcrStageEnabled` resolves `false` REGARDLESS of
 * env or in-memory override — including after `overrideOcrStageFlags({
 * packagingOcrStageEnabled: true })`. Dominance is applied in BOTH
 * `loadOcrStageFlags()` (against the supplied/ambient env) and
 * `getOcrStageFlags()` (re-applied after the override merge against
 * `process.env`), so no merge order can resurrect the stage while the kill
 * switch is set. Clearing the env var immediately restores normal precedence.
 */

export interface OcrStageFlags {
  /**
   * Master switch: when false, the packaging_ocr classification stage never
   * runs and all consumers stay on the legacy OCR path. Forced false while
   * the PI kill switch is set — see module docblock for precedence.
   */
  packagingOcrStageEnabled: boolean;
  /** Shadow mode: the stage may run but its output can never become
   *  authoritative (comparison rows only). Only meaningful while the master
   *  switch is ON. */
  packagingOcrStageShadowOnly: boolean;
  /** Run the legacy OCR path alongside the stage and record comparison
   *  rows. Requires the master switch ON: with the stage disabled its output
   *  is inert, so no comparison rows can be produced. */
  packagingOcrDualRunCompare: boolean;
  /** Enable bounded transport-class retries inside the OCR core. */
  packagingOcrRetriesEnabled: boolean;
}

export const DEFAULT_OCR_STAGE_FLAGS: OcrStageFlags = {
  packagingOcrStageEnabled: false,
  packagingOcrStageShadowOnly: true,
  packagingOcrDualRunCompare: false,
  packagingOcrRetriesEnabled: false,
};

const OCR_STAGE_FLAG_ENV: Record<keyof OcrStageFlags, string> = {
  packagingOcrStageEnabled: 'BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED',
  packagingOcrStageShadowOnly: 'BAYSTATE_CMS_PACKAGING_OCR_STAGE_SHADOW_ONLY',
  packagingOcrDualRunCompare: 'BAYSTATE_CMS_PACKAGING_OCR_DUAL_RUN',
  packagingOcrRetriesEnabled: 'BAYSTATE_CMS_OCR_RETRIES_ENABLED',
};

/**
 * The OCR kill switch env var (ADR-0030 Phase 3 rename from the PI global
 * kill switch). `BAYSTATE_CMS_PI_KILL_SWITCH` is honored as a deprecated
 * alias during the alias window: EITHER name explicitly set ⇒ switch on.
 */
const OCR_KILL_SWITCH_ENV = 'BAYSTATE_CMS_OCR_KILL_SWITCH';
const PI_KILL_SWITCH_ALIAS_ENV = 'BAYSTATE_CMS_PI_KILL_SWITCH';

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  // Fail closed on unparseable values rather than guessing.
  return fallback;
}

/**
 * Kill-switch detection mirrors the old `killSwitch` parsing in the deleted
 * `src/product-intelligence/flags.ts`: only an explicit truthy value counts
 * as set; unset/falsey/garbage means not set. Either the primary OCR var or
 * the deprecated PI alias counts.
 */
function isPiKillSwitchSet(env: Record<string, string | undefined>): boolean {
  return (
    parseBooleanEnv(env[OCR_KILL_SWITCH_ENV], false) ||
    parseBooleanEnv(env[PI_KILL_SWITCH_ALIAS_ENV], false)
  );
}

export function loadOcrStageFlags(
  env: Record<string, string | undefined> = process.env,
): OcrStageFlags {
  const flags: OcrStageFlags = {
    packagingOcrStageEnabled: parseBooleanEnv(
      env[OCR_STAGE_FLAG_ENV.packagingOcrStageEnabled],
      DEFAULT_OCR_STAGE_FLAGS.packagingOcrStageEnabled,
    ),
    packagingOcrStageShadowOnly: parseBooleanEnv(
      env[OCR_STAGE_FLAG_ENV.packagingOcrStageShadowOnly],
      DEFAULT_OCR_STAGE_FLAGS.packagingOcrStageShadowOnly,
    ),
    packagingOcrDualRunCompare: parseBooleanEnv(
      env[OCR_STAGE_FLAG_ENV.packagingOcrDualRunCompare],
      DEFAULT_OCR_STAGE_FLAGS.packagingOcrDualRunCompare,
    ),
    packagingOcrRetriesEnabled: parseBooleanEnv(
      env[OCR_STAGE_FLAG_ENV.packagingOcrRetriesEnabled],
      DEFAULT_OCR_STAGE_FLAGS.packagingOcrRetriesEnabled,
    ),
  };
  // Kill-switch dominance: the PI kill switch forces the legacy pipeline
  // everywhere, so the stage can never be enabled by env alone.
  if (isPiKillSwitchSet(env)) {
    flags.packagingOcrStageEnabled = false;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// In-memory runtime override (tests, future settings UI)
// ---------------------------------------------------------------------------

let runtimeOverride: Partial<OcrStageFlags> | null = null;

/** Apply an in-memory override of the effective flags. Returns the new flags. */
export function overrideOcrStageFlags(next: Partial<OcrStageFlags>): OcrStageFlags {
  runtimeOverride = { ...runtimeOverride, ...next };
  return getOcrStageFlags();
}

/** Clear any in-memory override. */
export function resetOcrStageFlagsOverride(): void {
  runtimeOverride = null;
}

/**
 * Effective flags: env-derived defaults merged with the in-memory override.
 * Read per call so a config change applies without a redeploy. Kill-switch
 * dominance is RE-applied after the merge (against `process.env`) so an
 * override can never resurrect the stage while the kill switch is set —
 * see the module docblock precedence rules.
 */
export function getOcrStageFlags(): OcrStageFlags {
  const base = loadOcrStageFlags();
  const merged = runtimeOverride ? { ...base, ...runtimeOverride } : base;
  if (isPiKillSwitchSet(process.env)) {
    merged.packagingOcrStageEnabled = false;
  }
  return merged;
}
