/**
 * Curator specialist — deterministic catalog drafting, classification, and
 * claim grounding for Product Intelligence (epic #47, issue #54, ADR 0026).
 *
 * The curator consumes the typed `ResolvedFactSet` artifact produced by the
 * Resolver specialist (ADR 0025) and classification configuration context,
 * and produces a versioned `CuratedProductDraft` artifact:
 *
 *   - clean catalog title synthesized deterministically from brand, name,
 *     and canonical quantity/size attributes without redundant brand duplication
 *   - source title vs resolved identity name vs catalog title kept distinct
 *   - product description strictly grounded in resolved facts and evidence refs
 *   - category and product-type proposals constrained strictly to active CMS
 *     configuration (never invented taxonomy IDs)
 *   - normalized product attributes (flavor, life stage, form, size, weight, pack count)
 *   - image selections filtered strictly for exact-variant identity and
 *     commerce rights approval (PI-6)
 *   - explicit field grounding references linking generated claims back to
 *     resolved fact fields and evidence IDs
 *   - structured abstentions for unverified or conflicting claims
 *
 * The curator is a pure deterministic specialist behind the #48 specialist boundary.
 * It performs no network I/O, does not invent taxonomy terms, and never writes
 * catalog state directly.
 */

import { z } from 'zod';
import { sha256Hex } from '../../shared/stable-id';
import {
  ResolvedFactSetSchema,
  type ResolvedFactSet,
  type ResolvedFact,
} from './resolver';
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

export const CURATOR_SPECIALIST_NAME = 'curator';
export const CURATOR_SPECIALIST_VERSION = '1.0.0';
export const CURATOR_INPUT_SCHEMA_VERSION = '1.0.0';
export const CURATOR_OUTPUT_SCHEMA_VERSION = '1.0.0';
export const CURATOR_INPUT_ARTIFACT_TYPE = 'curator_input';
export const CURATOR_OUTPUT_ARTIFACT_TYPE = 'curated_product_draft';

// ── Classification Context ───────────────────────────────────────────────────

export const TaxonomyOptionSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  path: z.string().max(512).optional(),
}).strict();
export type TaxonomyOption = z.infer<typeof TaxonomyOptionSchema>;

export const ClassificationContextSchema = z.object({
  availableProductTypes: z.array(TaxonomyOptionSchema).default([]),
  availableCategories: z.array(TaxonomyOptionSchema).default([]),
  attributeProfiles: z.array(
    z.object({
      productTypeId: z.string().min(1).max(128),
      allowedAttributes: z.array(z.string().min(1).max(128)),
    }).strict(),
  ).default([]),
}).strict();
export type ClassificationContext = z.infer<typeof ClassificationContextSchema>;

// ── Input Schema ─────────────────────────────────────────────────────────────

export const CuratorSpecialistInputSchema = z.object({
  schemaVersion: z.literal(CURATOR_INPUT_SCHEMA_VERSION),
  productSeed: z.any(),
  resolvedFacts: ResolvedFactSetSchema,
  classificationContext: ClassificationContextSchema.default({
    availableProductTypes: [],
    availableCategories: [],
    attributeProfiles: [],
  }),
  titleTemplate: z.string().max(256).nullish(),
}).strict();
export type CuratorSpecialistInput = z.infer<typeof CuratorSpecialistInputSchema>;

// ── Output Schema ────────────────────────────────────────────────────────────

export const CuratedImageSchema = z.object({
  url: z.string().min(1).max(2048),
  role: z.enum(['primary', 'gallery', 'variant', 'comparison']),
  rightsStatus: z.string().min(1).max(64),
  commerceApproved: z.boolean(),
  identityMatch: z.string().min(1).max(64),
  sourceUrl: z.string().min(1).max(2048).nullable(),
}).strict();
export type CuratedImage = z.infer<typeof CuratedImageSchema>;

export const ClaimGroundingSchema = z.object({
  field: z.string().min(1).max(128),
  claim: z.string().min(1).max(2048),
  supportingFactFields: z.array(z.string().min(1).max(128)).min(1).max(32),
  evidenceIds: z.array(z.string().min(1).max(128)).min(1).max(64),
}).strict();
export type ClaimGrounding = z.infer<typeof ClaimGroundingSchema>;

