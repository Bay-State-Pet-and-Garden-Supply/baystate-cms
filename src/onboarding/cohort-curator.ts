/**
 * Cohort curator — the PR3 M2 freeze engine (issue #30).
 *
 * The ONLY path from `freezing → running` for a parent cohort run. Two-phase
 * freeze (implementation-plan section D):
 *
 * 1. capture the common authorities ONCE (config authority + persisted config
 *    snapshot ref — FAIL CLOSED for an active v2 authority whose bundle hash
 *    has no persisted `classification_config_snapshots` row; verified Page
 *    catalog identity; the H5 model-execution digest; frozen fieldOptions);
 * 2. per member: idempotent `ensureMemberRun`, build + persist the member
 *    runtime snapshot WITH the frozen fieldOptions injected, run-bound OCR
 *    pull-forward when the stored OCR is unsettled or its input set changed,
 *    persist OCR back into `extraction_data_json`, recompute the member hash;
 * 3. FINAL CAS TRANSACTION: reload cohort + members + items, verify the
 *    candidate is still ready / non-superseded, membership hash unchanged,
 *    every member's current evidence hash + `ocrInputHash` still match the
 *    frozen values, and config/page/policy digests unchanged. On match the
 *    content-addressed `classification_cohort_snapshots` row is persisted
 *    (execution-evidence-v1 projection), H1–H5 + `evidence_snapshot_id` are
 *    written onto the run, and the run transitions to `running` — all in ONE
 *    transaction. On ANY mismatch the run is superseded (and its linked
 *    running children failed): execution NEVER starts from a mixed-time
 *    snapshot.
 *
 * This module also exposes:
 * - `buildExecutionEvidenceProjection` — the pure `execution-evidence-v1`
 *   projection builder (contract C);
 * - `verifyCohortRunFrozen` — the production `verifyFrozen` implementation for
 *   lease reclaim (resume-on-match / supersede-on-drift);
 * - `PreparedCohortContext` — the prepared-cohort input contract consumed by
 *   `curateItemWithPipeline` (amendment 6).
 */
import { getDb } from '../db/connection';
import {
  getCohortById,
  getCohortMembers,
  computeExtractionHash,
  computeMembershipHash,
} from '../db/repositories/curation-cohort-repo';
import {
  ensureMemberRun,
  freezeCohortRunAuthorities,
  transitionCohortRunToRunning,
  supersedeCohortRun,
  persistCohortSnapshot,
  getCohortRunById,
} from '../db/repositories/classification-cohort-run-repo';
import { listItemsByBatch, updateItemExtractionData } from '../db/repositories/onboarding-item-repo';
import { getLatestExtractionSourcesByItemIds } from '../db/repositories/onboarding-extraction-repo';
import {
  syncConfigToCache,
  createConfigSnapshot,
  getPersistedConfigSnapshotId,
} from '../db/repositories/classification-config-repo';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../classification/config-loader';
import type { RuntimeConfigAuthority } from '../classification/config-loader';
import { captureVerifiedPageSnapshot, toPageSnapshotState } from '../classification/page-snapshot';
import { assertClassificationReady } from '../classification/readiness';
import {
  buildRuntimeSnapshot,
  persistRuntimeSnapshot,
  computeSnapshotFieldOptions,
  captureLocalVlmConfig,
  requireModelCallContext,
  getModelExecutionPlanEntry,
} from '../classification/runtime-snapshot';
import type {
  PageSnapshotState,
  RuntimeClassificationSnapshot,
} from '../classification/runtime-snapshot';
import { buildModelPolicyView } from '../classification/model-policy-gateway';
import type { ModelPolicyView } from '../classification/model-policy-gateway';
import { buildModelExecutionPlan, buildRuntimeRuleVersions } from '../classification/model-operation-registry';
import type { ModelCallContext, ModelExecutionPlan, RuntimeRuleVersions } from '../classification/model-operation-registry';
import { modelPolicyViewFromConfig } from './model-policy-snapshot';
import { getVlmConfig } from './vlm-client';
import { extractPackagingOcr, mergeOcrResults } from './packaging-ocr';
import { hashCanonicalJson, canonicalJsonStringify } from '../shared/stable-id';
import {
  PROJECTION_VERSION,
  ExecutionEvidenceProjectionV1Schema,
} from '../shared/schemas/cohorts';
import type {
  CohortRun,
  CurationCohort,
  CurationCohortMember,
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionV1,
} from '../shared/schemas/cohorts';
import type {
  OnboardingItem,
  PackagingOcrData,
  OcrAttemptOutcome,
} from '../shared/schemas/onboarding';
import type { ClassificationConfigSnapshotRef } from '../shared/schemas/classification';
import type { ResolvedTargetOption } from '../classification/curation-target-resolver';

const now = () => new Date().toISOString();

// ─── ocrInputHash (amendment 7) ────────────────────────────────────────────────

/**
 * SHA-256 over the canonical `{sourceUrl, extractionSourceUrl, primaryImage,
 * additionalImages}` set a packaging OCR attempt is bound to. A terminal
 * `ocrOutcome` alone is NOT sufficient: freeze finalization (and the frozen
 * evidence stage) verify the input set still matches `ocrInputHash` before
 * trusting a stored OCR result — mismatch means the OCR belongs to different
 * inputs → re-run OCR (or block).
 */
