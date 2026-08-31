/**
 * Variant resolution feature flags — strict, re-read per call.
 */

export type VariantResolutionMode = 'off' | 'observe' | 'active';

const VALID_MODES: readonly VariantResolutionMode[] = ['off', 'observe', 'active'];

export function parseVariantResolutionMode(raw: string | undefined): VariantResolutionMode {
  if (raw === undefined || raw === null) return 'off';
  const normalized = raw.trim().toLowerCase();
  if ((VALID_MODES as readonly string[]).includes(normalized)) return normalized as VariantResolutionMode;
  return 'off';
}

export function getVariantResolutionMode(env: Record<string, string | undefined> = process.env): VariantResolutionMode {
  return parseVariantResolutionMode(env['BAYSTATE_CMS_VARIANT_RESOLUTION_MODE']);
}

export function isVariantResolutionActive(env?: Record<string, string | undefined>): boolean {
  return getVariantResolutionMode(env) === 'active';
}
export function isVariantResolutionObserve(env?: Record<string, string | undefined>): boolean {
  return getVariantResolutionMode(env) === 'observe';
}
export function isVariantResolutionOff(env?: Record<string, string | undefined>): boolean {
  return getVariantResolutionMode(env) === 'off';
}

export function parseVariantInteractionEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw === null) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return false;
}

export function isVariantInteractionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseVariantInteractionEnabled(env['BAYSTATE_CMS_VARIANT_INTERACTION_ENABLED']);
}

// Test overrides
let modeOverride: VariantResolutionMode | null = null;
let interactionOverride: boolean | null = null;

export function overrideVariantFlags(next: { mode?: VariantResolutionMode; interactionEnabled?: boolean }): void {
  if (next.mode !== undefined) modeOverride = next.mode;
  if (next.interactionEnabled !== undefined) interactionOverride = next.interactionEnabled;
}
export function resetVariantFlagsOverride(): void {
  modeOverride = null;
  interactionOverride = null;
}
export function getEffectiveVariantResolutionMode(): VariantResolutionMode {
  if (modeOverride !== null) return modeOverride;
  return getVariantResolutionMode();
}
export function getEffectiveVariantInteractionEnabled(): boolean {
  if (interactionOverride !== null) return interactionOverride;
  return isVariantInteractionEnabled();
}
