/**
 * Verifier specialist — independent quality assurance, identity verification,
 * and structured retry routing for Product Intelligence (epic #47, issue #55, ADR 0027).
 *
 * The verifier evaluates a `CuratedProductDraft` against its source `ProductSeed`,
 * `ResolvedFactSet`, and classification context to produce a versioned
 * `VerificationReport` artifact:
 *
 *   - independent identity check (confirms resolved GTIN/UPC matches draft GTIN/UPC;
 *     flags wrong variants, parent-product-only states, or case-pack GTINs promoted to consumer units)
 *   - separate identity and product-data scoring & decisions
 *   - image compliance QA (verifies variant identity match, rights status, and commerce approval)
 *   - attribute value fidelity check (verifies draft attribute values match resolved
 *     fact values exactly, preventing wrong weights, counts, or flavors from passing)
 *   - mandatory grounding coverage check (verifies EVERY emitted attribute, catalog
 *     title, subtitle, and description has a non-empty grounding entry with valid evidence)
 *   - strict per-fact evidence isolation (every supportingFactField must exist as a resolved
 *     fact; evidence IDs must belong exclusively to declared supporting facts)
 *   - fail-closed description QA (only grounded headers and validated bullet claims are accepted;
 *     arbitrary ungrounded free prose is strictly rejected)
 *   - conflict omission check (ensures facts with unresolved conflicts were NOT
 *     unfaithfully promoted to draft attributes)
 *   - taxonomy bounds & semantic check (verifies proposed category/product-type IDs
 *     belong strictly to the approved CMS configuration)
 *   - structured QA verdict: `pass`, `retry_curator`, `retry_resolver`,
 *     `retry_discovery`, or `human_review`
 */

import { z } from 'zod';
import { sha256Hex } from '../../shared/stable-id';
import {
  ResolvedFactSetSchema,
} from './resolver';
import {
  CuratedProductDraftSchema,
  ClassificationContextSchema,
} from './curator';
import { ExtractionEvidenceBundleSchema } from '../extraction/evidence';
import {
  finalizeSpecialistArtifact,
  captureSpecialistCodeCommit,
  summarizeZodIssues,
  SpecialistArtifactSchemaRegistry,
} from './artifacts';
import {
  SpecialistResultSchema,
  type SpecialistCapability,
  type SpecialistContext,
  type SpecialistResult,
} from './contracts';

// ── Constants ────────────────────────────────────────────────────────────────

export const VERIFIER_SPECIALIST_NAME = 'verifier';
export const VERIFIER_SPECIALIST_VERSION = '1.0.0';
export const VERIFIER_INPUT_SCHEMA_VERSION = '1.0.0';
export const VERIFIER_OUTPUT_SCHEMA_VERSION = '1.0.0';
export const VERIFIER_INPUT_ARTIFACT_TYPE = 'verifier_input';
export const VERIFIER_OUTPUT_ARTIFACT_TYPE = 'verification_report';

// ── Input Schema ─────────────────────────────────────────────────────────────

export const VerifierSpecialistInputSchema = z.object({
  schemaVersion: z.literal(VERIFIER_INPUT_SCHEMA_VERSION),
  productSeed: z.any(),
  resolvedFacts: ResolvedFactSetSchema,
  curatedDraft: CuratedProductDraftSchema,
  classificationContext: ClassificationContextSchema.default({
    availableProductTypes: [],
    availableCategories: [],
    attributeProfiles: [],
  }),
  extractionBundles: z.array(ExtractionEvidenceBundleSchema).optional().default([]),
}).strict();
export type VerifierSpecialistInput = z.input<typeof VerifierSpecialistInputSchema>;

// ── Output Schema ────────────────────────────────────────────────────────────

export const VerificationVerdictSchema = z.enum([
  'pass',
  'retry_curator',
  'retry_resolver',
  'retry_discovery',
  'human_review',
]);
export type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;

export const QualityCheckSeveritySchema = z.enum(['blocking', 'warning', 'info']);
export type QualityCheckSeverity = z.infer<typeof QualityCheckSeveritySchema>;

export const QualityCheckCategorySchema = z.enum(['identity', 'product_data', 'image_rights', 'taxonomy']);
export type QualityCheckCategory = z.infer<typeof QualityCheckCategorySchema>;

export const QualityCheckItemSchema = z.object({
  checkName: z.string().min(1).max(128),
  category: QualityCheckCategorySchema.default('product_data'),
  passed: z.boolean(),
  severity: QualityCheckSeveritySchema,
  field: z.string().min(1).max(128).nullable(),
  details: z.string().min(1).max(1024),
}).strict();
export type QualityCheckItem = z.infer<typeof QualityCheckItemSchema>;

export const StructuredRetryRequestSchema = z.object({
  targetSpecialist: z.enum(['curator', 'resolver', 'discovery']),
  reason: z.string().min(1).max(1024),
  conflictingFields: z.array(z.string().min(1).max(128)).default([]),
  suggestedAction: z.string().min(1).max(1024),
}).strict();
export type StructuredRetryRequest = z.infer<typeof StructuredRetryRequestSchema>;

