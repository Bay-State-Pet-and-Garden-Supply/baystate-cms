import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  evaluateStrictGtin,
  evaluateOldRelaxed,
  computeConfusionMatrix,
  validateGtinChecksum,
} from '../../../scripts/benchmark-official-page-identity';
import type { GoldIdentityBenchmarkRecord } from '../../../scripts/generate-gold-benchmark';

describe('Official-Page Identity Gold Benchmark (G0.2 & P1-A Activation Gate)', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/onboarding/official-page-identity-gold.jsonl');

  it('fixture file exists and has 350 valid JSONL records with verified SHA-256 hashes', () => {
    expect(fs.existsSync(fixturePath)).toBe(true);
    const content = fs.readFileSync(fixturePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(350);

    for (const line of lines) {
      const record: GoldIdentityBenchmarkRecord = JSON.parse(line);
      expect(record.id).toMatch(/^gold-ident-\d{3}$/);
      expect(record.version).toBe('1.0');
      expect(record.item.rawUpc).toBeTruthy();
      expect(record.fixture.html).toBeTruthy();

      const computedHash = createHash('sha256').update(record.fixture.html, 'utf8').digest('hex');
      expect(computedHash).toBe(record.fixture.contentHash);
    }
  });

  it('contains exactly 175 positive GTIN cases and 175 hard negatives across 8 strata', () => {
    const content = fs.readFileSync(fixturePath, 'utf8');
    const records: GoldIdentityBenchmarkRecord[] = content
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => JSON.parse(l));

    const positives = records.filter(r => r.groundTruth.expectedAutoSelect);
    const negatives = records.filter(r => !r.groundTruth.expectedAutoSelect);

    expect(positives.length).toBe(175);
    expect(negatives.length).toBe(175);

    const strataCounts = new Map<string, number>();
    for (const r of records) {
      strataCounts.set(r.groundTruth.stratum, (strataCounts.get(r.groundTruth.stratum) ?? 0) + 1);
    }

    expect(strataCounts.get('exact_valid_gtin_jsonld_single')).toBe(40);
    expect(strataCounts.get('exact_valid_gtin_jsonld_graph')).toBe(30);
    expect(strataCounts.get('exact_valid_gtin_shopify_product_json')).toBe(20);
    expect(strataCounts.get('exact_valid_gtin_microdata')).toBe(15);
    expect(strataCounts.get('exact_valid_gtin_meta')).toBe(15);
    expect(strataCounts.get('exact_variant_shopify_matrix')).toBe(30);
    expect(strataCounts.get('exact_variant_jsonld_product_group')).toBe(25);
    expect(strataCounts.get('same_family_variants')).toBe(40);
    expect(strataCounts.get('listing_search_blog')).toBe(30);
    expect(strataCounts.get('missing_invalid_gtin')).toBe(35);
    expect(strataCounts.get('contradictory_ambiguous_gtin')).toBe(25);
    expect(strataCounts.get('sku_text_only')).toBe(20);
    expect(strataCounts.get('off_domain_false_friends')).toBe(25);
  });

  it('demonstrates that Old Relaxed Selector suffers from severe false positives on hard negatives', () => {
    const content = fs.readFileSync(fixturePath, 'utf8');
    const records: GoldIdentityBenchmarkRecord[] = content
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => JSON.parse(l));

    const oldMatrix = computeConfusionMatrix(records, evaluateOldRelaxed);
    // Old relaxed selector falsely accepts many hard negatives due to relaxed domain overlap rules
    expect(oldMatrix.fp).toBeGreaterThan(50);
    expect(oldMatrix.precision).toBeLessThan(0.70);
  });

  it('enforces G0.2 Activation Floor: Strict GTIN Gate achieves 0 False Positives and Precision 1.0', () => {
    const content = fs.readFileSync(fixturePath, 'utf8');
    const records: GoldIdentityBenchmarkRecord[] = content
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => JSON.parse(l));

    const strictMatrix = computeConfusionMatrix(records, evaluateStrictGtin);

    // 1. Zero False Positives
    expect(strictMatrix.fp).toBe(0);

    // 2. Point Precision is 1.0
    expect(strictMatrix.precision).toBe(1.0);

    // 3. Wilson 95% Precision Lower Bound >= 0.95 (Measured: ~97.85%)
    expect(strictMatrix.wilsonPrecision.lower).toBeGreaterThanOrEqual(0.95);

    // 4. Valid GTIN Recall >= 0.99 (Measured: 100.0%)
    expect(strictMatrix.recall).toBeGreaterThanOrEqual(0.99);

    // 5. Specificity on Negatives is 1.0 (100.0%)
    expect(strictMatrix.specificity).toBe(1.0);
  });

  it('strictly rejects all cross-variant hard negatives in same_family_variants', () => {
    const content = fs.readFileSync(fixturePath, 'utf8');
    const records: GoldIdentityBenchmarkRecord[] = content
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => JSON.parse(l));

    const sameFamilyRecords = records.filter(r => r.groundTruth.stratum === 'same_family_variants');
    expect(sameFamilyRecords.length).toBe(40);

    for (const r of sameFamilyRecords) {
      const res = evaluateStrictGtin(r);
      expect(res.autoSelected).toBe(false);
      expect(res.proofClass).toBe('none');
    }
  });

  it('strictly rejects all off-domain candidates in off_domain_false_friends', () => {
    const content = fs.readFileSync(fixturePath, 'utf8');
    const records: GoldIdentityBenchmarkRecord[] = content
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => JSON.parse(l));

    const offDomainRecords = records.filter(r => r.groundTruth.stratum === 'off_domain_false_friends');
    expect(offDomainRecords.length).toBe(25);

    for (const r of offDomainRecords) {
      const res = evaluateStrictGtin(r);
      expect(res.autoSelected).toBe(false);
      expect(res.authorityMatch).toBe(false);
    }
  });

  it('correctly validates and rejects corrupted GTIN checksums', () => {
    expect(validateGtinChecksum('017800010009')).toBe(true);
    expect(validateGtinChecksum('017800010005')).toBe(false); // Check digit 5 is invalid when expected is 9
    expect(validateGtinChecksum('12345')).toBe(false); // Too short
    expect(validateGtinChecksum('1234567890123456')).toBe(false); // Too long
  });
});
