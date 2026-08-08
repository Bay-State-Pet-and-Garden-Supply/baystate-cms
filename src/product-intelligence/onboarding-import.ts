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
  listPiEvidence,
  listPiEvidenceByToolEvidenceId,
  listPiImportsByRun,
  listPiSources,
  updatePiImportStatus,
  type PiEvidenceRow,
  type PiImportRow,
  type PiSourceRow,
} from '../db/repositories/product-intelligence-repo';
import { assertRunApprovedForImport } from './review-gate';
import type { ExtractionData, OnboardingItem } from '../shared/schemas/onboarding';
import { getProductIntelligenceFlags } from './flags';
import { isPiKillSwitchEnabled } from './evaluation/rollout';

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

/**
 * Fail-closed import error (P1-1): selected facts without durable evidence.
 * Carries a per-field report so callers/UI can show exactly which fields
 * blocked the import.
 */
export class UnresolvedEvidenceError extends Error {
  readonly unresolvedFields: Array<{ field: string; reason: string }>;

  constructor(unresolvedFields: Array<{ field: string; reason: string }>) {
    super(
      `Import failed: ${unresolvedFields.length} selected field(s) lack durable field-level evidence: ` +
        unresolvedFields.map((f) => `${f.field} (${f.reason})`).join('; '),
    );
    this.name = 'UnresolvedEvidenceError';
    this.unresolvedFields = unresolvedFields;
  }
}

function normalizeFieldKey(field: string): string {
  return String(field ?? '').trim().toLowerCase();
}