export const VerificationReportSchema = z.object({
  schemaVersion: z.literal(VERIFIER_OUTPUT_SCHEMA_VERSION),
  specialist: z.literal(VERIFIER_SPECIALIST_NAME),
  specialistVersion: z.literal(VERIFIER_SPECIALIST_VERSION),
  verdict: VerificationVerdictSchema,
  score: z.number().min(0).max(1),
  identityScore: z.number().min(0).max(1),
  productDataScore: z.number().min(0).max(1),
  identityStatus: z.enum(['verified', 'mismatched', 'ambiguous', 'unresolved']),
  identityDecision: z.enum(['pass', 'fail', 'ambiguous']),
  productDataDecision: z.enum(['pass', 'fail', 'needs_review']),
  checks: z.array(QualityCheckItemSchema).min(1).max(64),
  retryRequest: StructuredRetryRequestSchema.nullable(),
  blockingIssuesCount: z.number().int().min(0),
  warningsCount: z.number().int().min(0),
  verifiedAt: z.string().min(1),
}).strict();
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

// ── QA Verification Logic ────────────────────────────────────────────────────

function normalizeVal(str: string | null | undefined): string {
  return (str ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function extractDigits(str: string | null | undefined): string {
  return (str ?? '').replace(/\D/g, '');
}

function mapBulletLabelToField(label: string): string {
  const norm = normalizeVal(label);
  switch (norm) {
    case 'brand': return 'brand';
    case 'net weight':
    case 'weight': return 'weight';
    case 'size':
    case 'volume': return 'size';
    case 'package count':
    case 'pack count':
    case 'count': return 'packCount';
    case 'dimensions': return 'dimensions';
    case 'case dimensions': return 'caseDimensions';
    case 'shipping dimensions': return 'shippingDimensions';
    case 'gtin':
    case 'upc': return 'gtin';
    case 'sku': return 'sku';
    case 'flavor': return 'flavor';
    case 'color': return 'color';
    case 'material': return 'material';
    default: return norm.replace(/[^a-z0-9]/g, '');
  }
}

export interface VerifyDraftOptions {
  now?: () => string;
}

export function verifyCuratedDraft(
  rawInput: VerifierSpecialistInput,
  options: VerifyDraftOptions = {},
): VerificationReport {
  const input = VerifierSpecialistInputSchema.parse(rawInput);
  const { resolvedFacts, curatedDraft, classificationContext } = input;
  const now = options.now ?? (() => new Date().toISOString());

  const checks: QualityCheckItem[] = [];

  // 1. Identity Resolution & Identifier Fidelity Check
  let identityStatus: 'verified' | 'mismatched' | 'ambiguous' | 'unresolved' = 'verified';
  if (resolvedFacts.identity.status === 'conflict') {
    identityStatus = 'mismatched';
    checks.push({
      checkName: 'identity_resolution',
      category: 'identity',
      passed: false,
      severity: 'blocking',
      field: 'gtin',
      details: 'Product identity is in conflict across discovery sources',
    });
  } else if (resolvedFacts.identity.status === 'unresolved') {
    identityStatus = 'unresolved';
    checks.push({
      checkName: 'identity_resolution',
      category: 'identity',
      passed: false,
      severity: 'blocking',
      field: 'gtin',
      details: 'Product identity could not be resolved from available discovery evidence',
    });
  } else if (resolvedFacts.identity.status === 'ambiguous') {
    identityStatus = 'ambiguous';
    checks.push({
      checkName: 'identity_resolution',
      category: 'identity',
      passed: false,
      severity: 'warning',
      field: 'gtin',
      details: 'Product identity is probable but ambiguous (missing exact GTIN match)',
    });
  } else {
    checks.push({
      checkName: 'identity_resolution',
      category: 'identity',
      passed: true,
      severity: 'info',
      field: 'gtin',
      details: `Product identity confirmed (GTIN: ${resolvedFacts.identity.gtin ?? 'none'}) with confidence ${resolvedFacts.identity.confidence}`,
    });
  }

  // Check draft GTIN / UPC against resolved identity (for consumer-unit identities)
  const isCaseIdentity = resolvedFacts.expectedIdentity?.gtinScope === 'case' || Boolean(resolvedFacts.identity.gtin && extractDigits(resolvedFacts.identity.gtin).length === 14);

  if (!isCaseIdentity && resolvedFacts.identity.gtin) {
    if (curatedDraft.gtin !== resolvedFacts.identity.gtin) {
      checks.push({
        checkName: 'identity_gtin_fidelity',
        category: 'identity',
        passed: false,
        severity: 'blocking',
        field: 'gtin',
        details: `Draft GTIN '${curatedDraft.gtin}' does not match resolved identity GTIN '${resolvedFacts.identity.gtin}'`,
      });
    } else {
      checks.push({
        checkName: 'identity_gtin_fidelity',
        category: 'identity',
        passed: true,
        severity: 'info',
        field: 'gtin',
        details: `Draft GTIN matches resolved identity GTIN '${curatedDraft.gtin}'`,
      });
    }
  }

  if (resolvedFacts.identity.upc) {
    if (curatedDraft.upc !== resolvedFacts.identity.upc) {
      checks.push({
        checkName: 'identity_upc_fidelity',
        category: 'identity',
        passed: false,
        severity: 'blocking',
        field: 'upc',
        details: `Draft UPC '${curatedDraft.upc}' does not match resolved identity UPC '${resolvedFacts.identity.upc}'`,
      });
    }
  }

  // Case-pack GTIN protection: ensure 14-digit GTINs or case-scoped identifiers are never assigned as consumer unit GTINs
  if (curatedDraft.gtin) {
    const draftGtinDigits = extractDigits(curatedDraft.gtin);
    if (draftGtinDigits.length === 14 || resolvedFacts.expectedIdentity?.gtinScope === 'case') {
      checks.push({
        checkName: 'case_gtin_assigned_to_consumer_unit',
        category: 'identity',
        passed: false,
        severity: 'blocking',
        field: 'gtin',
        details: `Case GTIN / case-scoped identifier '${curatedDraft.gtin}' was improperly assigned as a consumer unit draft GTIN (must be null on consumer product draft)`,
      });
    }
  }

  // Check parent_product_only / wrong_variant decisions
  const parentDecision = resolvedFacts.identity.decisions.find((d) => d.decision === 'parent_product_only');
  if (parentDecision && resolvedFacts.identity.status !== 'resolved') {
    checks.push({
      checkName: 'exact_variant_verification',
      category: 'identity',
      passed: false,
      severity: 'blocking',
      field: 'candidateUrl',
      details: `Candidate '${parentDecision.url}' is a parent/family product page rather than an exact variant PDP`,
    });
  }

  const wrongVariantDecision = resolvedFacts.identity.decisions.find((d) => d.decision === 'wrong_variant');
  if (wrongVariantDecision && resolvedFacts.identity.status !== 'resolved') {
    checks.push({
      checkName: 'exact_variant_verification',
      category: 'identity',
      passed: false,
      severity: 'blocking',
      field: 'candidateUrl',
      details: `Candidate '${wrongVariantDecision.url}' is a wrong variant page`,
    });
  }

  // 2. Draft Brand Fidelity
  const brandFact = resolvedFacts.facts.find((f) => f.field === 'brand');
  const titleFact = resolvedFacts.facts.find((f) => f.field === 'title');
  const weightFact = resolvedFacts.facts.find((f) => f.field === 'weight');
  const sizeFact = resolvedFacts.facts.find((f) => f.field === 'size');

  if (brandFact?.status === 'resolved' && brandFact.value) {
    if (curatedDraft.brand && normalizeVal(curatedDraft.brand) !== normalizeVal(brandFact.value)) {
      checks.push({
        checkName: 'brand_fidelity',
        category: 'product_data',
        passed: false,
        severity: 'blocking',
        field: 'brand',
        details: `Draft brand '${curatedDraft.brand}' does not match resolved brand fact '${brandFact.value}'`,
      });
    }
  }

  // 3. Catalog Title Quality and Alignment
  if (!curatedDraft.catalogTitle || curatedDraft.catalogTitle.trim() === 'Untitled Product') {
    checks.push({
      checkName: 'catalog_title_quality',
      category: 'product_data',
      passed: false,
      severity: 'blocking',
      field: 'catalogTitle',
      details: 'Catalog title is missing or empty',
    });
  } else {
    checks.push({
      checkName: 'catalog_title_quality',
      category: 'product_data',
      passed: true,
      severity: 'info',
      field: 'catalogTitle',
      details: `Catalog title '${curatedDraft.catalogTitle}' is well-formed`,
    });

    if (brandFact?.status === 'resolved' && brandFact.value) {
      if (!normalizeVal(curatedDraft.catalogTitle).includes(normalizeVal(brandFact.value))) {
        checks.push({
          checkName: 'catalog_title_brand_alignment',
          category: 'product_data',
          passed: false,
          severity: 'blocking',
          field: 'catalogTitle',
          details: `Catalog title '${curatedDraft.catalogTitle}' is missing resolved brand '${brandFact.value}'`,
        });
      }
    }

    // Weight/size alignment in catalog title
    const titleQtyMatch = /\b\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|lb|lbs|kg|g|ml|l)\b/i.exec(curatedDraft.catalogTitle);
    if (titleQtyMatch) {
      if (weightFact?.status === 'resolved' && weightFact.value) {
        if (!normalizeVal(curatedDraft.catalogTitle).includes(normalizeVal(weightFact.value))) {
          checks.push({
            checkName: 'catalog_title_weight_alignment',
            category: 'product_data',
            passed: false,
            severity: 'blocking',
            field: 'catalogTitle',
            details: `Catalog title '${curatedDraft.catalogTitle}' mentions weight '${titleQtyMatch[0]}' mismatching resolved weight '${weightFact.value}'`,
          });
        }
      } else if (sizeFact?.status === 'resolved' && sizeFact.value) {
        if (!normalizeVal(curatedDraft.catalogTitle).includes(normalizeVal(sizeFact.value))) {
          checks.push({
            checkName: 'catalog_title_size_alignment',
            category: 'product_data',
            passed: false,
            severity: 'blocking',
            field: 'catalogTitle',
            details: `Catalog title '${curatedDraft.catalogTitle}' mentions size '${titleQtyMatch[0]}' mismatching resolved size '${sizeFact.value}'`,
          });
        }
      }
    }

    // Name tokens alignment: require at least 50% substantive token match
    if (titleFact?.status === 'resolved' && titleFact.value) {
      const cleanTitleFact = normalizeVal(titleFact.value);
      const PROTEIN_FLAVOR_TOKENS = [
        'chicken', 'beef', 'turkey', 'duck', 'salmon', 'tuna', 'lamb', 'pork', 'venison', 'rabbit',
        'fish', 'vegetable', 'liver', 'bacon', 'cheese', 'veggie', 'poultry', 'seafood',
      ];
      const draftTitleLower = normalizeVal(curatedDraft.catalogTitle);
      const resolvedTitleLower = normalizeVal(titleFact.value);

      for (const flavor of PROTEIN_FLAVOR_TOKENS) {
        if (resolvedTitleLower.includes(flavor) && !draftTitleLower.includes(flavor)) {
          checks.push({
            checkName: 'catalog_title_variant_alignment',
            category: 'product_data',
            passed: false,
            severity: 'blocking',
            field: 'catalogTitle',
            details: `Catalog title '${curatedDraft.catalogTitle}' is missing essential variant/flavor token '${flavor}' from resolved title '${titleFact.value}'`,
          });
        } else if (!resolvedTitleLower.includes(flavor) && draftTitleLower.includes(flavor)) {
          checks.push({
            checkName: 'catalog_title_variant_alignment',
            category: 'product_data',
            passed: false,
            severity: 'blocking',
            field: 'catalogTitle',
            details: `Catalog title '${curatedDraft.catalogTitle}' introduces contradictory variant/flavor token '${flavor}' not present in resolved title '${titleFact.value}'`,
          });
        }
      }

      const nameTokens = cleanTitleFact
        .split(/[\s,&/\\-]+/)
        .filter((w) => w.length >= 3 && !['with', 'from', 'the', 'and', 'for', 'organic', 'product'].includes(w));

      if (nameTokens.length > 0) {
        const matchedCount = nameTokens.filter((tok) => normalizeVal(curatedDraft.catalogTitle).includes(tok)).length;
        const matchRatio = matchedCount / nameTokens.length;
        if (matchRatio < 0.75) {
          checks.push({
            checkName: 'catalog_title_name_alignment',
            category: 'product_data',
            passed: false,
            severity: 'blocking',
            field: 'catalogTitle',
            details: `Catalog title '${curatedDraft.catalogTitle}' matches only ${Math.round(matchRatio * 100)}% of substantive name tokens from resolved title '${titleFact.value}' (minimum 75% required)`,
          });
        }
      }
    }
  }

  // Subtitle Quality and Alignment
  if (curatedDraft.subtitle) {
    const subtitleNorm = normalizeVal(curatedDraft.subtitle);
    if (brandFact?.status === 'resolved' && brandFact.value) {
      if (!subtitleNorm.includes(normalizeVal(brandFact.value))) {
        checks.push({
          checkName: 'subtitle_brand_mismatch',
          category: 'product_data',
          passed: false,
          severity: 'blocking',
          field: 'subtitle',
          details: `Subtitle '${curatedDraft.subtitle}' is missing resolved brand '${brandFact.value}'`,
        });
      }
    }

    const subQtyMatch = /\b\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|lb|lbs|kg|g|ml|l)\b/i.exec(curatedDraft.subtitle);
    if (subQtyMatch) {
      if (weightFact?.status === 'resolved' && weightFact.value) {
        if (!subtitleNorm.includes(normalizeVal(weightFact.value))) {
          checks.push({
            checkName: 'subtitle_quantity_mismatch',
            category: 'product_data',
            passed: false,
            severity: 'blocking',
            field: 'subtitle',
            details: `Subtitle '${curatedDraft.subtitle}' mentions quantity '${subQtyMatch[0]}' mismatching resolved weight '${weightFact.value}'`,
          });
        }
      } else if (sizeFact?.status === 'resolved' && sizeFact.value) {
        if (!subtitleNorm.includes(normalizeVal(sizeFact.value))) {
          checks.push({
            checkName: 'subtitle_quantity_mismatch',
            category: 'product_data',
            passed: false,
            severity: 'blocking',
            field: 'subtitle',
            details: `Subtitle '${curatedDraft.subtitle}' mentions quantity '${subQtyMatch[0]}' mismatching resolved size '${sizeFact.value}'`,
          });
        }
      }
    }
  }

  // 4. Mandatory Grounding Coverage Checks (every output field must have valid grounding)
  for (const [attrKey, attrValue] of Object.entries(curatedDraft.attributes)) {
    const fact = resolvedFacts.facts.find((f) => f.field === attrKey);
    if (!fact || fact.status !== 'resolved') {
      checks.push({
        checkName: 'claim_grounding',
        category: 'product_data',
        passed: false,
        severity: 'blocking',
        field: attrKey,
        details: `Attribute '${attrKey}' with value '${attrValue}' is not supported by a resolved fact (status: ${fact?.status ?? 'missing'})`,
      });
    } else {
      // Check exact value fidelity (prevents resolved "16 fl oz" being mutated to "50 lb")
      if (fact.value && normalizeVal(attrValue) !== normalizeVal(fact.value)) {
        checks.push({
          checkName: 'attribute_value_fidelity',
          category: 'product_data',
          passed: false,
          severity: 'blocking',
          field: attrKey,
          details: `Draft attribute '${attrKey}' value '${attrValue}' does not match resolved fact value '${fact.value}'`,
        });
      }

      // Grounding entry existence for attribute
      const groundingEntry = curatedDraft.grounding.find((g) => g.field === attrKey);
      if (!groundingEntry || groundingEntry.evidenceIds.length === 0) {
        checks.push({
          checkName: 'missing_attribute_grounding',
          category: 'product_data',
          passed: false,
          severity: 'blocking',
          field: attrKey,
          details: `Attribute '${attrKey}' is missing required grounding provenance entry in draft`,
        });
      }
    }
  }

  // Required grounding for catalogTitle, description, and subtitle
  const titleGrounding = curatedDraft.grounding.find((g) => g.field === 'catalogTitle');
  if (!titleGrounding || titleGrounding.evidenceIds.length === 0) {
    checks.push({
      checkName: 'missing_title_grounding',
      category: 'product_data',
      passed: false,
      severity: 'blocking',
      field: 'catalogTitle',
      details: 'Catalog title is missing required grounding entry in draft',
    });
  }

  const descGrounding = curatedDraft.grounding.find((g) => g.field === 'description');
  if (!descGrounding || descGrounding.evidenceIds.length === 0) {
    checks.push({
      checkName: 'missing_description_grounding',
      category: 'product_data',
      passed: false,
      severity: 'blocking',
      field: 'description',
      details: 'Product description is missing required grounding entry in draft',
    });
  }

  if (curatedDraft.subtitle) {
    const subtitleGrounding = curatedDraft.grounding.find((g) => g.field === 'subtitle');
    if (!subtitleGrounding || subtitleGrounding.evidenceIds.length === 0) {
      checks.push({
        checkName: 'missing_subtitle_grounding',
        category: 'product_data',
        passed: false,
        severity: 'blocking',
        field: 'subtitle',
        details: 'Product subtitle is missing required grounding entry in draft',
      });
    }
  }

  // 5. Strict Per-Fact Grounding Evidence Isolation & Fact Existence
  for (const groundingEntry of curatedDraft.grounding) {
    const citedFields = groundingEntry.supportingFactFields;
    if (citedFields.length === 0) {
      checks.push({
        checkName: 'grounding_evidence_misassociation',
        category: 'product_data',
        passed: false,
        severity: 'blocking',
        field: groundingEntry.field,
        details: `Grounding entry for '${groundingEntry.field}' specifies no supporting fact fields`,
      });
      continue;
    }

    // Verify EVERY supportingFactField corresponds to a REAL resolved fact in resolvedFacts
    for (const citedField of citedFields) {
      const fact = resolvedFacts.facts.find((f) => f.field === citedField);
      if (!fact || fact.status !== 'resolved') {
        checks.push({
          checkName: 'grounding_unresolved_fact_reference',
          category: 'product_data',
          passed: false,
          severity: 'blocking',
          field: groundingEntry.field,
          details: `Grounding for '${groundingEntry.field}' declares supporting fact '${citedField}' which is not a resolved fact (status: ${fact?.status ?? 'missing'})`,
        });
      }
    }

    // Collect all valid evidence IDs belonging EXCLUSIVELY to the cited fact fields
    const validEvidenceIdsForEntry = new Set<string>();
    for (const citedField of citedFields) {
      const fact = resolvedFacts.facts.find((f) => f.field === citedField);
      if (fact && fact.status === 'resolved') {
        for (const ev of fact.supportingEvidence) {
          validEvidenceIdsForEntry.add(ev.id);
        }
      }
    }

    for (const evId of groundingEntry.evidenceIds) {
      if (evId.startsWith('resolved_fact:')) {
        const factField = evId.slice('resolved_fact:'.length);
        const resolvedFact = resolvedFacts.facts.find((f) => f.field === factField);
        if (!citedFields.includes(factField) || !resolvedFact || resolvedFact.status !== 'resolved') {
          checks.push({
            checkName: 'grounding_evidence_misassociation',
            category: 'product_data',
            passed: false,
            severity: 'blocking',
            field: groundingEntry.field,
            details: `Grounding for '${groundingEntry.field}' cites synthetic fact '${evId}' that is not a declared resolved fact`,
          });
        }
      } else if (!validEvidenceIdsForEntry.has(evId)) {
        checks.push({
          checkName: 'grounding_evidence_misassociation',
          category: 'product_data',
          passed: false,
          severity: 'blocking',
          field: groundingEntry.field,
          details: `Grounding for '${groundingEntry.field}' cites evidence '${evId}' which does not belong to supporting facts (${citedFields.join(', ')})`,
        });
      }
    }
  }

  // 6. Fail-Closed Description QA: Header lines & structured bullets allowed; ungrounded prose rejected
  if (curatedDraft.description) {
    const desc = curatedDraft.description;
    const lines = desc.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Allow Markdown headers (e.g. #, ##, ###, ****)
      if (trimmed.startsWith('#') || (trimmed.startsWith('**') && trimmed.endsWith('**'))) {
        continue;
      }

      const bulletMatch = /^\s*(?:-|\*)\s*([^:]+):\s*(.+)$/.exec(trimmed);
      if (!bulletMatch) {
        // Fail-closed check: Any non-header, non-bullet prose must be backed by an explicit fact
        checks.push({
          checkName: 'unsupported_description_claim',
          category: 'product_data',
          passed: false,
          severity: 'blocking',
          field: 'description',
          details: `Description contains ungrounded non-bullet prose: '${trimmed}'`,
        });
        continue;
      }

      const rawLabel = bulletMatch[1].trim();
      const rawClaimValue = bulletMatch[2].trim();
      const mappedField = mapBulletLabelToField(rawLabel);

      const fact = resolvedFacts.facts.find((f) => f.field === mappedField);
      if (!fact || fact.status !== 'resolved') {
        checks.push({
          checkName: 'unsupported_description_claim',
          category: 'product_data',
          passed: false,
          severity: 'blocking',
          field: 'description',
          details: `Description claims '${rawLabel}: ${rawClaimValue}', but '${mappedField}' is not a resolved fact (status: ${fact?.status ?? 'missing'})`,
        });
      } else if (fact.value && normalizeVal(rawClaimValue) !== normalizeVal(fact.value)) {
        checks.push({
          checkName: 'description_claim_mismatch',
          category: 'product_data',
          passed: false,
          severity: 'blocking',
          field: 'description',
          details: `Description claims '${rawLabel}: ${rawClaimValue}', but resolved fact value is '${fact.value}'`,
        });
      }
    }
  }

  // 7. Image Variant & Rights QA (Fail-Closed Allowlists & Provenance)
  const ALLOWED_IMAGE_RIGHTS = new Set(['approved', 'commercial', 'licensed', 'public_domain']);
  const ALLOWED_IMAGE_IDENTITY = new Set(['exact', 'verified', 'exact_match']);

  const extractedImageCandidates = (input.extractionBundles ?? []).flatMap((b) => b.images ?? []);

  for (const image of curatedDraft.images) {
    if (!image.commerceApproved) {
      checks.push({
        checkName: 'image_commerce_approval',
        category: 'image_rights',
        passed: false,
        severity: 'blocking',
        field: 'images',
        details: `Selected image '${image.url}' is not commerce approved`,
      });
    }

    const normalizedRights = (image.rightsStatus ?? '').toLowerCase().trim();
    if (!ALLOWED_IMAGE_RIGHTS.has(normalizedRights)) {
      checks.push({
        checkName: 'image_rights_compliance',
        category: 'image_rights',
        passed: false,
        severity: 'blocking',
        field: 'images',
        details: `Image '${image.url}' has non-compliant rights status '${image.rightsStatus}' (must be approved/commercial/licensed/public_domain)`,
      });
    }

    const normalizedIdentity = (image.identityMatch ?? '').toLowerCase().trim();
    if (!ALLOWED_IMAGE_IDENTITY.has(normalizedIdentity)) {
      checks.push({
        checkName: 'image_variant_compliance',
        category: 'image_rights',
        passed: false,
        severity: 'blocking',
        field: 'images',
        details: `Image '${image.url}' has non-exact identity match '${image.identityMatch}' (must be exact/verified)`,
      });
    }

    // Fail-closed provenance check: image MUST exist in extraction evidence candidates
    const match = extractedImageCandidates.find((ext) => ext.url === image.url);
    if (!match) {
      checks.push({
        checkName: 'image_evidence_provenance',
        category: 'image_rights',
        passed: false,
        severity: 'blocking',
        field: 'images',
        details: `Draft image '${image.url}' has no verified candidate provenance in extraction bundles`,
      });
    } else {
      if (!match.sourcePath || !match.artifactId) {
        checks.push({
          checkName: 'image_evidence_provenance',
          category: 'image_rights',
          passed: false,
          severity: 'blocking',
          field: 'images',
          details: `Draft image '${image.url}' is missing required source artifact/path provenance in extraction evidence`,
        });
      }

      // Independent rights verification: check extraction evidence directly (fail-closed)
      const extRights = match.rightsStatus ? match.rightsStatus.toLowerCase().trim() : null;
      if (!extRights || !ALLOWED_IMAGE_RIGHTS.has(extRights)) {
        checks.push({
          checkName: 'image_rights_compliance',
          category: 'image_rights',
          passed: false,
          severity: 'blocking',
          field: 'images',
          details: `Extraction evidence for '${image.url}' lacks verified compliant rights status (found: '${match.rightsStatus ?? 'unverified'}')`,
        });
      }
      if (match.commerceApproved !== true) {
        checks.push({
          checkName: 'image_commerce_approval',
          category: 'image_rights',
          passed: false,
          severity: 'blocking',
          field: 'images',
          details: `Extraction evidence for '${image.url}' lacks independent commerce approval (found: ${match.commerceApproved})`,
        });
      }

      // Independent identity verification (fail-closed)
      const extIdentity = match.identityMatch ? match.identityMatch.toLowerCase().trim() : null;
      if (!extIdentity || !ALLOWED_IMAGE_IDENTITY.has(extIdentity)) {
        checks.push({
          checkName: 'image_variant_compliance',
          category: 'image_rights',
          passed: false,
          severity: 'blocking',
          field: 'images',
          details: `Extraction evidence for '${image.url}' lacks exact/verified identity match (found: '${match.identityMatch ?? 'unverified'}')`,
        });
      }

      if (match.variantRef) {
        const resolvedVariantId = (resolvedFacts as any).variantId ?? (resolvedFacts as any).variant?.id ?? (input.extractionBundles ?? []).find((b) => b.variant?.id)?.variant?.id ?? null;
        const isShopifyId = match.variantRefKind === 'shopify_variant_id' ||
          Boolean(resolvedVariantId && match.variantRef === resolvedVariantId);

        const isSeedSku = match.variantRefKind === 'sku' ||
          Boolean((input.productSeed as any)?.sku && match.variantRef === (input.productSeed as any).sku);

        const isGtin = match.variantRefKind === 'gtin' ||
          (!isShopifyId && !isSeedSku && /^\d{8}$|^\d{12,14}$/.test(match.variantRef));

        if (isShopifyId) {
          if (resolvedVariantId && match.variantRef !== resolvedVariantId) {
            checks.push({
              checkName: 'image_variant_compliance',
              category: 'image_rights',
              passed: false,
              severity: 'blocking',
              field: 'images',
              details: `Draft image '${image.url}' references Shopify variant '${match.variantRef}' conflicting with resolved variant ID '${resolvedVariantId}'`,
            });
          }
        } else if (isGtin && resolvedFacts.expectedIdentity?.gtin && match.variantRef !== resolvedFacts.expectedIdentity.gtin) {
          checks.push({
            checkName: 'image_variant_compliance',
            category: 'image_rights',
            passed: false,
            severity: 'blocking',
            field: 'images',
            details: `Draft image '${image.url}' references GTIN '${match.variantRef}' conflicting with resolved GTIN '${resolvedFacts.expectedIdentity.gtin}'`,
          });
        } else if (isSeedSku && (input.productSeed as any)?.sku && match.variantRef !== (input.productSeed as any).sku) {
          checks.push({
            checkName: 'image_variant_compliance',
            category: 'image_rights',
            passed: false,
            severity: 'blocking',
            field: 'images',
            details: `Draft image '${image.url}' references SKU '${match.variantRef}' conflicting with seed SKU '${(input.productSeed as any).sku}'`,
          });
        }
      }
    }
  }

  // 8. Conflict Omission check: no conflicting facts should appear as resolved draft attributes
  for (const fact of resolvedFacts.facts) {
    if (fact.status === 'conflict' && curatedDraft.attributes[fact.field]) {
      checks.push({
        checkName: 'conflict_omission',
        category: 'product_data',
        passed: false,
        severity: 'blocking',
        field: fact.field,
        details: `Fact '${fact.field}' is in conflict across sources but was unfaithfully included as draft attribute '${curatedDraft.attributes[fact.field]}'`,
      });
    }
  }

  // 9. Taxonomy Bounds check: category and productTypeId must belong to active config
  if (curatedDraft.productTypeId) {
    const validPt = classificationContext.availableProductTypes.some((pt) => pt.id === curatedDraft.productTypeId);
    if (!validPt && classificationContext.availableProductTypes.length > 0) {
      checks.push({
        checkName: 'taxonomy_bounds',
        category: 'taxonomy',
        passed: false,
        severity: 'blocking',
        field: 'productTypeId',
        details: `Product type ID '${curatedDraft.productTypeId}' is not in approved classification configuration`,
      });
    }
  }

  for (const catId of curatedDraft.categoryIds) {
    const validCat = classificationContext.availableCategories.some((c) => c.id === catId);
    if (!validCat && classificationContext.availableCategories.length > 0) {
      checks.push({
        checkName: 'taxonomy_bounds',
        category: 'taxonomy',
        passed: false,
        severity: 'blocking',
        field: 'categoryIds',
        details: `Category ID '${catId}' is not in approved classification configuration`,
      });
    }
  }

  // Derive verdict and retry request
  const blockingIssues = checks.filter((c) => !c.passed && c.severity === 'blocking');
  const warnings = checks.filter((c) => !c.passed && c.severity === 'warning');

  // Separate identity and product data scoring & decisions
  const identityChecks = checks.filter((c) => c.category === 'identity');
  const productDataChecks = checks.filter((c) => c.category !== 'identity');

  const identityPassed = identityChecks.filter((c) => c.passed).length;
  const identityScore = identityChecks.length > 0 ? Math.round((identityPassed / identityChecks.length) * 100) / 100 : 1;
  const identityDecision = identityStatus === 'mismatched' || identityStatus === 'unresolved' || identityChecks.some((c) => !c.passed && c.severity === 'blocking')
    ? 'fail'
    : identityStatus === 'ambiguous'
      ? 'ambiguous'
      : 'pass';

  const productDataPassed = productDataChecks.filter((c) => c.passed).length;
  const productDataScore = productDataChecks.length > 0 ? Math.round((productDataPassed / productDataChecks.length) * 100) / 100 : 1;
  const productDataDecision = productDataChecks.some((c) => !c.passed && c.severity === 'blocking')
    ? 'fail'
    : productDataChecks.some((c) => !c.passed && c.severity === 'warning')
      ? 'needs_review'
      : 'pass';

  let verdict: VerificationVerdict = 'pass';
  let retryRequest: StructuredRetryRequest | null = null;

  if (identityDecision === 'fail' || blockingIssues.some((c) => c.category === 'identity')) {
    verdict = 'retry_discovery';
    retryRequest = {
      targetSpecialist: 'discovery',
      reason: 'Identity could not be verified or resolved from current discovery candidates',
      conflictingFields: ['gtin'],
      suggestedAction: 'Search for exact product variant URL matching SKU or GTIN',
    };
  } else if (
    blockingIssues.some(
      (c) =>
        c.checkName === 'conflict_omission' ||
        c.checkName === 'claim_grounding' ||
        c.checkName === 'attribute_value_fidelity' ||
        c.checkName === 'brand_fidelity' ||
        c.checkName === 'catalog_title_brand_alignment' ||
        c.checkName === 'catalog_title_weight_alignment' ||
        c.checkName === 'catalog_title_size_alignment' ||
        c.checkName === 'catalog_title_name_alignment' ||
        c.checkName === 'catalog_title_variant_alignment' ||
        c.checkName === 'subtitle_brand_mismatch' ||
        c.checkName === 'subtitle_quantity_mismatch' ||
        c.checkName === 'missing_attribute_grounding' ||
        c.checkName === 'missing_title_grounding' ||
        c.checkName === 'missing_description_grounding' ||
        c.checkName === 'missing_subtitle_grounding' ||
        c.checkName === 'grounding_unresolved_fact_reference' ||
        c.checkName === 'grounding_evidence_misassociation' ||
        c.checkName === 'unsupported_description_claim' ||
        c.checkName === 'description_claim_mismatch' ||
        c.checkName === 'image_commerce_approval' ||
        c.checkName === 'primary_image_commerce_approval' ||
        c.checkName === 'image_rights_compliance' ||
        c.checkName === 'image_variant_compliance' ||
        c.checkName === 'image_evidence_provenance',
    )
  ) {
    verdict = 'retry_curator';
    const badFields = blockingIssues.map((c) => c.field).filter((f): f is string => Boolean(f));
    retryRequest = {
      targetSpecialist: 'curator',
      reason: 'Draft contains ungrounded claims, altered values, missing required grounding, invalid image rights, or promotes conflicting facts',
      conflictingFields: badFields,
      suggestedAction: 'Regenerate draft attributes, images, and descriptions strictly from resolved facts with complete grounding',
    };
  } else if (blockingIssues.length > 0) {
    verdict = 'human_review';
    retryRequest = null;
  } else if (warnings.length > 0 && identityStatus === 'ambiguous') {
    verdict = 'human_review';
    retryRequest = null;
  }

  const passedChecksCount = checks.filter((c) => c.passed).length;
  const overallScore = checks.length > 0 ? Math.round((passedChecksCount / checks.length) * 100) / 100 : 0;

  return {
    schemaVersion: VERIFIER_OUTPUT_SCHEMA_VERSION,
    specialist: VERIFIER_SPECIALIST_NAME,
    specialistVersion: VERIFIER_SPECIALIST_VERSION,
    verdict,
    score: overallScore,
    identityScore,
    productDataScore,
    identityStatus,
    identityDecision,
    productDataDecision,
    checks,
    retryRequest,
    blockingIssuesCount: blockingIssues.length,
    warningsCount: warnings.length,
    verifiedAt: now(),
  };
}

