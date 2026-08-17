import { describe, expect, it } from 'vitest';
import {
  DiscoverySpecialist,
  DiscoverySpecialistInputSchema,
  DiscoverySpecialistOutputSchema,
  registerDiscoverySpecialistSchemas,
  DISCOVERY_OUTPUT_ARTIFACT_TYPE,
} from '../../../product-intelligence/specialists/discovery';
import { SpecialistArtifactSchemaRegistry } from '../../../product-intelligence/specialists/artifacts';
import type { PageExtractionContract, PageExtractionResult } from '../../../product-intelligence/tools/contract';
import type { SpecialistContext } from '../../../product-intelligence/specialists/contracts';

const seed = { sku: 'SUP-42', name: 'ACME Chicken Broth 16 oz', price: '9.99' };
const policy = {
  configId: 'policy-test', allowedTools: [], researchTools: [], allowedSourceDomains: [],
  maxResponseBytes: 5_000_000, networkPolicy: 'local_only' as const, dataSharingPolicy: 'local_only' as const,
  modelRoute: null, maxToolCalls: 10, deadlineMs: 10_000,
};
const context: SpecialistContext = { runId: 'run-49', workspaceId: 'ws-49', workspacePath: '/tmp/ws-49', policy, seq: 1 };

function source(url: string, sourceType: 'manufacturer' | 'supplier' | 'retailer' | 'search' = 'search') {
  return { url, sourceType, sourceRef: `${sourceType}:fixture`, sourceMethod: 'golden_fixture', evidenceIds: [`fixture:${url}`] };
}

function page(url: string, overrides: Partial<PageExtractionResult> = {}): PageExtractionResult {
  return {
    requestedUrl: url, finalUrl: url, fetchModes: ['fixture'], contentHash: 'a'.repeat(64), artifactRef: null,
    fields: [{ field: 'product_name', value: 'ACME Chicken Broth 16 oz', method: 'fixture', sourcePath: 'fixture.name' }],
    gtins: [], sku: null, brand: 'ACME', productName: 'ACME Chicken Broth 16 oz', variant: null, size: '16 oz', packCount: null,
    images: [], conflicts: [], identityStatus: 'probable_match', identityReasons: ['fixture'], deterministicOnly: true,
    ...overrides,
  };
}

class FixtureExtraction implements PageExtractionContract {
  readonly name = 'golden_fixture';
  readonly version = '1.0.0';
  constructor(private readonly pages: Map<string, PageExtractionResult>) {}
  async extract(request: { url: string; expected?: { gtin?: string; name?: string; brandHint?: string | null }; signal: AbortSignal; timeoutMs: number }) {
    const found = this.pages.get(request.url);
    if (!found) throw new Error('fixture page missing');
    return found;
  }
}

function specialist(pages: Map<string, PageExtractionResult>, options?: ConstructorParameters<typeof DiscoverySpecialist>[1]) {
  return new DiscoverySpecialist({ extraction: new FixtureExtraction(pages) }, options);
}

const candidate = source('https://brand.example/products/chicken-broth-16oz', 'manufacturer');

