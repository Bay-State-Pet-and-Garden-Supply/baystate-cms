// story: e05s01
import type { ClassificationEvidence } from '../shared/schemas/classification';

/**
 * e05s01: species-guard with provenance — pure helper.
 * Returns validated list plus dropped entries carrying species_incompatible
 * reason and matched term for review UI. Hard guard never changes.
 */
export function validatePageAssignmentsWithProvenance(
  proposedPages: string[],
  allEvidence: ClassificationEvidence[],
): { validated: string[]; dropped: Array<{ pageName: string; species: string; reason: string; matchedTerm?: string }> } {
  const speciesEntries = allEvidence.filter(
    e => e.source === 'visual_product_evidence' && e.sourceField === 'species',
  );
  const species = speciesEntries
    .map(e => (typeof e.value === 'string' ? e.value.toLowerCase() : ''))
    .filter(Boolean);

  if (species.length === 0) return { validated: proposedPages, dropped: [] };

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
  if (incompatibleTerms.length === 0) return { validated: proposedPages, dropped: [] };

  const dropped: Array<{ pageName: string; species: string; reason: string; matchedTerm?: string }> = [];
  const validated = proposedPages.filter(pageName => {
    const nameLower = pageName.toLowerCase();
    const matched = incompatibleTerms.find(term => nameLower.includes(term));
    const isCompatible = !matched;
    if (!isCompatible) {
      dropped.push({ pageName, species: primarySpecies, reason: 'species_incompatible', matchedTerm: matched });
      console.warn(`[SpeciesGuard] Dropping cross-species page assignment: "${pageName}" for species "${primarySpecies}"`);
    }
    return isCompatible;
  });
  return { validated, dropped };
}

export function validatePageAssignmentsBySpecies(
  proposedPages: string[],
  allEvidence: ClassificationEvidence[],
): string[] {
  return validatePageAssignmentsWithProvenance(proposedPages, allEvidence).validated;
}