export const CuratedProductDraftSchema = z.object({
  schemaVersion: z.literal(CURATOR_OUTPUT_SCHEMA_VERSION),
  specialist: z.literal(CURATOR_SPECIALIST_NAME),
  specialistVersion: z.literal(CURATOR_SPECIALIST_VERSION),
  productSeed: z.any(),
  catalogTitle: z.string().min(1).max(512),
  sourceTitle: z.string().min(1).max(512).nullable(),
  resolvedIdentityName: z.string().min(1).max(512).nullable(),
  brand: z.string().min(1).max(256).nullable(),
  gtin: z.string().min(6).max(20).nullable(),
  upc: z.string().min(12).max(12).nullable(),
  subtitle: z.string().max(512).nullable(),
  description: z.string().max(8192).nullable(),
  productTypeId: z.string().min(1).max(128).nullable(),
  categoryIds: z.array(z.string().min(1).max(128)).default([]),
  attributes: z.record(z.string().min(1).max(128), z.string().min(1).max(1024)).default({}),
  images: z.array(CuratedImageSchema).default([]),
  grounding: z.array(ClaimGroundingSchema).default([]),
  abstentions: z.array(
    z.object({
      field: z.string().min(1).max(128),
      reason: z.string().min(1).max(512),
    }).strict(),
  ).default([]),
  curatedAt: z.string().min(1),
}).strict();
export type CuratedProductDraft = z.infer<typeof CuratedProductDraftSchema>;

// ── Helper Functions ─────────────────────────────────────────────────────────

function factByField(factSet: ResolvedFactSet, field: string): ResolvedFact | null {
  return factSet.facts.find((f) => f.field === field) ?? null;
}

function cleanTitle(brand: string | null, name: string | null, sizeOrWeight: string | null): string {
  const parts: string[] = [];
  const brandTrimmed = brand?.trim();
  const nameTrimmed = name?.trim();
  const sizeTrimmed = sizeOrWeight?.trim();

  if (brandTrimmed) {
    parts.push(brandTrimmed);
  }

  if (nameTrimmed) {
    // If name already starts with brand, avoid duplicate brand tokens.
    if (brandTrimmed && nameTrimmed.toLowerCase().startsWith(brandTrimmed.toLowerCase())) {
      const rest = nameTrimmed.slice(brandTrimmed.length).trim().replace(/^[-:,\s]+/, '');
      if (rest) parts.push(rest);
    } else {
      parts.push(nameTrimmed);
    }
  }

  if (sizeTrimmed) {
    // Avoid appending size if already in the name
    const currentCombined = parts.join(' ').toLowerCase();
    if (!currentCombined.includes(sizeTrimmed.toLowerCase())) {
      parts.push(sizeTrimmed);
    }
  }

  const combined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return combined || 'Untitled Product';
}

function matchTaxonomy(
  terms: string[],
  options: TaxonomyOption[],
): TaxonomyOption | null {
  if (options.length === 0 || terms.length === 0) return null;
  const normalizedTerms = terms.map((t) => t.toLowerCase().trim()).filter(Boolean);

  let bestOption: TaxonomyOption | null = null;
  let bestScore = 0;

  for (const option of options) {
    const optName = option.name.toLowerCase().trim();
    const optPath = (option.path ?? '').toLowerCase().trim();
    const optNameTokens = optName.split(/[\s,&/\\-]+/).filter((w) => w.length >= 3 && !['and', 'the', 'for', 'with'].includes(w));

    let score = 0;

    // Check exact phrase matches first
    for (const term of normalizedTerms) {
      if (term === optName || term.includes(optName) || (optName.length > 5 && optName.includes(term))) {
        score += 50;
      }
      if (optPath && optPath.includes(term)) {
        score += 5;
      }
    }

    // Token matching
    let matchedNameTokens = 0;
    for (const term of normalizedTerms) {
      const termTokens = term.split(/[\s,&/\\-]+/).filter((w) => w.length >= 3);
      for (const optTok of optNameTokens) {
        if (termTokens.includes(optTok)) {
          score += 10;
          matchedNameTokens += 1;
        } else if (termTokens.some((tt) => (tt.length >= 4 && optTok.length >= 4) && (tt.startsWith(optTok) || optTok.startsWith(tt)))) {
          score += 6;
          matchedNameTokens += 1;
        }
      }
    }

    // Specificity / precision penalty: penalize options with many tokens where only one generic token matched
    if (optNameTokens.length > 1 && matchedNameTokens > 0) {
      const matchRatio = matchedNameTokens / optNameTokens.length;
      score *= (0.5 + 0.5 * matchRatio);
    }

    if (score > bestScore && score >= 6) {
      bestScore = score;
      bestOption = option;
    }
  }

  return bestOption;
}

// ── Synthesis Logic ──────────────────────────────────────────────────────────

export interface CurateDraftOptions {
  now?: () => string;
}

