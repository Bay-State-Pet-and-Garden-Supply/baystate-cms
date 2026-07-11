/**
 * @deprecated Feature flag for modular (classification pipeline) curation.
 * The modular pipeline is now the only curation path. This module exists
 * solely for downstream compatibility and always returns `true`.
 */
export function isModularCurationEnabled(_env?: Record<string, string | undefined>): boolean {
  return true;
}
