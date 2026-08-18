import { describe, expect, it } from 'vitest';
import {
  ResolverSpecialist,
  ResolverSpecialistInputSchema,
  ResolvedFactSetSchema,
  RESOLVER_INPUT_ARTIFACT_TYPE,
  RESOLVER_OUTPUT_ARTIFACT_TYPE,
  RESOLVER_SPECIALIST_CAPABILITY,
  DEFAULT_SOURCE_AUTHORITY_POLICY,
  sourceAuthorityConfigId,
  canonicalFieldFor,
  parseQuantity,
  parseDimensions,
  parseCount,
  scopeForIdentifier,
  resolveFactSet,
  registerResolverSchemas,
  type ResolverSpecialistInput,
  type SourceAuthorityPolicy,
} from '../../../product-intelligence/specialists/resolver';
import { SpecialistArtifactSchemaRegistry, validateSpecialistArtifactEnvelope } from '../../../product-intelligence/specialists/artifacts';
import { validateSpecialistResult, type SpecialistContext } from '../../../product-intelligence/specialists/contracts';
import type { DiscoveryCandidate, DiscoverySourceType } from '../../../product-intelligence/specialists/discovery';
import type { ExtractionEvidenceBundle, ExtractionObservation } from '../../../product-intelligence/extraction/evidence';
import { sha256Hex } from '../../../shared/stable-id';

const FIXED_NOW = '2026-08-17T12:00:00.000Z';

const policy = {
  configId: 'policy-test', allowedTools: [], researchTools: [], allowedSourceDomains: [],
  maxResponseBytes: 5_000_000, networkPolicy: 'local_only' as const, dataSharingPolicy: 'local_only' as const,
  modelRoute: null, maxToolCalls: 10, deadlineMs: 10_000,
};
const context: SpecialistContext = { runId: 'run-53', workspaceId: 'ws-53', workspacePath: '/tmp/ws-53', policy, seq: 1 };

function candidateKeyFor(url: string): string {
  return `cand:${sha256Hex(url).slice(0, 16)}`;
}

function candidate(
  url: string,
  sourceType: DiscoverySourceType = 'manufacturer',
  extracted: Partial<DiscoveryCandidate['extracted']> = {},
  pageKind: DiscoveryCandidate['pageKind'] = 'exact_pdp',
): DiscoveryCandidate {
  return {
    rank: 1,
    score: 0.8,
    scoreMeaning: 'ranking_only',
    source: { url, sourceType, sourceRef: `${sourceType}:fixture`, sourceMethod: 'golden_fixture', evidenceIds: [`fixture:${url}`] },
    finalUrl: url,
    pageKind,
    extractionStatus: 'verified',
    extracted: {
      productName: null,
      brand: null,
      sku: null,
      size: null,
      gtins: [],
      identifiers: [],
      identityStatus: null,
      ...extracted,
    },
    signals: [],
    rationaleCodes: [],
    evidenceIds: [`fixture:${url}`],
  };
}

function observation(url: string, field: string, value: string, method = 'json_ld', sourcePath = `fixture.${field}`): ExtractionObservation {
  return {
    id: `extraction:${sha256Hex(`${url}\n${field}\n${value}`).slice(0, 32)}`,
    field,
    value,
    method,
    sourcePath,
    sourceUrl: url,
    finalUrl: url,
    contentHash: 'a'.repeat(64),
    artifactId: `artifact:${url}`,
    profileId: null,
    profileVersion: null,
    variantRef: null,
    provenanceQuality: 'exact_path',
  };
}

function bundle(
  url: string,
  fields: Record<string, string>,
  identityStatus: ExtractionEvidenceBundle['identityStatus'] = 'exact_match',
): ExtractionEvidenceBundle {
  return {
    schemaVersion: 1,
    runnerVersion: '1.0.0',
    requestedUrl: url,
    finalUrl: url,
    retrievedAt: FIXED_NOW,
    contentHash: 'b'.repeat(64),
    artifactRefs: [`artifact:${url}`],
    profile: null,
    extractionPath: [],
    observations: Object.entries(fields).map(([field, value]) => observation(url, field, value)),
    images: [],
    variant: null,
    identityStatus,
    identityReasons: ['fixture'],
    failures: [],
    deterministicOnly: true,
  };
}

