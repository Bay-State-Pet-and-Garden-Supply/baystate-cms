/**
 * Shared evidence extraction logic for classification pipelines.
 *
 * This module provides a source-neutral extraction function that takes
 * a NormalizedEvidenceInput and produces ClassificationEvidence entries.
 * It is used by both the onboarding evidence extraction stage and the
 * catalog product evidence extraction stage.
 */
import { randomUUID } from 'node:crypto';
import { getVlmConfig } from '../onboarding/vlm-client';
import { extractPackagingOcr, mergeOcrResults } from '../onboarding/packaging-ocr';
import { getLlmConfigForTask, callLlmForTaskWithProvenance } from '../onboarding/llm-client';
import { redactTransportText } from './model-policy-gateway';
import { MODEL_CALL_STATUS } from './model-operation-registry';
import { recordTerminalPreflight } from '../db/repositories/classification-model-call-repo';
import { modelPolicyViewFromConfig } from '../onboarding/model-policy-snapshot';
import { buildModelCallContext } from './runtime-snapshot';
import { getCachedBrands, getCachedDataSharingPolicy } from '../db/repositories/classification-config-repo';
import { resolveBrand } from './brand-resolution';
import type { StageInput, StageContext } from './types';
import type { ClassificationEvidence } from '../shared/types';
import { CanonicalBrandEvidenceValueSchema } from '../shared/schemas/classification';
import type { ModelPolicyConfigV2 } from '../shared/schemas/classification';
import type { PackagingOcrData, OcrAttemptOutcome } from '../shared/schemas/onboarding';
export type { OcrAttemptOutcome };

const now = () => new Date().toISOString();

export interface EvidenceInputField<T = string> {
  value: T | null;
  source?: ClassificationEvidence['source'];
  sourceUrl?: string | null;
  sourceField?: string | null;
  reliability?: ClassificationEvidence['reliability'];
  metadata?: Record<string, unknown>;
}

// ─── Normalized Evidence Input ────────────────────────────────────────────────

/**
 * Source-neutral input for product evidence extraction.
 * Populated by either the onboarding adapter (from onboarding_items)
 * or the catalog adapter (from Product object).
 */
export interface NormalizedEvidenceInput {
  /** Product name/title */
  title: string | EvidenceInputField<string> | null;
  /** Product description */
  description: string | EvidenceInputField<string> | null;
  /** Brand name (free text) */
  brand: string | EvidenceInputField<string> | null;
  /** Product weight string */
  weight: string | EvidenceInputField<string> | null;
  /** Bullet-point features */
  bulletPoints: string[] | EvidenceInputField<string[]>;
  /** SEO / search keywords */
  searchKeywords: string | EvidenceInputField<string> | null;
  /** Custom fields key-value pairs */
  customFields: Record<string, string | EvidenceInputField<string>>;
  /** Primary product image URL or path */
  primaryImage: string | null;
  /** Additional gallery image URLs or paths */
  additionalImages: string[];
  /** Source URL of the product page (null for catalog products) */
  sourceUrl: string | null;
  /** Existing category page names the product is assigned to */
  existingPageNames: string[];
  /** Workspace path for local file resolution */
  workspacePath: string;
  /** Override for default text evidence source label */
  evidenceSourceOverride?: ClassificationEvidence['source'];
  /** Distributor provider ID for metadata provenance */
  distributorProviderId?: string | null;
}



export interface EvidenceExtractionResult {
  /** All evidence collected during extraction */
  evidence: ClassificationEvidence[];
  /** Optional packaging OCR data (not persisted by this function) */
  packagingOcrData?: PackagingOcrData;
  /** Detailed outcome status and provenance of the OCR extraction attempt */
  ocrOutcome?: OcrAttemptOutcome;
}

// ─── Packaging OCR evidence conversion ────────────────────────────────────────

interface OcrToEvidenceParams {
  runId: string;
  sku: string;
  model: string;
  /** Durable model-call IDs that produced the OCR evidence (issue #17 E). */
  modelCallIds?: string[];
}

