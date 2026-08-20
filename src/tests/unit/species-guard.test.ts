// story: e05s01
import { describe, it, expect } from 'vitest';
import { validatePageAssignmentsWithProvenance } from '../../classification/species-guard';

describe('species guard provenance // story: e05s01', () => {
  it('drops cross-species pages with species_incompatible provenance', () => {
    const evidence = [
      { source: 'visual_product_evidence', sourceField: 'species', value: 'Dog', sourceId: 'x', evidenceId: 'y' },
    ] as any;
    const pages = ['Dog Treats Shop All', 'Cat Food Wet', 'Dog Food Dry'];
    const result = validatePageAssignmentsWithProvenance(pages, evidence);
    expect(result.validated).toEqual(['Dog Treats Shop All', 'Dog Food Dry']);
    expect(result.dropped).toEqual([
      expect.objectContaining({ pageName: 'Cat Food Wet', species: 'dog', reason: 'species_incompatible', matchedTerm: 'cat' }),
    ]);
  });

  it('keeps all pages when species is empty', () => {
    const result = validatePageAssignmentsWithProvenance(['Cat Food', 'Dog Food'], []);
    expect(result.validated).toEqual(['Cat Food', 'Dog Food']);
    expect(result.dropped).toEqual([]);
  });

  it('keeps pages when species has no incompatible map entry', () => {
    const evidence = [{ source: 'visual_product_evidence', sourceField: 'species', value: 'Ferret', sourceId: 'x', evidenceId: 'y' }] as any;
    const result = validatePageAssignmentsWithProvenance(['Cat Food'], evidence);
    expect(result.validated).toEqual(['Cat Food']);
    expect(result.dropped).toEqual([]);
  });
});
