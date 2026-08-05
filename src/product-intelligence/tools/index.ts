/**
 * Bounded Product Intelligence research tools (PI-3).
 *
 * Builds the default tool registry: every adapter wraps a deterministic CMS
 * capability (discovery, verification, extraction, OCR, catalog/taxonomy
 * lookup). The registry is the only path from the Pi worker to CMS data —
 * the agent never calls repositories or reads pages directly.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/20
 */
import { PiToolRegistry } from './registry';
import { identityTools } from './identity-tools';
import { discoveryTools } from './discovery-tools';
import { verificationTools } from './verification-tools';
import { buildExtractionTools } from './extraction-tools';
import { taxonomyTools } from './taxonomy-tools';
import { imageTools } from './image-tools';
import type { PageExtractionContract } from './contract';

export * from './contract';
export * from './registry';
export { identityTools } from './identity-tools';
export { discoveryTools } from './discovery-tools';
export { verificationTools } from './verification-tools';
export { buildExtractionTools, HttpPageExtractionAdapter } from './extraction-tools';
export { taxonomyTools } from './taxonomy-tools';
export { imageTools } from './image-tools';

/** All research tool names the default registry exposes (policy default allowlist). */
export const DEFAULT_RESEARCH_TOOL_NAMES: readonly string[] = [
  ...identityTools.map((t) => t.name),
  ...discoveryTools.map((t) => t.name),
  ...verificationTools.map((t) => t.name),
  ...buildExtractionTools().map((t) => t.name),
  ...taxonomyTools.map((t) => t.name),
  ...imageTools.map((t) => t.name),
];

/**
 * Build the default registry. `extractionContract` is the provider-neutral
 * seam: PI-11 replaces the HTTP adapter with the deterministic ladder later.
 */
export function buildDefaultToolRegistry(extractionContract?: PageExtractionContract): PiToolRegistry {
  return new PiToolRegistry().registerAll([
    ...identityTools,
    ...discoveryTools,
    ...verificationTools,
    ...buildExtractionTools(extractionContract),
    ...taxonomyTools,
    ...imageTools,
  ]);
}

export const defaultToolRegistry = buildDefaultToolRegistry();
