import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection';
import { getVlmConfig, callVlm } from '../../onboarding/vlm-client';
import { getLlmConfigForTask, callLlmForTask } from '../../onboarding/llm-client';
import { getCachedDataSharingPolicy } from '../../db/repositories/classification-config-repo';
import fs from 'fs';
import path from 'path';

const now = () => new Date().toISOString();

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
      'SELECT extraction_data_json, source_url FROM onboarding_items WHERE id = ?'
    ).get(input.onboardingItemId) as Record<string, any> | undefined;

    if (!itemRow) {
      return { status: 'abstained', reason: 'No onboarding item found for evidence extraction.' };
    }

    const extData: Record<string, any> = itemRow.extraction_data_json
      ? JSON.parse(String(itemRow.extraction_data_json))
      : {};
    const sourceUrl = itemRow.source_url ? String(itemRow.source_url) : null;

    // Check data-sharing policy before using cloud services
    let dataPolicy: any = null;
    try {
      dataPolicy = getCachedDataSharingPolicy(context.workspaceId);
    } catch {
      // Use defaults
    }
    const canUseCloud = !dataPolicy || dataPolicy.textPolicy !== 'local_only';
    const canUploadImages = dataPolicy?.imagePolicy === 'cloud_allowed';

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

    if (extData.price) {
      evidence.push({
        id: randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'official_product_page' as const,
        reliability: 'high' as const,
        sourceUrl,
        sourceField: 'price',
        snippet: String(extData.price),
        value: String(extData.price),
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

    // ── Extract visual evidence from product images ───────────────────────

    if (extData.primaryImage) {
      const imagePath = path.resolve(context.workspacePath, String(extData.primaryImage));
      if (fs.existsSync(imagePath)) {
        const vlmConfig = getVlmConfig();
        if (vlmConfig?.enabled && canUploadImages) {
          try {
            const buffer = fs.readFileSync(imagePath);
            const base64Image = buffer.toString('base64');

            // Try OCR for packaging text
            const ocrText = await callVlm(
              'Identify the main product name, brand name, flavor, color, size, and any visible packaging text from this product image. Return each fact as a separate line like "Name: ...", "Flavor: ...", "Color: ...". Do not guess or invent values.',
              base64Image,
              vlmConfig,
            );

            if (ocrText && ocrText.length > 2) {
              // Parse VLM output into structured evidence
              const lines = ocrText.split('\n').filter(l => l.trim().length > 0);
              for (const line of lines) {
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0) {
                  const field = line.slice(0, colonIdx).trim().toLowerCase();
                  const value = line.slice(colonIdx + 1).trim();
                  if (value && value.length > 1) {
                    evidence.push({
                      id: randomUUID(),
                      runId: context.runId,
                      stageName: 'evidence_extraction',
                      productSku: input.sku,
                      attributeId: null,
                      source: 'visual_product_evidence' as const,
                      reliability: 'medium' as const,
                      sourceUrl: null,
                      sourceField: `vlm_${field}`,
                      snippet: value.slice(0, 300),
                      value,
                      metadata: { provenance: 'vlm_ocr', model: vlmConfig.model },
                      capturedAt: now(),
                    });
                  }
                }
              }
            }
          } catch (err: any) {
            console.warn(`[EvidenceExtraction] VLM OCR failed: ${err.message}`);
          }
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
