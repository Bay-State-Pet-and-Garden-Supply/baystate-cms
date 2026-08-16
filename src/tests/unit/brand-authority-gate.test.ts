/**
 * ADR 0017 (Phase 1) — brand authority gate + provisional brand→domain mapping.
 *
 * Proves the two new discovery invariants:
 * 1. Commitment 1: `persistProvisionalInferredDomain` writes a high-confidence
 *    inferred brand→domain into `brand_sites` (never overwriting an
 *    operator-maintained mapping) so subsequent discovery runs for the same
 *    brand are guided (`site:` scoping + sitemap).
 * 2. Commitment 2: `passesAuthorityGate` (+ worker flow) — auto-accept as the
 *    selected official source requires the candidate's domain to be a mapped
 *    official brand domain (strict exact-or-subdomain). Unknown or unmapped
 *    brands ALWAYS route to manual review even when page-verification identity
 *    proof is strong, and a provisional mapping created by the same run grants
 *    no auto-accept authority in that run.
 *
 * Offline-only: `discoverSources` + `verifyTopCandidates` are injected through
 * the worker's deps seam (same convention as discovery-run-trace.test.ts). No
 * network, no LLM.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import { getLatestDiscoveryRunForItem } from '../../db/repositories/onboarding-source-repo';
import { upsertBrandSite, findBrandSites, insertBrandSiteIfAbsent } from '../../db/repositories/brand-site-repo';
import {
  OnboardingWorker,
  persistProvisionalInferredDomain,
  passesAuthorityGate,
  PROVISIONAL_BRAND_SITE_MIN_CONFIDENCE,
} from '../../onboarding/job-queue';
import type { Workspace } from '../../shared/types';
import type { InsertSourceData } from '../../db/repositories/onboarding-source-repo';
import type { VerificationResult } from '../../onboarding/page-verifier';
import type { BrandInferenceResult } from '../../onboarding/brand-inferrer';

// ─── Deferred discovery/verification impls (deps seam) ───────────────────────

let discoverImpl: ((upc: string, name: string, brandHint?: string | null) => Promise<{
  candidates: InsertSourceData[];
  consolidatedName: string | null;
  inferredBrand?: BrandInferenceResult | null;
  noDomainMapped?: boolean;
}>) | null = null;
let verifyImpl: ((candidates: InsertSourceData[]) => Promise<VerificationResult[]>) | null = null;

const OFFICIAL_CANDIDATE: InsertSourceData = {
  url: 'https://brand.example.com/product/upc1',
  title: 'Brand Product',
  confidence: 0.95,
  domain: 'brand.example.com',
  sourceMethod: 'serper_name',
};

const RETAILER_CANDIDATE: InsertSourceData = {
  url: 'https://farmtopaw.ca/products/upc1',
  title: 'Brand Product at Retailer',
  confidence: 0.9,
  domain: 'farmtopaw.ca',
  sourceMethod: 'serper_name',
};

const STRONG_SIGNALS: VerificationResult['signals'] = {
  domainOfficial: true,
  isProductDetailPage: true,
  isListingOrSearchPage: false,
  isBlogOrCmsPage: false,
  titleSimilarity: 0.8,
  brandInPage: true,
  upcInPage: true,
  skuInPage: true,
  hasJsonLdProduct: true,
  hasShopifyProductJson: false,
  variantResolved: false,
  canonicalMatchesCandidate: true,
  pageTitle: 'Brand Product',
  titleNameOverlap: 0.85,
};

function strongVerification(candidate: InsertSourceData, domainOfficial = true): VerificationResult {
  return {
    candidate,
    verificationScore: 0.9,
    signals: { ...STRONG_SIGNALS, domainOfficial },
    hasStrongProof: true,
    decisionReason: 'UPC match + title overlap',
  };
}

function makeDiscover(
  candidates: InsertSourceData[],
  inferredBrand?: BrandInferenceResult | null,
  noDomainMapped = false,
): NonNullable<typeof discoverImpl> {
  return async () => ({
    candidates,
    consolidatedName: 'Brand Product',
    inferredBrand: inferredBrand ?? null,
    noDomainMapped,
  });
}

// ─── Harness ──────────────────────────────────────────────────────────────────

describe('brand authority gate + provisional mapping (ADR 0017 phase 1)', () => {
  let tempDir: string;
  let workspaceId: string;
  let wsPath: string;
  let batchId: string;

  beforeEach(() => {
    delete process.env.BAYSTATE_CMS_SOURCING_ENABLED;
    delete process.env.BAYSTATE_CMS_SOURCING_MODE;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-authority-gate-test-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    wsPath = path.join(tempDir, 'ws');
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
    workspaceId = 'ws-brand-authority';
    const ws: Workspace = {
      id: workspaceId,
      name: 'Test Workspace',
      workspacePath: wsPath,
      gitPath: path.join(wsPath, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
    batchId = createBatch({ workspaceId, name: 'Brand batch', fileName: 'brand.csv', totalItems: 2 }).id;
    discoverImpl = null;
    verifyImpl = null;
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function runWorkerOnce(): Promise<void> {
    const worker = new OnboardingWorker(workspaceId, wsPath, 10, 3, undefined, {
      discoverSources: (async (upc: string, name: string, brandHint?: string | null) => {
        if (!discoverImpl) throw new Error('discoverImpl not configured');
        return discoverImpl(upc, name, brandHint);
      }) as never,
      verifyTopCandidates: (async (candidates: InsertSourceData[]) => {
        if (!verifyImpl) return [];
        return verifyImpl(candidates);
      }) as never,
    });
    await worker.poll();
    await worker.drain();
  }

  function insertDiscoveryItem(overrides: Partial<{ upc: string; name: string; brandHint: string | null }> = {}) {
    const [item] = insertItems(
      batchId,
      [{
        upc: overrides.upc ?? 'UPC-A',
        name: overrides.name ?? 'Brand Product',
        brandHint: overrides.brandHint ?? null,
        rowNumber: 1,
        stage: 'discovery',
      }],
      'discovery',
      1,
    );
    return item;
  }

  // ─── Commitment 1: provisional mapping persistence (pure) ──────────────

  test('persistProvisionalInferredDomain creates a mapping for a high-confidence inferred domain', () => {
    const created = persistProvisionalInferredDomain({
      brand: 'Butchers',
      confidence: 0.85,
      source: 'llm',
      inferredDomain: 'https://www.butcherspetcare.com/products/',
    });
    expect(created).not.toBeNull();
    expect(created!.brandName).toBe('butchers');
    expect(created!.domain).toBe('butcherspetcare.com'); // scheme/www/path stripped

    const rows = findBrandSites('butchers');
    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe('butcherspetcare.com');
  });

  test('persistProvisionalInferredDomain requires confidence >= threshold', () => {
    expect(PROVISIONAL_BRAND_SITE_MIN_CONFIDENCE).toBe(0.8);
    const created = persistProvisionalInferredDomain({
      brand: 'Butchers',
      confidence: 0.7, // passes the inference gate (0.7) but not the persist gate (0.8)
      source: 'llm',
      inferredDomain: 'https://www.butcherspetcare.com/',
    });
    expect(created).toBeNull();
    expect(findBrandSites('butchers')).toHaveLength(0);
  });

  test('persistProvisionalInferredDomain skips when no inferred domain', () => {
    const created = persistProvisionalInferredDomain({
      brand: 'Butchers',
      confidence: 0.9,
      source: 'heuristic',
      inferredDomain: null,
    });
    expect(created).toBeNull();
    expect(findBrandSites('butchers')).toHaveLength(0);
  });

  test('persistProvisionalInferredDomain never overwrites an operator mapping', () => {
    upsertBrandSite('Butchers', 'butcherspetcare.com');
    const created = persistProvisionalInferredDomain({
      brand: 'Butchers',
      confidence: 0.95,
      source: 'llm',
      inferredDomain: 'https://butcherspetcare.com/',
    });
    expect(created).toBeNull();

    const rows = findBrandSites('butchers');
    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe('butcherspetcare.com');
  });

  // ─── Commitment 2: authority-gate predicate (pure) ──────────────────────

  test('passesAuthorityGate rejects unknown or unmapped brands', () => {
    expect(passesAuthorityGate(null, ['brand.example.com'], 'brand.example.com')).toBe(false);
    expect(passesAuthorityGate('', ['brand.example.com'], 'brand.example.com')).toBe(false);
    expect(passesAuthorityGate('  ', ['brand.example.com'], 'brand.example.com')).toBe(false);
    expect(passesAuthorityGate('Brand', [], 'brand.example.com')).toBe(false);
    expect(passesAuthorityGate('Brand', ['brand.example.com'], null)).toBe(false);
    expect(passesAuthorityGate('Brand', ['brand.example.com'], undefined)).toBe(false);
  });

  test('passesAuthorityGate accepts exact and subdomain matches, rejects others', () => {
    expect(passesAuthorityGate('Brand', ['brand.example.com'], 'brand.example.com')).toBe(true);
    expect(passesAuthorityGate('Brand', ['brand.example.com'], 'shop.brand.example.com')).toBe(true);
    expect(passesAuthorityGate('Brand', ['brand.example.com'], 'farmtopaw.ca')).toBe(false);
    // Strict matching: a lookalike domain is NOT official.
    expect(passesAuthorityGate('Brand', ['brand.example.com'], 'notbrand.example.com')).toBe(false);
  });

  // ─── Worker flow: authority gate blocks off-domain auto-accept ─────────

  test('unknown brand + strong retailer proof → manual review (authority)', async () => {
    const item = insertDiscoveryItem({ upc: 'UPC-C1', name: 'Retailer Strong Proof' });
    discoverImpl = makeDiscover([RETAILER_CANDIDATE]);
    verifyImpl = async (candidates: InsertSourceData[]) =>
      candidates.map(c => strongVerification(c, /* domainOfficial */ false));

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.outcome).toBe('needs_input_candidates');
    expect(run!.outcome_message).toContain('authority');

    const after = findItemById(item.id)!;
    expect(after.stageStatus).toBe('completed');
    expect(after.sourceUrl).toBeNull();
    expect(after.errorMessage).toContain('authority');
  });

  test('mapped brand + off-domain strong proof → manual review (authority)', async () => {
    upsertBrandSite('BrandX', 'brand.example.com');
    const item = insertDiscoveryItem({ upc: 'UPC-C2', name: 'Off Domain', brandHint: 'BrandX' });
    discoverImpl = makeDiscover([RETAILER_CANDIDATE]);
    verifyImpl = async (candidates: InsertSourceData[]) =>
      candidates.map(c => strongVerification(c, /* domainOfficial */ false));

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.outcome).toBe('needs_input_candidates');
    expect(run!.outcome_message).toContain('authority');
    expect(run!.outcome_message).toContain('brand.example.com');

    const after = findItemById(item.id)!;
    expect(after.sourceUrl).toBeNull();
  });

  test('mapped brand + official-domain candidate still auto-accepts', async () => {
    upsertBrandSite('BrandX', 'brand.example.com');
    const item = insertDiscoveryItem({ upc: 'UPC-D', name: 'Official Match', brandHint: 'BrandX' });
    discoverImpl = makeDiscover([OFFICIAL_CANDIDATE]);
    verifyImpl = async (candidates: InsertSourceData[]) => candidates.map(c => strongVerification(c, true));

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.outcome).toBe('auto_selected');
    expect(run!.outcome_message).toContain('Auto-selected');

    const after = findItemById(item.id)!;
    expect(after.sourceUrl).toBe(OFFICIAL_CANDIDATE.url);
  });

  // ─── Worker flow: provisional mapping persists but never auto-accepts ──

  test('high-confidence inferred domain persists a mapping but requires manual review in the same run', async () => {
    const item = insertDiscoveryItem({ upc: 'UPC-E', name: 'Inferred Product' });
    const inferredBrand: BrandInferenceResult = {
      brand: 'InferredBrand',
      confidence: 0.85,
      source: 'llm',
      inferredDomain: 'https://inferredbrand.example.com/',
    };
    discoverImpl = makeDiscover(
      [{ ...OFFICIAL_CANDIDATE, url: 'https://inferredbrand.example.com/product/x', domain: 'inferredbrand.example.com' }],
      inferredBrand,
    );
    verifyImpl = async (candidates: InsertSourceData[]) =>
      candidates.map(c => strongVerification(c, true));

    await runWorkerOnce();

    // The provisional mapping IS persisted for the next run…
    const rows = findBrandSites('inferredbrand');
    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe('inferredbrand.example.com');

    // …the item's brand hint is updated…
    const after = findItemById(item.id)!;
    expect(after.brandHint).toBe('InferredBrand');

    // …but this run does NOT auto-accept: the provisional mapping grants no
    // authority in the same run — the source URL is held for manual review.
    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.outcome).toBe('needs_input_candidates');
    expect(run!.outcome_message).toContain('provisional inference mapping');
    expect(after.sourceUrl).toBeNull();
  });

  test('persistProvisionalInferredDomain never maps a known retailer/distributor domain', () => {
    // farmtopaw.ca is on the ADR 0017 denylist seed — the observed BUTCHERS
    // failure mode was a retailer page persisted as the brand's official
    // domain. A retailer domain must never become an authority mapping, even
    // provisionally and even at high confidence.
    const created = persistProvisionalInferredDomain({
      brand: 'Butchers',
      confidence: 0.95,
      source: 'llm',
      inferredDomain: 'https://farmtopaw.ca/products/',
    });
    expect(created).toBeNull();
    expect(findBrandSites('butchers')).toHaveLength(0);
  });

  test('passesAuthorityGate: multi-domain brands accept subdomains, reject lookalikes', () => {
    const officialDomains = ['brand.com', 'brand.co.uk'];
    // A subdomain of any mapped official domain is authoritative.
    expect(passesAuthorityGate('Brand', officialDomains, 'shop.brand.co.uk')).toBe(true);
    expect(passesAuthorityGate('Brand', officialDomains, 'www.brand.com')).toBe(true);
    // A lookalike that merely CONTAINS an official label is not authoritative
    // (strict exact-or-subdomain suffix matching).
    expect(passesAuthorityGate('Brand', officialDomains, 'brand.com.fake.com')).toBe(false);
    expect(passesAuthorityGate('Brand', officialDomains, 'notbrand.com')).toBe(false);
  });

  test('insertBrandSiteIfAbsent is atomic first-mapping-wins and same-domain idempotent', () => {
    const first = insertBrandSiteIfAbsent('PetBrand', 'petbrand.example.com');
    expect(first).not.toBeNull();
    expect(first!.brandName).toBe('petbrand');
    expect(first!.domain).toBe('petbrand.example.com');
    expect(first!.successCount).toBe(1);

    // Same brand + same domain: the existing row is returned unchanged — same
    // id, success_count still 1 (no upsert increment, no duplicate row).
    const second = insertBrandSiteIfAbsent('PetBrand', 'petbrand.example.com');
    expect(second).not.toBeNull();
    expect(second!.id).toBe(first!.id);
    expect(second!.successCount).toBe(1);
    expect(findBrandSites('petbrand')).toHaveLength(1);

    // Same brand + DIFFERENT domain: the guarded insert no-ops (the brand's
    // first mapping wins atomically) and the call reports no row for its
    // candidate.
    const third = insertBrandSiteIfAbsent('PetBrand', 'petbrand.ca');
    expect(third).toBeNull();
    expect(findBrandSites('petbrand')).toHaveLength(1);
    expect(findBrandSites('petbrand')[0].domain).toBe('petbrand.example.com');
  });
});