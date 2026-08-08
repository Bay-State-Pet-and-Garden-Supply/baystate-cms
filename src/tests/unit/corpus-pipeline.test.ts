import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rebuildOfflineCorpus } from '../../classification/datasets/silver-builder';
import { WeakLabelRules, type WeakLabelConfig } from '../../classification/datasets/weak-label-rules';
import { computeManifestDigest } from '../../crawler/corpus-manifest';

const ACTIVE_CONFIG: WeakLabelConfig = {
  productTypes: [
    { id: 'dog-food-dry', name: 'Dry Dog Food' },
    { id: 'cat-food-wet', name: 'Wet Cat Food' },
    { id: 'grass-seed', name: 'Grass Seed' },
    { id: 'weed-control', name: 'Weed Control' },
  ],
  attributes: [
    { id: 'species', name: 'Animal Species' },
    { id: 'life-stage', name: 'Life Stage' },
    { id: 'food-form', name: 'Food Form' },
  ],
  speciesAttributeId: 'species',
  lifeStageAttributeId: 'life-stage',
  foodFormAttributeId: 'food-form',
};

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-pipeline-'));
  tempDirs.push(dir);
  return dir;
}

function bronzeLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    retailer: 'chewy.com',
    sourceUrl: 'https://www.chewy.com/dp/102534',
    scrapedAt: '2026-08-01T08:41:00.000Z',
    title: 'Blue Buffalo Life Protection Adult Dry Dog Food',
    brand: 'Blue Buffalo',
    gtin: '0840243105625',
    rawBreadcrumb: ['Dog', 'Dog Food', 'Dry Kibble'],
    specifications: { 'Life Stage': 'Adult' },
    images: [],
    acquisitionMode: 'browser_parse',
    parserVersion: '2.0',
    ...overrides,
  });
}

