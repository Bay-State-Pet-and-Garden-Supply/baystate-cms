/**
 * Verifier specialist — independent quality assurance, identity verification,
 * and structured retry routing for Product Intelligence (epic #47, issue #55, ADR 0027).
 *
 * The verifier evaluates a `CuratedProductDraft` against its source `ProductSeed`,
 * `ResolvedFactSet`, and classification context to produce a versioned
 * `VerificationReport` artifact:
 *
 *   - independent identity check (confirms resolved GTIN/UPC matches draft GTIN/UPC;
 *     flags wrong variants or parent-product-only states)
 *   - attribute value fidelity check (verifies draft attribute values match resolved
 *     fact values exactly, preventing wrong weights, counts, or flavors from passing)
 *   - mandatory grounding coverage check (verifies EVERY emitted attribute, catalog
 *     title, subtitle, and description has a non-empty grounding entry with valid evidence)
 *   - strict per-fact evidence isolation (every supportingFactField must exist as a resolved
 *     fact; evidence IDs must belong exclusively to declared supporting facts)
 *   - comprehensive catalog prose QA (verifies catalog title brand, size/weight, and name
 *     alignment; verifies subtitle brand and quantity; parses and validates all description
 *     claims against resolved facts—rejecting unsupported statements)
 *   - conflict omission check (ensures facts with unresolved conflicts were NOT
 *     unfaithfully promoted to draft attributes)
 *   - taxonomy bounds & semantic check (verifies proposed category/product-type IDs
 *     belong strictly to the approved CMS configuration)
 *   - structured QA verdict: `pass`, `retry_curator`, `retry_resolver`,
 *     `retry_discovery`, or `human_review`
 *   - targeted retry requests citing exact violating fields and suggested actions
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
}).strict();
export type VerifierSpecialistInput = z.infer<typeof VerifierSpecialistInputSchema>;

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

export const QualityCheckItemSchema = z.object({
  checkName: z.string().min(1).max(128),
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
  identityStatus: z.enum(['verified', 'mismatched', 'ambiguous', 'unresolved']),
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
  input: VerifierSpecialistInput,
  options: VerifyDraftOptions = {},
): VerificationReport {
  const { resolvedFacts, curatedDraft, classificationContext } = input;
  const now = options.now ?? (() => new Date().toISOString());

  const checks: QualityCheckItem[] = [];

  // 1. Identity Resolution & Identifier Fidelity Check
  let identityStatus: 'verified' | 'mismatched' | 'ambiguous' | 'unresolved' = 'verified';
  if (resolvedFacts.identity.status === 'conflict') {
    identityStatus = 'mismatched';
    checks.push({
      checkName: 'identity_resolution',
      passed: false,
      severity: 'blocking',
      field: 'gtin',
      details: 'Product identity is in conflict across discovery sources',
    });
  } else if (resolvedFacts.identity.status === 'unresolved') {
    identityStatus = 'unresolved';
    checks.push({
      checkName: 'identity_resolution',
      passed: false,
      severity: 'blocking',
      field: 'gtin',
      details: 'Product identity could not be resolved from available discovery evidence',
    });
  } else if (resolvedFacts.identity.status === 'ambiguous') {
    identityStatus = 'ambiguous';
    checks.push({
      checkName: 'identity_resolution',
      passed: false,
      severity: 'warning',
      field: 'gtin',
      details: 'Product identity is probable but ambiguous (missing exact GTIN match)',
    });
  } else {
    checks.push({
      checkName: 'identity_resolution',
      passed: true,
      severity: 'info',
      field: 'gtin',
      details: `Product identity confirmed (GTIN: ${resolvedFacts.identity.gtin ?? 'none'}) with confidence ${resolvedFacts.identity.confidence}`,
    });
  }

  // Check draft GTIN / UPC against resolved identity
  if (resolvedFacts.identity.gtin) {
    if (curatedDraft.gtin !== resolvedFacts.identity.gtin) {
      checks.push({
        checkName: 'identity_gtin_fidelity',
        passed: false,
        severity: 'blocking',
        field: 'gtin',
        details: `Draft GTIN '${curatedDraft.gtin}' does not match resolved identity GTIN '${resolvedFacts.identity.gtin}'`,
      });
    } else {
      checks.push({
        checkName: 'identity_gtin_fidelity',
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
        passed: false,
        severity: 'blocking',
        field: 'upc',
        details: `Draft UPC '${curatedDraft.upc}' does not match resolved identity UPC '${resolvedFacts.identity.upc}'`,
      });
    }
  }

  // Check parent_product_only / wrong_variant decisions
  const parentDecision = resolvedFacts.identity.decisions.find((d) => d.decision === 'parent_product_only');
  if (parentDecision && resolvedFacts.identity.status !== 'resolved') {
    checks.push({
      checkName: 'exact_variant_verification',
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
      passed: false,
      severity: 'blocking',
      field: 'catalogTitle',
      details: 'Catalog title is missing or empty',
    });
  } else {
    checks.push({
      checkName: 'catalog_title_quality',
      passed: true,
      severity: 'info',
      field: 'catalogTitle',
      details: `Catalog title '${curatedDraft.catalogTitle}' is well-formed`,
    });

    if (brandFact?.status === 'resolved' && brandFact.value) {
      if (!normalizeVal(curatedDraft.catalogTitle).includes(normalizeVal(brandFact.value))) {
        checks.push({
          checkName: 'catalog_title_brand_alignment',
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
      const nameTokens = cleanTitleFact
        .split(/[\s,&/\\-]+/)
        .filter((w) => w.length >= 3 && !['with', 'from', 'the', 'and', 'for', 'organic', 'product'].includes(w));
      
      if (nameTokens.length > 0) {
        const matchedCount = nameTokens.filter((tok) => normalizeVal(curatedDraft.catalogTitle).includes(tok)).length;
        const matchRatio = matchedCount / nameTokens.length;
        if (matchRatio < 0.5) {
          checks.push({
            checkName: 'catalog_title_name_alignment',
            passed: false,
            severity: 'blocking',
            field: 'catalogTitle',
            details: `Catalog title '${curatedDraft.catalogTitle}' matches only ${Math.round(matchRatio * 100)}% of substantive name tokens from resolved title '${titleFact.value}'`,
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
            passed: false,
            severity: 'blocking',
            field: groundingEntry.field,
            details: `Grounding for '${groundingEntry.field}' cites synthetic fact '${evId}' that is not a declared resolved fact`,
          });
        }
      } else if (!validEvidenceIdsForEntry.has(evId)) {
        checks.push({
          checkName: 'grounding_evidence_misassociation',
          passed: false,
          severity: 'blocking',
          field: groundingEntry.field,
          details: `Grounding for '${groundingEntry.field}' cites evidence '${evId}' which does not belong to supporting facts (${citedFields.join(', ')})`,
        });
      }
    }
  }

  // 6. Comprehensive Description Prose & Bullet Claims QA
  if (curatedDraft.description) {
    const desc = curatedDraft.description;
    const lines = desc.split('\n');

    for (const line of lines) {
      const bulletMatch = /^\s*(?:-|\*)\s*([^:]+):\s*(.+)$/.exec(line);
      if (!bulletMatch) {
        // Free prose line: check for ungrounded claims (unsupported claims, medical claims, ungrounded quantities)
        const freeQtyMatch = /\b\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|lb|lbs|kg|g|ml|l)\b/i.exec(line);
        if (freeQtyMatch) {
          const qty = freeQtyMatch[0];
          const hasWeightMatch = weightFact?.status === 'resolved' && weightFact.value && normalizeVal(qty) === normalizeVal(weightFact.value);
          const hasSizeMatch = sizeFact?.status === 'resolved' && sizeFact.value && normalizeVal(qty) === normalizeVal(sizeFact.value);
          if (!hasWeightMatch && !hasSizeMatch) {
            checks.push({
              checkName: 'unsupported_description_claim',
              passed: false,
              severity: 'blocking',
              field: 'description',
              details: `Description free prose contains ungrounded quantity '${qty}'`,
            });
          }
        }

        const ungroundedPatterns = [
          { pattern: /\b(?:clinically\s+proven|veterinarian\s+recommended|vet\s+approved)\b/i, label: 'health/clinical claim' },
          { pattern: /\b(?:made\s+in\s+[a-z\s]+|product\s+of\s+[a-z\s]+)\b/i, label: 'origin claim' },
          { pattern: /\b(?:grain-free|gluten-free|hypoallergenic)\b/i, label: 'dietary claim' },
        ];

        for (const { pattern, label } of ungroundedPatterns) {
          const match = pattern.exec(line);
          if (match) {
            checks.push({
              checkName: 'unsupported_description_claim',
              passed: false,
              severity: 'blocking',
              field: 'description',
              details: `Description contains ungrounded ${label}: '${match[0]}'`,
            });
          }
        }
        continue;
      }

      const rawLabel = bulletMatch[1].trim();
      const rawClaimValue = bulletMatch[2].trim();
      const mappedField = mapBulletLabelToField(rawLabel);

      const fact = resolvedFacts.facts.find((f) => f.field === mappedField);
      if (!fact || fact.status !== 'resolved') {
        checks.push({
          checkName: 'unsupported_description_claim',
          passed: false,
          severity: 'blocking',
          field: 'description',
          details: `Description claims '${rawLabel}: ${rawClaimValue}', but '${mappedField}' is not a resolved fact (status: ${fact?.status ?? 'missing'})`,
        });
      } else if (fact.value && normalizeVal(rawClaimValue) !== normalizeVal(fact.value)) {
        checks.push({
          checkName: 'description_claim_mismatch',
          passed: false,
          severity: 'blocking',
          field: 'description',
          details: `Description claims '${rawLabel}: ${rawClaimValue}', but resolved fact value is '${fact.value}'`,
        });
      }
    }
  }

  // 7. Conflict Omission check: no conflicting facts should appear as resolved draft attributes
  for (const fact of resolvedFacts.facts) {
    if (fact.status === 'conflict' && curatedDraft.attributes[fact.field]) {
      checks.push({
        checkName: 'conflict_omission',
        passed: false,
        severity: 'blocking',
        field: fact.field,
        details: `Fact '${fact.field}' is in conflict across sources but was unfaithfully included as draft attribute '${curatedDraft.attributes[fact.field]}'`,
      });
    }
  }

  // 8. Taxonomy Bounds check: category and productTypeId must belong to active config
  if (curatedDraft.productTypeId) {
    const validPt = classificationContext.availableProductTypes.some((pt) => pt.id === curatedDraft.productTypeId);
    if (!validPt && classificationContext.availableProductTypes.length > 0) {
      checks.push({
        checkName: 'taxonomy_bounds',
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

  let verdict: VerificationVerdict = 'pass';
  let retryRequest: StructuredRetryRequest | null = null;

  if (identityStatus === 'mismatched' || identityStatus === 'unresolved' || blockingIssues.some((c) => c.checkName.startsWith('identity_'))) {
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
        c.checkName === 'subtitle_brand_mismatch' ||
        c.checkName === 'subtitle_quantity_mismatch' ||
        c.checkName === 'missing_attribute_grounding' ||
        c.checkName === 'missing_title_grounding' ||
        c.checkName === 'missing_description_grounding' ||
        c.checkName === 'missing_subtitle_grounding' ||
        c.checkName === 'grounding_unresolved_fact_reference' ||
        c.checkName === 'grounding_evidence_misassociation' ||
        c.checkName === 'unsupported_description_claim' ||
        c.checkName === 'description_claim_mismatch',
    )
  ) {
    verdict = 'retry_curator';
    const badFields = blockingIssues.map((c) => c.field).filter((f): f is string => Boolean(f));
    retryRequest = {
      targetSpecialist: 'curator',
      reason: 'Draft contains ungrounded claims, altered values, missing required grounding, or promotes conflicting facts',
      conflictingFields: badFields,
      suggestedAction: 'Regenerate draft attributes and descriptions strictly from resolved facts with complete grounding',
    };
  } else if (blockingIssues.length > 0) {
    verdict = 'human_review';
    retryRequest = null;
  } else if (warnings.length > 0 && identityStatus === 'ambiguous') {
    verdict = 'human_review';
    retryRequest = null;
  }

  const passedChecksCount = checks.filter((c) => c.passed).length;
  const score = checks.length > 0 ? Math.round((passedChecksCount / checks.length) * 100) / 100 : 0;

  return {
    schemaVersion: VERIFIER_OUTPUT_SCHEMA_VERSION,
    specialist: VERIFIER_SPECIALIST_NAME,
    specialistVersion: VERIFIER_SPECIALIST_VERSION,
    verdict,
    score,
    identityStatus,
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
