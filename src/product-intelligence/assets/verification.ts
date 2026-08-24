/**
 * ADR-0030 Phase 1 relocation shim: this module moved to
 * src/onboarding/image-verification/verification.ts. Re-exported for remaining
 * Product Intelligence consumers; deleted together with the PI program
 * in Phase 3. Non-PI production code must import the new home directly.
 */
export * from '../../onboarding/image-verification/verification';
