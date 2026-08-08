import { describe, it, expect } from 'vitest';
import {
  extractPageNamesFromPreserved,
  scanProductOnPagesCandidates,
  type PageFragmentSource,
} from '../../shopsite/page-candidate-importer';

const frag = (name: string) => `<Name>${name}</Name>`;

describe('page-candidate-importer — provisional ProductOnPages candidates', () => {
  it('extracts and deduplicates names from unknownElements and advancedBlocks', () => {
    const source: PageFragmentSource = {
      sku: 'SKU-1',
      preserved: {
        unknownElements: {
          ProductOnPages: `${frag('Dog Food')}\n${frag('Dog Food Dry')}`,
        },
        advancedBlocks: {
          ProductOnPages: `${frag('Dog Food')}\n${frag('Treats &amp; Bones')}`,
        },
      },
    };
    const names = extractPageNamesFromPreserved(source.preserved);
    expect(names).toContain('Dog Food');
    expect(names).toContain('Dog Food Dry');
    expect(names).toContain('Treats & Bones');
    expect(names.filter(n => n === 'Dog Food')).toHaveLength(1);
  });

  it('returns empty for products without fragments', () => {
    expect(extractPageNamesFromPreserved(undefined)).toEqual([]);
    expect(extractPageNamesFromPreserved({ unknownElements: {}, advancedBlocks: {} })).toEqual([]);
  });

  it('produces deterministic candidates with counts and sorted sample SKUs', () => {
    const products: PageFragmentSource[] = [
      { sku: 'SKU-B', preserved: { unknownElements: { ProductOnPages: frag('Dog Food') } } },
      { sku: 'SKU-A', preserved: { unknownElements: { ProductOnPages: `${frag('Cat Food')}\n${frag('Dog Food')}` } } },
      { sku: 'SKU-C', preserved: { unknownElements: { ProductOnPages: frag('Dog Food') } } },
    ];
    const scan = scanProductOnPagesCandidates(products);

    expect(scan.schemaVersion).toBe(1);
    expect(scan.candidateCount).toBe(2);
    expect(scan.candidates.map(c => c.pageName)).toEqual(['Cat Food', 'Dog Food']);

    const dogFood = scan.candidates.find(c => c.pageName === 'Dog Food')!;
    expect(dogFood.productCount).toBe(3);
    expect(dogFood.sampleSkus).toEqual(['SKU-A', 'SKU-B', 'SKU-C']);

    const catFood = scan.candidates.find(c => c.pageName === 'Cat Food')!;
    expect(catFood.productCount).toBe(1);
    expect(catFood.sampleSkus).toEqual(['SKU-A']);
  });

  it('caps sample SKUs deterministically at 10 and sorts them', () => {
    const skus = Array.from({ length: 25 }, (_, i) => `SKU-${String(1000 - i)}`);
    const products: PageFragmentSource[] = skus.map(sku => ({
      sku,
      preserved: { unknownElements: { ProductOnPages: frag('Bird Food') } },
    }));
    const scan = scanProductOnPagesCandidates(products);
    const birdFood = scan.candidates.find(c => c.pageName === 'Bird Food')!;
    expect(birdFood.productCount).toBe(25);
    expect(birdFood.sampleSkus).toHaveLength(10);
    expect(birdFood.sampleSkus).toEqual([...birdFood.sampleSkus].sort());
  });

  it('is byte-identical across repeated scans of identical inputs', () => {
    const products: PageFragmentSource[] = [
      { sku: 'SKU-B', preserved: { unknownElements: { ProductOnPages: frag('Dog Food') } } },
      { sku: 'SKU-A', preserved: { unknownElements: { ProductOnPages: `${frag('Cat Food')}\n${frag('Dog Food')}` } } },
    ];
    const first = scanProductOnPagesCandidates(products);
    const second = scanProductOnPagesCandidates(structuredClone(products));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.fragmentSetHash).toBe(second.fragmentSetHash);
  });

  it('fragment set hash is sensitive to fragment content and SKU order', () => {
    const a = scanProductOnPagesCandidates([
      { sku: 'SKU-1', preserved: { unknownElements: { ProductOnPages: frag('Dog Food') } } },
      { sku: 'SKU-2', preserved: { unknownElements: { ProductOnPages: frag('Cat Food') } } },
    ]);
    const b = scanProductOnPagesCandidates([
      { sku: 'SKU-1', preserved: { unknownElements: { ProductOnPages: frag('Dog Food') } } },
      { sku: 'SKU-2', preserved: { unknownElements: { ProductOnPages: frag('Bird Food') } } },
    ]);
    expect(a.fragmentSetHash).not.toBe(b.fragmentSetHash);
  });

  it('is deterministic regardless of input SKU order', () => {
    const base: PageFragmentSource[] = [
      { sku: 'SKU-1', preserved: { unknownElements: { ProductOnPages: frag('Dog Food') } } },
      { sku: 'SKU-2', preserved: { unknownElements: { ProductOnPages: frag('Cat Food') } } },
    ];
    const reversed = [base[1], base[0]];
    expect(scanProductOnPagesCandidates(base).fragmentSetHash)
      .toBe(scanProductOnPagesCandidates(reversed).fragmentSetHash);
  });
});
