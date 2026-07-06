import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection';
import { getVlmConfig } from '../../onboarding/vlm-client';
import { extractPackagingOcr } from '../../onboarding/packaging-ocr';
import { getLlmConfigForTask, callLlmForTask } from '../../onboarding/llm-client';
import { getCachedBrands, getCachedDataSharingPolicy } from '../../db/repositories/classification-config-repo';
import { resolveBrand } from '../brand-resolution';
import type { PackagingOcrData } from '../../shared/schemas/onboarding';

const now = () => new Date().toISOString();

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
function packagingOcrDataToEvidence(
  ocrData: PackagingOcrData,
  params: OcrToEvidenceParams,
): Array<Record<string, unknown>> {
  const evidence: Array<Record<string, unknown>> = [];
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
    sourceUrl: null,
    capturedAt: now(),
  };

  // productName
  if (ocrData.productName) {
    evidence.push({
      ...base,
      id: randomUUID(),
      attributeId: null,
      reliability: reliability('productName', 'high') as any,
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
      reliability: reliability('brand', 'high') as any,
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
        reliability: reliability('species', 'medium') as any,
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
      reliability: reliability('flavorVariety', 'medium') as any,
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
      reliability: reliability('color', 'medium') as any,
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
      reliability: reliability('material', 'medium') as any,
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
      reliability: reliability('size', 'medium') as any,
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
      reliability: reliability('weight', 'medium') as any,
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
      reliability: reliability('count', 'medium') as any,
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
      reliability: reliability('lifeStage', 'medium') as any,
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
      reliability: reliability('breedSize', 'medium') as any,
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
      reliability: reliability('productForm', 'medium') as any,
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
        reliability: reliability('healthConcernFunction', 'medium') as any,
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
        reliability: reliability('dietaryLabels', 'medium') as any,
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
        reliability: reliability('ingredientKeywords', 'low') as any,
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
        reliability: reliability('visibleTextLines', 'low') as any,
        sourceField: 'visible_text',
        snippet: val.slice(0, 300),
        value: val,
        metadata: { provenance: 'packaging_ocr', model, visibleText: true, confidence: ocrData.confidenceByField?.visibleTextLines ?? null },
      });
    }
  }

  return evidence;
}

/**
 * Evidence Extraction Stage
 *
 * Gathers textual and visual product evidence from available sources:
 * - Spreadsheet import data (already in initialEvidence)
 * - Web extraction data (title, description, structured text)
 * - VLM image analysis (packaging text OCR, visual attributes like color)
 *
 * Produces evidence records with source, reliability, and value metadata.
 */
