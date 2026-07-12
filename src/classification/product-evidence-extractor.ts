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
import { getLlmConfigForTask, callLlmForTask } from '../onboarding/llm-client';
import { getCachedBrands, getCachedDataSharingPolicy } from '../db/repositories/classification-config-repo';
import { resolveBrand } from './brand-resolution';
import type { StageInput, StageContext } from './types';
import type { ClassificationEvidence } from '../shared/types';
import type { PackagingOcrData } from '../shared/schemas/onboarding';

const now = () => new Date().toISOString();

// ─── Normalized Evidence Input ────────────────────────────────────────────────

/**
 * Source-neutral input for product evidence extraction.
 * Populated by either the onboarding adapter (from onboarding_items)
 * or the catalog adapter (from Product object).
 */
export interface NormalizedEvidenceInput {
  /** Product name/title */
  title: string | null;
  /** Product description */
  description: string | null;
  /** Brand name (free text) */
  brand: string | null;
  /** Product weight string */
  weight: string | null;
  /** Bullet-point features */
  bulletPoints: string[];
  /** SEO / search keywords */
  searchKeywords: string | null;
  /** Custom fields key-value pairs */
  customFields: Record<string, string>;
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
}

export interface EvidenceExtractionResult {
  /** All evidence collected during extraction */
  evidence: ClassificationEvidence[];
  /** Optional packaging OCR data (not persisted by this function) */
  packagingOcrData?: PackagingOcrData;
}

// ─── Packaging OCR evidence conversion ────────────────────────────────────────

interface OcrToEvidenceParams {
  runId: string;
  sku: string;
  model: string;
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

  return evidence;
}

/**
 * Extract product evidence from a normalized input.
 *
 * Produces ClassificationEvidence entries from text fields (title, description,
 * brand, customFields, etc.), runs VLM OCR on product images (up to 2), runs
 * cloud VLM fallback if configured, and performs LLM-based text extraction
 * for richer attribute identification.
 *
 * This function has NO dependency on the onboarding_items table.
 * The caller is responsible for persisting OCR results if needed.
 */