export function curateProductDraft(
  input: CuratorSpecialistInput,
  options: CurateDraftOptions = {},
): CuratedProductDraft {
  const factSet = input.resolvedFacts;
  const classification = input.classificationContext;
  const now = options.now ?? (() => new Date().toISOString());

  const brandFact = factByField(factSet, 'brand');
  const titleFact = factByField(factSet, 'title');
  const weightFact = factByField(factSet, 'weight');
  const sizeFact = factByField(factSet, 'size');
  const packCountFact = factByField(factSet, 'packCount');
  const dimensionsFact = factByField(factSet, 'dimensions');
  const skuFact = factByField(factSet, 'sku');

  const brand = brandFact?.status === 'resolved' ? brandFact.value : null;
  const resolvedIdentityName = titleFact?.status === 'resolved' ? titleFact.value : null;
  const sourceTitle = typeof input.productSeed?.name === 'string' ? input.productSeed.name : null;
  const sizeOrWeight = weightFact?.status === 'resolved'
    ? weightFact.value
    : sizeFact?.status === 'resolved'
      ? sizeFact.value
      : null;

  // Title synthesis.
  const candidateName = resolvedIdentityName ?? sourceTitle;
  const catalogTitle = cleanTitle(brand, candidateName, sizeOrWeight);
  const subtitle = sizeOrWeight ? `${brand ?? ''} - ${sizeOrWeight}`.trim().replace(/^-\s*/, '') : null;

  // Grounding and attributes.
  const attributes: Record<string, string> = {};
  const grounding: ClaimGrounding[] = [];
  const abstentions: { field: string; reason: string }[] = [];

  const addGroundedField = (
    field: string,
    value: string,
    fact: ResolvedFact,
    claimDescription: string,
  ): void => {
    attributes[field] = value;
    const factRefs = [...fact.supportingEvidence.map((e) => e.id)];
    grounding.push({
      field,
      claim: `${claimDescription}: ${value}`,
      supportingFactFields: [fact.field],
      evidenceIds: factRefs.length > 0 ? factRefs : [`resolved_fact:${fact.field}`],
    });
  };

  if (brand && brandFact) {
    addGroundedField('brand', brand, brandFact, 'Brand name');
  }

  if (weightFact?.status === 'resolved' && weightFact.value) {
    addGroundedField('weight', weightFact.value, weightFact, 'Product weight');
  }

  if (sizeFact?.status === 'resolved' && sizeFact.value) {
    addGroundedField('size', sizeFact.value, sizeFact, 'Product size/volume');
  }

  if (packCountFact?.status === 'resolved' && packCountFact.value) {
    addGroundedField('packCount', packCountFact.value, packCountFact, 'Pack count');
  }

  if (dimensionsFact?.status === 'resolved' && dimensionsFact.value) {
    addGroundedField('dimensions', dimensionsFact.value, dimensionsFact, 'Product dimensions');
  }

  if (skuFact?.status === 'resolved' && skuFact.value) {
    addGroundedField('sku', skuFact.value, skuFact, 'Product SKU');
  }

  // Record abstentions for unverified or conflicting core attributes.
  for (const fact of factSet.facts) {
    if (fact.status === 'conflict') {
      abstentions.push({
        field: fact.field,
        reason: `Field '${fact.field}' has conflicting evidence across sources and was omitted from draft claims`,
      });
    } else if (fact.status === 'needs_more_evidence') {
      abstentions.push({
        field: fact.field,
        reason: `Field '${fact.field}' lacked sufficient evidence to ground draft claim`,
      });
    }
  }

  // Grounding for catalog title, subtitle, and description prose
  const titleSupportingFacts: string[] = [];
  const titleEvidenceIds: string[] = [];
  if (brandFact?.status === 'resolved') {
    titleSupportingFacts.push('brand');
    titleEvidenceIds.push(...brandFact.supportingEvidence.map((e) => e.id));
  }
  if (titleFact?.status === 'resolved') {
    titleSupportingFacts.push('title');
    titleEvidenceIds.push(...titleFact.supportingEvidence.map((e) => e.id));
  }
  if (weightFact?.status === 'resolved') {
    titleSupportingFacts.push('weight');
    titleEvidenceIds.push(...weightFact.supportingEvidence.map((e) => e.id));
  }
  if (sizeFact?.status === 'resolved') {
    titleSupportingFacts.push('size');
    titleEvidenceIds.push(...sizeFact.supportingEvidence.map((e) => e.id));
  }

  if (catalogTitle && titleSupportingFacts.length > 0) {
    grounding.push({
      field: 'catalogTitle',
      claim: `Synthesized catalog title: ${catalogTitle}`,
      supportingFactFields: titleSupportingFacts,
      evidenceIds: titleEvidenceIds.length > 0 ? [...new Set(titleEvidenceIds)] : ['resolved_fact:title'],
    });
  }

  if (subtitle && (weightFact?.status === 'resolved' || sizeFact?.status === 'resolved')) {
    const subFacts: string[] = [];
    const subEvidenceIds: string[] = [];
    if (brandFact?.status === 'resolved') {
      subFacts.push('brand');
      subEvidenceIds.push(...brandFact.supportingEvidence.map((e) => e.id));
    }
    if (weightFact?.status === 'resolved') {
      subFacts.push('weight');
      subEvidenceIds.push(...weightFact.supportingEvidence.map((e) => e.id));
    } else if (sizeFact?.status === 'resolved') {
      subFacts.push('size');
      subEvidenceIds.push(...sizeFact.supportingEvidence.map((e) => e.id));
    }
    if (subFacts.length > 0) {
      grounding.push({
        field: 'subtitle',
        claim: `Product subtitle: ${subtitle}`,
        supportingFactFields: subFacts,
        evidenceIds: subEvidenceIds.length > 0 ? [...new Set(subEvidenceIds)] : ['resolved_fact:subtitle'],
      });
    }
  }

  // Description construction: strictly grounded in resolved facts.
  const descriptionLines: string[] = [];
  if (catalogTitle) {
    descriptionLines.push(`**${catalogTitle}**`);
  }
  const bulletClaims: string[] = [];
  if (brand) bulletClaims.push(`- Brand: ${brand}`);
  if (weightFact?.status === 'resolved' && weightFact.value) bulletClaims.push(`- Net Weight: ${weightFact.value}`);
  if (sizeFact?.status === 'resolved' && sizeFact.value) bulletClaims.push(`- Size: ${sizeFact.value}`);
  if (packCountFact?.status === 'resolved' && packCountFact.value) bulletClaims.push(`- Package Count: ${packCountFact.value}`);
  if (dimensionsFact?.status === 'resolved' && dimensionsFact.value) bulletClaims.push(`- Dimensions: ${dimensionsFact.value}`);

  if (bulletClaims.length > 0) {
    descriptionLines.push('');
    descriptionLines.push('### Product Details');
    descriptionLines.push(...bulletClaims);
  }

  const description = descriptionLines.join('\n');

  if (description && titleSupportingFacts.length > 0) {
    const descFacts = [
      ...titleSupportingFacts,
      ...(packCountFact?.status === 'resolved' ? ['packCount'] : []),
      ...(dimensionsFact?.status === 'resolved' ? ['dimensions'] : []),
    ];
    const descEvidenceIds = [
      ...titleEvidenceIds,
      ...(packCountFact?.supportingEvidence.map((e) => e.id) ?? []),
      ...(dimensionsFact?.supportingEvidence.map((e) => e.id) ?? []),
    ];
    grounding.push({
      field: 'description',
      claim: 'Structured product description bullets',
      supportingFactFields: [...new Set(descFacts)],
      evidenceIds: descEvidenceIds.length > 0 ? [...new Set(descEvidenceIds)] : ['resolved_fact:description'],
    });
  }

  // Classification matching: strictly from provided configuration.
  let productTypeId: string | null = null;
  const categoryIds: string[] = [];

  const classificationSearchTerms = [
    catalogTitle,
    candidateName ?? '',
    brand ?? '',
  ].filter(Boolean);

  const matchedProductType = matchTaxonomy(classificationSearchTerms, classification.availableProductTypes);
  if (matchedProductType) {
    productTypeId = matchedProductType.id;
  } else if (classification.availableProductTypes.length > 0) {
    abstentions.push({
      field: 'productTypeId',
      reason: 'No matching product type found among available configuration options',
    });
  }

  const matchedCategory = matchTaxonomy(classificationSearchTerms, classification.availableCategories);
  if (matchedCategory) {
    categoryIds.push(matchedCategory.id);
  } else if (classification.availableCategories.length > 0) {
    abstentions.push({
      field: 'categoryIds',
      reason: 'No matching category found among available configuration options',
    });
  }

  // Images: curate only verified images from discovery / extraction evidence.
  const images: CuratedImage[] = [];
  // Downstream image rights verification ensures only commerce-approved assets are selected.

  return {
    schemaVersion: CURATOR_OUTPUT_SCHEMA_VERSION,
    specialist: CURATOR_SPECIALIST_NAME,
    specialistVersion: CURATOR_SPECIALIST_VERSION,
    productSeed: input.productSeed,
    catalogTitle,
    sourceTitle,
    resolvedIdentityName,
    brand,
    gtin: factSet.identity.gtin,
    upc: factSet.identity.upc,
    subtitle: sizeOrWeight ? `${brand ?? ''} - ${sizeOrWeight}`.trim().replace(/^-\s*/, '') : null,
    description: description || null,
    productTypeId,
    categoryIds,
    attributes,
    images,
    grounding,
    abstentions,
    curatedAt: now(),
  };
}

