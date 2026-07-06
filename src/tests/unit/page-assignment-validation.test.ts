/**
 * Unit tests for species-based page validation and page identity validation.
 *
 * The `validatePageAssignmentsBySpecies` function is private in
 * `product-curator.ts`. This test re-implements the same algorithm
 * inline to verify the validation logic independently.
 */
import { describe, it, expect } from 'vitest';

// ─── Logic under test (mirrors product-curator.ts) ───────────────────────────

interface EvidenceStub {
  source: string;
  sourceField: string;
  value: string;
}

/** Re-implements the private validatePageAssignmentsBySpecies from product-curator.ts */
function validatePageAssignmentsBySpecies(
  proposedPages: string[],
  evidence: EvidenceStub[],
): string[] {
  const speciesEntries = evidence.filter(
    e => e.source === 'visual_product_evidence' && e.sourceField === 'species',
  );
  const species = speciesEntries
    .map(e => e.value.toLowerCase())
    .filter(Boolean);

  if (species.length === 0) return proposedPages;

  const primarySpecies = species[0];

  const speciesIncompatible: Record<string, string[]> = {
    dog: ['cat', 'fish', 'bird', 'small animal', 'small pet', 'reptile', 'caged bird', 'wild bird', 'wildlife'],
    cat: ['dog', 'fish', 'bird', 'small animal', 'small pet', 'reptile', 'caged bird', 'wild bird', 'wildlife'],
    fish: ['dog', 'cat', 'bird', 'small animal', 'small pet', 'reptile', 'caged bird', 'farm animal', 'horse', 'wildlife'],
    bird: ['dog', 'cat', 'fish', 'reptile', 'farm animal', 'horse'],
    reptile: ['dog', 'cat', 'bird', 'farm animal', 'horse'],
    horse: ['dog', 'cat', 'fish', 'bird', 'small pet', 'reptile'],
  };

  const incompatibleTerms = speciesIncompatible[primarySpecies] ?? [];
  if (incompatibleTerms.length === 0) return proposedPages;

  return proposedPages.filter(pageName => {
    const nameLower = pageName.toLowerCase();
    return !incompatibleTerms.some(term => nameLower.includes(term));
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validatePageAssignmentsBySpecies', () => {
  it('drops cross-species pages: Dog product should not get Cat Food', () => {
    const pages = ['Dog Food Shop All', 'Cat Food Shop All', 'Dog Treats'];
    const evidence = [
      { source: 'visual_product_evidence', sourceField: 'species', value: 'Dog' },
    ];

    const result = validatePageAssignmentsBySpecies(pages, evidence);

    expect(result).toEqual(['Dog Food Shop All', 'Dog Treats']);
    expect(result).not.toContain('Cat Food Shop All');
  });

  it('drops cross-species pages: Cat product should not get Dog Food', () => {
    const pages = ['Cat Food Shop All', 'Cat Treats', 'Dog Food Dry'];
    const evidence = [
      { source: 'visual_product_evidence', sourceField: 'species', value: 'Cat' },
    ];

    const result = validatePageAssignmentsBySpecies(pages, evidence);
    expect(result).toEqual(['Cat Food Shop All', 'Cat Treats']);
    expect(result).not.toContain('Dog Food Dry');
  });

  it('keeps same-species pages: Dog product should keep Dog Food', () => {
    const pages = ['Dog Food Dry', 'Dog Food Wet', 'Dog Treats'];
    const evidence = [
      { source: 'visual_product_evidence', sourceField: 'species', value: 'Dog' },
    ];

    const result = validatePageAssignmentsBySpecies(pages, evidence);
    expect(result).toEqual(['Dog Food Dry', 'Dog Food Wet', 'Dog Treats']);
  });

  it('keeps Dog Beds for a Dog product (same species, fine)', () => {
    const pages = ['Dog Beds', 'Dog Cleanup', 'Dog Treats'];
    const evidence = [
      { source: 'visual_product_evidence', sourceField: 'species', value: 'Dog' },
    ];

    const result = validatePageAssignmentsBySpecies(pages, evidence);
    expect(result).toHaveLength(3);
    expect(result).toContain('Dog Beds');
    expect(result).toContain('Dog Cleanup');
  });

  it('drops cross-species for Fish: Fish product should not get Dog pages', () => {
    const pages = ['Fish Food Shop All', 'Fish Tanks', 'Dog Food Dry', 'Cat Food'];
    const evidence = [
      { source: 'visual_product_evidence', sourceField: 'species', value: 'Fish' },
    ];

    const result = validatePageAssignmentsBySpecies(pages, evidence);
    expect(result).toEqual(['Fish Food Shop All', 'Fish Tanks']);
    expect(result).not.toContain('Dog Food Dry');
    expect(result).not.toContain('Cat Food');
  });

  it('applies no filtering when no species evidence exists', () => {
    const pages = ['Dog Food Dry', 'Cat Food Wet', 'Fish Food'];
    const evidence: EvidenceStub[] = [];

    const result = validatePageAssignmentsBySpecies(pages, evidence);
    expect(result).toEqual(['Dog Food Dry', 'Cat Food Wet', 'Fish Food']);
  });

  it('returns empty array when given empty pages', () => {
    const evidence = [
      { source: 'visual_product_evidence', sourceField: 'species', value: 'Dog' },
    ];

    const result = validatePageAssignmentsBySpecies([], evidence);
    expect(result).toEqual([]);
  });

  it('handles multiple species entries (uses first as primary)', () => {
    const pages = ['Dog Food Dry', 'Cat Food Wet', 'Dog Treats'];
    const evidence: EvidenceStub[] = [
      { source: 'visual_product_evidence', sourceField: 'species', value: 'Dog' },
      { source: 'visual_product_evidence', sourceField: 'species', value: 'dogs' },
    ];

    const result = validatePageAssignmentsBySpecies(pages, evidence);
    // primary species is "Dog" → filters out cat pages
    expect(result).toEqual(['Dog Food Dry', 'Dog Treats']);
    expect(result).not.toContain('Cat Food Wet');
  });

  it('drops cross-species for Bird: Bird product should not get Dog pages', () => {
    const pages = ['Wild Bird Food Shop All', 'Caged Bird Food', 'Dog Toys'];
    const evidence = [
      { source: 'visual_product_evidence', sourceField: 'species', value: 'Bird' },
    ];

    const result = validatePageAssignmentsBySpecies(pages, evidence);
    expect(result).toEqual(['Wild Bird Food Shop All', 'Caged Bird Food']);
    expect(result).not.toContain('Dog Toys');
  });

  it('drops cross-species for Reptile: Reptile product should not get Cat or Dog pages', () => {
    const pages = ['Reptile Food & Treats', 'Reptile Tanks', 'Cat Treats', 'Dog Beds'];
    const evidence = [
      { source: 'visual_product_evidence', sourceField: 'species', value: 'Reptile' },
    ];

    const result = validatePageAssignmentsBySpecies(pages, evidence);
    expect(result).toEqual(['Reptile Food & Treats', 'Reptile Tanks']);
    expect(result).not.toContain('Cat Treats');
    expect(result).not.toContain('Dog Beds');
  });

  it('drops cross-species for Horse: Horse product should not get Dog or Small Pet pages', () => {
    const pages = ['Horse Feed', 'Horse Treats', 'Dog Food', 'Small Pet Food'];
    const evidence = [
      { source: 'visual_product_evidence', sourceField: 'species', value: 'Horse' },
    ];

    const result = validatePageAssignmentsBySpecies(pages, evidence);
    expect(result).toEqual(['Horse Feed', 'Horse Treats']);
    expect(result).not.toContain('Dog Food');
    expect(result).not.toContain('Small Pet Food');
  });
});
