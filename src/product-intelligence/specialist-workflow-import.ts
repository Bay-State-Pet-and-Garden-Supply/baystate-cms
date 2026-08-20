/** Verified SpecialistWorkflowResult -> onboarding handoff (e01s01 + e01s02 guards). */
import { getDb } from '../db/connection';
import { createBatch, findBatchById } from '../db/repositories/onboarding-batch-repo';
import { findItemById, insertItems } from '../db/repositories/onboarding-item-repo';
import {
  getPiImportByWorkflowAndItem,
  listPiImportsByWorkflow,
  insertPiImport,
  type PiImportRow,
} from '../db/repositories/product-intelligence-repo';
import type { OnboardingItem, ExtractionData } from '../shared/schemas/onboarding';
import type { SpecialistWorkflowResult } from './workflow/orchestrator';

export interface SpecialistWorkflowImportOptions {
  mode: 'create' | 'augment';
  workspaceId: string;
  onboardingItemId?: string | null;
  importingUser?: string | null;
  price?: string | null;
  quantity?: number | null;
}

export interface SpecialistWorkflowImportResult {
  importRecord: PiImportRow;
  item: OnboardingItem;
  batchId: string | null;
  created: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function artifactList(result: SpecialistWorkflowResult): Array<Record<string, unknown>> {
  return [result.discoveryArtifact, result.resolverArtifact, result.curatorArtifact, result.verifierArtifact]
    .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact))
    .map((artifact) => record(artifact));
}

function isValidHash(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function artifactHashes(result: SpecialistWorkflowResult): string[] {
  const hashes = artifactList(result).map((artifact) => String(artifact.contentHash ?? '')).filter(Boolean);
  for (const hash of hashes) {
    if (!isValidHash(hash)) throw new Error(`Invalid artifact hash format: ${hash.slice(0, 16)}`);
  }
  return hashes;
}

function existingItemValue(item: OnboardingItem, field: string): unknown {
  switch (field) {
    case 'title':
    case 'name':
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
      return false;
    }
    return false;
  }
  state.overridden[field] = imported;
  return true;
}

function evidenceRefs(result: SpecialistWorkflowResult): string[] {
  const refs = new Set<string>();
  const draft = record(result.curatorOutput);
  for (const claim of Array.isArray(draft.grounding) ? draft.grounding : []) {
    for (const id of Array.isArray(record(claim).evidenceIds) ? record(claim).evidenceIds as unknown[] : []) refs.add(String(id));
  }
  const resolved = record(result.resolverOutput);
  for (const fact of Array.isArray(resolved.facts) ? resolved.facts : []) {
    for (const id of Array.isArray(record(fact).supportingEvidence) ? record(fact).supportingEvidence as unknown[] : []) refs.add(String(id));
  }
  return [...refs].filter(Boolean).slice(0, 256);
}

function draftFields(result: SpecialistWorkflowResult): Record<string, unknown> {
  const draft = record(result.curatorOutput);
  const fields: Record<string, unknown> = {};
  if (typeof draft.catalogTitle === 'string') fields.title = draft.catalogTitle;
  if (typeof draft.brand === 'string' && draft.brand) fields.brand = draft.brand;
  if (typeof draft.subtitle === 'string' && draft.subtitle) fields.subtitle = draft.subtitle;
  if (typeof draft.description === 'string' && draft.description) fields.description = draft.description;
  if (draft.productTypeId !== null && draft.productTypeId !== undefined) fields.productTypeId = draft.productTypeId;
  if (Array.isArray(draft.categoryIds)) fields.categoryIds = draft.categoryIds;
  if (draft.attributes && typeof draft.attributes === 'object') fields.attributes = draft.attributes;
  return fields;
}