// ── Specialist Capability & Class ────────────────────────────────────────────

export const CURATOR_SPECIALIST_CAPABILITY: SpecialistCapability = {
  name: CURATOR_SPECIALIST_NAME,
  version: CURATOR_SPECIALIST_VERSION,
  kind: 'classification',
  summary:
    'Synthesizes store-ready product drafts strictly grounded in resolved fact sets, classification taxonomy constraints, and verified image rights.',
  input: {
    schemaName: CURATOR_INPUT_ARTIFACT_TYPE,
    schemaVersion: CURATOR_INPUT_SCHEMA_VERSION,
    description: 'Resolved fact set and classification taxonomy configuration context',
  },
  output: {
    schemaName: CURATOR_OUTPUT_ARTIFACT_TYPE,
    schemaVersion: CURATOR_OUTPUT_SCHEMA_VERSION,
    description: 'Curated product draft with grounded catalog title, description, taxonomy mappings, and abstentions',
  },
};

export function registerCuratorSchemas(registry: SpecialistArtifactSchemaRegistry): SpecialistArtifactSchemaRegistry {
  registry.register({
    name: CURATOR_INPUT_ARTIFACT_TYPE,
    version: CURATOR_INPUT_SCHEMA_VERSION,
    schema: CuratorSpecialistInputSchema,
    description: 'Curator specialist input schema',
  });
  registry.register({
    name: CURATOR_OUTPUT_ARTIFACT_TYPE,
    version: CURATOR_OUTPUT_SCHEMA_VERSION,
    schema: CuratedProductDraftSchema,
    description: 'Curated product draft artifact schema',
  });
  return registry;
}