export function computeOcrInputHash(item: OnboardingItem, extractionSourceUrl: string | null): string {
  const ext = item.extractionData;
  return hashCanonicalJson({
    sourceUrl: item.sourceUrl ?? null,
    extractionSourceUrl: extractionSourceUrl ?? null,
    primaryImage: ext?.primaryImage ?? null,
    additionalImages: Array.isArray(ext?.additionalImages) ? ext.additionalImages : [],
  });
}

/** The ocrInputHash recorded with the item's stored OCR (top-level marker in
 *  extraction_data_json), or null when no attempt has recorded one. */
function storedOcrInputHash(item: OnboardingItem): string | null {
  const ext = item.extractionData as { ocrInputHash?: unknown } | null | undefined;
  return ext && typeof ext.ocrInputHash === 'string' ? ext.ocrInputHash : null;
}

/** OCR is settled ⇔ structured OCR data exists OR the attempt reached a
 *  terminal outcome (`succeeded | disabled | failed | no_image`). Mirrors the
 *  curation-cohort-service readiness check (curation-cohort-service.ts:196). */
function isOcrSettled(item: OnboardingItem): boolean {
  const ext = item.extractionData;
  if (!ext) return false;
  if (ext.packagingOcrData) return true;
  const status = (ext as { ocrOutcome?: { status?: string } | null }).ocrOutcome?.status;
  if (!status) return false;
  return status === 'succeeded' || status === 'disabled' || status === 'failed' || status === 'no_image';
}

/** True when a parsed OCR result carries usable content (same rule as the
 *  evidence extractor). */
function hasOcrContent(ocr: PackagingOcrData | undefined | null): boolean {
  if (!ocr) return false;
  if (ocr.productName && ocr.productName.trim().length > 0) return true;
  if (ocr.brand && ocr.brand.trim().length > 0) return true;
  if (ocr.visibleTextLines && ocr.visibleTextLines.some(b => b && b.trim().length > 0)) return true;
  return false;
}

// ─── Execution-evidence projection (contract C) ───────────────────────────────

/**
 * Build the `execution-evidence-v1` projection for a cohort. Per member, one
 * entry (SORTED by onboardingItemId for deterministic hashing):
 * - `spreadsheetIdentity` — the frozen spreadsheet hints;
 * - `extraction` — the complete normalized extraction evidence the frozen-mode
 *   evidence stage may consume, including the OCR outcome/data and the
 *   `ocrInputHash` the OCR was started against;
 * - `evidenceHash` — `computeExtractionHash(item)` (member-local H2 input).
 *
 * Fails closed when a member has no extraction hash (the freeze gate requires
 * extraction completeness) or an attached PI import is incomplete (the
 * `piImportComplete: true` semantic assertion must be honest).
 */