function validateImages(result: SpecialistWorkflowResult): { images: Array<{ assetId: string; role: string }>; approvedImageIds: string[] } {
  const draft = record(result.curatorOutput);
  const rawImages = draft.images;
  if (!Array.isArray(rawImages) || rawImages.length === 0) return { images: [], approvedImageIds: [] };
  const images: Array<{ assetId: string; role: string }> = [];
  const approvedImageIds: string[] = [];
  const primary = rawImages.map((r) => record(r)).find((i) => i.role === 'primary');
  const primaryPageUrl = primary ? String(primary.sourcePageUrl ?? '') : '';
  for (const raw of rawImages) {
    const image = record(raw);
    const role = String(image.role ?? 'unknown');
    const assetId = String(image.assetId ?? image.url ?? image.id ?? '');
    if (!assetId) throw new Error(`Image candidate missing assetId for role ${role}`);
    const commerceApproved = image.commerceApproved === true || image.commerceApproved === 1;
    const rightsStatus = String(image.rightsStatus ?? '');
    const exactProductMatch = image.exactProductMatch === true || image.exactProductMatch === 1;
    const exactVariantMatch = image.exactVariantMatch === true || image.exactVariantMatch === 1;
    const sourcePageUrl = String(image.sourcePageUrl ?? '');
    const samePageLinkage = Boolean(primaryPageUrl && sourcePageUrl && primaryPageUrl === sourcePageUrl);
    const sameProductLinkage = exactProductMatch || exactVariantMatch || samePageLinkage;
    if (role === 'primary') {
      if (!commerceApproved) throw new Error('Primary image is not commerce-approved');
      images.push({ assetId, role });
      approvedImageIds.push(assetId);
    } else if (role === 'alternate' || role === 'nutrition' || role === 'ingredients') {
      if (rightsStatus !== 'approved') throw new Error(`cited ${role} verified asset rights are '${rightsStatus}', not approved`);
      if (!sameProductLinkage) throw new Error(`cited ${role} verified asset is not durably linked to this product`);
      images.push({ assetId, role });
      if (commerceApproved) approvedImageIds.push(assetId);
    } else if (role === 'comparison') {
      images.push({ assetId, role });
    } else {
      throw new Error(`unknown image role '${role}'`);
    }
  }
  return { images, approvedImageIds };
}

function terminalGate(result: SpecialistWorkflowResult): void {
  if (result.status !== 'completed' && result.status !== 'needs_review') {
    throw new Error(`Workflow ${result.runId} is not eligible for onboarding import (${result.status})`);
  }
  const verifier = record(result.verifierOutput);
  if (verifier.verdict !== 'pass') throw new Error('Workflow VerificationReport did not pass');
  if (!result.curatorOutput || !result.curatorArtifact) throw new Error('Workflow has no curated product artifact');
  if (artifactHashes(result).length === 0) throw new Error('Workflow has no verified artifact hashes');
  // Image commerce guard is fail-closed for primary; supporting roles validated in validateImages
  const draft = record(result.curatorOutput);
  const images = draft.images;
  if (Array.isArray(images) && images.length > 0) {
    // Validate at gate time as well to fail before transaction
    validateImages(result);
  }
}

function identity(result: SpecialistWorkflowResult): { upc: string; name: string } {
  const seed = record(result.productSeed);
  const draft = record(result.curatorOutput);
  const upc = String(draft.upc ?? draft.gtin ?? seed.sku ?? '').trim();
  const name = String(draft.catalogTitle ?? seed.name ?? '').trim();
  if (!upc || !name) throw new Error('Workflow product identity is incomplete');
  return { upc, name };
}

