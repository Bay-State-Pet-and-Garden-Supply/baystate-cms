/**
 * PI-8 onboarding import — a reviewed Agent Lab run imported into an
 * onboarding item (create or augment).
 *
 * Principles (from #25):
 * - Import is idempotent per (run, item) and atomic (single transaction).
 * - Import NEVER creates accepted classification decisions; imported evidence
 *   only enters the item's extraction data with a distinct provenance type
 *   (`productIntelligenceEvidence`) that the classification pipeline reads.
 * - Manual/approved values are never silently overwritten: competing values
 *   are recorded as excluded values on the import record, and identical
 *   values are deduplicated.
 * - A newer Agent Lab run does not silently replace an imported result:
 *   multiple active imports can coexist per item (UNIQUE is per run+item).
 * - Promotion rejects a missing, stale, or mismatched origin via
 *   `verifyImportedResultGate` (run + result hash + active import record).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/25
 */
import { getDb } from '../db/connection';
import { createBatch } from '../db/repositories/onboarding-batch-repo';
import { findBatchById } from '../db/repositories/onboarding-batch-repo';
import { findItemById, insertItems } from '../db/repositories/onboarding-item-repo';
import {
  getPiImportByRunAndItem,
  getPiResult,
  getPiRun,
  insertPiImport,
  listPiAssetsByRun,
  listPiImportsByRun,
  updatePiImportStatus,
  type PiImportRow,
} from '../db/repositories/product-intelligence-repo';
import type { ExtractionData, OnboardingItem } from '../shared/schemas/onboarding';
import { getProductIntelligenceFlags } from './flags';

export interface ImportRunResult {
  importRecord: PiImportRow;
  item: OnboardingItem;
  batchId: string | null;
  created: boolean;
}

export interface ImportRunOptions {
  mode: 'create' | 'augment';
  onboardingItemId?: string | null;
  fieldSelection?: string[];
  price?: string | null;
  quantity?: number | null;
  importingUser?: string | null;
}

interface ParsedRun {
  runId: string;
  workspaceId: string;
  gtinDigits: string;
  registerName: string;
  resultHash: string;
  envelope: Record<string, unknown>;
}

/** Proposal field extraction (mirrors src/client/agent-lab/logic.ts). */
interface ProposalField {
  field: string;
  value: unknown;
  evidenceIds: string[];
}

function digitsOf(value: string | null | undefined): string {
  return String(value ?? '').replace(/[^0-9]/g, '');
}

function parseRun(runId: string): ParsedRun {
  const run = getPiRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== 'completed') {
    throw new Error(`Run ${runId} is not completed (${run.status})`);
  }
  const result = getPiResult(runId);
  if (!result) throw new Error(`Run ${runId} has no result`);
  if (result.disposition !== 'submitted') {
    throw new Error(`Run ${runId} result was not submitted (${result.disposition})`);
  }
  if (!result.resultHash) throw new Error(`Run ${runId} result has no content hash`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.resultJson);
  } catch {
    throw new Error(`Run ${runId} result JSON could not be parsed`);
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  // The server persists the full ProductResearchResult envelope with the
  // submission nested under `submission`; fall back to the top level.
  const envelope = obj.submission && typeof obj.submission === 'object' && !Array.isArray(obj.submission)
    ? (obj.submission as Record<string, unknown>)
    : obj;

  let runInput: Record<string, unknown> = {};
  try {
    runInput = JSON.parse(run.inputJson) as Record<string, unknown>;
  } catch {
    // inputJson is written by the service and always valid; stay defensive.
  }

  const gtinDigits = digitsOf(typeof runInput.gtin === 'string' ? runInput.gtin : null);
  const registerName = String(runInput.registerName ?? envelope.inputName ?? envelope.gtin ?? gtinDigits);
  if (!gtinDigits) throw new Error(`Run ${runId} input has no GTIN`);

  return { runId, workspaceId: run.workspaceId, gtinDigits, registerName, resultHash: result.resultHash, envelope };
}

