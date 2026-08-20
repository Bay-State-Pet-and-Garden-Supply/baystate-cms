import type { PiEvidenceRow, PiSourceRow } from '../product-intelligence-api';
import type { CuratorFactDisplay } from './specialist-workspace-logic';

export interface ProvenanceLink {
  resolvedFactField: string;
  evidenceId: string;
  sourceUrl: string | null;
  method: string | null;
  contentHash: string | null;
}

/** Link curated fields to deterministic evidence and source metadata. */
export function getProvenanceLinks(
  curatorFacts: CuratorFactDisplay[],
  evidence: PiEvidenceRow[],
  sources: PiSourceRow[],
): ProvenanceLink[] {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const sourceById = new Map(sources.map((item) => [item.id, item]));
  return curatorFacts.flatMap((fact) => fact.evidenceIds.map((evidenceId) =>
    buildProvenanceLink(fact, evidenceId, evidenceById, sourceById)));
}

function buildProvenanceLink(
  fact: CuratorFactDisplay,
  evidenceId: string,
  evidenceById: Map<string, PiEvidenceRow>,
  sourceById: Map<string, PiSourceRow>,
): ProvenanceLink {
  const evidence = evidenceById.get(evidenceId);
  const source = evidence ? sourceById.get(evidence.sourceId) : undefined;
  return {
    resolvedFactField: fact.field,
    evidenceId,
    sourceUrl: source?.url ?? evidence?.snippet ?? null,
    method: evidence?.extractionMethod ?? null,
    contentHash: readContentHash(evidence?.metadataJson),
  };
}

function readContentHash(metadataJson: string | null | undefined): string | null {
  if (!metadataJson) return null;
  try {
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    return typeof metadata.contentHash === 'string' ? metadata.contentHash : null;
  } catch {
    return null;
  }
}
