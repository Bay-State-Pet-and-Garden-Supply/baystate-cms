/**
 * Cross-sibling consistency validator for curation pipeline.
 *
 * Compares classification proposals across batch siblings in the same
 * product-line group and returns divergence warnings. Read-only — does
 * NOT modify any proposals or DB state.
 *
 * Call this AFTER all items in a batch have completed curation.
 * The goal is to surface inconsistencies for human review, not to
 * auto-correct them.
 */
import { getDb } from '../db/connection';
import { normalizeBrand, extractNameStem } from '../onboarding/product-line-grouper';
import { getCohortCurationFlags } from './flags';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SiblingPageProposal {
  sku: string;
  pages: string[];
}

export interface DivergenceWarning {
  groupId: string;
  groupLabel: string;
  field: 'category_page' | 'primary_product_type' | 'curated_title';
  values: Record<string, string[]>;
  message: string;
}

/** PR9 C3 (issue #30, DECISION-C): the active-cohort semantic surface payload. */
export interface CohortSemanticFindingsPayload {
  status: 'passed' | 'blocked';
  findings: Array<{ code: string; memberSku: string; message: string }>;
}

/**
 * PR9 C3 (issue #30, DECISION-C): the item's ACTIVE-cohort semantic findings,
 * or null when the item is NOT an active-cohort member. Active cohort mode is
 * flag ON + !shadowOnly AND the item's active run is a cohort child — only
 * then do the SSE/routes surfaces surface the NEW validator's findings instead
 * of the legacy `validateSiblingConsistency` warnings. Legacy/shadow items
 * (and flag OFF) keep the legacy surface byte-identical.
 */
export function activeCohortSemanticFindingsForItem(item: {
  curationData?: { classificationRunId?: string | null; semanticValidation?: unknown } | null;
}): CohortSemanticFindingsPayload | null {
  const flags = getCohortCurationFlags();
  if (!(flags.cohortCurationV2Enabled && !flags.cohortShadowOnly)) return null;
  const runId = item.curationData?.classificationRunId;
  if (!runId) return null;
  const cohortChild = getDb().query(
    'SELECT 1 FROM classification_runs WHERE id = ? AND cohort_run_id IS NOT NULL LIMIT 1',
  ).get(runId);
  if (!cohortChild) return null;

  const semanticValidation = item.curationData?.semanticValidation;
  if (!semanticValidation || typeof semanticValidation !== 'object') return null;
  const status = (semanticValidation as { status?: unknown }).status;
  if (status !== 'passed' && status !== 'blocked') return null;
  const findings = (semanticValidation as { findings?: unknown }).findings;
  return {
    status,
    findings: Array.isArray(findings)
      ? findings
          .filter(finding => finding && typeof finding === 'object')
          .map(finding => ({
            code: String((finding as { code?: unknown }).code ?? ''),
            memberSku: String((finding as { memberSku?: unknown }).memberSku ?? ''),
            message: String((finding as { message?: unknown }).message ?? ''),
          }))
      : [],
  };
}

// ─── Validator ─────────────────────────────────────────────────────────────────

/**
 * Compare proposals across batch siblings and return divergence warnings.
 *
 * Groups items using the same deterministic algorithm as the product-line
 * grouper (normalizeBrand + extractNameStem). For each multi-item group,
 * checks whether siblings received consistent category page proposals,
 * product type proposals, and curation titles.
 *
 * @param batchId - The onboarding batch to validate
 * @returns Array of divergence warnings (empty if all siblings are consistent)
 */
export function validateSiblingConsistency(batchId: string): DivergenceWarning[] {
  const db = getDb();
  const warnings: DivergenceWarning[] = [];

  const parseCurationData = (raw: unknown): Record<string, unknown> | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };

  // 1. Get all items in the batch with curation data
  const items = db.query(
    `SELECT upc, name, brand_hint, curation_data_json
     FROM onboarding_items
     WHERE batch_id = ? AND curation_data_json IS NOT NULL`,
  ).all(batchId) as Record<string, any>[];

  if (items.length < 2) return warnings;

  // 2. Group by product line using the same deterministic algorithm
  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const brand = normalizeBrand(item.brand_hint);
    const stem = extractNameStem(item.name || '');
    if (!stem) continue;
    const key = `${brand}|${stem}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  // 3. For each group with >1 sibling, check consistency
  for (const [groupId, groupItems] of groups) {
    if (groupItems.length < 2) continue;

    const groupLabel = (groupItems[0].name || 'Unknown').slice(0, 80);

    // 3a. Check page assignment consistency
    const pageSets = groupItems.map(i => {
      const cd = parseCurationData(i.curation_data_json);
      return {
        sku: String(i.upc),
        pages: Array.isArray(cd?.suggestedPages)
          ? cd.suggestedPages.map(String).sort()
          : [],
      };
    });

    const allPageSets = pageSets.map(p => p.pages.join('|'));
    const uniquePageSets = new Set(allPageSets);
    if (uniquePageSets.size > 1) {
      warnings.push({
        groupId,
        groupLabel,
        field: 'category_page',
        values: Object.fromEntries(pageSets.map(p => [p.sku, p.pages])),
        message:
          `Siblings in group "${groupLabel}" have different page assignments. ` +
          `${uniquePageSets.size} distinct page sets across ${groupItems.length} items.`,
      });
    }

    // 3b. Check product type consistency
    const productTypes = groupItems.map(i => {
      const cd = parseCurationData(i.curation_data_json);
      return {
        sku: String(i.upc),
        ptype: typeof cd?.suggestedProductType === 'string'
          ? cd.suggestedProductType
          : '',
      };
    });

    // Missing on one sibling but present on another is also divergence.
    const uniquePtypes = new Set(productTypes.map(p => p.ptype || '<none>'));
    if (uniquePtypes.size > 1) {
      warnings.push({
        groupId,
        groupLabel,
        field: 'primary_product_type',
        values: Object.fromEntries(productTypes.map(t => [t.sku, [t.ptype || 'none']])),
        message:
          `Siblings in group "${groupLabel}" have different product types: ` +
          `${[...uniquePtypes].join(', ')}.`,
      });
    }

    // 3c. Check curated title consistency
    // Derive a normalised title skeleton by removing known size/flavor/color
    // variant tokens. If skeletons differ, siblings have structurally different titles.
    const curatedTitles = groupItems.map(i => {
      const cd = parseCurationData(i.curation_data_json);
      const title = typeof cd?.curatedTitle === 'string' ? cd.curatedTitle : '';
      // Reuse the product-line normalizer so title validation and grouping
      // agree on flavor, color, count, and size variants.
      const skeleton = extractNameStem(title);
      return { sku: String(i.upc), title, skeleton };
    });

    const uniqueSkeletons = new Set(curatedTitles.map(t => t.skeleton).filter(Boolean));
    if (uniqueSkeletons.size > 1) {
      warnings.push({
        groupId,
        groupLabel,
        field: 'curated_title',
        values: Object.fromEntries(curatedTitles.map(t => [t.sku, [t.title]])),
        message:
          `Siblings in group "${groupLabel}" have structurally different title skeletons. ` +
          `${uniqueSkeletons.size} distinct skeletons across ${curatedTitles.length} items.`,
      });
    }
  }

  return warnings;
}