/**
 * Convert a stored PackagingOcrData object into ClassificationEvidence entries.
 * Each visible field produces one or more evidence records with appropriate
 * sourceField, attributeId, and reliability derived from per-field confidence.
 */
export function packagingOcrDataToEvidence(
  ocrData: PackagingOcrData,
  params: OcrToEvidenceParams,
): ClassificationEvidence[] {
  const evidence: ClassificationEvidence[] = [];
  const { runId, sku, model } = params;
  /** Resolve reliability — use per-field confidence when available. */
  const reliability = (field: string, fallback: string): string => {
    const confidence = ocrData.confidenceByField?.[field];
    if (confidence == null) return fallback;
    if (confidence >= 0.7) return 'high';
    if (confidence >= 0.4) return 'medium';
    return 'low';
  };

  const base = {
    runId,
    stageName: 'evidence_extraction' as const,
    productSku: sku,
    source: 'visual_product_evidence' as const,
    sourceUrl: null as string | null,
    capturedAt: now(),
  };

  // productName
  if (ocrData.productName) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: null,
      reliability: reliability('productName', 'high') as ClassificationEvidence['reliability'],
      sourceField: 'name',
      snippet: ocrData.productName.slice(0, 300),
      value: ocrData.productName,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.productName ?? null },
    });
  }

  // brand
  if (ocrData.brand) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: null,
      reliability: reliability('brand', 'high') as ClassificationEvidence['reliability'],
      sourceField: 'brand',
      snippet: ocrData.brand.slice(0, 300),
      value: ocrData.brand,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.brand ?? null },
    });
  }

  // species — one entry per value
  if (ocrData.species?.length) {
    for (const val of ocrData.species) {
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: null,
        reliability: reliability('species', 'medium') as ClassificationEvidence['reliability'],
        sourceField: 'species',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.species ?? null },
      });
    }
  }

  // flavorVariety
  if (ocrData.flavorVariety) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'flavor',
      reliability: reliability('flavorVariety', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'flavor',
      snippet: ocrData.flavorVariety.slice(0, 300),
      value: ocrData.flavorVariety,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.flavorVariety ?? null },
    });
  }

  // color
  if (ocrData.color) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'color',
      reliability: reliability('color', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'color',
      snippet: ocrData.color.slice(0, 300),
      value: ocrData.color,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.color ?? null },
    });
  }

  // material
  if (ocrData.material) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'material',
      reliability: reliability('material', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'material',
      snippet: ocrData.material.slice(0, 300),
      value: ocrData.material,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.material ?? null },
    });
  }

  // size
  if (ocrData.size) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'size',
      reliability: reliability('size', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'size',
      snippet: ocrData.size.slice(0, 300),
      value: ocrData.size,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.size ?? null },
    });
  }

  // weight
  if (ocrData.weight) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: null,
      reliability: reliability('weight', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'weight',
      snippet: ocrData.weight.slice(0, 300),
      value: ocrData.weight,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.weight ?? null },
    });
  }

  // count
  if (ocrData.count) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: null,
      reliability: reliability('count', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'count',
      snippet: ocrData.count.slice(0, 300),
      value: ocrData.count,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.count ?? null },
    });
  }

  // lifeStage
  if (ocrData.lifeStage) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'lifeStage',
      reliability: reliability('lifeStage', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'lifeStage',
      snippet: ocrData.lifeStage.slice(0, 300),
      value: ocrData.lifeStage,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.lifeStage ?? null },
    });
  }

  // breedSize
  if (ocrData.breedSize) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'breedSize',
      reliability: reliability('breedSize', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'breedSize',
      snippet: ocrData.breedSize.slice(0, 300),
      value: ocrData.breedSize,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.breedSize ?? null },
    });
  }

  // productForm
  if (ocrData.productForm) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: 'productForm',
      reliability: reliability('productForm', 'medium') as ClassificationEvidence['reliability'],
      sourceField: 'productForm',
      snippet: ocrData.productForm.slice(0, 300),
      value: ocrData.productForm,
      metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.productForm ?? null },
    });
  }

  // healthConcernFunction — one entry per value
  if (ocrData.healthConcernFunction?.length) {
    for (const val of ocrData.healthConcernFunction) {
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: 'healthConcern',
        reliability: reliability('healthConcernFunction', 'medium') as ClassificationEvidence['reliability'],
        sourceField: 'healthConcern',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.healthConcernFunction ?? null },
      });
    }
  }

  // dietaryLabels — one entry per label
  if (ocrData.dietaryLabels?.length) {
    for (const val of ocrData.dietaryLabels) {
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: null,
        reliability: reliability('dietaryLabels', 'medium') as ClassificationEvidence['reliability'],
        sourceField: 'dietaryLabel',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.dietaryLabels ?? null },
      });
    }
  }

  // ingredientKeywords — one entry per keyword (low reliability)
  if (ocrData.ingredientKeywords?.length) {
    for (const val of ocrData.ingredientKeywords) {
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: null,
        reliability: reliability('ingredientKeywords', 'low') as ClassificationEvidence['reliability'],
        sourceField: 'ingredientKeyword',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.ingredientKeywords ?? null },
      });
    }
  }

  // visibleTextLines — emit only first 3 lines to avoid bloat
  if (ocrData.visibleTextLines?.length) {
    const lines = ocrData.visibleTextLines.slice(0, 3);
    for (const val of lines) {
      if (!val?.trim()) continue;
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: null,
        reliability: reliability('visibleTextLines', 'low') as ClassificationEvidence['reliability'],
        sourceField: 'visible_text',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, visibleText: true, confidence: ocrData.confidenceByField?.visibleTextLines ?? null },
      });
    }
  }

  // ingredients — one entry per ingredient
  if (ocrData.ingredients?.length) {
    for (const val of ocrData.ingredients) {
      if (!val?.trim()) continue;
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: null,
        reliability: reliability('ingredients', 'medium') as ClassificationEvidence['reliability'],
        sourceField: 'ingredient',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.ingredients ?? null },
      });
    }
  }

  // claims — one entry per claim
  if (ocrData.claims?.length) {
    for (const val of ocrData.claims) {
      if (!val?.trim()) continue;
      evidence.push({
        ...base,
        id: randomUUID(),
        attributeId: null,
        reliability: reliability('claims', 'medium') as ClassificationEvidence['reliability'],
        sourceField: 'claim',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, confidence: ocrData.confidenceByField?.claims ?? null },
      });
    }
  }

  // Propagate the durable model-call IDs that produced this OCR evidence so
  // proposals/stage metadata can trace back to the exact calls (issue #17 E).
  if (params.modelCallIds?.length) {
    for (const e of evidence) {
      e.metadata = { ...(e.metadata ?? {}), modelCallIds: params.modelCallIds };
    }
  }

  return evidence;
}