function evidenceMetadataOf(row: PiEvidenceRow): Record<string, unknown> | null {
  if (!row.metadataJson) return null;
  try {
    const parsed = JSON.parse(row.metadataJson) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toolEvidenceIdOf(row: PiEvidenceRow): string | null {
  const md = evidenceMetadataOf(row);
  return md && typeof md.toolEvidenceId === 'string' ? md.toolEvidenceId : null;
}

/** A durable evidence row is field-level when it was persisted per field
 *  (targetField carries the field name, not the coarse 'tool_evidence' kind). */
function isFieldLevelEvidence(row: PiEvidenceRow): boolean {
  return normalizeFieldKey(row.targetField) !== 'tool_evidence';
}

/** Normalized comparable form of a durable evidence row's stored value.
 *  Field-level rows persist the extracted value; coarse rows persist
 *  {evidenceId, snippet} whose snippet is the evidence text. */
function evidenceValueOf(row: PiEvidenceRow): string | null {
  if (row.valueJson === null || row.valueJson === undefined || row.valueJson === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.valueJson) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed === 'string') return parsed;
  if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
  if (Array.isArray(parsed)) return JSON.stringify(parsed);
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.snippet === 'string' && obj.snippet) return obj.snippet;
    try {
      return JSON.stringify(obj);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** Clean full-string number parse; null when the string is not purely numeric. */
function parseCleanNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Narrow field-specific canonicalization keys (round-3 finding 6): these are
 *  the ONLY fields allowed looser-than-exact equality. Everything else must
 *  match exactly under normalization. */
const SIZE_LIKE_FIELDS = new Set([
  'size', 'netcontent', 'netweight', 'weight', 'volume', 'capacity',
  'packcount', 'count', 'quantity',
]);

/** Leading numeric value of a string that may carry a unit suffix; null when
 *  the string does not START with a number ('16 oz' -> 16, '16oz' -> 16). */
function numericPrefix(value: string): number | null {
  const m = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Evidence is ground truth (security review findings 4 + round-3 finding 6):
 *  the proposed value must equal the evidence value under NORMALIZED
 *  EQUALITY, with only the narrowly defined field-specific canonicalizations
 *  below. No substring, no partial, no 'substantial fragment' acceptance. */
function valuesEquivalent(proposed: unknown, evidenceRow: PiEvidenceRow, field: string): boolean {
  const evidenceText = evidenceValueOf(evidenceRow);
  if (evidenceText === null || evidenceText === '') return false;
  const proposedText = String(proposed ?? '');
  if (proposedText.trim() === '') return false;
  const key = normalizeFieldKey(field);

  // GTIN/UPC: digits-only comparison (barcodes carry arbitrary
  // spacing/separators; digits are the identity).
  if (key.includes('gtin') || key.includes('upc')) {
    const pd = digitsOf(proposedText);
    const ed = digitsOf(evidenceText);
    return pd !== '' && pd === ed;
  }

  // Size / net-content style fields: numeric-prefix equivalence tolerates
  // unit formatting ('16 oz' vs '16oz') but never different quantities.
  if (SIZE_LIKE_FIELDS.has(key)) {
    const pNum = numericPrefix(proposedText);
    const eNum = numericPrefix(evidenceText);
    if (pNum !== null && eNum !== null) return pNum === eNum;
    return normalizeValue(proposedText) === normalizeValue(evidenceText);
  }

  const p = normalizeValue(proposedText);
  const e = normalizeValue(evidenceText);
  if (p === e) return true;
  // Pure numeric values compare numerically ('8.99' vs '8.990'); anything
  // with a unit suffix must match exactly outside the size-like fields.
  const pNum = parseCleanNumber(p);
  const eNum = parseCleanNumber(e);
  if (pNum !== null && eNum !== null) return pNum === eNum;
  return false;
}

/** Resolve a selected fact to the DURABLE field-level evidence row that
 *  explicitly supports it (security review finding 4 — value binding):
 *   (a) CITATION FIRST — only rows the proposal explicitly cited for this
 *       field (by tool evidence id, submission evidence id, or row id) are
 *       eligible; a targetField match alone never resolves.
 *   (b) FIELD MATCH — the cited row's targetField must normalize to the
 *       proposed field name.
 *   (c) VALUE EQUIVALENCE — the proposed value must equal the evidence row's
 *       stored value under normalized equality (field-specific
 *       canonicalization only; no substring acceptance).
 *  Returns { row } on success or { reason } describing the failing rule.
 *  The caller fails closed on any { reason }. */
function resolveFieldEvidence(
  field: string,
  citedIds: string[],
  proposalValue: unknown,
  byToolEvidenceId: Map<string, PiEvidenceRow>,
  bySubmissionEvidenceId: Map<string, PiEvidenceRow>,
  byRowId: Map<string, PiEvidenceRow>,
): { row: PiEvidenceRow } | { reason: string } {
  if (citedIds.length === 0) {
    return { reason: 'no citation for field' };
  }
  let cited: PiEvidenceRow | undefined;
  for (const id of citedIds) {
    const viaToolId = byToolEvidenceId.get(id);
    if (viaToolId && isFieldLevelEvidence(viaToolId)) {
      cited = viaToolId;
      break;
    }
    const viaSubmission = bySubmissionEvidenceId.get(id);
    if (viaSubmission && isFieldLevelEvidence(viaSubmission)) {
      cited = viaSubmission;
      break;
    }
    const viaRowId = byRowId.get(id);
    if (viaRowId && isFieldLevelEvidence(viaRowId)) {
      cited = viaRowId;
      break;
    }
  }
  if (!cited) {
    return { reason: 'no durable field-level evidence row cited for this field' };
  }
  if (normalizeFieldKey(cited.targetField) !== normalizeFieldKey(field)) {
    return { reason: `field mismatch: cited row targets '${cited.targetField}'` };
  }
  if (!valuesEquivalent(proposalValue, cited, field)) {
    const proposed = String(proposalValue ?? '').slice(0, 60);
    const evidenceText = (evidenceValueOf(cited) ?? '').slice(0, 60);
    return { reason: `value mismatch: proposed '${proposed}' vs evidence '${evidenceText}'` };
  }
  return { row: cited };
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
  // PI-4 bundle: identity (canonicalName -> title) + commerceFacts. Identity
  // facts inherit the bundle identity's own evidence citations (finding 4:
  // every imported value must be bound to evidence it explicitly cites).
  const identity = envelope.identity as Record<string, unknown> | undefined;
  if (identity) {
    const citedIdentityIds = (identity.evidenceIds as string[] | undefined) ?? [];
    const identityFields: Array<[string, string]> = [
      ['canonicalName', 'title'],
      ['brand', 'brand'],
      ['manufacturer', 'manufacturer'],
      ['variant', 'variant'],
    ];
    for (const [srcKey, destKey] of identityFields) {
      if (identity[srcKey] != null) {
        fields.push({ field: destKey, value: identity[srcKey], evidenceIds: citedIdentityIds });
      }
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
  if (isPiKillSwitchEnabled()) throw new Error('Product Intelligence is disabled by the kill switch');

  const db = getDb();
  return db.transaction(() => {
    const parsed = parseRun(runId);
    // Round-3 finding 7: the durable approval gate lives in the SERVICE, so
    // every caller path (HTTP route, tests, future internal callers) is bound
    // to a human review decision for the exact stored result. The HTTP route's
    // own pre-check remains as defense-in-depth.
    assertRunApprovedForImport(runId);
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

    // Apply the merge policy: collect the fields this import will actually
    // write (conflicting manual values are excluded; identical values dedupe).
    const state: {
      excluded: Record<string, { itemValue: string; importedValue: string }>;
      overridden: Record<string, string>;
    } = { excluded: {}, overridden: {} };
    const selected: Array<{ field: string; proposal: ProposalField }> = [];
    for (const field of fieldSelection) {
      const proposal = proposals.find((p) => p.field === field);
      if (!proposal || proposal.value == null) continue;
      if (mergeField(field, proposal.value, item, state)) selected.push({ field, proposal });
    }

    // P1-1 + finding 4 (security review): every selected fact must resolve to
    // the DURABLE field-level evidence row it explicitly cites (per-tool rows
    // keyed by metadata.toolEvidenceId; legacy submission rows keyed by
    // metadata.submissionEvidenceId; row id as a secondary namespace) AND the
    // evidence value must support the proposed value (see
    // resolveFieldEvidence rules a-c). Fabricated ids, proposal evidence
    // ids-as-source-ids, and the runId-as-source fallback are gone; an
    // unresolved or mismatched fact aborts the import before anything is
    // written.
    const citedIds = [...new Set(selected.flatMap((s) => s.proposal.evidenceIds))];
    const allEvidence = listPiEvidence(runId);
    const allSources = listPiSources(runId);
    const sourcesById = new Map(allSources.map((s) => [s.id, s]));
    const bySubmissionEvidenceId = new Map<string, PiEvidenceRow>();
    const byRowId = new Map<string, PiEvidenceRow>();
    for (const row of allEvidence) {
      byRowId.set(row.id, row);
      const md = evidenceMetadataOf(row);
      if (md && typeof md.submissionEvidenceId === 'string') {
        bySubmissionEvidenceId.set(md.submissionEvidenceId, row);
      }
    }
    const byToolEvidenceId = new Map(
      listPiEvidenceByToolEvidenceId(runId, citedIds).map((row) => [toolEvidenceIdOf(row) ?? row.id, row]),
    );

    const unresolved: Array<{ field: string; reason: string }> = [];
    const evidencePayload: Array<{
      field: string; value: string; sourceId: string; evidenceId: string; extractionMethod: string | null; snippet: string | null;
    }> = [];
    const evidenceIds: string[] = [];
    for (const { field, proposal } of selected) {
      const resolved = resolveFieldEvidence(field, proposal.evidenceIds, proposal.value, byToolEvidenceId, bySubmissionEvidenceId, byRowId);
      if ('reason' in resolved) {
        unresolved.push({ field, reason: resolved.reason });
        continue;
      }
      const row = resolved.row;
      const source = row.sourceId ? sourcesById.get(row.sourceId) : undefined;
      if (!source) {
        unresolved.push({ field, reason: 'evidence row has no durable source row' });
        continue;
      }
      evidenceIds.push(toolEvidenceIdOf(row) ?? row.id);
      evidencePayload.push({
        field,
        value: String(proposal.value).slice(0, 2048),
        sourceId: source.id,
        evidenceId: toolEvidenceIdOf(row) ?? row.id,
        extractionMethod: row.extractionMethod,
        snippet: row.snippet != null ? row.snippet.slice(0, 2048) : null,
      });
    }
    if (unresolved.length > 0) {
      throw new UnresolvedEvidenceError(unresolved);
    }

    // Durable source rows behind the resolved evidence (deduped by source id).
    const sources = [...new Set(evidencePayload.map((e) => e.sourceId))]
      .map((id) => sourcesById.get(id))
      .filter((s): s is PiSourceRow => Boolean(s))
      .map((s) => ({ sourceId: s.id, url: s.url, domain: s.domain, sourceType: s.sourceType }));

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
