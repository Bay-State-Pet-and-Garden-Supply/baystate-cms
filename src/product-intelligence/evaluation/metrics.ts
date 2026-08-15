/**
 * PI-9 evaluation metrics engine (issue #26).
 *
 * Pure module — no zod, no DB. Derives a run outcome taxonomy, normalizes a
 * run's result JSON into a PiPrediction, compares it against golden labels,
 * and aggregates comparisons into rates with Wilson confidence intervals and
 * sample-size warnings. Also re-exported for the extraction benchmark.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import type { PiGoldLabels } from './gold';

// ---------------------------------------------------------------------------
// Outcome taxonomy
// ---------------------------------------------------------------------------

/**
 * Canonical Pi run outcome classes (issue acceptance: distinguish failure,
 * abstention, parent-product-only, wrong variant, not configured, and policy
 * denied).
 */
export type PiOutcome =
  | 'submitted'
  | 'abstained'
  | 'parent_product_only'
  | 'wrong_variant'
  | 'failed'
  | 'policy_denied'
  | 'not_configured'
  | 'cancelled'
  | 'unavailable';

const PI_OUTCOMES: PiOutcome[] = [
  'submitted',
  'abstained',
  'parent_product_only',
  'wrong_variant',
  'failed',
  'policy_denied',
  'not_configured',
  'cancelled',
  'unavailable',
];

export function classifyRunOutcome(
  status: string,
  errorCode: string | null,
  disposition: string | null,
  identityStatus: string | null,
): PiOutcome {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') {
    if (errorCode === 'policy_denied') return 'policy_denied';
    if (errorCode === 'model_unavailable') return 'not_configured';
    return 'failed';
  }
  if (status !== 'completed') return 'failed';
  if (disposition === 'unavailable') return 'unavailable';
  if (disposition === 'abstained') {
    if (identityStatus === 'parent_product_only') return 'parent_product_only';
    if (identityStatus === 'wrong_variant') return 'wrong_variant';
    return 'abstained';
  }
  // A submitted bundle can still declare a parent-only or wrong-variant
  // identity (disposition 'needs_review'); the outcome must reflect it.
  if (identityStatus === 'parent_product_only') return 'parent_product_only';
  if (identityStatus === 'wrong_variant') return 'wrong_variant';
  return 'submitted';
}

// ---------------------------------------------------------------------------
// Prediction normalization
// ---------------------------------------------------------------------------

export interface PiPrediction {
  identityStatus: string | null;
  brand: string | null;
  title: string | null;
  variant: string | null;
  facts: Array<{
    field: string;
    value: string;
    method: string | null;
    sourcePath: string | null;
  }>;
  imageUrl: string | null;
  imageRights: 'approved' | 'restricted' | 'unknown' | null;
  imageCommerceApproved: boolean | null;
  productType: string | null;
  attributes: Array<{ attributeId: string; value: string }>;
  categoryPages: string[];
  conflicts: Array<{ field: string; severity: string }>;
}

function safeParseJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** The server persists the full result envelope with the submission nested. */
function submissionOf(parsed: Record<string, unknown>): Record<string, unknown> {
  const sub = parsed.submission;
  if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
    return sub as Record<string, unknown>;
  }
  return parsed;
}