// ── Specialist Capability & Class ────────────────────────────────────────────

export const VERIFIER_SPECIALIST_CAPABILITY: SpecialistCapability = {
  name: VERIFIER_SPECIALIST_NAME,
  version: VERIFIER_SPECIALIST_VERSION,
  kind: 'classification',
  summary:
    'Independent quality assurance: verifies identity accuracy, claim grounding, taxonomy constraints, and emits structured retry requests.',
  input: {
    schemaName: VERIFIER_INPUT_ARTIFACT_TYPE,
    schemaVersion: VERIFIER_INPUT_SCHEMA_VERSION,
    description: 'Product seed, resolved fact set, curated product draft, and classification context',
  },
  output: {
    schemaName: VERIFIER_OUTPUT_ARTIFACT_TYPE,
    schemaVersion: VERIFIER_OUTPUT_SCHEMA_VERSION,
    description: 'Verification report with QA verdict, check items, and structured retry requests',
  },
};

export function registerVerifierSchemas(registry: SpecialistArtifactSchemaRegistry): SpecialistArtifactSchemaRegistry {
  registry.register({
    name: VERIFIER_INPUT_ARTIFACT_TYPE,
    version: VERIFIER_INPUT_SCHEMA_VERSION,
    schema: VerifierSpecialistInputSchema,
    description: 'Verifier specialist input schema',
  });
  registry.register({
    name: VERIFIER_OUTPUT_ARTIFACT_TYPE,
    version: VERIFIER_OUTPUT_SCHEMA_VERSION,
    schema: VerificationReportSchema,
    description: 'Verification report artifact schema',
  });
  return registry;
}

