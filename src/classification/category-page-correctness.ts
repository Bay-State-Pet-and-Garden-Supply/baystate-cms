/**
 * Category Page Correctness — pure validator (e09 B2, P1-P12).
 *
 * No I/O, DB, embeddings, retrieval. Confidence is non-authoritative (P8) —
 * never read.
 */

export const CATEGORY_PAGE_CORRECTNESS_VERSION = 'v1';

export type PageCorrectnessInput = {
  member: {
    onboardingItemId: string;
    frozenEvidenceHash: string;
    frozenEvidence: {
      species?: string[];
      productType?: string | null;
      form?: string | null;
      title?: string | null;
      description?: string | null;
      extraction?: { title?: string | null; description?: string | null; productForm?: string | null };
      brand?: string | null;
    };
    frozenProductTypeContext?: string | null;
  };
  candidate: {
    primaryPageId: string | null;
    secondaryPageIds: string[];
    primaryPageName?: string | null;
  };
  /** Frozen verified catalog — only IDs here are authoritative (P2). */
  verifiedPageCatalog: Array<{
    id: string;
    name: string;
    parentId: string | null;
    species?: string | null;
    categoryType?: string | null;
  }>;
  activePageImportHash: string;
  /** Optional frozen-snapshot expectation: when provided and mismatched with
   *  activePageImportHash the member is blocked as stale (P2/P11 defense-in-depth).
   *  Absent/null = skip here; the promotion gate remains the P11 enforcement point. */
  expectedActivePageImportHash?: string | null;
};

export type PageCorrectnessResult = {
  outcome: 'assigned' | 'needs_input' | 'blocked';
  valid: boolean;
  reason?: string;
};

function normalizeLower(value: string): string {
  return value.trim().toLowerCase();
}

function findPage(catalog: PageCorrectnessInput['verifiedPageCatalog'], id: string) {
  return catalog.find(p => p.id === id) ?? null;
}

function isBrandPageName(name: string): boolean {
  return normalizeLower(name).startsWith('brand -');
}

function speciesTokens(evidenceSpecies: string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const s of evidenceSpecies ?? []) {
    const v = normalizeLower(s);
    if (v.includes('dog')) out.add('dog');
    if (v.includes('cat')) out.add('cat');
    if (v.includes('bird')) out.add('bird');
    if (v.includes('fish')) out.add('fish');
    if (v.includes('reptile')) out.add('reptile');
    if (v.includes('small animal') || v.includes('small pet')) out.add('small animal');
    if (v.includes('horse')) out.add('horse');
  }
  return out;
}

function pageSpeciesTokens(page: { name: string; species?: string | null; categoryType?: string | null }): Set<string> {
  const name = normalizeLower(page.name);
  const cat = normalizeLower(page.categoryType ?? '');
  const combined = `${name} ${cat}`;
  const out = new Set<string>();
  if (/\bdog\b/.test(combined)) out.add('dog');
  if (/\bcat\b/.test(combined)) out.add('cat');
  if (/\bbird\b/.test(combined)) out.add('bird');
  if (/\bfish\b/.test(combined)) out.add('fish');
  if (/\breptile\b/.test(combined)) out.add('reptile');
  if (/\bsmall animal\b/.test(combined) || /\bsmall pet\b/.test(combined)) out.add('small animal');
  if (/\bhorse\b/.test(combined)) out.add('horse');
  if (page.species) {
    const s = normalizeLower(page.species);
    if (s.includes('dog')) out.add('dog');
    if (s.includes('cat')) out.add('cat');
    if (s.includes('bird')) out.add('bird');
    if (s.includes('fish')) out.add('fish');
  }
  return out;
}