export function extractPredictionFromResult(
  resultJson: string | null,
): PiPrediction | null {
  const parsed = safeParseJson(resultJson);
  if (!parsed) return null;
  const submission = submissionOf(parsed);

  const empty: PiPrediction = {
    identityStatus: null,
    brand: null,
    title: null,
    variant: null,
    facts: [],
    imageUrl: null,
    imageRights: null,
    imageCommerceApproved: null,
    productType: null,
    attributes: [],
    categoryPages: [],
    conflicts: [],
  };

  // --- PI-4 bundle ---
  const identity = submission.identity as Record<string, unknown> | undefined;
  if (identity && typeof identity === 'object' && 'status' in identity) {
    const bundle: PiPrediction = {
      ...empty,
      identityStatus:
        typeof identity.status === 'string' ? identity.status : null,
      brand: typeof identity.brand === 'string' ? identity.brand : null,
      title:
        typeof identity.canonicalName === 'string'
          ? identity.canonicalName
          : null,
      variant: typeof identity.variant === 'string' ? identity.variant : null,
      productType: null,
    };
    const facts = submission.commerceFacts;
    if (Array.isArray(facts)) {
      for (const f of facts as Array<Record<string, unknown>>) {
        const field = f.field;
        if (typeof field !== 'string') continue;
        const values = Array.isArray(f.values) ? f.values : [];
        bundle.facts.push({
          field,
          value: values.length > 0 ? String(values[0] ?? '') : '',
          method: typeof f.method === 'string' ? f.method : null,
          sourcePath: typeof f.sourcePath === 'string' ? f.sourcePath : null,
        });
      }
    }
    const images = submission.imageCandidates;
    if (Array.isArray(images) && images.length > 0) {
      const img = images[0] as Record<string, unknown>;
      bundle.imageUrl = typeof img.url === 'string' ? img.url : null;
      bundle.imageRights = bundleRightsOf(img.rightsStatus);
      bundle.imageCommerceApproved = img.commerceApproved === true;
    }
    const conflicts = submission.conflicts;
    if (Array.isArray(conflicts)) {
      for (const c of conflicts as Array<Record<string, unknown>>) {
        bundle.conflicts.push({
          field: String(c.field ?? ''),
          severity: String(c.severity ?? ''),
        });
      }
    }
    return bundle;
  }

  // --- PI-1 envelope ---
  const proposal = submission.productProposal as Record<string, unknown> | undefined;
  const envelopeIdentity = submission.identity as Record<string, unknown> | undefined;
  const envelope: PiPrediction = {
    ...empty,
    identityStatus:
      envelopeIdentity && envelopeIdentity.gtinMatch === 'exact'
        ? 'exact_match'
        : null,
    brand:
      proposal && typeof proposal.brand === 'string'
        ? proposal.brand
        : typeof identity?.brand === 'string'
          ? (identity.brand as string)
          : null,
    title:
      proposal && typeof proposal.title === 'string'
        ? proposal.title
        : typeof identity?.registerName === 'string'
          ? (identity.registerName as string)
          : null,
    variant: null,
    productType:
      submission.classificationProposal &&
      typeof submission.classificationProposal === 'object'
        ? ((submission.classificationProposal as Record<string, unknown>)
            .productTypeId as string | null) ?? null
        : null,
  };
  if (proposal && Array.isArray(proposal.fields)) {
    for (const f of proposal.fields as Array<Record<string, unknown>>) {
      if (typeof f.field !== 'string') continue;
      envelope.facts.push({
        field: f.field,
        value: f.value != null ? String(f.value) : '',
        method: null,
        sourcePath: null,
      });
    }
  }
  const images = submission.images;
  if (Array.isArray(images) && images.length > 0) {
    const img = images[0] as Record<string, unknown>;
    envelope.imageUrl = typeof img.url === 'string' ? img.url : null;
    envelope.imageRights = envelopeRightsOf(img.rightsStatus);
    envelope.imageCommerceApproved =
      img.identityMatch === 'exact' ? true : img.identityMatch === 'wrong' ? false : null;
  }
  const conflicts = submission.conflicts;
  if (Array.isArray(conflicts)) {
    for (const c of conflicts as Array<Record<string, unknown>>) {
      envelope.conflicts.push({
        field: String(c.field ?? ''),
        severity: String(c.severity ?? ''),
      });
    }
  }
  return envelope;
}

function bundleRightsOf(
  status: unknown,
): 'approved' | 'restricted' | 'unknown' {
  if (status === 'supplier_authorized' || status === 'manufacturer_authorized' || status === 'licensed_dataset' || status === 'retailer_authorized') {
    return 'approved';
  }
  if (status === 'unknown' || status === undefined || status === null) return 'unknown';
  return 'restricted';
}

