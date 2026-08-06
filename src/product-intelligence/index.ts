/**
 * Product Intelligence execution boundary (PI-1).
 *
 * Provider-neutral executor contracts, runtime feature flags, executor
 * routing, the deterministic legacy executor, and the Pi SDK adapter.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/18
 */
export * from './contracts';
export * from './executor';
export * from './flags';
export * from './execution-router';
export * from './legacy-executor';
export * from './pi/pi-executor';
export * from './pi/pi-session-factory';
export * from './pi/pi-tool-registry';
export * from './pi/pi-resource-loader';
export * from './pi/pi-prompt-builder';
export * from './run-service';
export * from './policy';
export * from './onboarding-import';
export * from './budgets';
export * from './retention';
export * from './tools';
export * from './assets';

export * from './evaluation/gold';
export * from './evaluation/metrics';
export * from './evaluation/fixture-dataset';