function pageCategoryTokens(page: { name: string; categoryType?: string | null }): Set<string> {
  const name = normalizeLower(page.name);
  const cat = normalizeLower(page.categoryType ?? '');
  const combined = `${name} ${cat}`;
  const out = new Set<string>();
  // food vs treat vs toy vs supply vs accessory/refill, wet vs dry
  if (combined.includes('food')) out.add('food');
  if (combined.includes('treat')) out.add('treat');
  if (combined.includes('toy')) out.add('toy');
  if (combined.includes('supply') || combined.includes('supplies')) out.add('supply');
  if (combined.includes('accessory') || combined.includes('refill')) out.add('accessory');
  if (combined.includes('wet')) out.add('wet');
  if (combined.includes('dry')) out.add('dry');
  if (combined.includes('jerky')) out.add('jerky');
  if (combined.includes('chew') || combined.includes('bully') || combined.includes('bone')) out.add('chew');
  // life-stage / form hints
  if (combined.includes('puppy')) out.add('puppy');
  if (combined.includes('kitten')) out.add('kitten');
  return out;
}

function evidenceCategoryTokens(
  evidence: PageCorrectnessInput['member']['frozenEvidence'],
  productTypeContext?: string | null,
): Set<string> {
  const parts = [
    evidence.title ?? '',
    evidence.description ?? '',
    evidence.productType ?? '',
    evidence.form ?? '',
    evidence.extraction?.title ?? '',
    evidence.extraction?.description ?? '',
    evidence.extraction?.productForm ?? '',
    // Frozen Execution Product Type context is member-owned frozen input (P4) — merged into
    // the token basis so type-level distinctions (e.g. "Dry Dog Food") participate.
    productTypeContext ?? '',
  ]
    .join(' ')
    .toLowerCase();
  const out = new Set<string>();
  if (parts.includes('treat')) out.add('treat');
  if (parts.includes('food')) out.add('food');
  if (parts.includes('toy')) out.add('toy');
  if (parts.includes('supply')) out.add('supply');
  // wet/dry signal
  if (/\bwet\b/.test(parts)) out.add('wet');
  if (/\bdry\b/.test(parts)) out.add('dry');
  // chew/jerky
  if (parts.includes('chew') || parts.includes('bully') || parts.includes('bone')) out.add('chew');
  if (parts.includes('jerky')) out.add('jerky');
  return out;
}

/**
 * Validate one member's candidate Page assignment against frozen correctness rules.
 * Pure, deterministic. Confidence never read (P8).
 */