export async function extractProductEvidence(
  input: NormalizedEvidenceInput,
  stageInput: StageInput,
  context: StageContext,
): Promise<EvidenceExtractionResult> {
  const evidence: ClassificationEvidence[] = [];
  const sku = stageInput.sku;
  const sourceUrl = input.sourceUrl;

  // ── Emit text evidence from product fields ─────────────────────────────
  // Source depends on caller: 'spreadsheet' for onboarding, 'catalog_product' for catalog
  const textSource = stageInput.sourceKind === 'catalog_product'
    ? ('catalog_product' as const)
    : ('spreadsheet' as const);

  if (input.title) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: textSource,
      reliability: 'medium' as ClassificationEvidence['reliability'],
      sourceUrl: sourceUrl,
      sourceField: 'name',
      snippet: input.title.slice(0, 300),
      value: input.title,
      metadata: { provenance: textSource === 'catalog_product' ? 'catalog_product' : 'spreadsheet_import' },
      capturedAt: now(),
    });
  }

  // brand
  if (input.brand) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: textSource,
      reliability: 'medium' as ClassificationEvidence['reliability'],
      sourceUrl: sourceUrl,
      sourceField: 'brand',
      snippet: input.brand.slice(0, 300),
      value: input.brand,
      metadata: { provenance: textSource === 'catalog_product' ? 'catalog_product' : 'spreadsheet_import' },
      capturedAt: now(),
    });
  }

  // weight
  if (input.weight) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: textSource,
      reliability: 'medium' as ClassificationEvidence['reliability'],
      sourceUrl: sourceUrl,
      sourceField: 'weight',
      snippet: input.weight.slice(0, 300),
      value: input.weight,
      metadata: { provenance: textSource === 'catalog_product' ? 'catalog_product' : 'spreadsheet_import' },
      capturedAt: now(),
    });
  }

  // description
  if (input.description) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: 'official_product_page' as ClassificationEvidence['source'],
      reliability: 'medium' as ClassificationEvidence['reliability'],
      sourceUrl: sourceUrl,
      sourceField: 'description',
      snippet: input.description.slice(0, 500),
      value: input.description,
      metadata: { provenance: 'product_data', extractedAt: now() },
      capturedAt: now(),
    });
  }

  // bullet points
  if (input.bulletPoints?.length) {
    for (const bullet of input.bulletPoints) {
      if (!bullet?.trim()) continue;
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: sku,
        attributeId: null,
        source: 'official_product_page' as ClassificationEvidence['source'],
        reliability: 'medium' as ClassificationEvidence['reliability'],
        sourceUrl: sourceUrl,
        sourceField: 'bullet_point',
        snippet: String(bullet).slice(0, 300),
        value: String(bullet),
        metadata: { provenance: 'product_data', extractedAt: now() },
        capturedAt: now(),
      });
    }
  }

  // custom fields
  if (input.customFields && typeof input.customFields === 'object') {
    for (const [key, value] of Object.entries(input.customFields)) {
      if (value && String(value).trim().length > 0) {
        evidence.push({
          id: randomUUID(),
          runId: context.runId,
          stageName: 'evidence_extraction',
          productSku: sku,
          attributeId: null,
          source: textSource,
          reliability: 'medium' as ClassificationEvidence['reliability'],
          sourceUrl: sourceUrl,
          sourceField: key,
          snippet: String(value),
          value: String(value),
          metadata: { provenance: textSource === 'catalog_product' ? 'catalog_product' : 'product_data' },
          capturedAt: now(),
        });
      }
    }
  }

  // search keywords
  if (input.searchKeywords) {
    evidence.push({
      id: randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      attributeId: null,
      source: textSource,
      reliability: 'low' as ClassificationEvidence['reliability'],
      sourceUrl: sourceUrl,
      sourceField: 'search_keywords',
      snippet: input.searchKeywords.slice(0, 300),
      value: input.searchKeywords,
      metadata: { provenance: 'product_data' },
      capturedAt: now(),
    });
  }

  // Existing page context (for catalog products this provides awareness of current pages)
  if (input.existingPageNames?.length) {
    for (const pageName of input.existingPageNames) {
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: sku,
        attributeId: null,
        source: 'page_context' as ClassificationEvidence['source'],
        reliability: 'high' as ClassificationEvidence['reliability'],
        sourceUrl: null,
        sourceField: 'page_name',
        snippet: pageName.slice(0, 300),
        value: pageName,
        metadata: { provenance: 'existing_assignment' },
        capturedAt: now(),
      });
    }
  }

  // ── Resolve brand to canonical brand evidence ──────────────────────────
  if (input.brand) {
    try {
      const brands = getCachedBrands(context.workspaceId);
      const resolved = resolveBrand(input.brand, brands);
      if (resolved) {
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
          value: { id: resolved.brandId, name: resolved.brandName, confidence: resolved.confidence },
          metadata: { provenance: 'brand_resolution', matchedBy: resolved.matchedBy },
          capturedAt: now(),
        });
      }
    } catch (err: any) {
      console.warn(`[EvidenceExtraction] Brand resolution failed: ${err.message}`);
    }
  }

  // ── VLM OCR on product images ──────────────────────────────────────────
  let vlmOcrSucceeded = false;
  const ocrResults: PackagingOcrData[] = [];

  const vlmConfig = getVlmConfig();
  const canUseLocalVlm = vlmConfig?.enabled === true;
  let dataPolicy: any = null;
  try {
    dataPolicy = getCachedDataSharingPolicy(context.workspaceId);
  } catch {
    // Use defaults
  }
  const canUseCloud = dataPolicy?.textPolicy === 'cloud_allowed';

  if (canUseLocalVlm) {
    const MAX_OCR_IMAGES = 2;
    const imageUrls: string[] = [];
    if (input.primaryImage) imageUrls.push(input.primaryImage);
    if (input.additionalImages && Array.isArray(input.additionalImages)) {
      for (const img of input.additionalImages) {
        if (imageUrls.length >= MAX_OCR_IMAGES) break;
        if (img && String(img).trim()) {
          imageUrls.push(String(img));
        }
      }
    }

    if (imageUrls.length > 0) {
      console.log(`[EvidenceExtraction] Running VLM OCR on ${imageUrls.length} image(s) for SKU ${sku}`);
    }

    for (let i = 0; i < imageUrls.length; i++) {
      const imgUrl = imageUrls[i];
      try {
        const ocrResult = await extractPackagingOcr({
          imageUrl: imgUrl,
          workspacePath: input.workspacePath,
          imageSourceUrl: imgUrl,
          sku,
        });

        if (ocrResult) {
          ocrResults.push(ocrResult);
          console.log(`[EvidenceExtraction] VLM OCR completed for image ${i + 1}/${imageUrls.length} of SKU ${sku}`);
        } else {
          console.warn(`[EvidenceExtraction] VLM OCR returned no result for image ${i + 1}/${imageUrls.length} of SKU ${sku}`);
        }
      } catch (err: any) {
        console.warn(`[EvidenceExtraction] VLM OCR failed for image ${i + 1}/${imageUrls.length} of SKU ${sku}: ${err.message}`);
      }
    }

    if (ocrResults.length > 0) {
      vlmOcrSucceeded = true;
      const mergedOcr = ocrResults.length === 1 ? ocrResults[0] : mergeOcrResults(ocrResults);

      const visualEvidence = packagingOcrDataToEvidence(mergedOcr, {
        runId: context.runId,
        sku,
        model: mergedOcr.metadata?.model ?? 'unknown',
      });
      evidence.push(...visualEvidence);
      console.log(`[EvidenceExtraction] Added ${visualEvidence.length} evidence entries from packaging OCR`);

      // Return merged OCR data so the caller can persist if needed (onboarding adapter stores it)
      const extractionResult: EvidenceExtractionResult = {
        evidence,
        packagingOcrData: mergedOcr,
      };

      // ── Cloud multimodal VLM fallback ────────────────────────────────
      if (!vlmOcrSucceeded && input.primaryImage) {
        const canUseCloudImages = dataPolicy?.imagePolicy === 'cloud_allowed';
        if (canUseCloudImages) {
          try {
            const { extractPackagingOcrFromCloud } = await import('../onboarding/cloud-vlm-client');
            const cloudOcrResult = await extractPackagingOcrFromCloud({
              imageUrl: String(input.primaryImage),
            });

            if (cloudOcrResult) {
              const cloudEvidence = packagingOcrDataToEvidence(cloudOcrResult, {
                runId: context.runId,
                sku,
                model: (cloudOcrResult as any).metadata?.model ?? 'cloud-vision',
              });
              evidence.push(...cloudEvidence);
              console.log(`[EvidenceExtraction] Added ${cloudEvidence.length} evidence entries from cloud packaging OCR`);
            }
          } catch (err: any) {
            console.warn(`[EvidenceExtraction] Cloud packaging OCR failed: ${err.message}`);
          }
        }
      }

      // ── LLM-based text extraction for richer attributes ──────────────
      if (canUseCloud) {
        const llmConfig = getLlmConfigForTask('classification_evidence_extraction', { allowFallback: true });
        if (llmConfig) {
          const allText = [
            input.title,
            input.description,
            input.bulletPoints?.join(' ') ?? '',
            input.searchKeywords,
          ].filter(Boolean).join('\n');

          if (allText.length > 10) {
            try {
              const prompt = `Extract the following attributes from this product text. Return ONLY valid JSON with these keys (omit any you cannot determine): {"flavor": "..." | null, "color": "..." | null, "material": "..." | null, "size": "..." | null, "lifeStage": "..." | null, "breedSize": "..." | null, "productForm": "..." | null, "healthConcern": "..." | null, "ingredientKeywords": ["..."]}. Do not guess. Only include values that are explicitly mentioned.\n\nProduct text:\n${allText.slice(0, 3000)}`;

              const response = await callLlmForTask('classification_evidence_extraction', prompt, 'You are a precise product data extraction assistant. Return only valid JSON.', { allowFallback: true });
              if (response == null) {
                throw new Error('LLM call returned null');
              }
              const parsed = JSON.parse(response.trim());
              for (const [key, val] of Object.entries(parsed)) {
                if (val === null || val === undefined) continue;
                if (Array.isArray(val) && val.length === 0) continue;
                if (typeof val === 'string' && val.trim().length === 0) continue;

                evidence.push({
                  id: randomUUID(),
                  runId: context.runId,
                  stageName: 'evidence_extraction',
                  productSku: sku,
                  attributeId: key,
                  source: 'official_product_page' as ClassificationEvidence['source'],
                  reliability: 'medium' as ClassificationEvidence['reliability'],
                  sourceUrl,
                  sourceField: `llm_${key}`,
                  snippet: typeof val === 'string' ? val.slice(0, 300) : JSON.stringify(val).slice(0, 300),
                  value: val,
                  metadata: { provenance: 'llm_extraction', model: llmConfig.model },
                  capturedAt: now(),
                });
              }
            } catch (err: any) {
              console.warn(`[EvidenceExtraction] LLM extraction failed: ${err.message}`);
            }
          }
        }
      }

      return { evidence, packagingOcrData: mergedOcr };
    }
  }

  // No VLM OCR ran or all OCR failed — return text-only evidence
  return { evidence };
}
