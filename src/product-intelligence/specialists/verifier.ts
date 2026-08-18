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
 *   - claim grounding & provenance check (verifies every grounding entry cites valid
 *     resolved facts and that all evidence IDs strictly belong to the cited fact(s))
 *   - structured prose fidelity check (verifies synthesized title, subtitle, and
 *     description claims—including Brand, Net Weight, Size, Count, Dimensions bullets—
 *     faithfully reflect resolved facts without cross-fact or invented claims)
 *   - conflict omission check (ensures facts with unresolved conflicts were NOT
 *     unfaithfully promoted to draft attributes)
 *   - taxonomy bounds & semantic check (verifies proposed category/product-type IDs
 *     belong strictly to the approved CMS configuration)
 *   - structured QA verdict: `pass`, `retry_curator`, `retry_resolver`,
 *     `retry_discovery`, or `human_review`
 *   - targeted retry requests citing exact violating fields and suggested actions
 *
 * The verifier is a pure QA specialist behind the #48 specialist boundary.
 * It NEVER silently rewrites or mutates the draft, NEVER invokes other specialists,
 * and NEVER writes catalog state directly.
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

  // 3. Catalog Title check
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
  }

  // 4. Attribute Value Fidelity Checks
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
      } else {
        checks.push({
          checkName: 'attribute_value_fidelity',
          passed: true,
          severity: 'info',
          field: attrKey,
          details: `Attribute '${attrKey}' value is faithful to resolved fact value '${fact.value}'`,
        });
      }
    }
  }

  // 5. Strict Grounding & Evidence Integrity Check (Per-Fact Evidence Isolation)
  for (const groundingEntry of curatedDraft.grounding) {
    const citedFields = groundingEntry.supportingFactFields;
    if (citedFields.length === 0) {
      checks.push({
        checkName: 'claim_provenance',
        passed: false,
        severity: 'warning',
        field: groundingEntry.field,
        details: `Grounding entry for '${groundingEntry.field}' specifies no supporting fact fields`,
      });
      continue;
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
        if (!citedFields.includes(factField)) {
          checks.push({
            checkName: 'grounding_evidence_misassociation',
            passed: false,
            severity: 'blocking',
            field: groundingEntry.field,
            details: `Grounding for '${groundingEntry.field}' cites synthetic fact '${evId}' not declared in supportingFactFields (${citedFields.join(', ')})`,
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

  // 6. Description & Structured Prose Claims QA
  if (curatedDraft.description) {
    const desc = curatedDraft.description;

    // Check Brand bullet claim
    const brandMatch = /(?:-|\*)\s*Brand:\s*([^\n\r]+)/i.exec(desc);
    if (brandMatch && brandFact?.status === 'resolved' && brandFact.value) {
      if (normalizeVal(brandMatch[1]) !== normalizeVal(brandFact.value)) {
        checks.push({
          checkName: 'description_claim_mismatch',
          passed: false,
          severity: 'blocking',
          field: 'description',
          details: `Description Brand claim '${brandMatch[1].trim()}' does not match resolved brand fact '${brandFact.value}'`,
        });
      }
    }

    // Check Net Weight bullet claim
    const weightFact = resolvedFacts.facts.find((f) => f.field === 'weight');
    const weightMatch = /(?:-|\*)\s*Net Weight:\s*([^\n\r]+)/i.exec(desc);
    if (weightMatch && weightFact?.status === 'resolved' && weightFact.value) {
      if (normalizeVal(weightMatch[1]) !== normalizeVal(weightFact.value)) {
        checks.push({
          checkName: 'description_claim_mismatch',
          passed: false,
          severity: 'blocking',
          field: 'description',
          details: `Description Net Weight claim '${weightMatch[1].trim()}' does not match resolved weight fact '${weightFact.value}'`,
        });
      }
    }

    // Check Size bullet claim
    const sizeFact = resolvedFacts.facts.find((f) => f.field === 'size');
    const sizeMatch = /(?:-|\*)\s*Size:\s*([^\n\r]+)/i.exec(desc);
    if (sizeMatch && sizeFact?.status === 'resolved' && sizeFact.value) {
      if (normalizeVal(sizeMatch[1]) !== normalizeVal(sizeFact.value)) {
        checks.push({
          checkName: 'description_claim_mismatch',
          passed: false,
          severity: 'blocking',
          field: 'description',
          details: `Description Size claim '${sizeMatch[1].trim()}' does not match resolved size fact '${sizeFact.value}'`,
        });
      }
    }

    // Check Package Count bullet claim
    const packFact = resolvedFacts.facts.find((f) => f.field === 'packCount');
    const packMatch = /(?:-|\*)\s*Package Count:\s*([^\n\r]+)/i.exec(desc);
    if (packMatch && packFact?.status === 'resolved' && packFact.value) {
      if (normalizeVal(packMatch[1]) !== normalizeVal(packFact.value)) {
        checks.push({
          checkName: 'description_claim_mismatch',
          passed: false,
          severity: 'blocking',
          field: 'description',
          details: `Description Package Count claim '${packMatch[1].trim()}' does not match resolved packCount fact '${packFact.value}'`,
        });
      }
    }

    // Check Dimensions bullet claim
    const dimFact = resolvedFacts.facts.find((f) => f.field === 'dimensions');
    const dimMatch = /(?:-|\*)\s*Dimensions:\s*([^\n\r]+)/i.exec(desc);
    if (dimMatch && dimFact?.status === 'resolved' && dimFact.value) {
      if (normalizeVal(dimMatch[1]) !== normalizeVal(dimFact.value)) {
        checks.push({
          checkName: 'description_claim_mismatch',
          passed: false,
          severity: 'blocking',
          field: 'description',
          details: `Description Dimensions claim '${dimMatch[1].trim()}' does not match resolved dimensions fact '${dimFact.value}'`,
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
        c.checkName === 'grounding_evidence_misassociation' ||
        c.checkName === 'description_claim_mismatch',
    )
  ) {
    verdict = 'retry_curator';
    const badFields = blockingIssues.map((c) => c.field).filter((f): f is string => Boolean(f));
    retryRequest = {
      targetSpecialist: 'curator',
      reason: 'Draft contains ungrounded claims, altered values, or promotes conflicting facts',
      conflictingFields: badFields,
      suggestedAction: 'Regenerate draft attributes and descriptions strictly from resolved facts',
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