export function validateCategoryPageAssignment(input: PageCorrectnessInput): PageCorrectnessResult {
  const { candidate, verifiedPageCatalog, member } = input;

  // P1 — verified frozen catalog only
  if (!verifiedPageCatalog || verifiedPageCatalog.length === 0) {
    return { outcome: 'blocked', valid: false, reason: 'No verified frozen Page catalog available (P1).' };
  }

  // Stale-import defense-in-depth: member froze against a different verified Page import.
  if (
    input.expectedActivePageImportHash != null &&
    input.expectedActivePageImportHash !== '' &&
    input.activePageImportHash !== input.expectedActivePageImportHash
  ) {
    return {
      outcome: 'blocked',
      valid: false,
      reason: `Stale Page import — member froze against "${input.expectedActivePageImportHash}" but validated against "${input.activePageImportHash}" (P2/P11).`,
    };
  }

  if (!candidate.primaryPageId) {
    return { outcome: 'needs_input', valid: false, reason: 'Missing primary Page — needs manual selection (P3/P10).' };
  }

  // P2 — stable identity
  const primaryPage = findPage(verifiedPageCatalog, candidate.primaryPageId);
  if (!primaryPage) {
    return { outcome: 'blocked', valid: false, reason: `Unknown primary Page ID "${candidate.primaryPageId}" — not in frozen verified catalog (P2).` };
  }

  if (candidate.primaryPageName && normalizeLower(candidate.primaryPageName) !== normalizeLower(primaryPage.name)) {
    return {
      outcome: 'blocked',
      valid: false,
      reason: `Mismatched ID/name pair for Page "${candidate.primaryPageId}" — expected "${primaryPage.name}" got "${candidate.primaryPageName}" (P2).`,
    };
  }

  // P7 — brand page cannot be primary (canonical brand not re-resolved here; name prefix is the gate,
  // full canonical check happens in B3 review gate — see task note)
  if (isBrandPageName(primaryPage.name)) {
    return {
      outcome: 'needs_input',
      valid: false,
      reason: `Brand landing page "${primaryPage.name}" cannot serve as primary category — optional secondary only (P7).`,
    };
  }

  // Validate secondaries are known if provided (unknown secondary is not a primary block, but stale)
  for (const sid of candidate.secondaryPageIds ?? []) {
    const sp = findPage(verifiedPageCatalog, sid);
    if (!sp) {
      // Stale/unknown secondary — treat as blocked for defense in depth? Keep per-member needs_input
      return { outcome: 'needs_input', valid: false, reason: `Secondary Page ID "${sid}" not in frozen verified catalog (P2).` };
    }
    // Brand secondary is allowed; non-brand secondary must not masquerade as primary (P3)
    // — no additional check needed beyond primary correctness.
  }

  // P3 — dual-species co-primary guard: up to 2 primaries (one per species) only when frozen evidence
  // explicitly proves dual use (both species tokens present). Our input carries single primary + secondaries;
  // we enforce that a second species Page in secondaries is only allowed as co-primary when evidence is dual.
  const evidenceSpecies = speciesTokens(member.frozenEvidence.species);
  const hasDogCatBoth = evidenceSpecies.has('dog') && evidenceSpecies.has('cat');
  // If secondaries contain a cross-species Page while evidence is single-species, flag as needs_input (leakage)
  // This keeps single-primary validity for single-species members.
  if (!hasDogCatBoth && (candidate.secondaryPageIds ?? []).length > 0) {
    const primarySpecies = pageSpeciesTokens(primaryPage);
    for (const sid of candidate.secondaryPageIds) {
      const sp = findPage(verifiedPageCatalog, sid);
      if (!sp) continue;
      // If primary is dog and secondary is cat (or vice versa) without dual evidence → needs_input
      const spSpecies = pageSpeciesTokens(sp);
      for (const s of spSpecies) {
        if ((s === 'cat' && primarySpecies.has('dog')) || (s === 'dog' && primarySpecies.has('cat'))) {
          return {
            outcome: 'needs_input',
            valid: false,
            reason: `Cross-species secondary "${sp.name}" without evidenced dual use (P3 guard).`,
          };
        }
      }
    }
  }

  // P5 — semantic compatibility: species + food/treat/toy/supply + wet/dry + product vs accessory
  const evTokens = evidenceCategoryTokens(member.frozenEvidence, member.frozenProductTypeContext);
  const evSpecies = evidenceSpecies;

  // Species contradiction: evidence species exists and page species is disjoint and not dual
  const primarySpeciesSet = pageSpeciesTokens(primaryPage);
  if (evSpecies.size > 0 && primarySpeciesSet.size > 0) {
    // Evidence says dog, page says cat-only → needs_input. Evidence says dog+cat (dual) passes either.
    const speciesIntersect = [...evSpecies].some(s => primarySpeciesSet.has(s));
    if (!speciesIntersect) {
      // Allow generic pages without species token to pass (e.g., "Shop All" without dog/cat)
      // But P3/P5 require explicit contradiction → only fail when page is explicitly the other species
      return {
        outcome: 'needs_input',
        valid: false,
        reason: `Species mismatch — evidence species [${[...evSpecies].join(',')}] vs page "${primaryPage.name}" [${[...primarySpeciesSet].join(',')}] (P5).`,
      };
    }
  }

  // Food vs treat vs toy vs supply: if evidence strongly indicates one and page is exclusively another
  const pageTokens = pageCategoryTokens(primaryPage);
  // Only enforce when evidence has chew/jerky distinction and page is opposing
  if (evTokens.has('chew') && pageTokens.has('jerky') && !pageTokens.has('chew')) {
    return { outcome: 'needs_input', valid: false, reason: `Product is chew-type but page is jerky-only "${primaryPage.name}" (P5).` };
  }
  if (evTokens.has('jerky') && pageTokens.has('chew') && !pageTokens.has('jerky')) {
    return { outcome: 'needs_input', valid: false, reason: `Product is jerky-type but page is chew-only "${primaryPage.name}" (P5).` };
  }
  if (evTokens.has('toy') && (pageTokens.has('treat') || pageTokens.has('food')) && !pageTokens.has('toy')) {
    return { outcome: 'needs_input', valid: false, reason: `Product is toy but page is consumable "${primaryPage.name}" (P5).` };
  }
  if ((evTokens.has('treat') || evTokens.has('food')) && pageTokens.has('toy') && !evTokens.has('toy')) {
    return { outcome: 'needs_input', valid: false, reason: `Product is consumable but page is toy "${primaryPage.name}" (P5).` };
  }
  // Food ↔ treat exclusivity (P5): a dry dog FOOD on a treat-only page (or converse) is the
  // same-species wrong-category class this validator exists to reject.
  // Ambiguity contract (P9): evidence containing BOTH members of an exclusive pair (food AND
  // treat) deliberately does NOT fail here — ambiguity resolves at manual review. Phase C tests
  // pin this lenient behavior intentionally.
  if (evTokens.has('food') && !evTokens.has('treat') && pageTokens.has('treat') && !pageTokens.has('food')) {
    return { outcome: 'needs_input', valid: false, reason: `Product is food but page is treat-only "${primaryPage.name}" (P5).` };
  }
  if (evTokens.has('treat') && !evTokens.has('food') && pageTokens.has('food') && !pageTokens.has('treat')) {
    return { outcome: 'needs_input', valid: false, reason: `Product is treat but page is food-only "${primaryPage.name}" (P5).` };
  }
  // Accessory/refill contradiction requires an accessory signal in frozen evidence; no such
  // deterministic signal exists today without inventing taxonomy (P5 stop rule).
  // TODO(e09 Phase C): wire evidence-side accessory/refill detection only if a frozen source provides it.
  // wet vs dry where Page distinguishes
  if (evTokens.has('wet') && pageTokens.has('dry') && !pageTokens.has('wet')) {
    return { outcome: 'needs_input', valid: false, reason: `Wet product vs dry-only page "${primaryPage.name}" (P5).` };
  }
  if (evTokens.has('dry') && pageTokens.has('wet') && !pageTokens.has('dry')) {
    return { outcome: 'needs_input', valid: false, reason: `Dry product vs wet-only page "${primaryPage.name}" (P5).` };
  }

  // P6 — specificity: Shop All ancestor superseded by specific child. If primary is Shop All while a specific child exists in catalog matching product, needs_input.
  const primaryIsShopAll = normalizeLower(primaryPage.name).endsWith('shop all');
  if (primaryIsShopAll) {
    // Cheap heuristic: if any other catalog page is a child-specific page for the same species/category and is not Shop All,
    // treat primary Shop All as too generic → needs_input (child required per P6).
    // A specific child must belong to the same subtree family as the Shop All primary: it must
    // share a category token with the primary's non-"Shop All" core name, or share a species
    // token with the member's own frozen evidence (P4 member-owned). Unrelated catalog pages
    // (e.g. "Cat Food Dry" vs a dog Shop All) do NOT qualify — bare fallback removed (P6 fix).
    const primaryCoreName = normalizeLower(primaryPage.name).replace(/shop[- ]all/g, ' ');
    const primaryCoreCategory = pageCategoryTokens({ name: primaryCoreName, categoryType: primaryPage.categoryType });
    const hasSpecificAlternative = verifiedPageCatalog.some(p => {
      if (p.id === primaryPage.id) return false;
      if (normalizeLower(p.name).endsWith('shop all')) return false;
      if (isBrandPageName(p.name)) return false;
      const altCategory = pageCategoryTokens(p);
      for (const t of altCategory) {
        if (primaryCoreCategory.has(t)) return true;
      }
      if (evSpecies.size > 0) {
        const altSpecies = pageSpeciesTokens(p);
        for (const s of altSpecies) {
          if (evSpecies.has(s)) return true;
        }
      }
      return false;
    });
    if (hasSpecificAlternative) {
      return {
        outcome: 'needs_input',
        valid: false,
        reason: `Primary is generic Shop All "${primaryPage.name}" while a specific child exists in catalog — child required (P6).`,
      };
    }
  }

  // Also: if candidate secondary contains Shop All alongside a specific primary, deduplicate is fine — no block.
  // (normalizePageAssignments already drops Shop All when specific exists.)

  return { outcome: 'assigned', valid: true };
}
