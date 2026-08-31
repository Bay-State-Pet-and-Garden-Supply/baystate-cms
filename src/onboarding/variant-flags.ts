/**
 * Variant resolution feature flags — always-on since #90.
 * Env vars BAYSTATE_CMS_VARIANT_RESOLUTION_MODE and BAYSTATE_CMS_VARIANT_INTERACTION_ENABLED are deprecated and ignored.
 * Resolution is always 'active'; interaction remains default-off unless test override enables it.
 * Test overrides retained for isolated unit tests.
 */

export type VariantResolutionMode = 'off' | 'observe' | 'active';

export function parseVariantResolutionMode(_raw: string | undefined): VariantResolutionMode {
  return 'active';
}

export function getVariantResolutionMode(_env: Record<string, string | undefined> = process.env): VariantResolutionMode {
  return 'active';
}

export function isVariantResolutionActive(_env?: Record<string, string | undefined>): boolean {
  return true;
}
export function isVariantResolutionObserve(_env?: Record<string, string | undefined>): boolean {
  return false;
}
export function isVariantResolutionOff(_env?: Record<string, string | undefined>): boolean {
  return false;
}

export function parseVariantInteractionEnabled(_raw: string | undefined): boolean {
  return false;
}

export function isVariantInteractionEnabled(_env: Record<string, string | undefined> = process.env): boolean {
  return false;
}

// Test overrides — retained for unit tests that need to simulate off/observe
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
  return 'active';
}
export function getEffectiveVariantInteractionEnabled(): boolean {
  if (interactionOverride !== null) return interactionOverride;
  return false;
}
