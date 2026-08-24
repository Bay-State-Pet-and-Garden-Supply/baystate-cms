/**
 * ADR-0030 Phase 1 relocation shim: the image evidence pipeline moved to
 * src/onboarding/image-verification/. Deleted together with the PI program
 * in Phase 3.
 */
export * from '../../onboarding/image-verification/schema';
export * from '../../onboarding/image-verification/image-hash';
export * from '../../onboarding/image-verification/rights';
export * from '../../onboarding/image-verification/contract';
export * from '../../onboarding/image-verification/verification';
export * from '../../onboarding/image-verification/discovery';