describe('offline corpus pipeline', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accounts for every Bronze observation as accepted/rejected/duplicate', () => {
    const root = makeTempDir();
    const bronzeRoot = path.join(root, 'training-corpus');
    const bronzeDir = path.join(bronzeRoot, 'chewy.com');
    fs.mkdirSync(bronzeDir, { recursive: true });

    const lines = [
      bronzeLine({}),
      bronzeLine({ sourceUrl: 'https://www.chewy.com/dp/102535', title: 'Fancy Feast Wet Cat Food Pate' }),
      // duplicate locator (same URL as line 0)
      bronzeLine({}),
      // category/interstitial page
      bronzeLine({ sourceUrl: 'https://www.chewy.com/b/dry-food', title: 'Technical Page', rawBreadcrumb: ['Shop All'] }),
      // invalid GTIN
      bronzeLine({ sourceUrl: 'https://www.chewy.com/dp/102536', title: 'Good Product', gtin: '0840243105626' }),
      // invalid JSON
      '{not json',
    ];
    fs.writeFileSync(path.join(bronzeDir, 'evidence-1.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const outputDir = path.join(root, 'datasets');
    const summary = rebuildOfflineCorpus({
      bronzeDir: bronzeRoot,
      outputDir,
      weakRules: new WeakLabelRules(ACTIVE_CONFIG),
    });

    expect(summary.bronzeTotal).toBe(6);
    expect(summary.bronzeAccepted + summary.bronzeRejected + summary.bronzeDuplicates).toBe(6);
    expect(summary.bronzeAccepted).toBe(2); // two unique valid product pages
    expect(summary.bronzeDuplicates).toBe(1);
    expect(summary.bronzeRejected).toBe(3); // category + bad gtin + invalid json
    expect(summary.silverRecords).toBe(2);
  });

  it('preserves every Bronze observation in normalized Bronze with validation state', () => {
    const root = makeTempDir();
    const bronzeRoot = path.join(root, 'training-corpus');
    const bronzeDir = path.join(bronzeRoot, 'chewy.com');
    fs.mkdirSync(bronzeDir, { recursive: true });
    const lines = [
      bronzeLine({}),
      bronzeLine({ sourceUrl: 'https://www.chewy.com/b/dry-food', title: 'Technical Page' }),
      '{bad json',
    ];
    fs.writeFileSync(path.join(bronzeDir, 'evidence-1.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const summary = rebuildOfflineCorpus({
      bronzeDir: bronzeRoot,
      outputDir: path.join(root, 'datasets'),
      weakRules: new WeakLabelRules(ACTIVE_CONFIG),
    });

    const normalized = fs.readFileSync(summary.bronzeFile, 'utf-8').trim().split('\n');
    expect(normalized).toHaveLength(3);
    const states = normalized.map((line) => JSON.parse(line).validationState as string).sort();
    expect(states.filter((s) => s === 'valid')).toHaveLength(1);
    expect(states.filter((s) => s === 'rejected')).toHaveLength(2);
  });

  it('rejects category/interstitial/blocked pages', () => {
    const root = makeTempDir();
    const bronzeRoot = path.join(root, 'training-corpus');
    const bronzeDir = path.join(bronzeRoot, 'chewy.com');
    fs.mkdirSync(bronzeDir, { recursive: true });
    const lines = [
      bronzeLine({ sourceUrl: 'https://www.chewy.com/b/dry-food', title: 'Technical Page' }),
      bronzeLine({ sourceUrl: 'https://www.chewy.com/app/c/pet-supplies', title: 'Shop All Pet Supplies' }),
      bronzeLine({ sourceUrl: 'https://www.chewy.com/learn/dog-food', title: 'Learn About Dog Food' }),
      bronzeLine({ sourceUrl: 'https://www.chewy.com/cart', title: 'Cart' }),
      bronzeLine({ sourceUrl: 'https://bonide.com/product-category/lawn-care/', title: 'Lawn Care Products' }),
      bronzeLine({ sourceUrl: 'https://www.chewy.com/collections/dog-toys', title: 'Dog Toy Collection' }),
      bronzeLine({}),
    ];
    fs.writeFileSync(path.join(bronzeDir, 'evidence-1.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const summary = rebuildOfflineCorpus({
      bronzeDir: bronzeRoot,
      outputDir: path.join(root, 'datasets'),
      weakRules: new WeakLabelRules(ACTIVE_CONFIG),
    });

    expect(summary.bronzeAccepted).toBe(1);
    expect(summary.bronzeRejected).toBe(6);
  });

  it('produces byte-identical output across repeated regeneration', () => {
    const root = makeTempDir();
    const bronzeRoot = path.join(root, 'training-corpus');
    const bronzeDir = path.join(bronzeRoot, 'chewy.com');
    fs.mkdirSync(bronzeDir, { recursive: true });
    const lines = [
      bronzeLine({}),
      bronzeLine({ sourceUrl: 'https://www.chewy.com/dp/102535', title: 'Fancy Feast Wet Cat Food Pate' }),
      bronzeLine({ sourceUrl: 'https://www.scotts.com/en-us/shop/grass-seed/', title: 'Scotts Turf Builder Grass Seed', retailer: 'scotts.com' }),
    ];
    fs.writeFileSync(path.join(bronzeDir, 'evidence-1.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const outputDirA = path.join(root, 'datasets-a');
    const summaryA = rebuildOfflineCorpus({
      bronzeDir: bronzeRoot,
      outputDir: outputDirA,
      weakRules: new WeakLabelRules(ACTIVE_CONFIG),
    });

    const outputDirB = path.join(root, 'datasets-b');
    const summaryB = rebuildOfflineCorpus({
      bronzeDir: bronzeRoot,
      outputDir: outputDirB,
      weakRules: new WeakLabelRules(ACTIVE_CONFIG),
    });

    const silverA = fs.readFileSync(summaryA.silverFile, 'utf-8');
    const silverB = fs.readFileSync(summaryB.silverFile, 'utf-8');
    expect(silverA).toBe(silverB);
    expect(path.basename(summaryA.silverFile)).toBe(path.basename(summaryB.silverFile));

    const bronzeA = fs.readFileSync(summaryA.bronzeFile, 'utf-8');
    const bronzeB = fs.readFileSync(summaryB.bronzeFile, 'utf-8');
    expect(bronzeA).toBe(bronzeB);

    expect(summaryA.bronzeManifestDigest).toBe(summaryB.bronzeManifestDigest);
    expect(summaryA.silverManifestDigest).toBe(summaryB.silverManifestDigest);
  });

  it('audits every legacy silver-v1 row as accepted/rejected/duplicate', () => {
    const root = makeTempDir();
    const bronzeRoot = path.join(root, 'training-corpus');
    const bronzeDir = path.join(bronzeRoot, 'chewy.com');
    fs.mkdirSync(bronzeDir, { recursive: true });
    const lines = [
      bronzeLine({}),
      bronzeLine({ sourceUrl: 'https://www.chewy.com/b/dry-food', title: 'Technical Page' }),
    ];
    fs.writeFileSync(path.join(bronzeDir, 'evidence-1.jsonl'), lines.join('\n') + '\n', 'utf-8');

    // Legacy silver-v1 mirroring the same source URLs (as the real dataset does).
    const silverDir = path.join(root, 'datasets', 'silver');
    fs.mkdirSync(silverDir, { recursive: true });
    const legacy = [
      { id: 'legacy-1', sourceProductId: 'x', source: 'chewy.com', sourceUrl: 'https://www.chewy.com/dp/102534', input: { title: 'Blue Buffalo' } },
      { id: 'legacy-2', sourceProductId: 'y', source: 'chewy.com', sourceUrl: 'https://www.chewy.com/b/dry-food', input: { title: 'Technical Page' } },
    ];
    fs.writeFileSync(path.join(silverDir, 'silver-v1.jsonl'), legacy.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

    const summary = rebuildOfflineCorpus({
      bronzeDir: bronzeRoot,
      outputDir: path.join(root, 'datasets'),
      weakRules: new WeakLabelRules(ACTIVE_CONFIG),
      legacySilverFile: path.join(silverDir, 'silver-v1.jsonl'),
    });

    expect(summary.legacyRowsAudited).toBe(2);
    const audit = fs
      .readFileSync(summary.auditFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(audit).toHaveLength(2);
    expect(audit.find((entry) => entry.sourceUrl.includes('/dp/102534'))?.disposition).toBe('accepted');
    expect(audit.find((entry) => entry.sourceUrl.includes('/b/dry-food'))?.disposition).toBe('rejected');
  });

  it('silver v2 records carry provenance and abstain where evidence is insufficient', () => {
    const root = makeTempDir();
    const bronzeRoot = path.join(root, 'training-corpus');
    const bronzeDir = path.join(bronzeRoot, 'chewy.com');
    fs.mkdirSync(bronzeDir, { recursive: true });
    const lines = [
      bronzeLine({}),
      // Ambiguous title with no species/form evidence → abstains on type + attributes.
      bronzeLine({ sourceUrl: 'https://www.chewy.com/dp/102540', title: 'Deluxe Pet Accessory Kit', rawBreadcrumb: [] }),
    ];
    fs.writeFileSync(path.join(bronzeDir, 'evidence-1.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const summary = rebuildOfflineCorpus({
      bronzeDir: bronzeRoot,
      outputDir: path.join(root, 'datasets'),
      weakRules: new WeakLabelRules(ACTIVE_CONFIG),
    });

    const records = fs.readFileSync(summary.silverFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(records).toHaveLength(2);

    const dogRecord = records.find((r) => r.input.title.includes('Blue Buffalo'));
    expect(dogRecord.silverPredictions.candidateProductType.id).toBe('dog-food-dry');
    expect(dogRecord.silverPredictions.species).toBeUndefined();
    expect(dogRecord.provenance.acquisitionMode).toBe('browser_parse');
    expect(dogRecord.provenance.weakRuleVersion).toBe('2.0');

    const ambiguous = records.find((r) => r.input.title.includes('Accessory Kit'));
    expect(ambiguous.silverPredictions.candidateProductType).toBeUndefined();
    expect(ambiguous.silverPredictions.abstentions).toContain('product_type');

    // Never guessed pages; never Product Type → ProductField24/25.
    for (const record of records) {
      expect(record.silverPredictions.proposedCategoryPages).toEqual([]);
      expect(record.silverPredictions.shopsiteFields).toEqual({});
    }
  });

  it('writes content-addressed manifests and rejects duplicate locator collisions', () => {
    const root = makeTempDir();
    const bronzeRoot = path.join(root, 'training-corpus');
    const bronzeDir = path.join(bronzeRoot, 'chewy.com');
    fs.mkdirSync(bronzeDir, { recursive: true });
    // Two distinct URLs, one duplicate → 2 unique entities.
    const lines = [
      bronzeLine({}),
      bronzeLine({ sourceUrl: 'https://www.chewy.com/dp/102535', title: 'Second Product' }),
      bronzeLine({}), // duplicate
    ];
    fs.writeFileSync(path.join(bronzeDir, 'evidence-1.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const outputDir = path.join(root, 'datasets');
    const summary = rebuildOfflineCorpus({
      bronzeDir: bronzeRoot,
      outputDir,
      weakRules: new WeakLabelRules(ACTIVE_CONFIG),
    });

    expect(summary.bronzeDuplicates).toBe(1);
    expect(summary.silverRecords).toBe(2);

    // Manifests exist and their digests round-trip.
    const silverManifestPath = path.join(outputDir, 'silver', `manifest-${summary.silverManifestDigest}.json`);
    expect(fs.existsSync(silverManifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(silverManifestPath, 'utf-8'));
    expect(computeManifestDigest(manifest)).toBe(summary.silverManifestDigest);
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.files.every((f: { name: string }) => typeof f.name === 'string' && !path.isAbsolute(f.name))).toBe(true);
  });
});
