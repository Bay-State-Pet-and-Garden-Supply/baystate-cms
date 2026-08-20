// story: e06s04
import { randomUUID } from 'node:crypto';

export interface ProfileVersion {
  id: string;
  domain: string;
  version: number;
  selectors: Record<string, unknown>;
  runtime: string;
  sampleIds: string[];
  artifactHashes: string[];
  validationSummary: Record<string, unknown>;
  provenance: { provider: string; model: string; configId: string };
  approver: string;
  reason: string;
  createdAt: string;
}

// in-memory stores for test isolation — production would persist to SQLite via migration
const versionsById = new Map<string, ProfileVersion>();
const versionsByDomain = new Map<string, ProfileVersion[]>();
const activePointer = new Map<string, string>();

export function createVersion(input: {
  domain: string;
  selectors: Record<string, unknown>;
  runtime: string;
  sampleIds: string[];
  artifactHashes: string[];
  validationSummary: Record<string, unknown>;
  provenance: { provider: string; model: string; configId: string };
  approver: string;
  reason: string;
}): ProfileVersion {
  const domain = input.domain.toLowerCase().replace(/^www\./, '').trim();
  const list = versionsByDomain.get(domain) ?? [];
  const version: ProfileVersion = {
    id: randomUUID(),
    domain,
    version: list.length + 1,
    selectors: input.selectors,
    runtime: input.runtime,
    sampleIds: input.sampleIds,
    artifactHashes: input.artifactHashes,
    validationSummary: input.validationSummary,
    provenance: input.provenance,
    approver: input.approver,
    reason: input.reason,
    createdAt: new Date().toISOString(),
  };
  versionsById.set(version.id, version);
  list.push(version);
  versionsByDomain.set(domain, list);
  return version;
}

export function getVersionById(id: string): ProfileVersion | null {
  return versionsById.get(id) ?? null;
}

export function getActiveVersion(domain: string): ProfileVersion | null {
  const key = domain.toLowerCase().replace(/^www\./, '').trim();
  const id = activePointer.get(key);
  if (!id) return null;
  return versionsById.get(id) ?? null;
}

export function setActiveVersion(domain: string, id: string): void {
  const key = domain.toLowerCase().replace(/^www\./, '').trim();
  const v = versionsById.get(id);
  if (!v || v.domain !== key) throw new Error(`Version ${id} not found for domain ${domain}`);
  activePointer.set(key, id);
}

export function rollbackToVersion(domain: string, id: string): ProfileVersion | null {
  const key = domain.toLowerCase().replace(/^www\./, '').trim();
  const v = versionsById.get(id);
  if (!v || v.domain !== key) return null;
  activePointer.set(key, id);
  return v;
}

export function migrateLegacyProfile(input: { domain: string; selectors: Record<string, unknown> }): ProfileVersion {
  const v = createVersion({
    domain: input.domain,
    selectors: input.selectors,
    runtime: 'rendered',
    sampleIds: [],
    artifactHashes: [],
    validationSummary: { legacy: true },
    provenance: { provider: 'legacy-migration', model: 'migrate', configId: 'legacy' },
    approver: 'system',
    reason: 'legacy-migration',
  });
  // explicitly do NOT set active — degraded until re-pass per SCOPE
  return v;
}

export function getVersionState(domain: string): string {
  const key = domain.toLowerCase().replace(/^www\./, '').trim();
  const active = activePointer.get(key);
  if (active) return 'Active';
  const list = versionsByDomain.get(key) ?? [];
  if (list.some(v => v.provenance.provider === 'legacy-migration')) return 'Degraded';
  return 'Not configured';
}

export function resetProfileVersionsForTest(): void {
  versionsById.clear();
  versionsByDomain.clear();
  activePointer.clear();
}