function parseFieldInput<T>(
  fieldInput: T | EvidenceInputField<T> | null | undefined,
  defaultSource: ClassificationEvidence['source'],
  defaultUrl: string | null = null,
): {
  value: T | null;
  source: ClassificationEvidence['source'];
  sourceUrl: string | null;
  reliability: ClassificationEvidence['reliability'];
  metadata: Record<string, unknown>;
} {
  if (fieldInput == null) {
    return { value: null, source: defaultSource, sourceUrl: defaultUrl, reliability: 'medium', metadata: {} };
  }
  if (typeof fieldInput === 'object' && fieldInput !== null && 'value' in fieldInput) {
    const inputObj = fieldInput as EvidenceInputField<T>;
    return {
      value: inputObj.value,
      source: inputObj.source ?? defaultSource,
      sourceUrl: inputObj.sourceUrl !== undefined ? inputObj.sourceUrl : defaultUrl,
      reliability: inputObj.reliability ?? 'medium',
      metadata: inputObj.metadata ?? {},
    };
  }
  return {
    value: fieldInput as T,
    source: defaultSource,
    sourceUrl: defaultUrl,
    reliability: 'medium',
    metadata: {},
  };
}

function hasOcrContent(ocr: PackagingOcrData | undefined | null): boolean {
  if (!ocr) return false;
  if (ocr.productName && ocr.productName.trim().length > 0) return true;
  if (ocr.brand && ocr.brand.trim().length > 0) return true;
  if (ocr.visibleTextLines && ocr.visibleTextLines.some((b: string) => b && b.trim().length > 0)) return true;
  return false;
}

