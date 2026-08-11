import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { getDb } from '../../db/connection';
import { extractProductEvidence, packagingOcrDataToEvidence } from '../product-evidence-extractor';
import type { NormalizedEvidenceInput, EvidenceInputField } from '../product-evidence-extractor';
import { resolveBrand } from '../brand-resolution';
import { CanonicalBrandEvidenceValueSchema } from '../../shared/schemas/classification';
import { hashCanonicalJson } from '../../shared/stable-id';
import type { ExecutionEvidenceProjectionMemberV1 } from '../../shared/schemas/cohorts';
import type { ClassificationEvidence } from '../../shared/types';
import * as crypto from 'node:crypto';

const now = () => new Date().toISOString();

/**
 * Prepared-cohort (frozen) evidence extraction (issue #30 PR3 M2, amendment 4).
 *
 * When `StageContext` carries the member's frozen execution-evidence
 * projection (`cohortFrozenEvidence`), this stage builds evidence ONLY from
 * the projection's `spreadsheetIdentity` + `extraction` fields — it must NOT
 * query `onboarding_items` for semantic evidence, and it materializes
 * `classification_evidence` from the FROZEN stored packaging OCR via
 * `packagingOcrDataToEvidence` WITHOUT a model call. The OCR is trusted only
 * when its recorded `ocrInputHash` still matches the projection's own input
 * set (source/image set the attempt was started against) — a mismatch means
 * the stored OCR belongs to different inputs and is never materialized.
 */
