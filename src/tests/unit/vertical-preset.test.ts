import { describe, it, expect } from 'vitest';
import { PET_AND_GARDEN_PRESET } from '../../classification/presets/preset-pet-and-garden';

describe('Vertical Presets', () => {
  it('should provide a valid pet & garden guidance preset', () => {
    expect(PET_AND_GARDEN_PRESET).toBeDefined();
    expect(PET_AND_GARDEN_PRESET.length).toBeGreaterThanOrEqual(3);

    const speciesRule = PET_AND_GARDEN_PRESET.find(p => p.id === 'species-safety-guidance');
    expect(speciesRule).toBeDefined();
    expect(speciesRule?.structured?.ruleType).toBe('species_safety');

    const pageRule = PET_AND_GARDEN_PRESET.find(p => p.id === 'page-assignment-guidance');
    expect(pageRule).toBeDefined();
    expect(pageRule?.structured?.ruleType).toBe('page_assignment_rules');

    const keywordRule = PET_AND_GARDEN_PRESET.find(p => p.id === 'domain-keywords-guidance');
    expect(keywordRule).toBeDefined();
    expect(keywordRule?.structured?.ruleType).toBe('domain_keywords');
  });
});