describe('Discovery / Identity specialist (#49)', () => {
  it('accepts ProductSeed without GTIN and ranks abbreviated names with source provenance', async () => {
    const result = await specialist(new Map([[candidate.url, page(candidate.url)]])).discover({ productSeed: seed, sourceCandidates: [candidate] }, context);
    expect('result' in result && result.result.outcome).toBe('succeeded');
    if (!('artifact' in result)) throw new Error('expected discovery artifact');
    expect(result.output.candidates[0].pageKind).toBe('probable_pdp');
    expect(result.output.candidates[0].source.sourceRef).toBe('manufacturer:fixture');
    expect(result.output.candidates[0].signals.some((s) => s.kind === 'name_alignment')).toBe(true);
    expect(result.output.candidates.map((candidate) => candidate.rank)).toEqual([1]);
    expect(result.output.authority).toBe('none');
    expect(result.artifact.provenance.codeCommit).toBeTruthy();
  });

  it('uses a supplier-only SKU as a ranking signal, never as a GTIN assertion', async () => {
    const skuPage = page(candidate.url, {
      sku: seed.sku,
      skuEvidence: {
        value: seed.sku,
        method: 'fixture',
        sourcePath: 'json_ld.offers.sku',
        sourceArtifactId: 'fixture-artifact-sku',
        evidenceIds: ['fixture-evidence-sku'],
      },
      productName: 'Chicken Broth 16 oz',
      fields: [{ field: 'sku', value: seed.sku, method: 'fixture', sourcePath: 'json_ld.offers.sku' }],
    });
    const result = await specialist(new Map([[candidate.url, skuPage]])).discover({ productSeed: seed, sourceCandidates: [candidate] }, context);
    if (!('artifact' in result)) throw new Error('expected discovery artifact');
    expect(result.output.discoveredGtin).toBeNull();
    expect(result.output.candidates[0].signals.some((s) => s.kind === 'sku_match')).toBe(true);
    expect(result.output.candidates[0].extracted.gtins).toEqual([]);
    expect(result.output.candidates[0].extracted.identifiers[0]).toMatchObject({ kind: 'sku', value: seed.sku, method: 'fixture' });
    expect(result.output.candidates[0].extracted.identifiers[0].evidenceIds).toEqual(['fixture-evidence-sku']);
    expect(result.output.candidates[0].extracted.identifiers[0].sourcePath).toBe('json_ld.offers.sku');
    expect(result.output.candidates[0].extracted.identifiers[0].sourceArtifactId).toBe('fixture-artifact-sku');
  });

  it('does not score identifiers from generic candidate evidence or incomplete identifier provenance', async () => {
    const untrusted = page(candidate.url, {
      artifactRef: 'generic-page-artifact',
      gtins: [{ value: '012345678905', method: 'fixture' }],
      sku: seed.sku,
      fields: [
        { field: 'product_name', value: 'ACME Chicken Broth 16 oz', method: 'fixture', sourcePath: 'fixture.name' },
        { field: 'sku', value: seed.sku, method: 'fixture' },
      ],
    });
    const baseline = await specialist(new Map([[candidate.url, page(candidate.url)]])).discover({ productSeed: seed, discoveredGtin: '012345678905', sourceCandidates: [candidate] }, context);
    const result = await specialist(new Map([[candidate.url, untrusted]])).discover({ productSeed: seed, discoveredGtin: '012345678905', sourceCandidates: [candidate] }, context);
    if (!('artifact' in baseline) || !('artifact' in result)) throw new Error('expected discovery artifacts');
    const signals = result.output.candidates[0].signals;
    expect(signals.some((signal) => signal.kind === 'exact_gtin' || signal.kind === 'sku_match')).toBe(false);
    expect(result.output.candidates[0].extracted.identifiers).toEqual([]);
    expect(result.output.candidates[0].score).toBe(baseline.output.candidates[0].score);
  });

  it('ranks a clearly labeled imported supplier fixture abbreviation and marks the alignment explicitly', async () => {
    const abbreviatedSeed = { ...seed, name: 'Acme WS Salmon 5 oz' };
    const abbreviated = {
      ...source('https://supplier.example/acme/wild-salmon-5oz', 'supplier'),
      sourceRef: 'supplier:golden_fixture:acme-ws-salmon',
      evidenceIds: ['supplier-evidence:acme-ws-salmon'],
    };
    const unrelated = source('https://other.example/products/salmon-5oz', 'manufacturer');
    const supplierArtifactId = 'supplier-artifact:acme-ws-salmon';
    const pages = new Map([
      [abbreviated.url, page(abbreviated.url, {
        artifactRef: supplierArtifactId,
        productName: 'Acme Wild Salmon 5 oz',
        brand: 'Acme',
        size: '5 oz',
        fields: [{ field: 'product_name', value: 'Acme Wild Salmon 5 oz', method: 'supplier_import', sourcePath: 'supplier_export.rows[0].product_name', sourceArtifactId: supplierArtifactId, evidenceIds: ['supplier-evidence:acme-ws-salmon:name'] }],
      })],
      [unrelated.url, page(unrelated.url, { productName: 'Other Salmon 5 oz', brand: 'Other', size: '5 oz' })],
    ]);
    const result = await specialist(pages).discover({ productSeed: abbreviatedSeed, sourceCandidates: [unrelated, abbreviated] }, context);
    if (!('artifact' in result)) throw new Error('expected discovery artifact');
    expect(result.output.candidates[0].source.url).toBe(abbreviated.url);
    expect(result.output.candidates[0].source.sourceRef).toBe('supplier:golden_fixture:acme-ws-salmon');
    expect(result.output.candidates[0].signals.some((s) => s.kind === 'abbreviated_name_alignment')).toBe(true);
  });

  it('does not rank unresolved leads when extraction is unavailable or budget is exhausted', async () => {
    const unavailable = await new DiscoverySpecialist({}, { codeCommit: 'test-build-49' }).discover({ productSeed: seed, sourceCandidates: [candidate] }, context);
    if (!('artifact' in unavailable)) throw new Error('expected discovery artifact');
    expect(unavailable.output.disposition).toBe('needs_targeted_evidence');
    expect(unavailable.output.nextEvidence.length).toBeGreaterThan(0);
    expect(unavailable.output.candidates[0].extractionStatus).toBe('unverified');
    expect(unavailable.output.candidates[0].rank).toBeNull();
    expect(unavailable.artifact.provenance.codeCommit).toBe('test-build-49');

    const exhausted = await specialist(new Map([[candidate.url, page(candidate.url)]],), { maxVerificationRequests: 0 }).discover({ productSeed: seed, sourceCandidates: [candidate] }, context);
    if (!('artifact' in exhausted)) throw new Error('expected discovery artifact');
    expect(exhausted.output.disposition).not.toBe('ranked');
    expect(exhausted.output.nextEvidence).toContain('additional_source');
  });

  it('retains identifier-specific path, artifact, method, and evidence provenance', async () => {
    const identified = page(candidate.url, {
      gtins: [{ value: '012345678905', method: 'json_ld', sourcePath: 'json_ld.offers.gtin13', sourceArtifactId: 'fixture-page-artifact', evidenceIds: ['fixture-gtin-evidence'] }],
      sku: 'ACME-16',
      skuEvidence: { value: 'ACME-16', method: 'selector', sourcePath: 'article[data-sku]', sourceArtifactId: 'fixture-page-artifact', evidenceIds: ['fixture-sku-evidence'] },
    });
    const result = await specialist(new Map([[candidate.url, identified]])).discover({ productSeed: seed, sourceCandidates: [candidate] }, context);
    if (!('artifact' in result)) throw new Error('expected discovery artifact');
    expect(result.output.candidates[0].extracted.identifiers).toEqual([
      expect.objectContaining({ kind: 'gtin', method: 'json_ld', sourcePath: 'json_ld.offers.gtin13', sourceArtifactId: 'fixture-page-artifact', evidenceIds: ['fixture-gtin-evidence'] }),
      expect.objectContaining({ kind: 'sku', method: 'selector', sourcePath: 'article[data-sku]', sourceArtifactId: 'fixture-page-artifact', evidenceIds: ['fixture-sku-evidence'] }),
    ]);
  });

  it('distinguishes an exact PDP from a wrong-size page', async () => {
    const exact = source('https://brand.example/products/chicken-broth-16oz', 'manufacturer');
    const wrong = source('https://retailer.example/products/chicken-broth-4oz', 'retailer');
    const pages = new Map([
      [exact.url, page(exact.url, {
        gtins: [{ value: '012345678905', method: 'fixture', sourcePath: 'supplier_export.rows[0].gtin', sourceArtifactId: 'fixture-artifact:exact-gtin', evidenceIds: ['fixture-evidence:exact-gtin'] }],
        identityStatus: 'exact_match',
      })],
      [wrong.url, page(wrong.url, { productName: 'ACME Chicken Broth 4 oz', size: '4 oz', identityStatus: 'wrong_variant', identityReasons: ['size mismatch'] })],
    ]);
    const result = await specialist(pages).discover({ productSeed: seed, discoveredGtin: '012345678905', sourceCandidates: [wrong, exact] }, context);
    if (!('artifact' in result)) throw new Error('expected discovery artifact');
    expect(result.output.candidates.map((c) => c.pageKind)).toEqual(['exact_pdp', 'wrong_variant']);
    expect(result.output.candidates[1].signals.some((s) => s.kind === 'size_conflict')).toBe(true);
    expect(result.output.candidates.map((candidate) => candidate.rank)).toEqual([1, null]);
    expect(result.output.candidates[0].signals.some((s) => s.kind === 'exact_gtin')).toBe(true);
  });

  it('distinguishes a family page and asks for selected-variant evidence', async () => {
    const family = source('https://brand.example/products/chicken-broth', 'manufacturer');
    const result = await specialist(new Map([[family.url, page(family.url, { identityStatus: 'parent_product_only', identityReasons: ['variant selector'] })]])).discover({ productSeed: seed, sourceCandidates: [family] }, context);
    if (!('artifact' in result)) throw new Error('expected discovery artifact');
    expect(result.output.candidates[0].pageKind).toBe('parent_family_page');
    expect(result.output.disposition).toBe('needs_targeted_evidence');
    expect(result.output.nextEvidence).toContain('selected_variant');
  });

  it('holds ambiguous brands for human review rather than forcing a match', async () => {
    const first = source('https://acme.example/p/broth', 'manufacturer');
    const second = source('https://other.example/p/broth', 'manufacturer');
    const pages = new Map([
      [first.url, page(first.url, { brand: 'ACME', productName: 'Chicken Broth 16 oz' })],
      [second.url, page(second.url, { brand: 'OTHER', productName: 'Chicken Broth 16 oz' })],
    ]);
    const result = await specialist(pages).discover({ productSeed: { ...seed, name: 'Chicken Broth 16 oz' }, sourceCandidates: [first, second] }, context);
    if (!('artifact' in result)) throw new Error('expected discovery artifact');
    expect(result.output.disposition).toBe('human_review');
    expect(result.output.nextEvidence).toEqual(['human_review']);
  });

  it('returns a structured abstention for discontinued/no-result products', async () => {
    const result = await new DiscoverySpecialist({ search: async () => ({ candidates: [] }) }).discover({ productSeed: seed }, context);
    expect('outcome' in result && result.outcome).toBe('abstained');
    if ('outcome' in result) expect(result.abstention?.reason).toMatch(/no source candidates/);
  });

  it('caps verification work and registers versioned input/output schemas', async () => {
    const sources = Array.from({ length: 4 }, (_, i) => source(`https://brand.example/products/${i}`));
    const pages = new Map(sources.map((item) => [item.url, page(item.url)]));
    const result = await specialist(pages, { maxVerificationRequests: 2 }).discover({ productSeed: seed, sourceCandidates: sources }, context);
    if (!('artifact' in result)) throw new Error('expected discovery artifact');
    expect(result.output.budget.verificationRequestsUsed).toBe(2);
    expect(result.output.budget.verificationRequestsAllowed).toBe(2);
    expect(result.output.candidates.map((candidate) => candidate.rank)).toEqual([1, 2, null, null]);
    expect(DiscoverySpecialistInputSchema.safeParse({ productSeed: seed }).success).toBe(true);
    expect(DiscoverySpecialistOutputSchema.safeParse(result.output).success).toBe(true);
    const schemas = registerDiscoverySpecialistSchemas(new SpecialistArtifactSchemaRegistry());
    expect(schemas.validatePayload(DISCOVERY_OUTPUT_ARTIFACT_TYPE, '1.0.0', result.output).valid).toBe(true);
  });
});