function input(
  candidates: DiscoveryCandidate[],
  bundles: ExtractionEvidenceBundle[],
  overrides: Partial<ResolverSpecialistInput> = {},
): ResolverSpecialistInput {
  return ResolverSpecialistInputSchema.parse({
    schemaVersion: '1.0.0',
    productSeed: { sku: 'SUP-53', name: 'ACME Chicken Broth 16 oz', price: '9.99' },
    expectedIdentity: { gtin: '012345678901', gtinScope: 'consumer_unit' },
    discoveryCandidates: candidates,
    extractionBundles: bundles,
    sourceAuthority: DEFAULT_SOURCE_AUTHORITY_POLICY,
    ...overrides,
  });
}

function fact(factSet: ReturnType<typeof resolveFactSet>, field: string) {
  const found = factSet.facts.find((f) => f.field === field);
  if (!found) throw new Error(`expected fact '${field}'`);
  return found;
}

const MANUFACTURER_URL = 'https://acme.example/products/chicken-broth-16oz';
const RETAILER_URL = 'https://retailer.example/p/chicken-broth-16oz';

describe('Resolver specialist (#53)', () => {
  it('reconciles equivalent units (5 lb vs 2.27 kg) into one canonical weight fact', () => {
    const factSet = resolveFactSet(
      input(
        [candidate(MANUFACTURER_URL, 'manufacturer'), candidate(RETAILER_URL, 'retailer')],
        [
          bundle(MANUFACTURER_URL, { weight: '5 lb', brand: 'ACME', gtin: '012345678901' }),
          bundle(RETAILER_URL, { weight: '2.27 kg', brand: 'ACME', gtin: '012345678901' }),
        ],
      ),
      { now: () => FIXED_NOW },
    );

    const weight = fact(factSet, 'weight');
    expect(weight.status).toBe('resolved');
    expect(weight.value).toBe('5 lb');
    expect(weight.canonicalQuantity).toMatchObject({ value: 5, unit: 'lb', kind: 'weight' });
    expect(weight.supportingEvidence).toHaveLength(2);
    expect(weight.confidence).toBeGreaterThan(0.5);
    expect(weight.confidence).toBeLessThanOrEqual(0.95);
  });

  it('preserves a true weight conflict instead of forcing a value', () => {
    const factSet = resolveFactSet(
      input(
        [candidate(MANUFACTURER_URL, 'manufacturer'), candidate(RETAILER_URL, 'retailer')],
        [
          bundle(MANUFACTURER_URL, { weight: '5 lb' }),
          bundle(RETAILER_URL, { weight: '10 lb' }),
        ],
      ),
      { now: () => FIXED_NOW },
    );

    const weight = fact(factSet, 'weight');
    expect(weight.status).toBe('conflict');
    expect(weight.value).toBeNull();
    expect(weight.contradictingEvidence).toHaveLength(2);
    expect(factSet.conflicts).toHaveLength(1);
    expect(factSet.conflicts[0].field).toBe('weight');
    expect(factSet.conflicts[0].sides).toHaveLength(2);
    expect(factSet.fieldCompleteness.conflicts).toBe(1);
  });

  it('does not conflate case and consumer identifiers', () => {
    const factSet = resolveFactSet(
      input(
        [candidate(MANUFACTURER_URL, 'manufacturer')],
        [bundle(MANUFACTURER_URL, { gtin: '012345678901', case_gtin: '10012345678901' })],
      ),
      { now: () => FIXED_NOW },
    );

    const gtin = fact(factSet, 'gtin');
    expect(gtin.status).toBe('resolved');
    expect(gtin.value).toBe('012345678901');
    expect(gtin.identifierScope).toBe('consumer_unit');

    const caseGtin = fact(factSet, 'caseGtin');
    expect(caseGtin.status).toBe('resolved');
    expect(caseGtin.value).toBe('10012345678901');
    expect(caseGtin.identifierScope).toBe('case');

    expect(factSet.identity.gtin).toBe('012345678901');
    expect(factSet.identity.upc).toBe('012345678901');
  });

  it('never promotes a 14-digit case identifier to the consumer GTIN', () => {
    const factSet = resolveFactSet(
      input(
        [candidate(MANUFACTURER_URL, 'manufacturer')],
        [bundle(MANUFACTURER_URL, { gtin: '10012345678901' })],
        { expectedIdentity: { gtin: null, gtinScope: 'consumer_unit' } },
      ),
      { now: () => FIXED_NOW },
    );

    const gtin = fact(factSet, 'gtin');
    expect(gtin.status).toBe('needs_more_evidence');
    expect(gtin.value).toBeNull();
    expect(gtin.notes).toMatch(/out of scope/i);

    const caseGtin = fact(factSet, 'caseGtin');
    expect(caseGtin.status).toBe('resolved');
    expect(caseGtin.value).toBe('10012345678901');

    // The page identity can still be resolved, but no consumer GTIN is claimed.
    expect(factSet.identity.status).toBe('resolved');
    expect(factSet.identity.gtin).toBeNull();
    expect(factSet.identity.upc).toBeNull();
  });

  it('does not promote case or shipping dimensions to product dimensions', () => {
    const factSet = resolveFactSet(
      input(
        [candidate(MANUFACTURER_URL, 'manufacturer')],
        [bundle(MANUFACTURER_URL, { case_dimensions: '24 x 18 x 12 in', shipping_dimensions: '30 x 24 x 18 in' })],
      ),
      { now: () => FIXED_NOW },
    );

    const dimensions = fact(factSet, 'dimensions');
    expect(dimensions.status).toBe('needs_more_evidence');
    expect(dimensions.value).toBeNull();

    const caseDimensions = fact(factSet, 'caseDimensions');
    expect(caseDimensions.status).toBe('resolved');
    expect(caseDimensions.value).toBe('24 x 18 x 12 in');
    expect(caseDimensions.dimensionScope).toBe('case');

    const shippingDimensions = fact(factSet, 'shippingDimensions');
    expect(shippingDimensions.status).toBe('resolved');
    expect(shippingDimensions.value).toBe('30 x 24 x 18 in');
    expect(shippingDimensions.dimensionScope).toBe('shipping');
  });

  it('retains evidence references on every resolved fact and in the registry', () => {
    const manBundle = bundle(MANUFACTURER_URL, { brand: 'ACME' });
    const retBundle = bundle(RETAILER_URL, { brand: 'ACME' });
    const factSet = resolveFactSet(
      input([candidate(MANUFACTURER_URL, 'manufacturer'), candidate(RETAILER_URL, 'retailer')], [manBundle, retBundle]),
      { now: () => FIXED_NOW },
    );

    const brand = fact(factSet, 'brand');
    expect(brand.status).toBe('resolved');
    expect(brand.supportingEvidence).toHaveLength(2);
    const ids = brand.supportingEvidence.map((ref) => ref.id).sort();
    expect(ids).toEqual([manBundle.observations[0].id, retBundle.observations[0].id].sort());
    for (const ref of brand.supportingEvidence) {
      expect(ref.sourceKind).toBeDefined();
      expect(ref.url).toBeDefined();
      expect(ref.field).toBe('brand');
      expect(ref.rawValue).toBe('ACME');
      expect(ref.method).toBe('json_ld');
      expect(factSet.evidenceRegistry[ref.id]).toEqual(ref);
    }
    expect(Object.keys(factSet.evidenceRegistry).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps identity confidence separate from field completeness and per-field confidence', () => {
    const factSet = resolveFactSet(
      input(
        [candidate(MANUFACTURER_URL, 'manufacturer')],
        [bundle(MANUFACTURER_URL, { brand: 'ACME', gtin: '012345678901' })],
      ),
      { now: () => FIXED_NOW },
    );

    expect(factSet.identity.status).toBe('resolved');
    expect(factSet.identity.confidence).toBe(0.95);

    // Only 2 of 12 canonical fields are resolved; identity is still high-confidence.
    expect(factSet.fieldCompleteness.total).toBe(12);
    expect(factSet.fieldCompleteness.resolved).toBe(2);
    expect(factSet.fieldCompleteness.needsMoreEvidence).toBeGreaterThan(0);

    const brand = fact(factSet, 'brand');
    expect(brand.confidence).not.toBe(factSet.identity.confidence);
    expect(brand.confidence).toBeGreaterThan(0);
    expect(brand.confidence).toBeLessThan(factSet.identity.confidence);
  });

  it('records needs_more_evidence and abstentions when evidence is missing', () => {
    const factSet = resolveFactSet(
      input([candidate(MANUFACTURER_URL, 'manufacturer')], [bundle(MANUFACTURER_URL, { brand: 'ACME' })]),
      { now: () => FIXED_NOW },
    );

    for (const field of ['title', 'gtin', 'weight', 'size', 'dimensions']) {
      expect(fact(factSet, field).status).toBe('needs_more_evidence');
    }
    for (const field of ['caseGtin', 'innerPackGtin', 'sku', 'packCount', 'caseDimensions', 'shippingDimensions']) {
      expect(fact(factSet, field).status).toBe('abstained');
    }
    expect(factSet.abstentions.length).toBeGreaterThanOrEqual(9);
    expect(factSet.abstentions.some((a) => a.field === 'title')).toBe(true);
  });

  it('applies config-driven source authority to display values and records the config id', () => {
    const candidates = [candidate(MANUFACTURER_URL, 'manufacturer'), candidate(RETAILER_URL, 'retailer')];
    const bundles = [
      bundle(MANUFACTURER_URL, { weight: '2.27 kg' }),
      bundle(RETAILER_URL, { weight: '5 lb' }),
    ];

    const defaultResult = resolveFactSet(input(candidates, bundles), { now: () => FIXED_NOW });
    expect(fact(defaultResult, 'weight').value).toBe('2.27 kg');
    expect(defaultResult.sourceAuthority.configId).toBe(sourceAuthorityConfigId(DEFAULT_SOURCE_AUTHORITY_POLICY));
    expect(defaultResult.sourceAuthority.configVersion).toBe('1.0.0');

    const retailerFirst: SourceAuthorityPolicy = {
      configVersion: '1.0.0',
      ranking: ['catalog', 'retailer', 'manufacturer', 'distributor', 'supplier', 'marketplace', 'other'],
    };
    const customResult = resolveFactSet(input(candidates, bundles, { sourceAuthority: retailerFirst }), { now: () => FIXED_NOW });
    expect(fact(customResult, 'weight').value).toBe('5 lb');
    expect(customResult.sourceAuthority.configId).not.toBe(defaultResult.sourceAuthority.configId);
    expect(customResult.sourceAuthority.ranking).toEqual(retailerFirst.ranking);
  });

  it('resolves identity through the exact variant candidate when a parent page is also present', () => {
    const parentUrl = 'https://acme.example/products/chicken-broth';
    const variantUrl = 'https://acme.example/products/chicken-broth-16oz';
    const factSet = resolveFactSet(
      input(
        [
          candidate(parentUrl, 'manufacturer', { gtins: ['10012345678901'] }, 'parent_family_page'),
          candidate(variantUrl, 'manufacturer'),
        ],
        [bundle(variantUrl, { gtin: '012345678901', brand: 'ACME' })],
      ),
      { now: () => FIXED_NOW },
    );

    expect(factSet.identity.status).toBe('resolved');
    expect(factSet.identity.candidateId).toBe(candidateKeyFor(variantUrl));
    expect(factSet.identity.gtin).toBe('012345678901');
    expect(factSet.identity.confidence).toBe(0.95);

    const decisions = factSet.identity.decisions;
    expect(decisions).toHaveLength(2);
    const parentDecision = decisions.find((d) => d.candidateId === candidateKeyFor(parentUrl));
    expect(parentDecision?.decision).toBe('parent_product_only');
  });

  it('resolves matching pack counts and preserves differing ones as conflicts', () => {
    const resolved = resolveFactSet(
      input(
        [candidate(MANUFACTURER_URL, 'manufacturer'), candidate(RETAILER_URL, 'retailer')],
        [bundle(MANUFACTURER_URL, { pack_count: '12 count' }), bundle(RETAILER_URL, { pack_count: '12' })],
      ),
      { now: () => FIXED_NOW },
    );
    const count = fact(resolved, 'packCount');
    expect(count.status).toBe('resolved');
    expect(count.canonicalQuantity).toMatchObject({ value: 12, unit: 'count', kind: 'count' });

    const conflicted = resolveFactSet(
      input(
        [candidate(MANUFACTURER_URL, 'manufacturer'), candidate(RETAILER_URL, 'retailer')],
        [bundle(MANUFACTURER_URL, { pack_count: '12' }), bundle(RETAILER_URL, { pack_count: '24' })],
      ),
      { now: () => FIXED_NOW },
    );
    expect(fact(conflicted, 'packCount').status).toBe('conflict');
  });

  it('treats unparseable values as needs_more_evidence instead of forcing them', () => {
    const factSet = resolveFactSet(
      input([candidate(MANUFACTURER_URL, 'manufacturer')], [bundle(MANUFACTURER_URL, { weight: 'heavy' })]),
      { now: () => FIXED_NOW },
    );
    const weight = fact(factSet, 'weight');
    expect(weight.status).toBe('needs_more_evidence');
    expect(weight.value).toBeNull();
    expect(weight.notes).toMatch(/not parseable/i);
  });

  it('emits a typed artifact through the specialist boundary without writing catalog state', async () => {
    const specialist = new ResolverSpecialist({ codeCommit: 'test-commit', now: () => FIXED_NOW });
    const rawInput = {
      schemaVersion: '1.0.0',
      productSeed: { sku: 'SUP-53', name: 'ACME Chicken Broth 16 oz', price: '9.99' },
      expectedIdentity: { gtin: '0123456789012', gtinScope: 'consumer_unit' },
      discoveryCandidates: [candidate(MANUFACTURER_URL, 'manufacturer')],
      extractionBundles: [bundle(MANUFACTURER_URL, { brand: 'ACME', gtin: '0123456789012', weight: '5 lb' })],
      sourceAuthority: DEFAULT_SOURCE_AUTHORITY_POLICY,
    };

    const result = await specialist.execute(rawInput, context);
    expect(result.specialist).toBe('resolver');
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') throw new Error('expected succeeded outcome');

    const envelope = validateSpecialistArtifactEnvelope(result.output);
    expect(envelope.valid).toBe(true);
    if (!envelope.valid) throw new Error('envelope invalid');
    expect(envelope.envelope.artifactType).toBe(RESOLVER_OUTPUT_ARTIFACT_TYPE);
    expect(envelope.envelope.provenance.codeCommit).toBe('test-commit');
    expect(envelope.envelope.provenance.policyConfigId).toBe('policy-test');

    const payload = ResolvedFactSetSchema.parse(envelope.envelope.payload);
    expect(payload.specialist).toBe('resolver');
    expect(payload.specialistVersion).toBe('1.0.0');
    expect(payload.identity.status).toBe('resolved');
    expect(payload.identity.confidence).toBe(0.95);

    const registry = registerResolverSchemas(new SpecialistArtifactSchemaRegistry());
    const validation = validateSpecialistResult({
      result,
      capability: RESOLVER_SPECIALIST_CAPABILITY,
      artifactSchemas: registry,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);

    // Deterministic: same input + clock → same content hash.
    const again = await specialist.execute(rawInput, context);
    if (again.outcome !== 'succeeded') throw new Error('expected succeeded outcome');
    expect(!Array.isArray(again.output) && !Array.isArray(result.output) && again.output?.contentHash).toBe(
      !Array.isArray(result.output) ? result.output?.contentHash : undefined,
    );
  });

  it('fails closed on invalid input', async () => {
    const specialist = new ResolverSpecialist({ codeCommit: 'test-commit', now: () => FIXED_NOW });
    const result = await specialist.execute({ garbage: true }, context);
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed outcome');
    expect(result.failure?.code).toBe('invalid_input');
    expect(result.output).toBeUndefined();

    const wrongVersion = await specialist.execute(
      {
        schemaVersion: '9.9.9',
        productSeed: {},
        expectedIdentity: { gtin: null, gtinScope: 'consumer_unit' },
        discoveryCandidates: [candidate(MANUFACTURER_URL, 'manufacturer')],
        extractionBundles: [],
      },
      context,
    );
    expect(wrongVersion.outcome).toBe('failed');
    if (wrongVersion.outcome !== 'failed') throw new Error('expected failed outcome');
    expect(wrongVersion.failure?.code).toBe('invalid_input');
  });

  it('cancels when the context signal is already aborted', async () => {
    const specialist = new ResolverSpecialist({ codeCommit: 'test-commit', now: () => FIXED_NOW });
    const controller = new AbortController();
    controller.abort();
    const result = await specialist.execute(
      input([candidate(MANUFACTURER_URL, 'manufacturer')], []),
      { ...context, signal: controller.signal },
    );
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed outcome');
    expect(result.failure?.code).toBe('cancelled');
  });

  describe('unit helpers', () => {
    it('parseQuantity normalizes weight, volume, and count', () => {
      expect(parseQuantity('5 lb', 'weight')).toMatchObject({ value: 5, unit: 'lb', kind: 'weight' });
      expect(parseQuantity('2.27 kg', 'weight')?.value).toBeCloseTo(5, 1);
      expect(parseQuantity('16 oz', 'weight')).toMatchObject({ value: 1, unit: 'lb', kind: 'weight' });
      expect(parseQuantity('16 oz', 'size')).toMatchObject({ value: 16, unit: 'fl oz', kind: 'volume' });
      expect(parseQuantity('473 ml', 'size')?.value).toBeCloseTo(16, 0);
      expect(parseQuantity('12 count', 'packCount')).toMatchObject({ value: 12, unit: 'count', kind: 'count' });
      expect(parseQuantity('heavy', 'weight')).toBeNull();
      expect(parseQuantity('16 oz', 'brand')).toBeNull();
    });

    it('parseDimensions canonicalizes to inches', () => {
      expect(parseDimensions('12 x 8 x 5 in')).toEqual({ parts: [12, 8, 5], unit: 'in' });
      expect(parseDimensions('30 x 20 x 10 cm')?.parts?.[0]).toBeCloseTo(11.811, 2);
      expect(parseDimensions('not dimensions')).toBeNull();
    });

    it('parseCount accepts integer counts only', () => {
      expect(parseCount('6 count')).toBe(6);
      expect(parseCount('12')).toBe(12);
      expect(parseCount('dozen')).toBeNull();
      expect(parseCount('1.5')).toBeNull();
    });

    it('scopeForIdentifier scopes by digit length and expected identity', () => {
      const noExpected = { gtin: null, gtinScope: 'consumer_unit' as const };
      expect(scopeForIdentifier('012345678901', noExpected)).toBe('consumer_unit');
      expect(scopeForIdentifier('0123456789012', noExpected)).toBe('consumer_unit');
      expect(scopeForIdentifier('01234567', noExpected)).toBe('consumer_unit');
      expect(scopeForIdentifier('10012345678901', noExpected)).toBe('case');
      expect(scopeForIdentifier('12345', noExpected)).toBe('unknown');
      const caseExpected = { gtin: '10012345678901', gtinScope: 'case' as const };
      expect(scopeForIdentifier('10012345678901', caseExpected)).toBe('case');
    });

    it('canonicalFieldFor maps raw observation fields to canonical fields', () => {
      expect(canonicalFieldFor('product_name')).toBe('title');
      expect(canonicalFieldFor('manufacturer')).toBe('brand');
      expect(canonicalFieldFor('case_upc')).toBe('caseGtin');
      expect(canonicalFieldFor('net_weight')).toBe('weight');
      expect(canonicalFieldFor('package_dimensions')).toBe('shippingDimensions');
      expect(canonicalFieldFor('unknown_field')).toBeNull();
    });

    it('sourceAuthorityConfigId is deterministic and policy-sensitive', () => {
      const a = sourceAuthorityConfigId(DEFAULT_SOURCE_AUTHORITY_POLICY);
      expect(a).toBe(sourceAuthorityConfigId(DEFAULT_SOURCE_AUTHORITY_POLICY));
      expect(a).not.toBe(
        sourceAuthorityConfigId({ configVersion: '1.0.0', ranking: ['catalog', 'retailer', 'manufacturer', 'other'] }),
      );
    });
  });

  it('exposes a registered capability and artifact schemas', () => {
    expect(RESOLVER_SPECIALIST_CAPABILITY.name).toBe('resolver');
    expect(RESOLVER_SPECIALIST_CAPABILITY.kind).toBe('identity');
    expect(RESOLVER_SPECIALIST_CAPABILITY.input.schemaName).toBe(RESOLVER_INPUT_ARTIFACT_TYPE);
    expect(RESOLVER_SPECIALIST_CAPABILITY.output.schemaName).toBe(RESOLVER_OUTPUT_ARTIFACT_TYPE);
    const registry = registerResolverSchemas(new SpecialistArtifactSchemaRegistry());
    expect(registry.has(RESOLVER_INPUT_ARTIFACT_TYPE)).toBe(true);
    expect(registry.has(RESOLVER_OUTPUT_ARTIFACT_TYPE)).toBe(true);
    expect(registry.isVersionCompatible(RESOLVER_INPUT_ARTIFACT_TYPE, RESOLVER_SPECIALIST_CAPABILITY.input.schemaVersion)).toBe(true);
    expect(registry.isVersionCompatible(RESOLVER_OUTPUT_ARTIFACT_TYPE, RESOLVER_SPECIALIST_CAPABILITY.output.schemaVersion)).toBe(true);
  });
});