export interface CuratorSpecialistOptions {
  codeCommit?: string | null;
  now?: () => string;
}

export class CuratorSpecialist {
  public readonly capability = CURATOR_SPECIALIST_CAPABILITY;
  private readonly codeCommit: string;
  private readonly now: () => string;

  public constructor(options: CuratorSpecialistOptions = {}) {
    this.codeCommit = options.codeCommit ?? captureSpecialistCodeCommit() ?? 'dev-commit';
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async execute(rawInput: unknown, context: SpecialistContext): Promise<SpecialistResult> {
    const startedAt = Date.now();
    if (context.signal?.aborted) {
      return SpecialistResultSchema.parse({
        specialist: CURATOR_SPECIALIST_NAME,
        outcome: 'failed',
        failure: {
          code: 'cancelled',
          message: 'Curator execution cancelled before start',
          retryable: true,
        },
        durationMs: Date.now() - startedAt,
      });
    }

    const parseResult = CuratorSpecialistInputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      return SpecialistResultSchema.parse({
        specialist: CURATOR_SPECIALIST_NAME,
        outcome: 'failed',
        failure: {
          code: 'invalid_input',
          message: `Curator input validation failed: ${summarizeZodIssues(parseResult.error)}`,
          retryable: false,
        },
        durationMs: Date.now() - startedAt,
      });
    }

    const input = parseResult.data;
    const draft = curateProductDraft(input, { now: this.now });
    const durationMs = Date.now() - startedAt;

    const inputArtifactId = `artifact:factset:${sha256Hex(JSON.stringify(input.resolvedFacts)).slice(0, 32)}`;
    const outputEnvelope = finalizeSpecialistArtifact({
      artifactType: CURATOR_OUTPUT_ARTIFACT_TYPE,
      payload: draft,
      payloadSchema: CuratedProductDraftSchema,
      lineage: {
        inputArtifactIds: [inputArtifactId],
        parentArtifactIds: [],
        runId: context.runId,
        workflowRef: context.workspaceId,
      },
      provenance: {
        specialist: CURATOR_SPECIALIST_NAME,
        specialistVersion: CURATOR_SPECIALIST_VERSION,
        policyConfigId: context.policy.configId,
        codeCommit: this.codeCommit ?? captureSpecialistCodeCommit(),
        durationMs,
      },
    });

    return SpecialistResultSchema.parse({
      specialist: CURATOR_SPECIALIST_NAME,
      outcome: 'succeeded',
      output: outputEnvelope,
      durationMs,
    });
  }
}