export function buildExecutionEvidenceProjection(
  workspaceId: string,
  cohort: CurationCohort,
  members: CurationCohortMember[],
  items: OnboardingItem[],
  extractionSources: Map<string, string>,
): ExecutionEvidenceProjectionV1 {
  if (cohort.workspaceId !== workspaceId) {
    throw new Error(`Execution-evidence projection workspace mismatch: cohort belongs to ${cohort.workspaceId}, expected ${workspaceId}.`);
  }
  const itemsById = new Map(items.map(item => [item.id, item]));
  const sortedMembers = [...members].sort((a, b) => a.onboardingItemId.localeCompare(b.onboardingItemId));

  const memberEntries = sortedMembers.map(member => {
    const item = itemsById.get(member.onboardingItemId);
    if (!item) {
      throw new Error(`Execution-evidence projection: member item ${member.onboardingItemId} not found.`);
    }
    const ext: Record<string, any> = item.extractionData ?? {};
    const extractionSourceUrl = extractionSources.get(item.id) ?? null;

    const piEvidence = ((ext as { productIntelligenceEvidence?: Array<{ runId?: string; resultHash?: string; importRecordId?: string }> }).productIntelligenceEvidence ?? [])
      .map(entry => ({
        runId: String(entry.runId ?? ''),
        resultHash: String(entry.resultHash ?? ''),
        importRecordId: String(entry.importRecordId ?? ''),
      }))
      .filter(entry => entry.runId && entry.resultHash && entry.importRecordId)
      .sort((a, b) => a.runId.localeCompare(b.runId));
    const piImportComplete =
      ((ext as { productIntelligenceEvidence?: unknown[] }).productIntelligenceEvidence ?? []).length === 0 ||
      piEvidence.length === ((ext as { productIntelligenceEvidence?: unknown[] }).productIntelligenceEvidence ?? []).length;

    const evidenceHash = computeExtractionHash(item);
    if (!evidenceHash) {
      throw new Error(`Execution-evidence projection: member ${member.onboardingItemId} has no extraction hash (extraction evidence incomplete).`);
    }
    if (!piImportComplete) {
      throw new Error(`Execution-evidence projection: member ${member.onboardingItemId} has an incomplete Product Intelligence import (piImportComplete cannot be asserted).`);
    }

    return ExecutionEvidenceProjectionV1Schema.shape.members.element.parse({
      onboardingItemId: item.id,
      ordinal: member.ordinal,
      productSku: item.upc ?? null,
      extractionComplete: true,
      sourceUrl: item.sourceUrl ?? null,
      extractionSourceUrl: extractionSourceUrl,
      sourcingDecision: item.sourcingDecision ?? null,
      spreadsheetIdentity: {
        name: item.name,
        expectedName: item.expectedName ?? null,
        brandHint: item.brandHint ?? null,
        departmentHint: item.departmentHint ?? null,
        price: item.price ?? null,
        quantity: item.quantity ?? null,
        rowNumber: item.rowNumber,
        upc: item.upc ?? null,
      },
      extraction: {
        title: ext.title ?? null,
        description: ext.description ?? null,
        brand: ext.brand ?? null,
        weight: ext.weight ?? null,
        bulletPoints: Array.isArray(ext.bulletPoints) ? ext.bulletPoints : [],
        searchKeywords: ext.searchKeywords ?? null,
        primaryImage: ext.primaryImage ?? null,
        additionalImages: Array.isArray(ext.additionalImages) ? ext.additionalImages : [],
        customFields: ext.customFields ?? {},
        fieldProvenance: ext.fieldProvenance ?? {},
        packagingTitle: ext.packagingTitle ?? null,
        ocr: {
          outcome: ext.ocrOutcome ?? null,
          packagingOcrData: ext.packagingOcrData ?? null,
          ocrInputHash: computeOcrInputHash(item, extractionSourceUrl),
        },
        piEvidence,
        piImportComplete,
      },
      evidenceHash,
    });
  });

  const projection: ExecutionEvidenceProjectionV1 = {
    version: 'execution-evidence-v1',
    cohortId: cohort.id,
    batchId: cohort.batchId,
    groupingVersion: cohort.groupingVersion,
    members: memberEntries,
  };
  const parsed = ExecutionEvidenceProjectionV1Schema.safeParse(projection);
  if (!parsed.success) {
    throw new Error(`Execution-evidence projection failed schema validation: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

// ─── Shared authority capture (contract D step 2, once per freeze) ────────────

export interface CohortFreezeAuthorities {
  authority: RuntimeConfigAuthority;
  configSnapshotRef: ClassificationConfigSnapshotRef;
  focusedFileHashes: Record<string, string>;
  catalogEvidenceHash: string | null;
  pages: PageSnapshotState;
  pageImportId: string | null;
  pageImportHash: string | null;
  /** Frozen once at cohort freeze (D7) — injected into every member snapshot. */
  fieldOptions: Record<string, ResolvedTargetOption[]>;
  /** Unbound model-policy view (no snapshotHash binding — the digest is
   *  identical across members). */
  modelPolicyView: ModelPolicyView | null;
  modelExecutionPlan: ModelExecutionPlan | null;
  runtimeRuleVersions: RuntimeRuleVersions | null;
  /** H5 combined digest over the full frozen execution authority. */
  modelExecutionDigest: string | null;
}

/**
 * Capture the common authorities ONCE for a cohort freeze. FAILS CLOSED for an
 * ACTIVE v2 authority whose bundle hash has no persisted
 * `classification_config_snapshots` row — `config_snapshot_id` may NOT be null
 * when v2 (the run row must reference the persisted snapshot). Page identity
 * comes from `captureVerifiedPageSnapshot` (transactional, bijective,
 * fail-closed). H5 = `hashCanonicalJson({ policyDigest,
 * modelExecutionPlanDigest, runtimeRuleVersionsDigest })` over the SAME frozen
 * inputs the per-member runtime snapshots are built from.
 */
export function captureCohortAuthorities(
  workspacePath: string,
  workspaceId: string,
): CohortFreezeAuthorities {
  const activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  const pageSnapshot = captureVerifiedPageSnapshot(workspaceId);
  assertClassificationReady(authority, {
    catalogFields: activationContext.catalogFields,
    verifyCatalogEvidence: activationContext.verifyCatalogEvidence,
    verifiedPageIds: pageSnapshot.pageImportId ? pageSnapshot.verifiedPageIds : [],
  });

  let configSnapshotRef: ClassificationConfigSnapshotRef;
  let focusedFileHashes: Record<string, string>;
  let catalogEvidenceHash: string | null;
  if (authority.kind === 'v2') {
    const bundle = authority.bundle;
    const persistedId = getPersistedConfigSnapshotId(workspaceId, bundle.manifest.bundleHash);
    if (!persistedId) {
      throw new Error(
        `Freeze fail-closed: active v2 configuration bundle ${bundle.manifest.bundleHash} has no persisted ` +
          'classification_config_snapshot row; config_snapshot_id may not be NULL for a v2 authority.',
      );
    }
    configSnapshotRef = {
      id: persistedId,
      hash: bundle.manifest.bundleHash,
      sourceCommit: bundle.manifest.sourceCatalogCommit,
      createdAt: now(),
    };
    focusedFileHashes = bundle.manifest.fileVersions;
    catalogEvidenceHash = bundle.manifest.catalogEvidenceHash;
  } else {
    try {
      syncConfigToCache(workspaceId, authority.config);
    } catch (err) {
      console.warn(`[CohortCurator] Failed to sync config to cache: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { id, hash } = createConfigSnapshot(workspaceId, authority.config);
    configSnapshotRef = { id, hash, sourceCommit: null, createdAt: now() };
    focusedFileHashes = authority.config.manifest.fileVersions ?? {};
    catalogEvidenceHash = null;
  }

  const config = authority.kind === 'v2'
    ? (authority.bundle as unknown as Parameters<typeof computeSnapshotFieldOptions>[0])
    : authority.config;
  const fieldOptions = computeSnapshotFieldOptions(config);

  const modelPolicyView = authority.kind === 'v2'
    ? buildModelPolicyView(authority.bundle.modelPolicy)
    : null;
  const modelExecutionPlan = modelPolicyView
    ? buildModelExecutionPlan(modelPolicyView, captureLocalVlmConfig())
    : null;
  const runtimeRuleVersions = modelPolicyView ? buildRuntimeRuleVersions() : null;
  const modelExecutionDigest = modelPolicyView && modelExecutionPlan && runtimeRuleVersions
    ? hashCanonicalJson({
        policyDigest: modelPolicyView.policyDigest,
        modelExecutionPlanDigest: modelExecutionPlan.digest,
        runtimeRuleVersionsDigest: runtimeRuleVersions.digest,
      })
    : null;

  return {
    authority,
    configSnapshotRef,
    focusedFileHashes,
    catalogEvidenceHash,
    pages: toPageSnapshotState(pageSnapshot),
    pageImportId: pageSnapshot.pageImportId,
    pageImportHash: pageSnapshot.pageImportHash,
    fieldOptions,
    modelPolicyView,
    modelExecutionPlan,
    runtimeRuleVersions,
    modelExecutionDigest,
  };
}

// ─── OCR pull-forward (contract D5 / amendment 5) ─────────────────────────────

/**
 * Run ONE run-bound OCR attempt for a member (frozen plan route,
 * start-before-transport provenance via `classification_model_calls` on the
 * member child run — mirroring product-evidence-extractor.ts:756-766 /
 * :834-843 with `requireModelCallContext` from the member's persisted
 * snapshot). Mirrors the extractor's local → cloud fallback with the frozen
 * data-sharing policy; the result is written back to
 * `extraction_data_json` by the caller together with the `ocrInputHash` the
 * attempt was started against. Exported for the exactly-once OCR tests.
 */
export async function runFrozenOcrPullForward(params: {
  snapshot: RuntimeClassificationSnapshot;
  childRunId: string;
  item: OnboardingItem;
  workspacePath: string;
}): Promise<{ packagingOcrData: PackagingOcrData | null; ocrOutcome: OcrAttemptOutcome }> {
  const { snapshot, childRunId, item, workspacePath } = params;
  const sku = item.upc;
  const ext: Record<string, any> = item.extractionData ?? {};

  const vlmConfig = getVlmConfig();
  const canUseLocalVlm = vlmConfig?.enabled === true;
  const dataPolicy = snapshot.dataSharing as { textPolicy?: string; imagePolicy?: string } | undefined;
  const canUseCloudImages = dataPolicy?.imagePolicy === 'cloud_allowed';

  let localStatus: OcrAttemptOutcome['status'] = canUseLocalVlm ? 'skipped' : 'disabled';
  let cloudStatus: OcrAttemptOutcome['status'] = canUseCloudImages ? 'skipped' : 'disabled';

  const imageUrls: string[] = [];
  if (ext.primaryImage) imageUrls.push(String(ext.primaryImage));
  if (Array.isArray(ext.additionalImages)) {
    for (const img of ext.additionalImages) {
      if (imageUrls.length >= 2) break;
      if (img && String(img).trim()) imageUrls.push(String(img));
    }
  }

  const ocrResults: PackagingOcrData[] = [];
  let packagingOcrData: PackagingOcrData | undefined;
  let localOcrSucceeded = false;

  if (canUseLocalVlm) {
    localStatus = imageUrls.length > 0 ? 'failed' : 'no_image';
    // Frozen evidence-extraction policy view + run-bound call context ONCE.
    const evidencePolicyView = modelPolicyViewFromConfig(
      snapshot.modelPolicy as Parameters<typeof modelPolicyViewFromConfig>[0],
      snapshot.snapshotHash,
    );
    let localModelCall: ModelCallContext | null = null;
    let localFrozenRoute: { baseUrl: string; model: string } | null = null;
    try {
      localModelCall = requireModelCallContext(snapshot, childRunId, 'evidence_extraction', 1);
      const entry = getModelExecutionPlanEntry(snapshot, 'evidence_extraction');
      if (entry?.localVlmBaseUrl && entry?.localVlmModel) {
        localFrozenRoute = { baseUrl: entry.localVlmBaseUrl, model: entry.localVlmModel };
      }
    } catch (err) {
      localStatus = 'failed';
      console.warn(
        `[CohortCurator] Freeze OCR pull-forward for SKU ${sku} abstained: no compatible frozen plan — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    for (let i = 0; i < imageUrls.length; i++) {
      const imgUrl = imageUrls[i];
      // No compatible plan → no transport, no evidence from the model call.
      if (!localModelCall) continue;
      try {
        const ocrResult = await extractPackagingOcr({
          imageUrl: imgUrl,
          workspacePath,
          imageSourceUrl: imgUrl,
          sku,
          modelCall: localModelCall,
          snapshot,
          frozenVlmRoute: localFrozenRoute,
          modelPolicyDigest: evidencePolicyView?.policyDigest ?? '',
        });
        if (ocrResult && hasOcrContent(ocrResult)) ocrResults.push(ocrResult);
      } catch (err) {
        console.warn(`[CohortCurator] Freeze OCR failed for image ${i + 1}/${imageUrls.length} of SKU ${sku}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (ocrResults.length > 0) {
      const merged = ocrResults.length === 1 ? ocrResults[0] : mergeOcrResults(ocrResults);
      if (hasOcrContent(merged)) {
        localOcrSucceeded = true;
        localStatus = 'succeeded';
        packagingOcrData = merged;
      }
    }
  }

  // Cloud multimodal VLM fallback (runs if local OCR did not succeed).
  if (!localOcrSucceeded && ext.primaryImage && canUseCloudImages) {
    cloudStatus = 'failed';
    try {
      const evidencePolicyView = modelPolicyViewFromConfig(
        snapshot.modelPolicy as Parameters<typeof modelPolicyViewFromConfig>[0],
        snapshot.snapshotHash,
      );
      const { extractPackagingOcrFromCloud } = await import('./cloud-vlm-client');
      let cloudModelCall: ModelCallContext | null = null;
      try {
        cloudModelCall = requireModelCallContext(snapshot, childRunId, 'evidence_extraction', 1);
      } catch (err) {
        cloudStatus = 'failed';
        cloudModelCall = null;
        console.warn(
          `[CohortCurator] Freeze cloud OCR pull-forward for SKU ${sku} abstained: no compatible frozen plan — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (cloudModelCall) {
        const cloudOcrResult = await extractPackagingOcrFromCloud({
          imageUrl: String(ext.primaryImage),
          modelPolicy: evidencePolicyView,
          modelCall: cloudModelCall,
          snapshot,
        });
        if (cloudOcrResult && hasOcrContent(cloudOcrResult)) {
          packagingOcrData = cloudOcrResult;
          cloudStatus = 'succeeded';
        }
      }
    } catch (err) {
      console.warn(`[CohortCurator] Freeze cloud packaging OCR failed for SKU ${sku}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const overallStatus: OcrAttemptOutcome['status'] =
    localStatus === 'succeeded' || cloudStatus === 'succeeded'
      ? 'succeeded'
      : imageUrls.length === 0
        ? 'no_image'
        : !canUseLocalVlm && !canUseCloudImages
          ? 'disabled'
          : 'failed';

  const ocrOutcome: OcrAttemptOutcome = {
    status: overallStatus,
    localStatus,
    cloudStatus,
    model: packagingOcrData?.metadata?.model ?? vlmConfig?.model ?? null,
    imageCount: imageUrls.length,
  };
  return { packagingOcrData: packagingOcrData ?? null, ocrOutcome };
}

// ─── Two-phase freeze service (contract D) ────────────────────────────────────

/** Internal CAS drift signal — rolled back and handled outside the transaction. */
class CohortFreezeCasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CohortFreezeCasError';
  }
}

/** Internal ownership signal — the run is no longer ours to finalize. */
class CohortFreezeOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CohortFreezeOwnershipError';
  }
}

export interface FreezeMemberResult {
  member: CurationCohortMember;
  item: OnboardingItem;
  extractionSourceUrl: string | null;
  /** ocrInputHash the (possibly pulled-forward) OCR was started against. */
  frozenOcrInputHash: string;
  /** Member-local evidence hash after OCR pull-forward. */
  frozenEvidenceHash: string;
  snapshot: RuntimeClassificationSnapshot;
  runtimeSnapId: string;
  runtimeSnapHash: string;
  memberRunId: string;
}

/**
 * Freeze a claimed cohort for execution (the ONLY path to `freezing →
 * running`). Returns the run in its final state:
 * - `running` on success (authorities + snapshot persisted, transitioned);
 * - `superseded` when the final CAS detects drift (children failed);
 * Throws for ownership loss / unexpected errors.
 *
 * `hooks.beforeFinalCas` (test seam) runs immediately before the final CAS
 * transaction so tests can deterministically simulate a freeze-window
 * mutation; production callers never pass it.
 */
export async function freezeCohortForExecution(
  run: CohortRun,
  workspacePath: string,
  workspaceId: string,
  hooks?: { beforeFinalCas?: () => void },
): Promise<CohortRun> {
  const workerId = run.claimedBy ?? '';
  if (!workerId) {
    throw new Error(`Freeze aborted: run ${run.id} has no claim owner.`);
  }
  if (run.status !== 'freezing') {
    // Fail fast: a non-freezing run (already running/superseded/…) can never
    // be re-frozen. The final CAS ownership guard would reject it anyway;
    // reject up front so callers cannot mistake a no-op for progress.
    throw new Error(`Freeze aborted: run ${run.id} is not in 'freezing' state (status=${run.status}).`);
  }

  // 1. Load the candidate cohort + members + items + extraction sources.
  const cohort = getCohortById(run.cohortId);
  if (!cohort || cohort.status !== 'ready' || cohort.supersededAt !== null) {
    throw new Error(`Freeze aborted: cohort ${run.cohortId} is not a ready candidate (status=${cohort?.status ?? 'missing'}).`);
  }
  const members = getCohortMembers(cohort.id);
  if (members.length === 0) {
    throw new Error(`Freeze aborted: cohort ${cohort.id} has no members.`);
  }
  const items = listItemsByBatch(cohort.batchId);
  const itemsById = new Map(items.map(item => [item.id, item]));
  for (const member of members) {
    if (!itemsById.has(member.onboardingItemId)) {
      throw new Error(`Freeze aborted: member item ${member.onboardingItemId} not found in batch ${cohort.batchId}.`);
    }
  }
  const extractionSources = getLatestExtractionSourcesByItemIds(members.map(member => member.onboardingItemId));
  const membershipHash = computeMembershipHash(members.map(member => member.onboardingItemId));
  if (membershipHash !== run.candidateMembershipHash) {
    throw new Error(`Freeze aborted: cohort membership changed since claim (candidate ${run.candidateMembershipHash}, current ${membershipHash}).`);
  }

  // 2. Capture the common authorities ONCE (config/page/policy/H5/fieldOptions).
  const captured = captureCohortAuthorities(workspacePath, workspaceId);

  // 3–4. Per member: snapshot (frozen fieldOptions) + persist + child run +
  //      OCR pull-forward + recompute hash.
  const frozenMembers: FreezeMemberResult[] = [];
  for (const member of members) {
    const item = itemsById.get(member.onboardingItemId)!;
    const extractionSourceUrl = extractionSources.get(item.id) ?? null;
    const currentOcrInputHash = computeOcrInputHash(item, extractionSourceUrl);

    const snapshot = buildRuntimeSnapshot({
      workspaceId,
      workspacePath,
      productSku: item.upc,
      authority: captured.authority,
      configSnapshotRef: captured.configSnapshotRef,
      focusedFileHashes: captured.focusedFileHashes,
      catalogEvidenceHash: captured.catalogEvidenceHash,
      fieldOptions: captured.fieldOptions,
      sourceProductHash: '',
      searchKeywords: item.extractionData?.searchKeywords ? String(item.extractionData.searchKeywords) : null,
      productPageNames: [],
      pages: captured.pages,
      pageImportId: captured.pageImportId,
      pageImportHash: captured.pageImportHash,
    });

    // Defensive: the member plan/rules must match the shared H5 components the
    // cohort run will record (identical inputs ⇒ identical digests).
    if (captured.authority.kind === 'v2') {
      if (!snapshot.modelExecutionPlan || !snapshot.runtimeRuleVersions) {
        throw new Error(`Freeze aborted: member ${item.id} snapshot lacks a frozen model-execution plan.`);
      }
      if (snapshot.modelExecutionPlan.digest !== captured.modelExecutionPlan?.digest ||
          snapshot.runtimeRuleVersions.digest !== captured.runtimeRuleVersions?.digest) {
        throw new Error(`Freeze aborted: member ${item.id} snapshot plan digest drifted from the shared H5 authority.`);
      }
    }

    const { id: runtimeSnapId, hash: runtimeSnapHash } = persistRuntimeSnapshot(snapshot);
    const memberRun = ensureMemberRun(run.id, item.id, workspaceId, item.upc, runtimeSnapId, runtimeSnapHash);
    if (memberRun.configSnapshotId !== runtimeSnapId || memberRun.configSnapshotHash !== runtimeSnapHash) {
      // Re-link the child run to the freeze-persisted snapshot (idempotent
      // ensureMemberRun may have returned a run created by a prior partial
      // freeze with stale refs).
      getDb().run(
        'UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?',
        [runtimeSnapId, runtimeSnapHash, memberRun.id],
      );
    }

    // OCR pull-forward: run ONE run-bound OCR call when the stored OCR is
    // unsettled OR its recorded input set no longer matches the current one.
    const ocrNeedsRun = !isOcrSettled(item) || storedOcrInputHash(item) !== currentOcrInputHash;
    let frozenItem = item;
    if (ocrNeedsRun) {
      const ocr = await runFrozenOcrPullForward({
        snapshot,
        childRunId: memberRun.id,
        item,
        workspacePath,
      });
      const updatedExt = {
        ...item.extractionData,
        ...(ocr.packagingOcrData
          ? { packagingOcrData: ocr.packagingOcrData, packagingTitle: ocr.packagingOcrData.productName }
          : {}),
        ...(ocr.ocrOutcome ? { ocrOutcome: ocr.ocrOutcome } : {}),
        ocrInputHash: currentOcrInputHash,
      };
      updateItemExtractionData(item.id, JSON.stringify(updatedExt));
      frozenItem = { ...item, extractionData: updatedExt as OnboardingItem['extractionData'] };
    }

    const frozenEvidenceHash = computeExtractionHash(frozenItem);
    if (!frozenEvidenceHash) {
      throw new Error(`Freeze aborted: member ${item.id} has no extraction hash after OCR pull-forward.`);
    }

    frozenMembers.push({
      member,
      item: frozenItem,
      extractionSourceUrl,
      frozenOcrInputHash: currentOcrInputHash,
      frozenEvidenceHash,
      snapshot,
      runtimeSnapId,
      runtimeSnapHash,
      memberRunId: memberRun.id,
    });
  }

  // 5. FINAL CAS TRANSACTION — reload + verify + persist + transition in ONE
  //    transaction. OCR ran OUTSIDE this transaction. The test seam hook runs
  //    right before the transaction so a freeze-window mutation can be
  //    simulated deterministically.
  hooks?.beforeFinalCas?.();
  const finalize = (): CohortRun => {
    const db = getDb();
    return db.transaction(() => {
      const reloadedCohort = getCohortById(run.cohortId);
      if (!reloadedCohort || reloadedCohort.status !== 'ready' || reloadedCohort.supersededAt !== null) {
        throw new CohortFreezeCasError(`cohort ${run.cohortId} is no longer a ready candidate (status=${reloadedCohort?.status ?? 'missing'}).`);
      }
      const reloadedMembers = getCohortMembers(run.cohortId);
      const reloadedMembershipHash = computeMembershipHash(reloadedMembers.map(member => member.onboardingItemId));
      if (reloadedMembershipHash !== run.candidateMembershipHash || reloadedCohort.membershipHash !== run.candidateMembershipHash) {
        throw new CohortFreezeCasError(`cohort membership changed during the freeze window (candidate ${run.candidateMembershipHash}, current ${reloadedMembershipHash}).`);
      }
      const reloadedItems = listItemsByBatch(reloadedCohort.batchId);
      const reloadedItemsById = new Map(reloadedItems.map(item => [item.id, item]));
      const reloadedExtractionSources = getLatestExtractionSourcesByItemIds(reloadedMembers.map(member => member.onboardingItemId));

      // (c) each member's CURRENT evidence hash + ocrInputHash still match the
      // frozen values captured during the freeze window.
      for (const frozen of frozenMembers) {
        const currentItem = reloadedItemsById.get(frozen.member.onboardingItemId);
        if (!currentItem) {
          throw new CohortFreezeCasError(`member ${frozen.member.onboardingItemId} disappeared during the freeze window.`);
        }
        const currentEvidenceHash = computeExtractionHash(currentItem);
        if (!currentEvidenceHash || currentEvidenceHash !== frozen.frozenEvidenceHash) {
          throw new CohortFreezeCasError(`member ${frozen.member.onboardingItemId} evidence changed during the freeze window (frozen hash ${frozen.frozenEvidenceHash}, current ${currentEvidenceHash ?? 'none'}).`);
        }
        const currentExtractionSource = reloadedExtractionSources.get(currentItem.id) ?? null;
        const currentOcrInputHash = computeOcrInputHash(currentItem, currentExtractionSource);
        if (currentOcrInputHash !== frozen.frozenOcrInputHash) {
          throw new CohortFreezeCasError(`member ${frozen.member.onboardingItemId} input set changed during the freeze window (ocrInputHash mismatch).`);
        }
      }

      // (d) config/page/policy digests unchanged since capture.
      const currentAuthorities = captureCohortAuthorities(workspacePath, workspaceId);
      if (currentAuthorities.configSnapshotRef.hash !== captured.configSnapshotRef.hash) {
        throw new CohortFreezeCasError('configuration authority changed during the freeze window.');
      }
      if (currentAuthorities.pageImportHash !== captured.pageImportHash) {
        throw new CohortFreezeCasError('Page catalog authority changed during the freeze window.');
      }
      if (currentAuthorities.modelExecutionDigest !== captured.modelExecutionDigest) {
        throw new CohortFreezeCasError('model-execution authority changed during the freeze window.');
      }

      // Build + persist the content-addressed execution-evidence projection.
      const projection = buildExecutionEvidenceProjection(
        workspaceId,
        reloadedCohort,
        reloadedMembers,
        reloadedItems,
        reloadedExtractionSources,
      );
      const payloadJson = canonicalJsonStringify(projection);
      const h2 = hashCanonicalJson(projection);
      const persisted = persistCohortSnapshot({
        workspaceId,
        snapshotHash: h2,
        projectionVersion: PROJECTION_VERSION,
        payloadJson,
      });

      // Write H1–H5 + evidence_snapshot_id, then transition — ownership guarded.
      const frozen = freezeCohortRunAuthorities(run.id, workerId, {
        evidenceSnapshotId: persisted.id,
        evidenceSnapshotHash: h2,
        configSnapshotId: captured.configSnapshotRef.id,
        configSnapshotHash: captured.configSnapshotRef.hash,
        pageImportId: captured.pageImportId,
        pageImportHash: captured.pageImportHash,
        modelPolicyDigest: captured.modelExecutionDigest,
      });
      if (!frozen) {
        throw new CohortFreezeOwnershipError(`Freeze CAS lost ownership of run ${run.id} (not freezing / claimed by ${workerId}).`);
      }
      if (!transitionCohortRunToRunning(run.id, workerId)) {
        throw new CohortFreezeOwnershipError(`Freeze CAS could not transition run ${run.id} to running (ownership lost).`);
      }
      const finalized = getCohortRunById(run.id);
      if (!finalized) {
        throw new CohortFreezeOwnershipError(`Freeze CAS run ${run.id} disappeared after transition.`);
      }
      return finalized;
    })();
  };

  try {
    return finalize();
  } catch (err) {
    if (err instanceof CohortFreezeCasError) {
      // Drift → supersede the freezing run (and fail its linked running
      // children). Execution never starts from a mixed-time snapshot; the
      // cohort stays ready and the next claim creates a fresh run.
      const reason = `Freeze CAS drift: ${err.message}`;
      supersedeCohortRun(run.id, reason);
      const superseded = getCohortRunById(run.id);
      if (!superseded) throw err;
      return superseded;
    }
    throw err;
  }
}

// ─── verifyFrozen implementation for reclaim (contract A, D5) ─────────────────

/**
 * Production `verifyFrozen` verdict for lease reclaim. True ('match') when the
 * run may be resumed:
 * - a `freezing` run with NULL frozen hashes is a crash mid-freeze → vacuous
 *   match (re-freeze allowed, same run id);
 * - otherwise the CURRENT world must still match the frozen run: cohort ready +
 *   non-superseded, membership hash equal, the rebuilt execution-evidence
 *   projection hashes to `evidenceSnapshotHash`, and config/page/policy
 *   digests unchanged. Any throw or mismatch → 'drift' (supersede + new run).
 */
export function verifyCohortRunFrozen(
  run: CohortRun,
  workspacePath: string,
  workspaceId: string,
): boolean {
  try {
    if (run.evidenceSnapshotHash === null) {
      // Crash mid-freeze (nothing finalized yet) → resume and re-freeze.
      return true;
    }
    const cohort = getCohortById(run.cohortId);
    if (!cohort || cohort.status !== 'ready' || cohort.supersededAt !== null) return false;
    const members = getCohortMembers(cohort.id);
    if (computeMembershipHash(members.map(member => member.onboardingItemId)) !== run.candidateMembershipHash) return false;
    if (cohort.membershipHash !== run.candidateMembershipHash) return false;

    const items = listItemsByBatch(cohort.batchId);
    const extractionSources = getLatestExtractionSourcesByItemIds(members.map(member => member.onboardingItemId));
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, extractionSources);
    if (hashCanonicalJson(projection) !== run.evidenceSnapshotHash) return false;

    const current = captureCohortAuthorities(workspacePath, workspaceId);
    if (run.configSnapshotHash !== null && current.configSnapshotRef.hash !== run.configSnapshotHash) return false;
    if (run.pageImportHash !== null && current.pageImportHash !== run.pageImportHash) return false;
    if (run.modelPolicyDigest !== null && current.modelExecutionDigest !== run.modelPolicyDigest) return false;
    return true;
  } catch {
    // Any capture/build failure (page snapshot drift, config load error,
    // missing item, projection validation) is a drift verdict — never resume
    // against an unverifiable freeze.
    return false;
  }
}

// ─── Prepared-cohort execution contract (amendment 6) ─────────────────────────

/**
 * Prepared-cohort context consumed by `curateItemWithPipeline` (cohort mode).
 * When present the curator SKIPS authority capture, per-SKU snapshot
 * creation, stale-run cleanup and child `createRun` — it reuses the
 * freeze-created child run + persisted member runtime snapshot and builds the
 * StageContext from frozen inputs + the member projection.
 */
export interface PreparedCohortContext {
  /** Frozen member execution-evidence projection (contract C). */
  memberProjection: ExecutionEvidenceProjectionMemberV1;
  /** Parent cohort run id (child runs link via cohort_run_id). */
  parentRunId: string;
  /** Persisted runtime snapshot refs created at freeze (child run config refs). */
  memberSnapshotId: string;
  memberSnapshotHash: string;
  /** Shared authorities captured ONCE at freeze (contract D step 2). */
  sharedAuthorities: {
    configSnapshotRef: ClassificationConfigSnapshotRef;
    pages: PageSnapshotState;
    pageImportId: string | null;
    pageImportHash: string | null;
    fieldOptions: Record<string, ResolvedTargetOption[]>;
    focusedFileHashes: Record<string, string>;
    catalogEvidenceHash: string | null;
    modelPolicyView: ModelPolicyView | null;
  };
}

/**
 * Overlay the frozen projection onto an item so the curator's downstream
 * synthesis (`ext`, `sourceUrl`) reads ONLY the frozen evidence — a mutation
 * of `extraction_data_json`/`source_url` after freeze is never visible to the
 * executed member.
 */
export function applyFrozenProjectionToItem(
  item: OnboardingItem,
  projection: ExecutionEvidenceProjectionMemberV1,
): OnboardingItem {
  const ext = item.extractionData ?? ({} as Record<string, unknown>);
  const frozen = projection.extraction;
  return {
    ...item,
    sourceUrl: projection.sourceUrl ?? item.sourceUrl,
    extractionData: ({
      ...ext,
      title: frozen.title ?? null,
      brand: frozen.brand ?? null,
      description: frozen.description ?? null,
      weight: frozen.weight ?? null,
      bulletPoints: [...frozen.bulletPoints],
      searchKeywords: frozen.searchKeywords ?? null,
      primaryImage: frozen.primaryImage ?? null,
      additionalImages: [...frozen.additionalImages],
      customFields: { ...frozen.customFields },
      fieldProvenance: { ...frozen.fieldProvenance },
      packagingTitle: frozen.packagingTitle ?? null,
      packagingOcrData: frozen.ocr.packagingOcrData ?? null,
      ocrOutcome: frozen.ocr.outcome ?? null,
    }) as OnboardingItem['extractionData'],
  };
}