export const evidenceExtractionStage: StageDefinition = {
  name: 'evidence_extraction',
  requires: [],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const evidence: any[] = [];
    const db = getDb();

    // Read the onboarding item's extraction data
    if (!input.onboardingItemId) {
      return { status: 'abstained', reason: 'No onboarding item ID available for evidence extraction.' };
    }

    const itemRow = db.query(
      'SELECT extraction_data_json, source_url, name, expected_name, brand_hint FROM onboarding_items WHERE id = ?'
    ).get(input.onboardingItemId) as Record<string, any> | undefined;

    if (!itemRow) {
      return { status: 'abstained', reason: 'No onboarding item found for evidence extraction.' };
    }

    const extData: Record<string, any> = itemRow.extraction_data_json
      ? JSON.parse(String(itemRow.extraction_data_json))
      : {};
    const sourceUrl = itemRow.source_url ? String(itemRow.source_url) : null;

    // ── Emit spreadsheet/import evidence from onboarding item fields ─────
    // These come from the spreadsheet import and represent the original
    // product identity data before any web extraction.

    const spreadsheetName = itemRow.name ? String(itemRow.name) : null;
    const spreadsheetExpectedName = itemRow.expected_name ? String(itemRow.expected_name) : null;
    const spreadsheetBrandHint = itemRow.brand_hint ? String(itemRow.brand_hint) : null;

    if (spreadsheetName) {
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'spreadsheet' as const,
        reliability: 'medium' as const,
        sourceUrl: null,
        sourceField: 'name',
        snippet: spreadsheetName.slice(0, 300),
        value: spreadsheetName,
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: now(),
      });
    }

    // expected_name is a more refined spreadsheet name (set during discovery consolidation)
    if (spreadsheetExpectedName && spreadsheetExpectedName !== spreadsheetName) {
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'spreadsheet' as const,
        reliability: 'medium' as const,
        sourceUrl: null,
        sourceField: 'expected_name',
        snippet: spreadsheetExpectedName.slice(0, 300),
        value: spreadsheetExpectedName,
        metadata: { provenance: 'spreadsheet_import', refinement: 'discovery_consolidation' },
        capturedAt: now(),
      });
    }

    if (spreadsheetBrandHint) {
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'spreadsheet' as const,
        reliability: 'medium' as const,
        sourceUrl: null,
        sourceField: 'brand',
        snippet: spreadsheetBrandHint.slice(0, 300),
        value: spreadsheetBrandHint,
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: now(),
      });
    }

    // ── Resolve brand to canonical brand ID from configured brands ────────
    // Runs after spreadsheet/OCR brand evidence is emitted. If brands are
    // configured in store/classification/brands.json, tries to resolve the
    // free-text brand hint (and web brand fallback) to a canonical brand ID.
    try {
      const resolutionCandidates: string[] = [];
      if (spreadsheetBrandHint) resolutionCandidates.push(spreadsheetBrandHint);
      if (extData.brand) resolutionCandidates.push(String(extData.brand));

      if (resolutionCandidates.length > 0) {
        const cachedBrands = getCachedBrands(context.workspaceId);
        if (cachedBrands.length > 0) {
          let resolution = resolveBrand(resolutionCandidates[0], cachedBrands);
          if (!resolution && resolutionCandidates.length > 1) {
            resolution = resolveBrand(resolutionCandidates[1], cachedBrands);
          }

          if (resolution) {
            evidence.push({
              id: randomUUID(),
              runId: context.runId,
              stageName: 'evidence_extraction' as const,
              productSku: input.sku,
              attributeId: null,
              source: 'catalog_manager_guidance' as const,
              reliability: 'high' as const,
              sourceUrl: null,
              sourceField: 'resolved_brand',
              snippet: resolution.brandName,
              value: { brandId: resolution.brandId, brandName: resolution.brandName },
              metadata: { matchedBy: resolution.matchedBy, confidence: resolution.confidence },
              capturedAt: now(),
            });
            console.log(`[EvidenceExtraction] Resolved brand "${resolutionCandidates[0]}" → ${resolution.brandName} (${resolution.matchedBy})`);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[EvidenceExtraction] Brand resolution failed: ${err.message}`);
    }

    // Check data-sharing policy before using cloud services
    let dataPolicy: any = null;
    try {
      dataPolicy = getCachedDataSharingPolicy(context.workspaceId);
    } catch {
      // Use defaults
    }
    const canUseCloud = !dataPolicy || dataPolicy.textPolicy !== 'local_only';
    const canUseLocalVlm = !!getVlmConfig()?.enabled;

    // ── Extract evidence from web-extracted data ──────────────────────────

    if (extData.title) {
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'official_product_page' as const,
        reliability: 'medium' as const,
        sourceUrl,
        sourceField: 'title',
        snippet: String(extData.title),
        value: String(extData.title),
        metadata: { provenance: 'web_scrape', extractedAt: now() },
        capturedAt: now(),
      });
    }

    if (extData.description) {
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'official_product_page' as const,
        reliability: 'medium' as const,
        sourceUrl,
        sourceField: 'description',
        snippet: String(extData.description).slice(0, 500),
        value: String(extData.description),
        metadata: { provenance: 'web_scrape', extractedAt: now() },
        capturedAt: now(),
      });
    }

    if (extData.brand) {
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'official_product_page' as const,
        reliability: 'high' as const,
        sourceUrl,
        sourceField: 'brand',
        snippet: String(extData.brand),
        value: String(extData.brand),
        metadata: { provenance: 'web_scrape', extractedAt: now() },
        capturedAt: now(),
      });
    }

    if (extData.weight) {
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'official_product_page' as const,
        reliability: 'high' as const,
        sourceUrl,
        sourceField: 'weight',
        snippet: String(extData.weight),
        value: String(extData.weight),
        metadata: { provenance: 'web_scrape', extractedAt: now() },
        capturedAt: now(),
      });
    }

    if (extData.bulletPoints && Array.isArray(extData.bulletPoints)) {
      for (const bullet of extData.bulletPoints) {
        evidence.push({
          id: randomUUID(),
          runId: context.runId,
          stageName: 'evidence_extraction',
          productSku: input.sku,
          attributeId: null,
          source: 'official_product_page' as const,
          reliability: 'medium' as const,
          sourceUrl,
          sourceField: 'bullet_point',
          snippet: String(bullet).slice(0, 300),
          value: String(bullet),
          metadata: { provenance: 'web_scrape', extractedAt: now() },
          capturedAt: now(),
        });
      }
    }

    if (extData.customFields && typeof extData.customFields === 'object') {
      for (const [key, value] of Object.entries(extData.customFields)) {
        if (value && String(value).trim().length > 0) {
          evidence.push({
            id: randomUUID(),
            runId: context.runId,
            stageName: 'evidence_extraction',
            productSku: input.sku,
            attributeId: null,
            source: 'official_product_page' as const,
            reliability: 'medium' as const,
            sourceUrl,
            sourceField: key,
            snippet: String(value),
            value: String(value),
            metadata: { provenance: 'web_scrape', extractedAt: now() },
            capturedAt: now(),
          });
        }
      }
    }

    // ── Extract visual evidence from product images ───────────────────────
    // Always run VLM OCR when a primary image exists and local VLM is
    // enabled, regardless of cached data. Use fresh OCR results; fall
    // back to cached data only if the VLM call fails.
    let vlmOcrSucceeded = false;

    if (extData.primaryImage && canUseLocalVlm) {
      try {
        const ocrResult = await extractPackagingOcr({
          imageUrl: String(extData.primaryImage),
          workspacePath: context.workspacePath,
          imageSourceUrl: String(extData.primaryImage),
          sku: input.sku,
        });

        if (ocrResult) {
          vlmOcrSucceeded = true;
          // Always update with fresh results
          extData.packagingOcrData = ocrResult;

          // Persist back to the item's extraction_data_json
          try {
            const updatedExt = { ...extData, packagingOcrData: ocrResult, packagingTitle: ocrResult.productName };
            db.query(
              'UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?',
            ).run(JSON.stringify(updatedExt), input.onboardingItemId);
          } catch (persistErr: any) {
            console.warn(`[EvidenceExtraction] Failed to persist fresh OCR: ${persistErr.message}`);
          }

          console.log(`[EvidenceExtraction] Fresh VLM OCR completed for item ${input.onboardingItemId}`);
        }
      } catch (err: any) {
        console.warn(`[EvidenceExtraction] VLM OCR failed for item ${input.onboardingItemId}: ${err.message}`);
        // Fall back to cached data if available — don't overwrite extData.packagingOcrData
      }
    }

    // Convert OCR data to evidence (fresh if we ran VLM, cached if VLM failed or was skipped)
    if (extData.packagingOcrData) {
      const visualEvidence = packagingOcrDataToEvidence(extData.packagingOcrData, {
        runId: context.runId,
        sku: input.sku,
        model: extData.packagingOcrData.metadata?.model ?? 'unknown',
      });
      evidence.push(...visualEvidence);
      console.log(`[EvidenceExtraction] Added ${visualEvidence.length} evidence entries from ${vlmOcrSucceeded ? 'fresh' : 'cached'} packaging OCR`);
    }

    // ── Cloud multimodal VLM fallback ─────────────────────────────────────
    // If local OCR was unavailable or produced no results, and data-sharing
    // policy allows cloud image processing, try cloud VLM as a last resort.
    //
    // Note: extData.packagingOcrData is checked first above (stored), then
    // local VLM (else-if branch). If neither produced results and the image
    // exists, this fallback runs when cloud is permitted.
    if (!extData.packagingOcrData && extData.primaryImage) {
      let dataPolicy: any = null;
      try {
        dataPolicy = getCachedDataSharingPolicy(context.workspaceId);
      } catch {
        // Use defaults — cloud not allowed
      }
      const canUseCloudImages = dataPolicy && dataPolicy.imagePolicy === 'cloud_allowed';

      if (canUseCloudImages) {
        try {
          const { extractPackagingOcrFromCloud } = await import('../../onboarding/cloud-vlm-client');
          const cloudOcrResult = await extractPackagingOcrFromCloud({
            imageUrl: String(extData.primaryImage),
          });

          if (cloudOcrResult) {
            // Persist back to extraction_data_json
            try {
              const updatedExt = { ...extData, packagingOcrData: cloudOcrResult, packagingTitle: cloudOcrResult.productName };
              db.query(
                'UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?',
              ).run(JSON.stringify(updatedExt), input.onboardingItemId);
            } catch (persistErr: any) {
              console.warn(`[EvidenceExtraction] Failed to persist cloud OCR: ${persistErr.message}`);
            }

            const visualEvidence = packagingOcrDataToEvidence(cloudOcrResult, {
              runId: context.runId,
              sku: input.sku,
              model: (cloudOcrResult as any).metadata?.model ?? 'cloud-vision',
            });
            evidence.push(...visualEvidence);
            console.log(`[EvidenceExtraction] Added ${visualEvidence.length} evidence entries from cloud packaging OCR`);
          }
        } catch (err: any) {
          console.warn(`[EvidenceExtraction] Cloud packaging OCR failed: ${err.message}`);
        }
      }
    }

    // ── LLM-based text extraction for richer attributes ───────────────────
    if (canUseCloud) {
      const llmConfig = getLlmConfigForTask('classification_evidence_extraction', { allowFallback: true });
      if (llmConfig) {
        const allText = [
          extData.title,
          extData.description,
          extData.bulletPoints?.join(' ') ?? '',
          extData.searchKeywords,
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
                productSku: input.sku,
                attributeId: key,
                source: 'official_product_page' as const,
                reliability: 'medium' as const,
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

    if (evidence.length === 0) {
      return { status: 'abstained', reason: 'No new evidence extracted from available sources.' };
    }

    return { status: 'succeeded', output: { evidence, proposals: [], abstained: false } };
  },
};
