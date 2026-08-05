/**
 * Image evidence pipeline (PI-6).
 *
 * Deterministic discovery, verification, rights, and duplicate detection for
 * product image candidates. The pipeline consumes structured artifacts
 * (#29-style captures, JSON-LD, platform variant mappings), quarantines
 * fetched assets behind the policy gateway, records content + perceptual
 * hashes, compares visible packaging evidence, resolves rights from declared
 * sources, and computes the fail-closed commerce-approval flag.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/23
 */
export * from './schema';
export * from './image-hash';
export * from './rights';
export * from './contract';
export * from './verification';
export * from './discovery';