function proposalFieldsOf(envelope: Record<string, unknown>): ProposalField[] {
  const fields: ProposalField[] = [];
  // PI-1 envelope: productProposal.fields[].field
  const proposal = envelope.productProposal as Record<string, unknown> | undefined;
  if (proposal && Array.isArray(proposal.fields)) {
    for (const f of proposal.fields as Array<Record<string, unknown>>) {
      const key = String(f.field ?? '');
      if (key) fields.push({ field: key, value: f.value, evidenceIds: (f.evidenceIds as string[] | undefined) ?? [] });
    }
  }
  // PI-4 bundle: identity (canonicalName -> title) + commerceFacts
  const identity = envelope.identity as Record<string, unknown> | undefined;
  if (identity) {
    const identityFields: Array<[string, string]> = [
      ['canonicalName', 'title'],
      ['brand', 'brand'],
      ['manufacturer', 'manufacturer'],
      ['variant', 'variant'],
    ];
    for (const [srcKey, destKey] of identityFields) {
      if (identity[srcKey] != null) fields.push({ field: destKey, value: identity[srcKey], evidenceIds: [] });
    }
  }
  const commerceFacts = envelope.commerceFacts;
  if (Array.isArray(commerceFacts)) {
    for (const f of commerceFacts as Array<Record<string, unknown>>) {
      const key = String(f.field ?? '');
      if (key && f.value != null) fields.push({ field: key, value: f.value, evidenceIds: (f.evidenceIds as string[] | undefined) ?? [] });
    }
  }
  return fields;
}

function existingItemValue(item: OnboardingItem, field: string): unknown {
  switch (field) {
    case 'name':
    case 'title': // proposal field key for the item's name
      return item.name;
    case 'price':
      return item.price;
    case 'quantity':
      return item.quantity;
    case 'brand':
      return item.brandHint;
    default:
      return item.extractionData && typeof item.extractionData === 'object'
        ? (item.extractionData as Record<string, unknown>)[field] ?? null
        : null;
  }
}

/** Merge policy: never overwrite a differing manual value; dedupe identical. */
function mergeField(
  field: string,
  importedValue: unknown,
  item: OnboardingItem,
  state: { excluded: Record<string, { itemValue: string; importedValue: string }>; overridden: Record<string, string> },
): boolean {
  const existing = existingItemValue(item, field);
  const imported = String(importedValue ?? '');
  if (existing != null && existing !== '') {
    if (String(existing) !== imported) {
      state.excluded[field] = { itemValue: String(existing), importedValue: imported };
      return false; // do not write, do not include
    }
    return false; // identical -> dedupe
  }
  state.overridden[field] = imported;
  return true; // include in payload evidence
}

/**
 * Verify that an item's imported Agent Lab origin is still promotable:
 * the originating run exists, the result hash matches, and the import
 * record is active. Items without imported evidence pass unconditionally.
 */
export function verifyImportedResultGate(item: OnboardingItem): { ok: true } | { ok: false; error: string } {
  const payloads = item.extractionData?.productIntelligenceEvidence;
  if (!payloads || payloads.length === 0) return { ok: true };

  // Every imported origin must still verify (fail closed): a deleted run, a
  // mismatched result hash, or a stale import record blocks promotion.
  for (const payload of payloads) {
    const run = getPiRun(payload.runId);
    if (!run) return { ok: false, error: `imported Agent Lab result ${payload.runId.slice(0, 8)}… is missing (run deleted)` };

    const result = getPiResult(payload.runId);
    if (!result || result.resultHash !== payload.resultHash) {
      return { ok: false, error: `imported Agent Lab result ${payload.runId.slice(0, 8)}… hash no longer matches the run result` };
    }

    const record = getPiImportByRunAndItem(payload.runId, item.id);
    if (!record || record.status !== 'active') {
      return { ok: false, error: `imported Agent Lab record ${payload.runId.slice(0, 8)}… is stale or missing` };
    }
  }

  return { ok: true };
}

