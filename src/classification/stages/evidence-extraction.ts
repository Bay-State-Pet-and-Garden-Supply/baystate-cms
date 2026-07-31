import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { getDb } from '../../db/connection';
import { extractProductEvidence } from '../product-evidence-extractor';
import type { NormalizedEvidenceInput, EvidenceInputField } from '../product-evidence-extractor';
import * as crypto from 'node:crypto';

const now = () => new Date().toISOString();

/**
 * Evidence Extraction Stage
 *
 * Gathers textual and visual product evidence from an onboarding item.
 * Adapted to use the shared extractor from product-evidence-extractor.ts.
 *
 * Onboarding-specific behavior preserved:
 * - Reads from onboarding_items table
 * - Uses 'spreadsheet' source for import fields
 * - Persists VLM/cloud OCR results back to extraction_data_json
 */
export const evidenceExtractionStage: StageDefinition = {
  name: 'evidence_extraction',
  requires: [],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
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

    // Build per-field inputs with explicit source provenance
    const titleField = extData.title
      ? { value: String(extData.title), source: 'official_product_page' as const, sourceUrl }
      : (itemRow.name ? { value: String(itemRow.name), source: 'spreadsheet' as const, sourceUrl: null } : null);

    const descriptionField = extData.description
      ? { value: String(extData.description), source: 'official_product_page' as const, sourceUrl }
      : null;

    const brandField = extData.brand
      ? { value: String(extData.brand), source: 'official_product_page' as const, sourceUrl }
      : (itemRow.brand_hint ? { value: String(itemRow.brand_hint), source: 'spreadsheet' as const, sourceUrl: null } : null);

    const customFieldsMap: Record<string, EvidenceInputField<string>> = {};
    if (extData.customFields && typeof extData.customFields === 'object') {
      for (const [k, v] of Object.entries(extData.customFields)) {
        if (v != null && String(v).trim().length > 0) {
          customFieldsMap[k] = { value: String(v), source: 'official_product_page', sourceUrl };
        }
      }
    }

    const normalizedInput: NormalizedEvidenceInput = {
      title: titleField,
      description: descriptionField,
      brand: brandField,
      weight: extData.weight ? String(extData.weight) : null,
      bulletPoints: Array.isArray(extData.bulletPoints) ? extData.bulletPoints : [],
      searchKeywords: extData.searchKeywords ? String(extData.searchKeywords) : null,
      customFields: customFieldsMap,
      primaryImage: extData.primaryImage ?? null,
      additionalImages: Array.isArray(extData.additionalImages) ? extData.additionalImages : [],
      sourceUrl,
      existingPageNames: [],
      workspacePath: context.workspacePath,
    };

    // Call the shared extractor (this handles VLM OCR, LLM extraction, brand resolution)
    const result = await extractProductEvidence(normalizedInput, input, context);
    const evidence = result.evidence;

    // ── Onboarding-specific: emit spreadsheet fields as 'spreadsheet' source ──
    const spreadsheetName = itemRow.name ? String(itemRow.name) : null;
    const spreadsheetExpectedName = itemRow.expected_name ? String(itemRow.expected_name) : null;
    const spreadsheetBrandHint = itemRow.brand_hint ? String(itemRow.brand_hint) : null;

    const hasSpreadsheetNameEvidence = evidence.some(e => e.source === 'spreadsheet' && e.sourceField === 'name');
    if (spreadsheetName && !hasSpreadsheetNameEvidence) {
      evidence.push({
        id: crypto.randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'spreadsheet' as any,
        reliability: 'medium' as any,
        sourceUrl: null,
        sourceField: 'name',
        snippet: spreadsheetName.slice(0, 300),
        value: spreadsheetName,
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: now(),
      });
    }

    if (spreadsheetExpectedName && spreadsheetExpectedName !== spreadsheetName) {
      evidence.push({
        id: crypto.randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'spreadsheet' as any,
        reliability: 'medium' as any,
        sourceUrl: null,
        sourceField: 'expected_name',
        snippet: spreadsheetExpectedName.slice(0, 300),
        value: spreadsheetExpectedName,
        metadata: { provenance: 'spreadsheet_import', refinement: 'discovery_consolidation' },
        capturedAt: now(),
      });
    }

    const hasSpreadsheetBrandEvidence = evidence.some(e => e.source === 'spreadsheet' && e.sourceField === 'brand');
    if (spreadsheetBrandHint && !hasSpreadsheetBrandEvidence) {
      evidence.push({
        id: crypto.randomUUID(),
        runId: context.runId,
        stageName: 'evidence_extraction',
        productSku: input.sku,
        attributeId: null,
        source: 'spreadsheet' as any,
        reliability: 'medium' as any,
        sourceUrl: null,
        sourceField: 'brand',
        snippet: spreadsheetBrandHint.slice(0, 300),
        value: spreadsheetBrandHint,
        metadata: { provenance: 'spreadsheet_import' },
        capturedAt: now(),
      });
    }

    // ── Onboarding-specific: persist OCR data & outcome back to extraction_data_json ────
    if (result.ocrOutcome || result.packagingOcrData) {
      try {
        const mergedOcr = result.packagingOcrData;
        const updatedExt = {
          ...extData,
          ...(mergedOcr ? { packagingOcrData: mergedOcr, packagingTitle: mergedOcr.productName } : {}),
          ...(result.ocrOutcome ? { ocrOutcome: result.ocrOutcome } : {}),
        };
        db.query(
          'UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?',
        ).run(JSON.stringify(updatedExt), input.onboardingItemId);
      } catch (persistErr: any) {
        console.warn(`[EvidenceExtraction] Failed to persist OCR to onboarding item: ${persistErr.message}`);
      }
    }

    if (evidence.length === 0) {
      return {
        status: 'abstained',
        reason: 'No new evidence extracted from available sources.',
        output: {
          evidence: [],
          proposals: [],
          abstained: true,
          metadata: { ocrOutcome: result.ocrOutcome },
        },
      };
    }

    return {
      status: 'succeeded',
      output: {
        evidence,
        proposals: [],
        abstained: false,
        metadata: { ocrOutcome: result.ocrOutcome },
      },
    };
  },
};
