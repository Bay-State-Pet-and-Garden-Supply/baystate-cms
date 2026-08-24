/**
 * ADR-0030 Phase 2 relocation shim: reuse-grant persistence moved to
 * src/db/repositories/image-reuse-policy-repo.ts. Re-exported for remaining
 * Product Intelligence consumers; deleted together with the PI program in
 * Phase 3.
 */
export * from './image-reuse-policy-repo';