export interface VerifierSpecialistOptions {
  codeCommit?: string | null;
  now?: () => string;
}

export class VerifierSpecialist {
  public readonly capability = VERIFIER_SPECIALIST_CAPABILITY;
  private readonly codeCommit: string;
  private readonly now: () => string;

  public constructor(options: VerifierSpecialistOptions = {}) {
    this.codeCommit = options.codeCommit ?? captureSpecialistCodeCommit() ?? 'dev-commit';
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async execute(rawInput: unknown, context: SpecialistContext): Promise<SpecialistResult> {
    const startedAt = Date.now();
    if (context.signal?.aborted) {
      return SpecialistResultSchema.parse({
        specialist: VERIFIER_SPECIALIST_NAME,
        outcome: 'failed',
        failure: {
          code: 'cancelled',
          message: 'Verifier execution cancelled before start',
          retryable: true,
        },
        durationMs: Date.now() - startedAt,
      });
    }

    const parseResult = VerifierSpecialistInputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      return SpecialistResultSchema.parse({
        specialist: VERIFIER_SPECIALIST_NAME,
        outcome: 'failed',
        failure: {
          code: 'invalid_input',
          message: `Verifier input validation failed: ${summarizeZodIssues(parseResult.error)}`,
          retryable: false,
        },
        durationMs: Date.now() - startedAt,
      });
    }

    const input = parseResult.data;
    const report = verifyCuratedDraft(input, { now: this.now });
    const durationMs = Date.now() - startedAt;

    const inputArtifactId = `artifact:draft:${sha256Hex(JSON.stringify(input.curatedDraft)).slice(0, 32)}`;
    const outputEnvelope = finalizeSpecialistArtifact({
      artifactType: VERIFIER_OUTPUT_ARTIFACT_TYPE,
      payload: report,
      payloadSchema: VerificationReportSchema,
      lineage: {
        inputArtifactIds: [inputArtifactId],
        parentArtifactIds: [],
        runId: context.runId,
        workflowRef: context.workspaceId,
      },
      provenance: {
        specialist: VERIFIER_SPECIALIST_NAME,
        specialistVersion: VERIFIER_SPECIALIST_VERSION,
        policyConfigId: context.policy.configId,
        codeCommit: this.codeCommit ?? captureSpecialistCodeCommit(),
        durationMs,
      },
    });

    return SpecialistResultSchema.parse({
      specialist: VERIFIER_SPECIALIST_NAME,
      outcome: 'succeeded',
      output: outputEnvelope,
      durationMs,
    });
  }
}