function executeFrozenEvidenceExtraction(
  input: StageInput,
  context: StageContext,
  frozen: ExecutionEvidenceProjectionMemberV1,
): StageResult {
  const evidence: ClassificationEvidence[] = [];
  const sku = input.sku;
  const sourceUrl = frozen.sourceUrl;
  const ext = frozen.extraction;
  const identity = frozen.spreadsheetIdentity;

  const push = (entry: Omit<ClassificationEvidence, 'id' | 'runId' | 'stageName' | 'productSku' | 'capturedAt'>): void => {
    evidence.push({
      ...entry,
      id: crypto.randomUUID(),
      runId: context.runId,
      stageName: 'evidence_extraction',
      productSku: sku,
      capturedAt: now(),
    } as ClassificationEvidence);
  };

  // ── Spreadsheet identity (frozen spreadsheet hints) ────────────────────
  push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'name', snippet: identity.name.slice(0, 300), value: identity.name, metadata: { provenance: 'spreadsheet_import' } });
  if (identity.expectedName && identity.expectedName !== identity.name) {
    push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'expected_name', snippet: identity.expectedName.slice(0, 300), value: identity.expectedName, metadata: { provenance: 'spreadsheet_import', refinement: 'discovery_consolidation' } });
  }
  if (identity.brandHint) {
    push({ attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'brand', snippet: identity.brandHint.slice(0, 300), value: identity.brandHint, metadata: { provenance: 'spreadsheet_import' } });
  }

  // ── Normalized extraction fields (official product page) ───────────────
  const pageSource: ClassificationEvidence['source'] = 'official_product_page';
  if (ext.title && ext.title.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'name', snippet: ext.title.slice(0, 300), value: ext.title, metadata: { provenance: 'official_product_page' } });
  }
  if (ext.brand && ext.brand.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'brand', snippet: ext.brand.slice(0, 300), value: ext.brand, metadata: { provenance: 'official_product_page' } });
  }
  if (ext.weight && ext.weight.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'weight', snippet: ext.weight.slice(0, 300), value: ext.weight, metadata: { provenance: 'official_product_page' } });
  }
  if (ext.description && ext.description.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'description', snippet: ext.description.slice(0, 500), value: ext.description, metadata: { provenance: 'official_product_page' } });
  }
  for (const bullet of ext.bulletPoints) {
    if (!bullet || !bullet.trim()) continue;
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: 'bullet_point', snippet: String(bullet).slice(0, 300), value: String(bullet), metadata: { provenance: 'official_product_page' } });
  }
  if (ext.searchKeywords && ext.searchKeywords.trim()) {
    push({ attributeId: null, source: pageSource, reliability: 'low', sourceUrl, sourceField: 'search_keywords', snippet: ext.searchKeywords.slice(0, 300), value: ext.searchKeywords, metadata: { provenance: 'product_data' } });
  }
  for (const [key, rawVal] of Object.entries(ext.customFields)) {
    const value = String(rawVal ?? '').trim();
    if (!value) continue;
    push({ attributeId: null, source: pageSource, reliability: 'medium', sourceUrl, sourceField: key, snippet: value.slice(0, 300), value, metadata: { provenance: 'product_data' } });
  }

  // ── Canonical brand resolution from the FROZEN snapshot brands (parity
  //    with the non-cohort path; never a DB read). ────────────────────────
  const brandToResolve = ext.brand ?? identity.brandHint ?? null;
  if (brandToResolve && context.snapshot) {
    try {
      const resolved = resolveBrand(brandToResolve, context.snapshot.brands);
      if (resolved) {
        const brandValue = CanonicalBrandEvidenceValueSchema.parse({
          brandId: resolved.brandId,
          brandName: resolved.brandName,
          confidence: resolved.confidence,
          matchedBy: resolved.matchedBy,
        });
        push({ attributeId: null, source: 'catalog_manager_guidance', reliability: 'high', sourceUrl: null, sourceField: 'resolved_brand', snippet: resolved.brandName.slice(0, 300), value: brandValue, metadata: { provenance: 'brand_resolution', matchedBy: resolved.matchedBy } });
      }
    } catch (err) {
      console.warn(`[EvidenceExtraction] Frozen brand resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── FROZEN packaging OCR materialization (NO model call) ────────────────
  // The stored OCR is trusted only when its recorded ocrInputHash matches the
  // projection's own input set (recomputed from frozen fields — never a live
  // onboarding_items read). A terminal outcome + matching hash proves the OCR
  // belongs to exactly these inputs, so the exactly-once OCR guarantee holds.
  const frozenOcr = ext.ocr;
  const ocrInputHashMatches =
    frozenOcr.packagingOcrData != null &&
    hashCanonicalJson({
      sourceUrl: frozen.sourceUrl,
      extractionSourceUrl: frozen.extractionSourceUrl,
      primaryImage: ext.primaryImage,
      additionalImages: ext.additionalImages,
    }) === frozenOcr.ocrInputHash;
  if (frozenOcr.packagingOcrData && ocrInputHashMatches) {
    const modelCallIds = frozenOcr.packagingOcrData.metadata?.modelCallIds;
    const visualEvidence = packagingOcrDataToEvidence(frozenOcr.packagingOcrData, {
      runId: context.runId,
      sku,
      model: frozenOcr.outcome?.model ?? 'unknown',
      ...(Array.isArray(modelCallIds) && modelCallIds.length > 0 ? { modelCallIds } : {}),
    });
    evidence.push(...visualEvidence);
  }

  if (evidence.length === 0) {
    return {
      status: 'abstained',
      reason: 'No new evidence extracted from the frozen cohort projection.',
      output: {
        evidence: [],
        proposals: [],
        abstained: true,
        metadata: { ocrOutcome: frozenOcr.outcome, frozenProjection: true },
      },
    };
  }

  return {
    status: 'succeeded',
    output: {
      evidence,
      proposals: [],
      abstained: false,
      metadata: { ocrOutcome: frozenOcr.outcome, frozenProjection: true },
    },
  };
}

/**
 * Evidence Extraction Stage
 *
 * Gathers textual and visual product evidence from an onboarding item.
 * Adapted to use the shared extractor from product-evidence-extractor.ts.
 *
 * Onboarding-specific behavior preserved:
 * - Reads from onboarding_items table (NON-cohort mode only)
 * - Uses 'spreadsheet' source for import fields
 * - Persists VLM/cloud OCR results back to extraction_data_json (NON-cohort
 *   mode only)
 *
 * Prepared-cohort (frozen) mode (PR3 M2): when `context.cohortFrozenEvidence`
 * is present the stage builds evidence ONLY from the frozen projection (see
 * `executeFrozenEvidenceExtraction`) — no onboarding_items read, no model
 * calls, no write-back.
 */
export const evidenceExtractionStage: StageDefinition = {
  name: 'evidence_extraction',
  requires: [],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    if (context.cohortFrozenEvidence) {
      return executeFrozenEvidenceExtraction(input, context, context.cohortFrozenEvidence);
    }
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
