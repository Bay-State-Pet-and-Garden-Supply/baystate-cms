/**
 * Specialist capability registry + typed workflow artifacts (epic #47,
 * issue #48).
 *
 * Provider-neutral capability contracts, versioned typed artifact schemas
 * with lineage + execution provenance, a metadata/configuration registry,
 * and per-specialist policy bindings that reuse Product Intelligence
 * governance (PI-5). Only the orchestrator routes work; the registry never
 * selects a specialist and a specialist never dispatches another.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/48
 */
export * from './contracts';
export * from './artifacts';
export * from './registry';
export * from './policies';
export * from './discovery';
export * from './profile-engineer';
export * from './resolver';
export * from './curator';