/**
 * Import a reviewed run into an onboarding item. Runs atomically inside one
 * transaction; every gate throws before any write happens, and a failure
 * inside the transaction rolls back everything.
 */
export function importRunToOnboarding(runId: string, opts: ImportRunOptions): ImportRunResult {
  const flags = getProductIntelligenceFlags();
  if (!flags.productIntelligenceEnabled) throw new Error('Product Intelligence is disabled');
  if (!flags.allowOnboardingImport) {
    throw new Error('Agent Lab import is disabled (productIntelligence.allowOnboardingImport is false)');
  }
  if (flags.shadowOnly) throw new Error('shadowOnly mode is enabled: Agent Lab results cannot be imported');

  const db = getDb();
  return db.transaction(() => {
    const parsed = parseRun(runId);
    const { gtinDigits, registerName, resultHash, envelope } = parsed;

    let item: OnboardingItem | undefined;
    let created: boolean;

    if (opts.mode === 'augment') {
      if (!opts.onboardingItemId) throw new Error('augment import requires an onboardingItemId');
      item = findItemById(opts.onboardingItemId);
      if (!item) throw new Error(`Onboarding item ${opts.onboardingItemId} not found`);
      const itemBatch = findBatchById(item.batchId);
      if (!itemBatch || itemBatch.workspaceId !== parsed.workspaceId) {
        throw new Error(`Onboarding item ${item.id} belongs to a different workspace`);
      }
      if (digitsOf(item.upc) !== gtinDigits) {
        throw new Error(`Onboarding item ${item.id} UPC does not match the run GTIN`);
      }
      // Idempotency: same run + item already imported -> active is a no-op;
      // a stale/superseded record is refreshed to active below.
      const existing = getPiImportByRunAndItem(runId, item.id);
      if (existing && existing.status === 'active') return { importRecord: existing, item, batchId: item.batchId, created: false };
      if (existing) {
        // Refresh a stale/superseded record back to active. The UNIQUE
        // (run_id, onboarding_item_id) slot is still occupied, so we must NOT
        // fall through to insertPiImport — return the reactivated record.
        updatePiImportStatus(existing.id, 'active');
        return { importRecord: { ...existing, status: 'active' as const }, item, batchId: item.batchId, created: false };
      }
      created = true;
    } else {
      // Idempotency: a create-mode import already exists for this run.
      const existing = listPiImportsByRun(runId).find((r) => r.mode === 'create');
      if (existing) {
        const existingItem = findItemById(existing.onboardingItemId);
        if (!existingItem) throw new Error(`Imported onboarding item ${existing.onboardingItemId} no longer exists`);
        return { importRecord: existing, item: existingItem, batchId: existingItem.batchId, created: false };
      }
      const batch = createBatch({
        workspaceId: parsed.workspaceId,
        name: `Agent Lab import ${runId.slice(0, 8)}`,
        fileName: 'agent-lab-import',
        totalItems: 1,
        columnMappingJson: '{}',
      });
      const items = insertItems(batch.id, [
        {
          upc: gtinDigits,
          name: registerName,
          price: opts.price ?? null,
          quantity: opts.quantity ?? null,
          rowNumber: 1,
          isDuplicate: false,
          existingSku: null,
        },
      ]);
      item = items[0];
      created = true;
    }

    if (!item) throw new Error('Import could not resolve an onboarding item');

    // Proposal fields (default = everything the run proposed).
    const proposals = proposalFieldsOf(envelope);
    const fieldSelection = opts.fieldSelection && opts.fieldSelection.length > 0
      ? opts.fieldSelection.slice(0, 64)
      : proposals.slice(0, 64).map((p) => p.field);

    // Sources + evidence items from the PI-1 envelope (when present).
    const sources = Array.isArray(envelope.evidenceSources)
      ? (envelope.evidenceSources as Array<Record<string, unknown>>).map((s) => ({
          sourceId: String(s.id ?? ''),
          url: String(s.url ?? ''),
          domain: s.domain != null ? String(s.domain) : null,
          sourceType: s.kind != null ? String(s.kind) : null,
        }))
      : [];
    const evidenceItems = Array.isArray(envelope.evidenceItems)
      ? (envelope.evidenceItems as Array<Record<string, unknown>>)
      : [];
    const fallbackSourceId = sources[0]?.sourceId ?? runId;

    // Build the selected-field payload with the merge policy applied.
    const state: {
      excluded: Record<string, { itemValue: string; importedValue: string }>;
      overridden: Record<string, string>;
    } = { excluded: {}, overridden: {} };
    const evidencePayload: Array<{
      field: string; value: string; sourceId: string; evidenceId: string; extractionMethod: string | null; snippet: string | null;
    }> = [];
    const evidenceIds: string[] = [];

    for (const field of fieldSelection) {
      const proposal = proposals.find((p) => p.field === field);
      if (!proposal || proposal.value == null) continue;
      const include = mergeField(field, proposal.value, item, state);
      if (!include) continue;

      const evItemsForField = evidenceItems.filter((e) => String(e.field ?? '') === field);
      const evidenceId = String(
        evItemsForField[0]?.id ?? proposal.evidenceIds[0] ?? `${runId}:${field}`,
      );
      const sourceId = String(
        Array.isArray(evItemsForField[0]?.sourceIds) ? (evItemsForField[0].sourceIds as string[])[0] : (proposal.evidenceIds[0] ?? fallbackSourceId),
      );
      evidenceIds.push(evidenceId);
      evidencePayload.push({
        field,
        value: String(proposal.value).slice(0, 2048),
        sourceId,
        evidenceId,
        extractionMethod: null,
        snippet: evItemsForField[0]?.quote != null ? String(evItemsForField[0].quote).slice(0, 2048) : null,
      });
    }

    // Approved images only (commerce-approval is deterministic, never manual).
    const approvedImages = listPiAssetsByRun(runId).filter((a) => a.commerceApproved === 1);
    const approvedImageIds = approvedImages.map((a) => a.id);

    // Materialize evidence into the item's extraction data (distinct
    // provenance key consumed by the classification pipeline).
    const existingExtraction: ExtractionData = (item.extractionData ?? {}) as ExtractionData;
    const piEvidence = {
      runId,
      resultHash,
      importRecordId: '',
      importedAt: new Date().toISOString(),
      evidence: evidencePayload,
      sources,
      approvedImageIds,
    };
    // One payload entry per imported run: a newer run augments the array, it
    // does not silently replace an earlier import's item evidence. A re-import
    // of the SAME run replaces that run's own entry (idempotent refresh).
    const existingEntries = Array.isArray(existingExtraction.productIntelligenceEvidence)
      ? existingExtraction.productIntelligenceEvidence
      : [];

    // Persist the import record first so its id can be embedded.
    const importedSourceIds = sources.map((s) => s.sourceId).filter(Boolean);
    const record = insertPiImport({
      runId,
      onboardingItemId: item.id,
      resultHash,
      mode: opts.mode,
      importingUser: opts.importingUser ?? null,
      fieldSelectionJson: JSON.stringify(fieldSelection),
      excludedValuesJson: JSON.stringify(state.excluded),
      overriddenValuesJson: JSON.stringify(state.overridden),
      importedSourceIdsJson: JSON.stringify(importedSourceIds),
      importedEvidenceIdsJson: JSON.stringify(evidenceIds),
      importedImageIdsJson: JSON.stringify(approvedImageIds),
    });

    piEvidence.importRecordId = record.id;

    const dbNow = new Date().toISOString();
    const mergedExtraction = {
      ...existingExtraction,
      productIntelligenceEvidence: [...existingEntries.filter((e) => e.runId !== runId), piEvidence],
    };
    db.run(
      'UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(mergedExtraction), dbNow, item.id],
    );

    return { importRecord: record, item: findItemById(item.id) as OnboardingItem, batchId: item.batchId, created };
  })();
}