/**
 * Shared, source-neutral product evidence extractor.
 */
export async function extractProductEvidence(
  input: NormalizedEvidenceInput,
  stageInput: StageInput,
  context: StageContext,
): Promise<EvidenceExtractionResult> {
  const evidence: ClassificationEvidence[] = [];
  const sku = stageInput.sku;
  const sourceUrl = input.sourceUrl;

  const defaultTextSource = stageInput.sourceKind === 'catalog_product'
    ? ('catalog_product' as const)
    : ('official_product_page' as const);

  // 1. Title
  const titleInfo = parseFieldInput(input.title, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (titleInfo.value && typeof titleInfo.value === 'string' && titleInfo.value.trim().length > 0) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: titleInfo.source,
      reliability: titleInfo.reliability,
      sourceUrl: titleInfo.sourceUrl,
      sourceField: 'name',
      snippet: titleInfo.value.slice(0, 300),
      value: titleInfo.value,
      metadata: { provenance: titleInfo.source === 'catalog_product' ? 'catalog_product' : titleInfo.source === 'spreadsheet' ? 'spreadsheet_import' : 'official_product_page', ...titleInfo.metadata },
      capturedAt: now(),
    });
  }

  // 2. Brand
  const brandInfo = parseFieldInput(input.brand, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (brandInfo.value && typeof brandInfo.value === 'string' && brandInfo.value.trim().length > 0) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: brandInfo.source,
      reliability: brandInfo.reliability,
      sourceUrl: brandInfo.sourceUrl,
      sourceField: 'brand',
      snippet: brandInfo.value.slice(0, 300),
      value: brandInfo.value,
      metadata: { provenance: brandInfo.source === 'catalog_product' ? 'catalog_product' : brandInfo.source === 'spreadsheet' ? 'spreadsheet_import' : 'official_product_page', ...brandInfo.metadata },
      capturedAt: now(),
    });
  }

  // 3. Weight
  const weightInfo = parseFieldInput(input.weight, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (weightInfo.value && typeof weightInfo.value === 'string' && weightInfo.value.trim().length > 0) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: weightInfo.source,
      reliability: weightInfo.reliability,
      sourceUrl: weightInfo.sourceUrl,
      sourceField: 'weight',
      snippet: weightInfo.value.slice(0, 300),
      value: weightInfo.value,
      metadata: { provenance: weightInfo.source === 'catalog_product' ? 'catalog_product' : weightInfo.source === 'spreadsheet' ? 'spreadsheet_import' : 'official_product_page', ...weightInfo.metadata },
      capturedAt: now(),
    });
  }

  // 4. Description
  const descInfo = parseFieldInput(input.description, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (descInfo.value && typeof descInfo.value === 'string' && descInfo.value.trim().length > 0) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: descInfo.source,
      reliability: descInfo.reliability,
      sourceUrl: descInfo.sourceUrl,
      sourceField: 'description',
      snippet: descInfo.value.slice(0, 500),
      value: descInfo.value,
      metadata: { provenance: descInfo.source === 'catalog_product' ? 'catalog_product' : descInfo.source === 'spreadsheet' ? 'spreadsheet_import' : 'official_product_page', extractedAt: now(), ...descInfo.metadata },
      capturedAt: now(),
    });
  }

  // 5. Bullet points
  const bulletInfo = parseFieldInput(input.bulletPoints, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (Array.isArray(bulletInfo.value) && bulletInfo.value.length > 0) {
    for (const bullet of bulletInfo.value) {
      if (!bullet?.trim()) continue;
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: sku,
        attributeId: null,
        source: bulletInfo.source,
        reliability: bulletInfo.reliability,
        sourceUrl: bulletInfo.sourceUrl,
        sourceField: 'bullet_point',
        snippet: String(bullet).slice(0, 300),
        value: String(bullet),
        metadata: { provenance: bulletInfo.source === 'catalog_product' ? 'catalog_product' : bulletInfo.source === 'spreadsheet' ? 'spreadsheet_import' : 'official_product_page', extractedAt: now(), ...bulletInfo.metadata },
        capturedAt: now(),
      });
    }
  }

  // 6. Custom fields
  if (input.customFields && typeof input.customFields === 'object') {
    for (const [key, rawVal] of Object.entries(input.customFields)) {
      const fieldInfo = parseFieldInput(rawVal, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
      if (fieldInfo.value && String(fieldInfo.value).trim().length > 0) {
        evidence.push({
          id: randomUUID(),
          runId: context.runId,
          stageName: 'evidence_extraction',
          productSku: sku,
          attributeId: null,
          source: fieldInfo.source,
          reliability: fieldInfo.reliability,
          sourceUrl: fieldInfo.sourceUrl,
          sourceField: key,
          snippet: String(fieldInfo.value),
          value: String(fieldInfo.value),
          metadata: { provenance: fieldInfo.source === 'catalog_product' ? 'catalog_product' : 'product_data', ...fieldInfo.metadata },
          capturedAt: now(),
        });
      }
    }
  }

  // 7. Search keywords
  const kwInfo = parseFieldInput(input.searchKeywords, (input.evidenceSourceOverride ?? defaultTextSource), sourceUrl);
  if (kwInfo.value && typeof kwInfo.value === 'string' && kwInfo.value.trim().length > 0) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: kwInfo.source,
      reliability: 'low' as ClassificationEvidence['reliability'],
      sourceUrl: kwInfo.sourceUrl,
      sourceField: 'search_keywords',
      snippet: kwInfo.value.slice(0, 300),
      value: kwInfo.value,
      metadata: { provenance: 'product_data', ...kwInfo.metadata },
      capturedAt: now(),
    });
  }

  // 8. Existing page context — name-only review context with LOW reliability.
  //    Page context never supports claims or composition (pageContextReliability
  //    is fixed to 'low' and verified identity is false until a real export).
  if (input.existingPageNames?.length) {
    for (const pageName of input.existingPageNames) {
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: sku,
        attributeId: null,
        source: 'page_context' as ClassificationEvidence['source'],
        reliability: 'low' as ClassificationEvidence['reliability'],
        sourceUrl: null,
        sourceField: 'page_name',
        snippet: pageName.slice(0, 300),
        value: pageName,
        metadata: {
          provenance: 'existing_assignment',
          pageContextReliability: 'low',
          verifiedPageIdentity: false,
        },
        capturedAt: now(),
      });
    }
  }

  // 9. Resolve brand to canonical brand evidence using CanonicalBrandEvidenceValueSchema
  const rawBrandStr = typeof titleInfo.value === 'string' ? titleInfo.value : (typeof brandInfo.value === 'string' ? brandInfo.value : null);
  if (rawBrandStr || input.brand) {
    const brandToResolve = typeof input.brand === 'string' ? input.brand : (typeof input.brand === 'object' && input.brand?.value ? String(input.brand.value) : rawBrandStr);
    if (brandToResolve) {
      try {
        const brands = context.snapshot
          ? context.snapshot.brands
          : getCachedBrands(context.workspaceId);
        const resolved = resolveBrand(brandToResolve, brands);
        if (resolved) {
          const brandValue = CanonicalBrandEvidenceValueSchema.parse({
            brandId: resolved.brandId,
            brandName: resolved.brandName,
            confidence: resolved.confidence,
            matchedBy: resolved.matchedBy,
          });
          evidence.push({
            id: randomUUID(),
            runId: context.runId,
            stageName: 'evidence_extraction',
            productSku: sku,
            attributeId: null,
            source: 'catalog_manager_guidance' as ClassificationEvidence['source'],
            reliability: 'high' as ClassificationEvidence['reliability'],
            sourceUrl: null,
            sourceField: 'resolved_brand',
            snippet: resolved.brandName.slice(0, 300),
            value: brandValue,
            metadata: { provenance: 'brand_resolution', matchedBy: resolved.matchedBy },
            capturedAt: now(),
          });
        }
      } catch (err: any) {
        console.warn(`[EvidenceExtraction] Brand resolution failed: ${redactTransportText(err.message)}`);
      }
    }
  }

  // ── VLM OCR and LLM Enrichment ──────────────────────────────────────────
  let localOcrSucceeded = false;
  let packagingOcrData: PackagingOcrData | undefined = undefined;
  const ocrResults: PackagingOcrData[] = [];

  const vlmConfig = getVlmConfig();
  const canUseLocalVlm = vlmConfig?.enabled === true;
  let dataPolicy: any = null;
  try {
    dataPolicy = context.snapshot
      ? context.snapshot.dataSharing
      : getCachedDataSharingPolicy(context.workspaceId);
  } catch {
    // Use defaults
  }
  const canUseCloudText = dataPolicy?.textPolicy === 'cloud_allowed';
  const canUseCloudImages = dataPolicy?.imagePolicy === 'cloud_allowed';

  let localStatus: OcrAttemptOutcome['status'] = canUseLocalVlm ? 'skipped' : 'disabled';
  let cloudStatus: OcrAttemptOutcome['status'] = canUseCloudImages ? 'skipped' : 'disabled';
  let llmStatus: OcrAttemptOutcome['llmStatus'] = canUseCloudText ? 'skipped' : 'disabled';

  const imageUrls: string[] = [];
  if (input.primaryImage) imageUrls.push(input.primaryImage);
  if (input.additionalImages && Array.isArray(input.additionalImages)) {
    for (const img of input.additionalImages) {
      if (imageUrls.length >= 2) break;
      if (img && String(img).trim()) {
        imageUrls.push(String(img));
      }
    }
  }

  // 1. Local VLM OCR
  if (canUseLocalVlm) {
    if (imageUrls.length > 0) {
      console.log(`[EvidenceExtraction] Running VLM OCR on ${imageUrls.length} image(s) for SKU ${sku}`);
      localStatus = 'failed';
    } else {
      localStatus = 'no_image';
    }

    for (let i = 0; i < imageUrls.length; i++) {
      const imgUrl = imageUrls[i];
      try {
        // Run-bound local VLM calls are audited (issue #17 E): the call
        // context binds the transport to the run snapshot plan and the
        // resulting callId flows into the OCR evidence metadata.
        const localModelCall = context.snapshot
          ? buildModelCallContext(context.snapshot, context.runId, 'evidence_extraction', 1)
          : null;
        const ocrResult = await extractPackagingOcr({
          imageUrl: imgUrl,
          workspacePath: input.workspacePath,
          imageSourceUrl: imgUrl,
          sku,
          ...(localModelCall && context.snapshot
            ? { modelCall: localModelCall, snapshot: context.snapshot }
            : {}),
        });

        if (ocrResult && hasOcrContent(ocrResult)) {
          ocrResults.push(ocrResult);
          console.log(`[EvidenceExtraction] VLM OCR completed for image ${i + 1}/${imageUrls.length} of SKU ${sku}`);
        } else {
          console.warn(`[EvidenceExtraction] VLM OCR returned no text content for image ${i + 1}/${imageUrls.length} of SKU ${sku}`);
        }
      } catch (err: any) {
        console.warn(`[EvidenceExtraction] VLM OCR failed for image ${i + 1}/${imageUrls.length} of SKU ${sku}: ${redactTransportText(err.message)}`);
      }
    }

    if (ocrResults.length > 0) {
      const mergedOcr = ocrResults.length === 1 ? ocrResults[0] : mergeOcrResults(ocrResults);
      if (hasOcrContent(mergedOcr)) {
        localOcrSucceeded = true;
        localStatus = 'succeeded';
        packagingOcrData = mergedOcr;

        const visualEvidence = packagingOcrDataToEvidence(mergedOcr, {
          runId: context.runId,
          sku,
          model: mergedOcr.metadata?.model ?? 'unknown',
          ...(Array.isArray((mergedOcr.metadata as { modelCallIds?: string[] } | undefined)?.modelCallIds)
            ? { modelCallIds: (mergedOcr.metadata as unknown as { modelCallIds: string[] }).modelCallIds }
            : {}),
        });
        evidence.push(...visualEvidence);
        console.log(`[EvidenceExtraction] Added ${visualEvidence.length} evidence entries from local packaging OCR`);
      }
    }
  }

  // 2. Cloud multimodal VLM fallback (runs if local OCR did not succeed and cloud images are allowed)
  if (!localOcrSucceeded && input.primaryImage && canUseCloudImages) {
    cloudStatus = 'failed';
    try {
      // Protected operation: route through the frozen classification policy
      // (issue #17 pass 1b). Without a snapshot, no policy exists → disabled
      // → no transport.
      const evidencePolicyView = context.snapshot
        ? modelPolicyViewFromConfig(
            context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            context.snapshot.snapshotHash,
          )
        : null;
      const { extractPackagingOcrFromCloud } = await import('../onboarding/cloud-vlm-client');
      const cloudOcrResult = await extractPackagingOcrFromCloud({
        imageUrl: String(input.primaryImage),
        modelPolicy: evidencePolicyView,
        ...(context.snapshot
          ? {
              modelCall: buildModelCallContext(context.snapshot, context.runId, 'evidence_extraction', 1),
              snapshot: context.snapshot,
            }
          : {}),
      });

      if (cloudOcrResult && hasOcrContent(cloudOcrResult)) {
        packagingOcrData = cloudOcrResult;
        cloudStatus = 'succeeded';
        const cloudModelCallIds = (cloudOcrResult as { metadata?: { modelCallIds?: string[] } }).metadata?.modelCallIds;
        const cloudEvidence = packagingOcrDataToEvidence(cloudOcrResult, {
          runId: context.runId,
          sku,
          model: (cloudOcrResult as any).metadata?.model ?? 'cloud-vision',
          ...(cloudModelCallIds?.length ? { modelCallIds: cloudModelCallIds } : {}),
        });
        evidence.push(...cloudEvidence);
        console.log(`[EvidenceExtraction] Added ${cloudEvidence.length} evidence entries from cloud packaging OCR`);
      }
    } catch (err: any) {
      console.warn(`[EvidenceExtraction] Cloud packaging OCR failed: ${redactTransportText(err.message)}`);
    }
  }

  // 3. LLM-based text extraction for richer attributes (decoupled from OCR)
  if (canUseCloudText) {
    // Protected operation: route through the frozen classification policy
    // (issue #17 item A). Without a snapshot, no policy exists → disabled →
    // no transport.
    const evidencePolicyView = context.snapshot
      ? modelPolicyViewFromConfig(
          context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
          context.snapshot.snapshotHash,
        )
      : null;
    const preflightModelCall = context.snapshot
      ? buildModelCallContext(context.snapshot, context.runId, 'evidence_extraction', 1)
      : null;
    let llmConfig: import('../onboarding/llm-client').LlmConfig | null;
    try {
      llmConfig = getLlmConfigForTask('classification_evidence_extraction', {
        allowFallback: true,
        modelPolicy: evidencePolicyView,
        protectedOperation: 'evidence_extraction',
      });
    } catch (err) {
      recordTerminalPreflight(
        preflightModelCall,
        evidencePolicyView?.policyDigest ?? '',
        MODEL_CALL_STATUS.policyDenied,
        `Model policy denied text evidence extraction (${err instanceof Error ? err.message : String(err)}).`,
      );
      llmConfig = null;
    }
    if (llmConfig) {
      const titleStr = typeof titleInfo.value === 'string' ? titleInfo.value : '';
      const descStr = typeof descInfo.value === 'string' ? descInfo.value : '';
      const allText = [
        titleStr,
        descStr,
        Array.isArray(bulletInfo.value) ? bulletInfo.value.join(' ') : '',
        typeof kwInfo.value === 'string' ? kwInfo.value : '',
      ].filter(Boolean).join('\n');

      if (allText.length > 10) {
        // Durable model-call audit context (issue #17 E): bound to the run
        // snapshot plan; null when the snapshot has no compatible plan (then
        // the wrapper fails closed before transport).
        const modelCall = context.snapshot
          ? buildModelCallContext(context.snapshot, context.runId, 'evidence_extraction', 1)
          : null;
        try {
          const prompt = `Extract the following attributes from this product text. Return ONLY valid JSON with these keys (omit any you cannot determine): {"flavor": "..." | null, "color": "..." | null, "material": "..." | null, "size": "..." | null, "lifeStage": "..." | null, "breedSize": "..." | null, "productForm": "..." | null, "healthConcern": "..." | null, "ingredientKeywords": ["..."]}. Do not guess. Only include values that are explicitly mentioned.\n\nProduct text:\n${allText.slice(0, 3000)}`;

          const response = await callLlmForTaskWithProvenance('classification_evidence_extraction', prompt, 'You are a precise product data extraction assistant. Return only valid JSON.', {
            allowFallback: true,
            modelPolicy: evidencePolicyView,
            protectedOperation: 'evidence_extraction',
            ...(modelCall ? { modelCall, snapshot: context.snapshot } : {}),
          });
          if (response == null) {
            throw new Error('LLM call returned null');
          }
          const parsed = JSON.parse(response.content.trim());
          let addedLlmEvidence = false;
          for (const [key, val] of Object.entries(parsed)) {
            if (val === null || val === undefined) continue;
            if (Array.isArray(val) && val.length === 0) continue;
            if (typeof val === 'string' && val.trim().length === 0) continue;

            addedLlmEvidence = true;
            evidence.push({
              id: randomUUID(),
              runId: context.runId,
              stageName: 'evidence_extraction',
              productSku: sku,
              attributeId: key,
              source: (input.evidenceSourceOverride ?? defaultTextSource) as ClassificationEvidence['source'],
              reliability: 'medium' as ClassificationEvidence['reliability'],
              sourceUrl,
              sourceField: `llm_${key}`,
              snippet: typeof val === 'string' ? val.slice(0, 300) : JSON.stringify(val).slice(0, 300),
              value: val,
              metadata: { provenance: defaultTextSource, model: llmConfig.model, modelCallIds: [response.callId] },
              capturedAt: now(),
            });
          }
          llmStatus = addedLlmEvidence ? 'succeeded' : 'failed';
        } catch (err: any) {
          llmStatus = 'failed';
          console.warn(`[EvidenceExtraction] LLM extraction failed: ${redactTransportText(err.message)}`);
        }
      } else {
        llmStatus = 'no_text';
      }
    } else {
      // Preflight decided not to call the model (no config): the attempted
      // call is still observable via a durable `unavailable` terminal row.
      llmStatus = 'failed';
      recordTerminalPreflight(
        preflightModelCall,
        evidencePolicyView?.policyDigest ?? '',
        MODEL_CALL_STATUS.unavailable,
        'No LLM config available for text evidence extraction.',
      );
    }
  }

  const overallStatus: OcrAttemptOutcome['status'] =
    (localStatus === 'succeeded' || cloudStatus === 'succeeded')
      ? 'succeeded'
      : (imageUrls.length === 0)
        ? 'no_image'
        : (!canUseLocalVlm && !canUseCloudImages)
          ? 'disabled'
          : 'failed';

  const ocrOutcome: OcrAttemptOutcome = {
    status: overallStatus,
    localStatus,
    cloudStatus,
    llmStatus,
    model: packagingOcrData?.metadata?.model ?? vlmConfig?.model ?? null,
    imageCount: imageUrls.length,
  };

  return { evidence, packagingOcrData, ocrOutcome };
}
