/**
 * story: e02s01 — specialist workspace logic F.I.R.S.T tests
 * Tests for src/client/agent-lab/specialist-workspace-logic.ts
 */
import { describe, it, expect } from 'vitest';
import {
  getSpecialistStages,
  parseProductSeedDisplay,
  isProductSeedImmutable,
  toDiscoveryCandidateDisplays,
  toExtractionProfileDisplays,
  toResolverFactDisplays,
  toResolverConflictDisplays,
  getUnresolvedFields,
  toCuratorFactDisplays,
  toVerifierVerdictDisplay,
  escapeArtifactString,
  isUnsupportedClaim,
} from '../../client/agent-lab/specialist-workspace-logic';
import { getProvenanceLinks } from '../../client/agent-lab/specialist-workspace-provenance';
import type { PiEvidenceRow, PiSourceRow } from '../../client/product-intelligence-api';

function makeSource(overrides: Partial<PiSourceRow> = {}): PiSourceRow {
  return {
    id: 'src-1',
    runId: 'run-1',
    url: 'https://brand.example.com/p/123',
    canonicalUrl: null,
    domain: 'brand.example.com',
    sourceType: 'manufacturer',
    gtinMatchStatus: 'exact',
    variantMatchStatus: 'unknown',
    retrievedAt: null,
    contentHash: 'abc123hash',
    artifactRef: null,
    licenseRef: null,
    termsRef: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<PiEvidenceRow> = {}): PiEvidenceRow {
  return {
    id: 'ev-1',
    runId: 'run-1',
    sourceId: 'src-1',
    targetField: 'title',
    valueJson: '"Test Title"',
    extractionMethod: 'profile_selector',
    sourceField: 'h1',
    reliability: 'high',
    directSupport: 1,
    snippet: 'snip',
    metadataJson: JSON.stringify({ contentHash: 'abc123hash', path: 'h1.title' }),
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getSpecialistStages
// ---------------------------------------------------------------------------

describe('getSpecialistStages', () => {
  it('returns 6 stages with pending when no artifacts', () => {
    const stages = getSpecialistStages([]);
    expect(stages).toHaveLength(6);
    expect(stages.every((s) => s.status === 'pending')).toBe(true);
    expect(stages.map((s) => s.label)).toEqual(['ProductSeed', 'Discovery', 'Extraction', 'Resolver', 'Curator', 'Verifier']);
  });

  it('marks completed when artifact present', () => {
    const stages = getSpecialistStages(['product_seed', 'discovery_output', 'resolved_factset']);
    expect(stages.find((s) => s.id === 'seed')?.status).toBe('completed');
    expect(stages.find((s) => s.id === 'discovery')?.status).toBe('completed');
    expect(stages.find((s) => s.id === 'resolver')?.status).toBe('completed');
    expect(stages.find((s) => s.id === 'curator')?.status).toBe('pending');
  });

  it('respects needs_review/failed overrides', () => {
    const stages = getSpecialistStages(['verification_report'], new Map([['verifier', 'needs_review']]));
    expect(stages.find((s) => s.id === 'verifier')?.status).toBe('needs_review');
    const failed = getSpecialistStages(['verification_report'], new Map([['verifier', 'failed']]));
    expect(failed.find((s) => s.id === 'verifier')?.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// parseProductSeedDisplay
// ---------------------------------------------------------------------------

describe('parseProductSeedDisplay', () => {
  it('parses productSeed from wrapper JSON', () => {
    const json = JSON.stringify({ productSeed: { sku: 'SKU123', name: 'My Product', price: '12.99' } });
    expect(parseProductSeedDisplay(json)).toEqual({ sku: 'SKU123', name: 'My Product', price: '12.99' });
  });

  it('parses bare seed shape (no wrapper)', () => {
    const json = JSON.stringify({ sku: 'A1', name: 'Name', price: 42 });
    const d = parseProductSeedDisplay(json);
    expect(d?.sku).toBe('A1');
    expect(d?.price).toBe('42');
  });

  it('returns null for missing fields or invalid JSON', () => {
    expect(parseProductSeedDisplay('not json')).toBeNull();
    expect(parseProductSeedDisplay(JSON.stringify({ productSeed: { sku: '' , name: '' } }))).toBeNull();
    expect(parseProductSeedDisplay(JSON.stringify({ sku: '', name: 'x' }))).toBeNull();
  });

  it('isProductSeedImmutable requires non-empty sku and name', () => {
    expect(isProductSeedImmutable({ sku: 'A', name: 'B', price: '' })).toBe(true);
    expect(isProductSeedImmutable({ sku: '', name: 'B', price: '' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toDiscoveryCandidateDisplays
// ---------------------------------------------------------------------------

describe('toDiscoveryCandidateDisplays', () => {
  it('filters to valid candidates with url', () => {
    const displays = toDiscoveryCandidateDisplays([
      { url: 'https://example.com/p/1', domain: 'example.com', sourceType: 'manufacturer', confidence: 0.9 },
      { domain: 'x.com' },
      null,
    ]);
    expect(displays).toHaveLength(1);
    expect(displays[0].url).toBe('https://example.com/p/1');
    expect(displays[0].confidence).toBe(0.9);
  });

  it('returns empty for non-array', () => {
    expect(toDiscoveryCandidateDisplays(null)).toEqual([]);
    expect(toDiscoveryCandidateDisplays({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toExtractionProfileDisplays
// ---------------------------------------------------------------------------

describe('toExtractionProfileDisplays', () => {
  it('maps bundles with profileBinding and sources', () => {
    const sources = [makeSource({ id: 'src-1', url: 'https://example.com/p/1', domain: 'example.com', contentHash: 'hash1' })];
    const bundles: unknown[] = [
      { sourceId: 'src-1', sourceUrl: 'https://example.com/p/1', extractionMethod: 'profile_selector', sourcePath: 'div.title', profileBinding: { domain: 'example.com', version: '2' } },
    ];
    const displays = toExtractionProfileDisplays(bundles, sources);
    expect(displays).toHaveLength(1);
    expect(displays[0].domain).toBe('example.com');
    expect(displays[0].profileVersion).toBe('2');
    expect(displays[0].method).toBe('profile_selector');
    expect(displays[0].selectorPath).toBe('div.title');
    expect(displays[0].contentHash).toBe('hash1');
  });

  it('returns empty for non-array', () => {
    expect(toExtractionProfileDisplays(null, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toResolverFactDisplays
// ---------------------------------------------------------------------------

describe('toResolverFactDisplays', () => {
  it('parses facts array with status and evidence refs', () => {
    const set = {
      facts: [
        { field: 'title', status: 'resolved', value: 'My Title', confidence: 0.95, supportingEvidence: [{ id: 'ev-1' }, { evidenceId: 'ev-2' }], contradictingEvidence: [] },
        { field: 'brand', status: 'needs_more_evidence', value: null, confidence: 0, supportingEvidence: [] },
      ],
    };
    const displays = toResolverFactDisplays(set);
    expect(displays).toHaveLength(2);
    expect(displays[0].field).toBe('title');
    expect(displays[0].value).toBe('My Title');
    expect(displays[0].supportingEvidenceIds).toEqual(['ev-1', 'ev-2']);
    expect(displays[1].status).toBe('needs_more_evidence');
  });

  it('handles missing facts gracefully', () => {
    expect(toResolverFactDisplays(null)).toEqual([]);
    expect(toResolverFactDisplays({})).toEqual([]);
  });
});

describe('toResolverConflictDisplays', () => {
  it('parses conflicts with sides', () => {
    const set = { conflicts: [{ field: 'title', reason: 'two values', sides: [{ value: 'A', evidenceIds: ['ev-1'] }, { value: 'B', evidenceIds: ['ev-2'] }] }] };
    const conflicts = toResolverConflictDisplays(set);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('title');
    expect(conflicts[0].sides).toHaveLength(2);
  });
});

describe('getUnresolvedFields', () => {
  it('returns fields with needs_more_evidence or abstained', () => {
    const facts = [
      { field: 'title', status: 'resolved' as const, value: 'x', confidence: 1, supportingEvidenceIds: [], contradictingEvidenceIds: [] },
      { field: 'brand', status: 'needs_more_evidence' as const, value: null, confidence: 0, supportingEvidenceIds: [], contradictingEvidenceIds: [] },
      { field: 'size', status: 'abstained' as const, value: null, confidence: 0, supportingEvidenceIds: [], contradictingEvidenceIds: [] },
    ];
    expect(getUnresolvedFields(facts)).toEqual(['brand', 'size']);
  });
});

// ---------------------------------------------------------------------------
// toCuratorFactDisplays
// ---------------------------------------------------------------------------

describe('toCuratorFactDisplays', () => {
  it('links curator facts to resolver fields (grounded)', () => {
    const draft = { commerceFacts: [{ field: 'title', value: 'Curated Title', evidenceIds: ['ev-1'] }] };
    const resolverSet = { facts: [{ field: 'title', status: 'resolved', value: 'Curated Title', confidence: 0.9, supportingEvidence: [{ id: 'ev-1' }] }] };
    const displays = toCuratorFactDisplays(draft, resolverSet);
    expect(displays).toHaveLength(1);
    expect(displays[0].groundedInResolvedFact).toBe(true);
    expect(displays[0].evidenceIds).toEqual(['ev-1']);
  });

  it('marks not grounded when resolver lacks field', () => {
    const draft = { commerceFacts: [{ field: 'brand', value: 'X', evidenceIds: ['ev-2'] }] };
    const resolverSet = { facts: [{ field: 'title', status: 'resolved', value: 'T', confidence: 0.9, supportingEvidence: [] }] };
    const displays = toCuratorFactDisplays(draft, resolverSet);
    expect(displays[0].groundedInResolvedFact).toBe(false);
  });

  it('returns empty for invalid draft', () => {
    expect(toCuratorFactDisplays(null, {})).toEqual([]);
  });
});

describe('getProvenanceLinks', () => {
  it('builds links with source url and method', () => {
    const facts = [{ field: 'title', value: 'T', evidenceIds: ['ev-1'], groundedInResolvedFact: true, supportedByEvidenceCount: 1 }];
    const evidence = [makeEvidence({ id: 'ev-1', extractionMethod: 'json_ld', metadataJson: JSON.stringify({ contentHash: 'hashX' }) })];
    const sources = [makeSource({ id: 'src-1', url: 'https://brand.example.com/p/123' })];
    const links = getProvenanceLinks(facts, evidence, sources);
    expect(links).toHaveLength(1);
    expect(links[0].evidenceId).toBe('ev-1');
    expect(links[0].method).toBe('json_ld');
    expect(links[0].sourceUrl).toBe('https://brand.example.com/p/123');
    expect(links[0].contentHash).toBe('hashX');
  });
});

// ---------------------------------------------------------------------------
// toVerifierVerdictDisplay
// ---------------------------------------------------------------------------

describe('toVerifierVerdictDisplay', () => {
  it('parses pass/fail/human_review', () => {
    expect(toVerifierVerdictDisplay({ verdict: 'pass', summary: 'ok' })?.verdict).toBe('pass');
    expect(toVerifierVerdictDisplay({ verdict: 'human_review', summary: 'needs check' })?.verdict).toBe('human_review');
    expect(toVerifierVerdictDisplay({ status: 'fail', failingFields: ['title'] })?.failingFields).toEqual(['title']);
  });

  it('returns null for missing verdict', () => {
    expect(toVerifierVerdictDisplay({ summary: 'no verdict' })).toBeNull();
    expect(toVerifierVerdictDisplay(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// escapeArtifactString + isUnsupportedClaim
// ---------------------------------------------------------------------------

describe('escapeArtifactString', () => {
  it('escapes html entities', () => {
    expect(escapeArtifactString('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(escapeArtifactString('a & b')).toBe('a &amp; b');
  });
});

describe('isUnsupportedClaim', () => {
  it('marks null/empty/zero-evidence/false commerce as unsupported', () => {
    expect(isUnsupportedClaim(null, 1)).toBe(true);
    expect(isUnsupportedClaim('', 1)).toBe(true);
    expect(isUnsupportedClaim('value', 0)).toBe(true);
    expect(isUnsupportedClaim('value', 1, false)).toBe(true);
    expect(isUnsupportedClaim('value', 1, true)).toBe(false);
    expect(isUnsupportedClaim('value', 2)).toBe(false);
  });
});

