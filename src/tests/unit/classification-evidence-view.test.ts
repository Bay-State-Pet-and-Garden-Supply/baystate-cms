import { describe, expect, it } from 'vitest';
import {
  deriveEvidenceView,
  evidenceRoleFor,
  safeSourceUrl,
} from '../../client/classification-evidence-view';
import type { ClassificationEvidence, ClassificationProposal, ClassificationProposalDecision } from '../../shared/schemas/classification';

function evidence(id: string, overrides: Partial<ClassificationEvidence> = {}): ClassificationEvidence {
  return {
    id,
    runId: 'run-1',
    stageName: 'evidence_extraction',
    productSku: 'SKU',
    source: 'official_product_page',
    reliability: 'high',
    capturedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  } as unknown as ClassificationEvidence;
}

function proposal(overrides: Partial<ClassificationProposal>): ClassificationProposal {
  return {
    id: 'p1',
    runId: 'run-1',
    productSku: 'SKU',
    proposalType: 'field_assignment',
    targetId: 'flavor',
    proposedValue: 'Chicken',
    confidence: 0.8,
    evidenceIds: ['e1', 'e2', 'e3'],
    supportingEvidenceIds: ['e1'],
    contradictingEvidenceIds: ['e2'],
    status: 'pending',
    isBulkAcceptable: false,
    isStale: false,
    createdAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  } as unknown as ClassificationProposal;
}

function decision(overrides: Partial<ClassificationProposalDecision> = {}): ClassificationProposalDecision {
  return {
    id: 'd1',
    proposalId: 'p1',
    decision: 'accepted',
    revisedFromId: null,
    reviewerId: null,
    reviewerNote: null,
    decisionKey: null,
    supersededAt: null,
    createdAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  } as unknown as ClassificationProposalDecision;
}

describe('classification-evidence-view (issue #17 I)', () => {
  it('groups proposal-linked evidence by supporting/contradicting/context roles', () => {
    const view = deriveEvidenceView({
      proposal: proposal({}),
      evidence: [
        evidence('e1', { source: 'official_product_page', snippet: 'Chicken recipe' }),
        evidence('e2', { source: 'spreadsheet', snippet: 'Beef recipe' }),
        evidence('e3', { source: 'third_party_page', snippet: 'context note' }),
      ],
    });
    expect(view.supportingCount).toBe(1);
    expect(view.contradictingCount).toBe(1);
    expect(view.contextCount).toBe(1);
    expect(view.hasConflict).toBe(true);
    const support = view.rows.filter(row => row.role === 'supporting');
    expect(support).toHaveLength(1);
    expect(support[0].evidenceId).toBe('e1');
    expect(support[0].source).toBe('official_product_page');
    expect(view.rows.find(row => row.role === 'contradicting')?.evidenceId).toBe('e2');
  });

  it('lists missing evidence ids as missing rows without dropping the proposal state', () => {
    const view = deriveEvidenceView({
      proposal: proposal({ evidenceIds: ['e1', 'ghost'], supportingEvidenceIds: ['ghost'], contradictingEvidenceIds: [] }),
      evidence: [evidence('e1')],
    });
    expect(view.missingEvidenceIds).toEqual(['ghost']);
    expect(view.rows.find(row => row.role === 'missing')?.evidenceId).toBe('ghost');
  });

  it('reports uncited vs cited decision state explicitly', () => {
    const uncited = deriveEvidenceView({ proposal: proposal({}), evidence: [evidence('e1')] });
    expect(uncited.citation.isCited).toBe(false);
    expect(uncited.citation.isUncited).toBe(true);

    const cited = deriveEvidenceView({
      proposal: proposal({}),
      evidence: [evidence('e1'), evidence('e2')],
      decision: decision({ evidenceIds: ['e2', 'e1', 'e2'] }),
    });
    expect(cited.citation.isCited).toBe(true);
    expect(cited.citation.isUncited).toBe(false);
    expect(cited.citation.citedIds).toEqual(['e1', 'e2']);
  });

  it('bounds snippets and values to 300 characters', () => {
    const long = 'x'.repeat(600);
    const view = deriveEvidenceView({
      proposal: proposal({ supportingEvidenceIds: ['e1'] }),
      evidence: [evidence('e1', { snippet: long, value: long })],
    });
    expect(view.rows[0].snippet?.length).toBe(300);
    expect(view.rows[0].value?.length).toBe(300);
  });

  it('derives roles from the authoritative proposal split', () => {
    const p = proposal({});
    expect(evidenceRoleFor(p, 'e1')).toBe('supporting');
    expect(evidenceRoleFor(p, 'e2')).toBe('contradicting');
    expect(evidenceRoleFor(p, 'e3')).toBe('context');
  });

  it('only exposes safe http(s) source urls', () => {
    expect(safeSourceUrl('https://example.com/page')).toBe('https://example.com/page');
    expect(safeSourceUrl('http://example.com/page')).toBe('http://example.com/page');
    expect(safeSourceUrl('javascript:alert(1)')).toBeNull();
    expect(safeSourceUrl('file:///etc/passwd')).toBeNull();
    expect(safeSourceUrl(null)).toBeNull();
    expect(safeSourceUrl('not a url')).toBeNull();
  });
});