export function importSpecialistWorkflowToOnboarding(
  result: SpecialistWorkflowResult,
  options: SpecialistWorkflowImportOptions,
): SpecialistWorkflowImportResult {
  terminalGate(result);
  const identityValue = identity(result);
  const workflowId = `wf:${result.runId}`;

  return getDb().transaction(() => {
    let item: OnboardingItem | undefined;
    let created = false;
    if (options.mode === 'create') {
      const prior = listPiImportsByWorkflow(workflowId).find((entry) => entry.mode === 'create');
      if (prior) {
        const priorItem = findItemById(prior.onboardingItemId);
        if (!priorItem) throw new Error(`Imported onboarding item ${prior.onboardingItemId} no longer exists`);
        return { importRecord: prior, item: priorItem, batchId: priorItem.batchId, created: false };
      }
    }
    if (options.mode === 'augment') {
      if (!options.onboardingItemId) throw new Error('augment import requires an onboardingItemId');
      item = findItemById(options.onboardingItemId);
      if (!item) throw new Error(`Onboarding item ${options.onboardingItemId} not found`);
      const batch = findBatchById(item.batchId);
      if (!batch || batch.workspaceId !== options.workspaceId) throw new Error('Onboarding item belongs to a different workspace');
    } else {
      const batch = createBatch({ workspaceId: options.workspaceId, name: `Specialist workflow ${result.runId.slice(0, 8)}`, fileName: 'specialist-workflow-import', totalItems: 1, columnMappingJson: '{}' });
      item = insertItems(batch.id, [{ upc: identityValue.upc, name: identityValue.name, price: options.price ?? null, quantity: options.quantity ?? null, rowNumber: 1, isDuplicate: false, existingSku: null }], 'discovery', 0)[0];
      created = true;
    }
    if (!item) throw new Error('Workflow import could not resolve an onboarding item');
    const existing = getPiImportByWorkflowAndItem(workflowId, item.id);
    if (existing) return { importRecord: existing, item, batchId: item.batchId, created: false };

    // Manual preservation: never silently overwrite manual/reviewed values
    const fields = draftFields(result);
    const mergeState: { excluded: Record<string, { itemValue: string; importedValue: string }>; overridden: Record<string, string> } = {
      excluded: {},
      overridden: {},
    };
    for (const [field, value] of Object.entries(fields)) {
      mergeField(field, value, item, mergeState);
    }

    const evidence = evidenceRefs(result);
    const hashes = artifactHashes(result);
    const verifier = record(result.verifierArtifact);
    // Stale hash guard: all hashes already validated via isValidHash; ensure non-empty and unique
    if (new Set(hashes).size !== hashes.length) throw new Error('Duplicate artifact hashes detected');
    // Image guards (role-aware, commerceApproved/rightsStatus)
    const imageGuard = validateImages(result);

    const existingExtraction = (item.extractionData ?? {}) as ExtractionData;
    const workflowEvidence = {
      workflowId,
      runId: result.runId,
      importedAt: new Date().toISOString(),
      artifactHashes: hashes,
      capabilityInvocationIds: result.workflowState.capabilityInvocationIds,
      evidenceRefs: evidence,
      verifier: { report: result.verifierOutput, artifactHash: verifier.contentHash ?? null, provenance: verifier.provenance ?? null },
      fields,
      excludedFields: mergeState.excluded,
      overriddenFields: mergeState.overridden,
      images: imageGuard.images,
      approvedImageIds: imageGuard.approvedImageIds,
    };
    const recordRow = insertPiImport({
      runId: null,
      workflowId,
      onboardingItemId: item.id,
      resultHash: hashes[hashes.length - 1],
      mode: options.mode,
      importingUser: options.importingUser ?? null,
      importedEvidenceIdsJson: JSON.stringify(evidence),
      artifactHashesJson: JSON.stringify(hashes),
      capabilityInvocationIdsJson: JSON.stringify(result.workflowState.capabilityInvocationIds),
      verifierProvenanceJson: JSON.stringify(workflowEvidence.verifier),
      excludedValuesJson: JSON.stringify(mergeState.excluded),
      overriddenValuesJson: JSON.stringify(mergeState.overridden),
      importedImageIdsJson: JSON.stringify(imageGuard.approvedImageIds),
    });
    const extractionRecord = existingExtraction as Record<string, unknown>;
    const priorEvidence = Array.isArray(extractionRecord.productIntelligenceEvidence)
      ? extractionRecord.productIntelligenceEvidence.filter((entry) => record(entry).workflowId !== workflowId)
      : [];
    const priorWorkflowEvidence = Array.isArray(extractionRecord.workflowEvidence)
      ? extractionRecord.workflowEvidence
      : [];
    const merged = {
      ...existingExtraction,
      productIntelligenceEvidence: [...priorEvidence, workflowEvidence],
      workflowEvidence: [...priorWorkflowEvidence, workflowEvidence],
    };
    getDb().run('UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(merged), new Date().toISOString(), item.id]);
    // Promotion remains owned by normal onboarding/review path — never set approvedAt/reviewedAt here.
    return { importRecord: recordRow, item: findItemById(item.id) as OnboardingItem, batchId: item.batchId, created };
  })();
}

/**
 * Promotion gate for SpecialistWorkflow imports: verifies every workflowEvidence
 * entry still has an active import record and matching artifact hash. Used by
 * promotion/export flows to block stale or missing origins. Items without
 * workflow evidence pass unconditionally (ordinary onboarding).
 */
export function verifySpecialistWorkflowImportGate(item: OnboardingItem): { ok: true } | { ok: false; error: string } {
  const payloads = (item.extractionData as Record<string, unknown> | null)?.workflowEvidence as Array<Record<string, unknown>> | undefined;
  if (!payloads || payloads.length === 0) return { ok: true };
  for (const payload of payloads) {
    const workflowId = String(payload.workflowId ?? '');
    const hashes = Array.isArray(payload.artifactHashes) ? payload.artifactHashes as string[] : [];
    const expectedHash = hashes.length > 0 ? String(hashes[hashes.length - 1]) : '';
    const rec = workflowId ? getPiImportByWorkflowAndItem(workflowId, item.id) : undefined;
    if (!rec || rec.status !== 'active') return { ok: false, error: `imported workflow ${workflowId.slice(0, 12)}… is stale or missing` };
    if (expectedHash && rec.resultHash !== expectedHash) return { ok: false, error: `imported workflow ${workflowId.slice(0, 12)}… hash no longer matches` };
  }
  return { ok: true };
}