function envelopeRightsOf(
  status: unknown,
): 'approved' | 'restricted' | 'unknown' {
  if (status === 'confirmed') return 'approved';
  if (status === 'conflicting') return 'restricted';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Comparison vs golden labels
// ---------------------------------------------------------------------------

export interface PiComparison {
  outcome: PiOutcome;
  identity: {
    exactProductHit: boolean;
    exactVariantHit: boolean | null;
    parentOnlyCorrect: boolean | null;
    wrongVariantCorrect: boolean | null;
    abstentionCorrect: boolean | null;
  };
  fields: {
    precision: number | null;
    recall: number | null;
    perField: Record<string, { precision: number | null; recall: number | null }>;
    predictedFacts: number;
  };
  unsupportedClaims: number;
  evidenceCoverage: {
    fieldsCompared: number;
    withMethod: number;
    withSourcePath: number;
    coverage: number | null;
  };
  image: {
    exactProductCorrect: boolean | null;
    exactVariantCorrect: boolean | null;
    rightsRejectionCorrect: boolean | null;
  };
  classification: {
    productTypeAccurate: boolean | null;
    attributePrecision: number | null;
    attributeCoverage: number | null;
    pagePrecision: number | null;
    pageRecall: number | null;
    pageExactSet: boolean | null;
  };
  conflicts: {
    goldHasMisleading: boolean;
    detectedAny: boolean | null;
    falseConflict: boolean | null;
  };
  ops: {
    durationMs: number | null;
    costUsd: number | null;
    toolCalls: number;
    deniedToolCalls: number;
    /** P2-2: 'tool_calls' when counts were derived from the persisted tool-call table, 'placeholder' otherwise. */
    derivedFrom?: 'tool_calls' | 'placeholder';
  };
}

function norm(v: string): string {
  return v.trim().toLowerCase();
}

function valueMatches(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === '' || nb === '') return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

export function comparePredictionToGold(
  prediction: PiPrediction | null,
  gold: PiGoldLabels,
  outcome: PiOutcome,
  ops: Partial<PiComparison['ops']> = {},
): PiComparison {
  const identityStatusExact =
    prediction?.identityStatus === 'exact_match' || prediction?.identityStatus === 'exact';

  // Identity
  const exactProductHit =
    (outcome === 'submitted' && identityStatusExact) === gold.identity.exactProduct;
  const exactVariantHit =
    gold.identity.exactVariant == null
      ? null
      : (outcome === 'submitted' && identityStatusExact) === gold.identity.exactVariant;
  const parentOnlyCorrect = gold.identity.parentProductOnly
    ? outcome === 'parent_product_only'
    : null;
  const wrongVariantCorrect = gold.identity.wrongVariant
    ? outcome === 'wrong_variant'
    : null;
  const abstentionCorrect = gold.identity.requiredAbstention
    ? outcome === 'abstained'
    : null;

  // Fields
  const goldFacts = gold.requiredFacts;
  const predFacts = prediction?.facts ?? [];
  const perField: Record<string, { precision: number | null; recall: number | null }> = {};
  let matchedCount = 0;
  for (const g of goldFacts) {
    const matched = predFacts.some(
      (f) => norm(f.field) === norm(g.field) && valueMatches(f.value, g.value),
    );
    if (matched) matchedCount++;
    perField[g.field] = {
      precision: matched ? 1 : 0,
      recall: matched ? 1 : 0,
    };
  }
  // Predictions not backed by gold facts = unsupported claims.
  const unsupportedClaims = predFacts.filter(
    (f) => !goldFacts.some((g) => norm(g.field) === norm(f.field)),
  ).length;
  const predictedForGoldField = predFacts.filter((f) =>
    goldFacts.some((g) => norm(g.field) === norm(f.field)),
  ).length;
  const fieldsPrecision =
    predictedForGoldField > 0 ? matchedCount / predictedForGoldField : null;
  const fieldsRecall =
    goldFacts.length > 0 ? matchedCount / goldFacts.length : null;

  // Evidence coverage (per gold expectedEvidence entry with a matching fact)
  let fieldsCompared = 0;
  let withMethod = 0;
  let withSourcePath = 0;
  for (const ev of gold.expectedEvidence) {
    const match = predFacts.find((f) => norm(f.field) === norm(ev.field));
    if (!match) continue;
    fieldsCompared++;
    if (match.method != null && match.method !== '') withMethod++;
    if (match.sourcePath != null && match.sourcePath !== '') withSourcePath++;
  }
  const coverage = fieldsCompared > 0 ? withMethod / fieldsCompared : null;

  // Image
  let exactProductCorrect: boolean | null = null;
  let exactVariantCorrect: boolean | null = null;
  let rightsRejectionCorrect: boolean | null = null;
  if (gold.expectedImage) {
    if (gold.expectedImage.identityMatch === 'exact') {
      exactProductCorrect = prediction?.imageCommerceApproved === true;
    }
    if (gold.expectedImage.identityMatch === 'variant') {
      exactVariantCorrect =
        prediction?.imageUrl != null && prediction?.imageRights === 'approved';
    }
    if (gold.expectedImage.rightsStatus === 'unknown') {
      rightsRejectionCorrect =
        prediction?.imageRights === 'unknown' &&
        prediction?.imageCommerceApproved === false;
    }
  }

  // Classification
  const goldPt = gold.expectedClassification.productType ?? null;
  const productTypeAccurate =
    goldPt == null ? null : prediction?.productType === goldPt;
  const goldAttrs = gold.expectedClassification.attributes;
  const predAttrs = prediction?.attributes ?? [];
  let attrMatched = 0;
  for (const ga of goldAttrs) {
    if (predAttrs.some((pa) => pa.attributeId === ga.attributeId && norm(pa.value) === norm(ga.value))) {
      attrMatched++;
    }
  }
  const attributePrecision =
    goldAttrs.length > 0 && predAttrs.length > 0 ? attrMatched / predAttrs.length : null;
  const attributeCoverage =
    goldAttrs.length > 0 ? attrMatched / goldAttrs.length : null;
  const goldPages = gold.expectedClassification.categoryPages;
  const predPages = prediction?.categoryPages ?? [];
  const pageIntersection = goldPages.filter((p) => predPages.includes(p));
  const pagePrecision =
    goldPages.length > 0 && predPages.length > 0
      ? pageIntersection.length / predPages.length
      : null;
  const pageRecall =
    goldPages.length > 0 ? pageIntersection.length / goldPages.length : null;
  const pageExactSet =
    goldPages.length > 0
      ? pageIntersection.length === goldPages.length && predPages.length === goldPages.length
      : null;

  // Conflicts
  const goldHasMisleading = gold.misleadingSources.length > 0;
  const predictedConflicts = prediction?.conflicts.length ?? 0;
  const detectedAny = goldHasMisleading ? predictedConflicts > 0 : null;
  const falseConflict = !goldHasMisleading ? predictedConflicts > 0 : null;

  return {
    outcome,
    identity: {
      exactProductHit,
      exactVariantHit,
      parentOnlyCorrect,
      wrongVariantCorrect,
      abstentionCorrect,
    },
    fields: {
      precision: fieldsPrecision,
      recall: fieldsRecall,
      perField,
      predictedFacts: predFacts.length,
    },
    unsupportedClaims,
    evidenceCoverage: { fieldsCompared, withMethod, withSourcePath, coverage },
    image: {
      exactProductCorrect,
      exactVariantCorrect,
      rightsRejectionCorrect,
    },
    classification: {
      productTypeAccurate,
      attributePrecision,
      attributeCoverage,
      pagePrecision,
      pageRecall,
      pageExactSet,
    },
    conflicts: { goldHasMisleading, detectedAny, falseConflict },
    ops: {
      durationMs: ops.durationMs ?? null,
      costUsd: ops.costUsd ?? null,
      toolCalls: ops.toolCalls ?? 0,
      deniedToolCalls: ops.deniedToolCalls ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregation + uncertainty
// ---------------------------------------------------------------------------

/** Wilson score interval for a proportion. */
export function wilsonInterval(
  p: number,
  n: number,
  z = 1.96,
): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 0 };
  const clamped = Math.min(1, Math.max(0, p));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (clamped + z2 / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((clamped * (1 - clamped) + z2 / (4 * n)) / n)) / denom;
  return {
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin),
  };
}

export interface PiAggregateReport {
  sampleSize: number;
  sampleSizeWarning: 'none' | 'small' | 'very_small';
  rates: Record<string, number | null>;
  confidence: Record<string, { lower: number; upper: number }>;
  outcomeDistribution: Record<PiOutcome, number>;
  ops: {
    avgDurationMs: number | null;
    totalCostUsd: number | null;
    avgToolCalls: number | null;
    avgDeniedToolCalls: number | null;
  };
}

const BOOLEAN_METRIC_KEYS: Array<{ key: string; pick: (c: PiComparison) => boolean | null }> = [
  { key: 'identity.exactProductHit', pick: (c) => c.identity.exactProductHit },
  { key: 'identity.exactVariantHit', pick: (c) => c.identity.exactVariantHit },
  { key: 'identity.parentOnlyCorrect', pick: (c) => c.identity.parentOnlyCorrect },
  { key: 'identity.wrongVariantCorrect', pick: (c) => c.identity.wrongVariantCorrect },
  { key: 'identity.abstentionCorrect', pick: (c) => c.identity.abstentionCorrect },
  { key: 'image.exactProductCorrect', pick: (c) => c.image.exactProductCorrect },
  { key: 'image.exactVariantCorrect', pick: (c) => c.image.exactVariantCorrect },
  { key: 'image.rightsRejectionCorrect', pick: (c) => c.image.rightsRejectionCorrect },
  { key: 'classification.productTypeAccurate', pick: (c) => c.classification.productTypeAccurate },
  { key: 'classification.pageExactSet', pick: (c) => c.classification.pageExactSet },
  { key: 'conflicts.detectedAny', pick: (c) => c.conflicts.detectedAny },
  { key: 'conflicts.falseConflict', pick: (c) => c.conflicts.falseConflict },
];

function avgNonNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

export function aggregatePiComparisons(
  comparisons: PiComparison[],
): PiAggregateReport {
  const n = comparisons.length;
  const rates: Record<string, number | null> = {};
  const confidence: Record<string, { lower: number; upper: number }> = {};

  for (const { key, pick } of BOOLEAN_METRIC_KEYS) {
    const picked = comparisons.map(pick);
    const present = picked.filter((v): v is boolean => v != null);
    const rate = present.length > 0 ? present.filter(Boolean).length / present.length : null;
    rates[key] = rate;
    confidence[key] = wilsonInterval(rate ?? 0, present.length);
  }

  // Field precision/recall: average of non-null per-comparison values.
  rates['fields.precision'] = avgNonNull(comparisons.map((c) => c.fields.precision));
  rates['fields.recall'] = avgNonNull(comparisons.map((c) => c.fields.recall));
  const unsupported = comparisons.reduce((a, c) => a + c.unsupportedClaims, 0);
  const predictedFactsTotal = comparisons.reduce((a, c) => a + c.fields.predictedFacts, 0);
  rates['unsupportedClaimRate'] =
    predictedFactsTotal > 0 ? unsupported / predictedFactsTotal : null;

  const evFields = comparisons.reduce((a, c) => a + c.evidenceCoverage.fieldsCompared, 0);
  const evWithMethod = comparisons.reduce((a, c) => a + c.evidenceCoverage.withMethod, 0);
  rates['evidenceCoverage.coverage'] = evFields > 0 ? evWithMethod / evFields : null;

  rates['classification.attributePrecision'] = avgNonNull(comparisons.map((c) => c.classification.attributePrecision));
  rates['classification.attributeCoverage'] = avgNonNull(comparisons.map((c) => c.classification.attributeCoverage));
  rates['classification.pagePrecision'] = avgNonNull(comparisons.map((c) => c.classification.pagePrecision));
  rates['classification.pageRecall'] = avgNonNull(comparisons.map((c) => c.classification.pageRecall));

  const outcomeDistribution = Object.fromEntries(
    PI_OUTCOMES.map((o) => [o, 0]),
  ) as Record<PiOutcome, number>;
  for (const c of comparisons) {
    outcomeDistribution[c.outcome] = (outcomeDistribution[c.outcome] ?? 0) + 1;
  }

  const durations = comparisons.map((c) => c.ops.durationMs);
  const costs = comparisons.map((c) => c.ops.costUsd);
  const toolCalls = comparisons.map((c) => c.ops.toolCalls);
  const denied = comparisons.map((c) => c.ops.deniedToolCalls);
  const presentCosts = costs.filter((v): v is number => v != null);

  const sampleSizeWarning: 'none' | 'small' | 'very_small' =
    n < 10 ? 'very_small' : n < 30 ? 'small' : 'none';

  return {
    sampleSize: n,
    sampleSizeWarning,
    rates,
    confidence,
    outcomeDistribution,
    ops: {
      avgDurationMs: avgNonNull(durations),
      totalCostUsd: presentCosts.length > 0 ? presentCosts.reduce((a, b) => a + b, 0) : null,
      avgToolCalls: avgNonNull(toolCalls),
      avgDeniedToolCalls: avgNonNull(denied),
    },
  };
}
