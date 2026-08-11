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
  listCohortsByWorkspace,
  computeExtractionHash,
  computeMembershipHash,
} from '../db/repositories/curation-cohort-repo';
import {
  ensureMemberRun,
  freezeCohortRunAuthorities,
  transitionCohortRunToRunning,
  supersedeCohortRunIfUnchanged,
  persistCohortSnapshot,
  getCohortRunById,
  completeCohortRun,
  heartbeatCohortRun,
  cancelFreezingRun,
  getCohortSnapshotByHash,
  writeExecutionProductType,
  writeFinalMembershipHash,
  writeProductTypeOutcomeOnly,
  failFrozenCohortRunForConflict,
  insertProposalDependency,
  COHORT_LEASE_TTL_MS,
} from '../db/repositories/classification-cohort-run-repo';
import {
  listItemsByBatch,
  findItemById,
  updateItemExtractionData,
  updateItemStageStatus,
  updateItemCurationData,
} from '../db/repositories/onboarding-item-repo';
import { getLatestExtractionSourcesByItemIds } from '../db/repositories/onboarding-extraction-repo';
import { completeRun, createRun } from '../db/repositories/classification-run-repo';
import type { ClassificationRunRow } from '../db/repositories/classification-run-repo';
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
  getRuntimeSnapshotByHash,
  computeOcrExecutionDigest,
  buildModelCallContext,
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
import { getCohortCurationFlags } from '../classification/flags';
import {
  evidenceFromProjection,
  matchMemberDeterministically,
  resolveCohortProductType,
  mapRankedLabelToOptionExactlyOne,
} from '../classification/cohort-product-type-resolver';
import type {
  CohortProductTypeResolution,
  ConfidentMemberProductTypeResult,
  MemberLlmRankResult,
  CohortMemberInput,
} from '../classification/cohort-product-type-resolver';
import { resolveTargetsFromSnapshot } from '../classification/curation-target-resolver';
import { getEffectiveCurationTypeForSnapshot } from '../classification/effective-curation-type';
import { buildEvidenceTargetPacket } from '../classification/evidence-targeting';
import { llmRankOptions } from '../classification/curation-target-ranker';
import { HeartbeatLostError } from '../classification/heartbeat-errors';
export { HeartbeatLostError };
import { onboardingEvents } from './sse-emitter';
import { redactTransportText } from '../classification/model-policy-gateway';
import type { ProductLineItemSnapshot } from '../classification/types';
import { getVlmConfig } from './vlm-client';
import { extractPackagingOcr, mergeOcrResults } from './packaging-ocr';
import { curateItemWithPipeline } from './product-curator';
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
  ExecutionProductTypeOutcome,
} from '../shared/schemas/cohorts';
import type {
  OnboardingItem,
  PackagingOcrData,
  OcrAttemptOutcome,
  CurationData,
} from '../shared/schemas/onboarding';
import type { ClassificationConfigSnapshotRef } from '../shared/schemas/classification';
import type { ResolvedTargetOption } from '../classification/curation-target-resolver';

const now = () => new Date().toISOString();

/**
 * Effective cohort Product Type confidence floor (PR4 architecture-report §7).
 * A member's resolved type contribution must clear this floor to count as a
 * confident cohort contribution (the per-member matcher's own
 * `KEYWORD_MATCH_MIN_CONFIDENCE` gate still applies first). Read per call
 * from the runtime flags so the env override
 * (`BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR`, default 0.7 — see
 * `src/classification/flags.ts` → `cohortProductTypeConfidenceFloor`) applies
 * without a redeploy; the freeze integration AND the shadow observer both use
 * this effective value.
 */
function cohortProductTypeConfidenceFloor(): number {
  return getCohortCurationFlags().cohortProductTypeConfidenceFloor;
}

// Re-exported so tests keep importing the OCR execution-authority digest from
// the cohort module; the implementation lives with the runtime snapshot it
// derives from (runtime-snapshot.ts).
export { computeOcrExecutionDigest };

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

/** The ocrExecutionDigest recorded with the item's stored OCR (top-level
 *  marker in extraction_data_json, alongside ocrInputHash), or null when the
 *  stored OCR predates the execution-authority binding (unknown authority ⇒
 *  the reuse guard fails closed — Commit A2: reuse requires BOTH the stored
 *  and the current digest to be non-null and equal). */
function storedOcrExecutionDigest(item: OnboardingItem): string | null {
  const ext = item.extractionData as { ocrExecutionDigest?: unknown } | null | undefined;
  return ext && typeof ext.ocrExecutionDigest === 'string' ? ext.ocrExecutionDigest : null;
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
 *   evidence stage may consume, including the OCR outcome/data, the
 *   `ocrInputHash` the OCR was started against, and the `ocrExecutionDigest`
 *   (execution-authority binding, Commit A) it was executed under;
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
    const extractionSourceUrl = extractionSources.get(item.id) ?? null;
    return buildExecutionEvidenceProjectionMember(member, item, extractionSourceUrl);
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

/**
 * Build ONE member's `execution-evidence-v1` entry from its live item — the
 * per-member core of `buildExecutionEvidenceProjection` (same fail-closed
 * extraction-completeness + PI-import-integrity gates). The freeze's per-member
 * loop uses this to build the member projection for the PR4 per-member
 * Product Type evidence directly from the post-OCR `frozenItem`; the final
 * CAS re-derives the identical entry from the reloaded item (verified against
 * the frozen hashes inside the transaction).
 */
function buildExecutionEvidenceProjectionMember(
  member: CurationCohortMember,
  item: OnboardingItem,
  extractionSourceUrl: string | null,
): ExecutionEvidenceProjectionMemberV1 {
  const ext: Record<string, any> = item.extractionData ?? {};

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
        ocrExecutionDigest: storedOcrExecutionDigest(item),
      },
      piEvidence,
      piImportComplete,
    },
    evidenceHash,
  });
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
  /**
   * Ownership assertion (PR3 hardening C) forwarded to the OCR transport's
   * terminal model-call updates. Run-bound cohort calls pass the scoped lease
   * keeper's `assertHeld`; legacy/absent → the transport is unchanged.
   */
  assertHeld?: () => void;
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
          assertHeld: params.assertHeld,
        });
        if (ocrResult && hasOcrContent(ocrResult)) ocrResults.push(ocrResult);
      } catch (err) {
        // PR3 hardening C: an ownership assertion failure during the transport's
        // terminal update aborts the freeze IMMEDIATELY — no further images or
        // writes from the stale owner.
        if (err instanceof HeartbeatLostError) throw err;
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
      // PR3 hardening C: same immediate-abort rule for the cloud fallback.
      if (err instanceof HeartbeatLostError) throw err;
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

/**
 * True when a child classification run accumulated model-call or stage side
 * effects (PR3 hardening, Commit A / R4). A running child with side effects
 * under a DIFFERENT snapshot authority is retired (never rebound); a
 * side-effect-free child is re-linked to the new snapshot in place.
 */
function childRunHasSideEffects(childRunId: string): boolean {
  const db = getDb();
  const call = db.query('SELECT 1 FROM classification_model_calls WHERE run_id = ? LIMIT 1').get(childRunId);
  if (call) return true;
  const stage = db.query('SELECT 1 FROM classification_stage_results WHERE run_id = ? LIMIT 1').get(childRunId);
  return Boolean(stage);
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
 * Deterministic structured conflict reason for a conflicted cohort Product
 * Type resolution (PR4 architecture-report §4 / DECISION-D): per-member ids +
 * SKUs + the distinct confident ids, written into the run's `error_message`
 * when the run completes `failed`. Members are sorted by onboardingItemId so
 * the message is stable across retries. Never majority-forced; no type is
 * written on conflict.
 */
function buildCohortProductTypeConflictReason(
  resolution: Extract<CohortProductTypeResolution, { outcome: 'conflicted' }>,
): string {
  const confident = resolution.perMember.filter(
    (m): m is ConfidentMemberProductTypeResult => !m.isAbstention,
  );
  const distinctIds = [...new Set(confident.map(m => m.productTypeId))].sort((a, b) => a.localeCompare(b));
  const detail = [...resolution.perMember]
    .sort((a, b) => a.onboardingItemId.localeCompare(b.onboardingItemId))
    .map(m => `${m.onboardingItemId}${m.productSku ? ` (${m.productSku})` : ''} -> ${m.productTypeId ?? 'abstained'}@${(m.confidence ?? 0).toFixed(3)}`)
    .join('; ');
  return `cohort_product_type_conflict: ${distinctIds.length} distinct confident Product Types (${distinctIds.join(', ')}); members: ${detail}; no execution type written (family conflict, never majority-forced).`;
}

/**
 * Confidence equality with a tiny epsilon: `product_type_confidence` is a REAL
 * column whose value may be re-derived from the keyword matcher's float
 * arithmetic (`0.45 + score * 0.35`), so a re-stored value can differ from the
 * freshly computed one in the last ulp. Genuinely different confidences are
 * still caught (the epsilon is 1e-9).
 */
function confidenceCloseTo(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= 1e-9;
}

/**
 * PR4 review fix (SHOULD-FIX 4): when a write-once shared-semantic write
 * no-ops during freeze finalization, the run must NOT be blessed into
 * `running` with a mismatched tuple. Reload the stored tuple and require it
 * to equal the freshly resolved `{id, confidence, outcome}`; when
 * `final_membership_hash` is already set it must equal the candidate
 * membership hash (and for a conflicted outcome — which finalizes nothing —
 * the hash slot must stay NULL). Any mismatch throws `CohortFreezeCasError`:
 * the caller supersedes the run (fail-closed, no execution from an incoherent
 * run; the cohort stays ready for a fresh claim).
 */
function assertStoredExecutionTypeMatches(
  runId: string,
  expected: { id: string | null; confidence: number | null; outcome: ExecutionProductTypeOutcome },
  expectedFinalMembershipHash: string | null,
): void {
  const stored = getCohortRunById(runId);
  if (!stored) {
    throw new CohortFreezeCasError(`run ${runId} disappeared during the shared semantic commit.`);
  }
  if (stored.productTypeOutcome !== expected.outcome) {
    throw new CohortFreezeCasError(
      `run ${runId} already carries product_type_outcome '${stored.productTypeOutcome}' but the fresh resolution is '${expected.outcome}' — refusing to finalize an incoherent run.`,
    );
  }
  if (stored.executionProductTypeId !== expected.id) {
    throw new CohortFreezeCasError(
      `run ${runId} already carries execution_product_type_id '${stored.executionProductTypeId}' but the fresh resolution is '${expected.id}' — refusing to finalize an incoherent run.`,
    );
  }
  if (!confidenceCloseTo(stored.productTypeConfidence, expected.confidence)) {
    throw new CohortFreezeCasError(
      `run ${runId} already carries product_type_confidence ${stored.productTypeConfidence} but the fresh resolution is ${expected.confidence} — refusing to finalize an incoherent run.`,
    );
  }
  const storedHash = stored.finalMembershipHash;
  if (expectedFinalMembershipHash === null) {
    if (storedHash !== null) {
      throw new CohortFreezeCasError(
        `run ${runId} already carries final_membership_hash ${storedHash} but the fresh resolution is conflicted — nothing may be finalized.`,
      );
    }
  } else if (storedHash !== null && storedHash !== expectedFinalMembershipHash) {
    throw new CohortFreezeCasError(
      `run ${runId} already carries final_membership_hash ${storedHash} but the candidate membership hash is ${expectedFinalMembershipHash} — refusing to finalize an incoherent run.`,
    );
  }
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
 * mutation; `hooks.onOcrInFlight` (test seam, PR3 hardening A2) fires while a
 * member's OCR pull-forward transport is actually in flight so tests can
 * deterministically simulate a sibling reclaim mid-call; `hooks.onTypeRankerInFlight`
 * (test seam, PR4 re-review fix) fires while a member's `product_type_ranking`
 * LLM transport is genuinely in flight so tests can deterministically simulate
 * a sibling reclaim mid-ranking-call; `hooks.beforeCasSupersede`
 * (test seam, PR4 review fix) fires in the CAS-drift handler immediately
 * before the owner-guarded supersede attempt so tests can deterministically
 * simulate a sibling reclaim between the failed CAS and the supersede;
 * `hooks.beforeConflictTerminal` (test seam, PR4 re-review fix P1-2) fires
 * inside the final CAS immediately before the owner-guarded conflict terminal
 * write so tests can deterministically simulate a sibling reclaim between
 * conflict detection and the helper (the helper must no-op).
 * Production callers never pass any.
 */
export async function freezeCohortForExecution(
  run: CohortRun,
  workspacePath: string,
  workspaceId: string,
  hooks?: {
    beforeFinalCas?: () => void;
    onOcrInFlight?: () => void | Promise<void>;
    onTypeRankerInFlight?: () => void | Promise<void>;
    beforeCasSupersede?: () => void;
    beforeConflictTerminal?: () => void;
  },
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

  // PR4 C4a gate: the Execution Product Type resolver + LLM ranker fallback
  // run ONLY in active mode (`cohortCurationV2Enabled && !cohortShadowOnly`).
  // Flag OFF / shadow: freeze is byte-identical to PR3 — zero resolver
  // invocations, zero model calls, zero writes to the PR4 columns.
  const cohortCurationFlags = getCohortCurationFlags();
  const cohortTypeResolutionActive = cohortCurationFlags.cohortCurationV2Enabled
    && !cohortCurationFlags.cohortShadowOnly;

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
  //      OCR pull-forward + recompute hash. The parent lease is heartbeated
  //      at member granularity (TTL/3 cadence) so a multi-member freeze with
  //      long OCR calls stays inside the TTL; a rejected heartbeat aborts the
  //      freeze (a sibling owns the run now — no further side effects).
  const frozenMembers: FreezeMemberResult[] = [];
  // PR4 C4a: per-member run-bound LLM ranker results (DECISION-A), aligned
  // with `frozenMembers` — null when the member's deterministic keyword match
  // was confident, or the LLM fallback was skipped / unavailable (fail-closed
  // abstention). Empty (never populated) when the resolver is inactive.
  const memberTypeLlmResults: Array<MemberLlmRankResult | null> = [];
  let lastHeartbeatAt = 0;
  for (const member of members) {
    if (Date.now() - lastHeartbeatAt > COHORT_LEASE_TTL_MS / 3) {
      if (!heartbeatCohortRun(run.id, workerId, COHORT_LEASE_TTL_MS)) {
        throw new HeartbeatLostError(
          `freeze lost claim ownership of run ${run.id} (heartbeat rejected; run no longer claimed by ${workerId} / no longer freezing).`,
        );
      }
      lastHeartbeatAt = Date.now();
    }
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
    let memberRun = ensureMemberRun(run.id, item.id, workspaceId, item.upc, runtimeSnapId, runtimeSnapHash);
    if (memberRun.configSnapshotId !== runtimeSnapId || memberRun.configSnapshotHash !== runtimeSnapHash) {
      // Reusing an existing RUNNING child whose snapshot refs differ from the
      // freshly built snapshot (a prior partial freeze captured the child
      // under a DIFFERENT authority). If the child already accumulated
      // model-call/stage side effects, rebinding it would stamp new
      // provenance onto old work — retire it and create a NEW child under the
      // same parent with the new snapshot. With no side effects the refs are
      // updated in place (idempotent ensureMemberRun may have returned a run
      // created by a prior partial freeze with stale refs).
      if (childRunHasSideEffects(memberRun.id)) {
        completeRun(memberRun.id, 'failed', 'snapshot changed during resume');
        memberRun = createRun(workspaceId, item.upc, runtimeSnapId, runtimeSnapHash, {
          onboardingItemId: item.id,
          cohortRunId: run.id,
        });
      } else {
        getDb().run(
          'UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?',
          [runtimeSnapId, runtimeSnapHash, memberRun.id],
        );
      }
    }

    // OCR pull-forward: run ONE run-bound OCR call when the stored OCR is
    // unsettled, OR its recorded input set no longer matches the current one,
    // OR its execution-authority digest no longer matches the CURRENT
    // snapshot's plan/rule digest (R4: old OCR under a changed model policy /
    // local-VLM route is NEVER accepted — it re-runs under the new authority).
    // Fail-closed (Commit A2): reuse requires BOTH digests non-null AND equal
    // — a stored OCR with a missing/uncomputable authority (pre-hardening
    // v1/v2 data) is never accepted, it re-runs under the current authority.
    const currentOcrExecutionDigest = computeOcrExecutionDigest(snapshot);
    const storedExecutionDigest = storedOcrExecutionDigest(item);
    const ocrNeedsRun =
      !isOcrSettled(item) ||
      storedOcrInputHash(item) !== currentOcrInputHash ||
      currentOcrExecutionDigest === null ||
      storedExecutionDigest === null ||
      storedExecutionDigest !== currentOcrExecutionDigest;
    let frozenItem = item;
    if (ocrNeedsRun) {
      // Scoped ownership-guarded lease keeper around the long-awaited OCR
      // call (PR3 hardening A2): the parent lease is renewed on a TTL/3
      // cadence WHILE the transport is in flight (a live-but-slow owner can
      // no longer silently outlive the lease), and the continuation asserts
      // ownership BEFORE the extraction_data_json write-back — a sibling
      // reclaim mid-call aborts the freeze with NO post-loss write. The
      // keeper is always cleared in `finally`.
      const ocrKeeper = new CohortLeaseKeeper(run.id, workerId, COHORT_LEASE_TTL_MS).start();
      try {
        const ocrPromise = runFrozenOcrPullForward({
          snapshot,
          childRunId: memberRun.id,
          item,
          workspacePath,
          // PR3 hardening C: the OCR transport asserts ownership immediately
          // before every terminal model-call update — a sibling reclaim
          // mid-transport skips the terminal write and aborts the freeze.
          assertHeld: () => ocrKeeper.assertHeld(),
        });
        await hooks?.onOcrInFlight?.();
        const ocr = await ocrPromise;
        // No write after ownership loss: the post-await assertion IS the guard.
        ocrKeeper.assertHeld();
        // PR3 hardening C (2a): a re-run outcome ALWAYS replaces the stored
        // OCR — packagingOcrData/packagingTitle are overwritten UNCONDITIONALLY
        // (null when the re-run produced no usable OCR). Old-authority OCR is
        // NEVER preserved and re-stamped with the new digest: an authority-
        // mismatch re-run that returns no usable OCR clears A's data instead of
        // stamping it as B's.
        const updatedExt = {
          ...item.extractionData,
          packagingOcrData: ocr.packagingOcrData ?? null,
          packagingTitle: ocr.packagingOcrData?.productName ?? null,
          ...(ocr.ocrOutcome ? { ocrOutcome: ocr.ocrOutcome } : {}),
          ocrInputHash: currentOcrInputHash,
          ocrExecutionDigest: currentOcrExecutionDigest,
        };
        updateItemExtractionData(item.id, JSON.stringify(updatedExt));
        frozenItem = { ...item, extractionData: updatedExt as OnboardingItem['extractionData'] };
      } finally {
        ocrKeeper.stop();
      }
    }

    const frozenEvidenceHash = computeExtractionHash(frozenItem);
    if (!frozenEvidenceHash) {
      throw new Error(`Freeze aborted: member ${item.id} has no extraction hash after OCR pull-forward.`);
    }

    // PR4 C4a per-member Execution Product Type resolution (active flags
    // only — flag OFF / shadow skips this block entirely): frozen evidence →
    // deterministic keyword match → run-bound LLM ranker fallback (DECISION-A:
    // `product_type_ranking` on the member child run, exactly like the member
    // SKU stage's `processTargetInternal`) when the deterministic match is
    // below the cohort confidence floor. A failing/unavailable LLM path
    // abstains (fail-closed — no silent type from a failed model path). NO
    // writes here; the per-member results feed the final CAS aggregation.
    let memberTypeLlmResult: MemberLlmRankResult | null = null;
    if (cohortTypeResolutionActive) {
      const memberProjection = buildExecutionEvidenceProjectionMember(member, frozenItem, extractionSourceUrl);
      const typeEvidence = evidenceFromProjection(memberProjection);
      const resolvedTypeTarget = resolveTargetsFromSnapshot(snapshot).productTypes[0] ?? null;
      const typeOptions = resolvedTypeTarget?.options ?? [];
      const deterministicTypeMatch = matchMemberDeterministically(typeEvidence, typeOptions);
      const belowFloor =
        deterministicTypeMatch.productTypeId === null ||
        deterministicTypeMatch.confidence === null ||
        deterministicTypeMatch.confidence < cohortProductTypeConfidenceFloor();
      if (belowFloor && resolvedTypeTarget !== null && typeOptions.length > 0) {
        const typePacket = buildEvidenceTargetPacket(typeEvidence, {
          attributeId: null,
          sourceField: null,
          selectionMode: 'single',
        });
        if (typePacket.promptText.trim().length >= 8) {
          // PR4 re-review fix (P1-1): the freeze-time `product_type_ranking`
          // fallback runs under a scoped CohortLeaseKeeper EXACTLY like the
          // OCR pull-forward above — the parent lease is renewed while the
          // ranking transport is in flight, and the continuation asserts
          // ownership before any further work. A sibling reclaim mid-call
          // aborts the freeze with NO post-loss side effect. The keeper is
          // always cleared in `finally`.
          const rankerKeeper = new CohortLeaseKeeper(run.id, workerId, COHORT_LEASE_TTL_MS).start();
          try {
            const rankedPromise = llmRankOptions({
              targetLabel: resolvedTypeTarget.config.label,
              options: typeOptions,
              selectionMode: 'single',
              evidenceText: typePacket.promptText,
              task: 'product_type_classification',
              modelPolicy: snapshot.modelPolicy
                ? modelPolicyViewFromConfig(snapshot.modelPolicy as never, snapshot.snapshotHash)
                : null,
              protectedOperation: 'product_type_ranking',
              modelCall: buildModelCallContext(snapshot, memberRun.id, 'product_type_ranking', 1),
              snapshot,
              // The ranker asserts ownership immediately before every
              // terminal-preflight row and around every awaited transport
              // call — a rejected assertion throws `HeartbeatLostError`.
              assertHeld: () => rankerKeeper.assertHeld(),
            });
            await hooks?.onTypeRankerInFlight?.();
            const ranked = await rankedPromise;
            // No write after ownership loss: the post-await assertion IS the guard.
            rankerKeeper.assertHeld();
            if (ranked && ranked.values.length > 0) {
              // PR4 review fix (BLOCKER): `llmRankOptions` prompts and
              // normalizes exclusively against option LABELS; the persisted
              // `execution_product_type_id` must be the option's canonical
              // VALUE (pt.id). Map the returned label back through this
              // member's FROZEN typeOptions; if no exact label maps the
              // member abstains (fail closed — never an id guessed from a
              // display label). `resolveCohortProductType` applies the same
              // defensive mapping to its `memberLlmResults` input.
              const llmLabel = ranked.values[0];
              // PR4 review fix (SHOULD-FIX): duplicate Product Type display
              // labels are permitted by config validation, so a label matching
              // TWO frozen options is ambiguous — the member must abstain
              // (fail closed), never silently pick the first match. Exactly
              // one matching option maps the label to its canonical VALUE.
              const mappedId = mapRankedLabelToOptionExactlyOne(llmLabel, typeOptions);
              memberTypeLlmResult = mappedId !== null
                ? { productTypeId: mappedId, confidence: ranked.confidence }
                : null;
            }
            // No valid LLM values / no LLM config / no frozen policy → the
            // member abstains (fail-closed).
          } catch (err) {
            // Ownership-loss exceptions are NEVER converted into an 'LLM
            // unavailable → abstain' outcome: the stale owner must abort the
            // freeze deterministically with no further side effects.
            if (err instanceof HeartbeatLostError) throw err;
            // Policy denial / transport failure → abstain, never a silent type.
            memberTypeLlmResult = null;
          } finally {
            rankerKeeper.stop();
          }
        }
      }
    }
    memberTypeLlmResults.push(memberTypeLlmResult);

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

      // PR4 C4a: freeze-time Execution Product Type resolution + write-once
      // final-membership hash — the shared semantic commit (DECISION-B, inside
      // the final CAS transaction). Only in active mode; flag OFF / shadow
      // never invokes the resolver (zero new writes, byte-identical PR3).
      let typeResolution: CohortProductTypeResolution | null = null;
      if (cohortTypeResolutionActive) {
        const memberProjectionByItemId = new Map(projection.members.map(m => [m.onboardingItemId, m]));
        typeResolution = resolveCohortProductType({
          confidenceFloor: cohortProductTypeConfidenceFloor(),
          members: frozenMembers.map(fm => {
            const memberProjection = memberProjectionByItemId.get(fm.member.onboardingItemId);
            if (!memberProjection) {
              throw new CohortFreezeCasError(`member ${fm.member.onboardingItemId} missing from the frozen execution-evidence projection.`);
            }
            return { projection: memberProjection, memberSnapshot: fm.snapshot };
          }),
          memberLlmResults: memberTypeLlmResults,
        });
        if (typeResolution.outcome === 'coherent' || typeResolution.outcome === 'coherent_with_abstentions') {
          // Write-once CAS: a second write (re-entrant freeze / pre-written
          // run) is a no-op — an existing execution type is never overwritten.
          const typeWritten = writeExecutionProductType(run.id, workerId, {
            executionProductTypeId: typeResolution.productTypeId,
            productTypeConfidence: typeResolution.confidence,
            productTypeOutcome: typeResolution.outcome,
          });
          const hashWritten = writeFinalMembershipHash(run.id, workerId, run.candidateMembershipHash);
          // PR4 review fix (SHOULD-FIX 4): a no-op write must not bless a
          // mismatched prewritten tuple as finalized. Reload the stored tuple
          // and require it to equal the fresh resolution (+ the candidate
          // membership hash when the hash slot is already taken); any
          // mismatch throws CohortFreezeCasError and the run is superseded —
          // it never transitions to `running` from an incoherent state.
          if (!typeWritten || !hashWritten) {
            assertStoredExecutionTypeMatches(
              run.id,
              {
                id: typeResolution.productTypeId,
                confidence: typeResolution.confidence,
                outcome: typeResolution.outcome,
              },
              run.candidateMembershipHash,
            );
          }
        } else if (typeResolution.outcome === 'abstained') {
          const outcomeWritten = writeProductTypeOutcomeOnly(run.id, workerId, 'abstained');
          // Abstention still finalizes membership (no family invariant to
          // violate) — final membership = candidate membership.
          const hashWritten = writeFinalMembershipHash(run.id, workerId, run.candidateMembershipHash);
          if (!outcomeWritten || !hashWritten) {
            assertStoredExecutionTypeMatches(
              run.id,
              { id: null, confidence: null, outcome: 'abstained' },
              run.candidateMembershipHash,
            );
          }
        } else {
          // Conflicted: record the outcome ONLY. The execution type id stays
          // NULL (never majority-forced) and final_membership_hash is NOT
          // written (nothing is finalized); the run completes `failed` below.
          const outcomeWritten = writeProductTypeOutcomeOnly(run.id, workerId, 'conflicted');
          if (!outcomeWritten) {
            assertStoredExecutionTypeMatches(run.id, { id: null, confidence: null, outcome: 'conflicted' }, null);
          }
        }
      }

      // PR4 re-review fix (P1-2): a conflicted family NEVER passes through
      // `running` — the parent transitions freezing → failed DIRECTLY via the
      // owner-guarded helper (started_at stays NULL; no transition to running
      // ever happens), which atomically terminalizes every freeze-created
      // child run of this parent in the same transaction. The run stays the
      // current historical decision, the cohort stays ready, and the operator
      // resolves the family later (no UI in PR4). If the helper's CAS fails
      // (ownership lost / no longer freezing), the run belongs to a fresh
      // owner — throw; nothing may be written.
      if (typeResolution?.outcome === 'conflicted') {
        // Test seam (PR4 re-review P1-2): fires inside the final CAS
        // immediately before the owner-guarded conflict terminal write so
        // tests can deterministically simulate a sibling reclaim between
        // conflict detection and the helper.
        hooks?.beforeConflictTerminal?.();
        const conflicted = failFrozenCohortRunForConflict(
          run.id,
          workerId,
          buildCohortProductTypeConflictReason(typeResolution),
        );
        if (!conflicted) {
          throw new CohortFreezeOwnershipError(
            `Freeze CAS lost ownership of run ${run.id} before the conflict terminal write (not freezing / claimed by ${workerId}).`,
          );
        }
      } else if (!transitionCohortRunToRunning(run.id, workerId)) {
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
      // PR4 review fix (BLOCKER): the supersede is OWNER/observed-state
      // guarded. Between the failed final CAS (which rolled back its
      // transaction) and this supersede attempt, another worker can reclaim
      // the run — an unconditional supersede would kill the fresh owner's run
      // and child. Reload the row and supersede ONLY while it is STILL
      // claimed by THIS worker and still `freezing`, CAS'd on the observed
      // {claimed_by, lease_expires_at, status}. The observed values are read
      // FRESH (never the claim-time snapshot): the freeze's periodic
      // heartbeats renew lease_expires_at, and the CAS must match the row as
      // it exists now. A failed supersede, or a run already owned elsewhere
      // / not freezing anymore, is ownership loss: no further mutation — the
      // run survives with its new owner and the CAS error is surfaced.
      hooks?.beforeCasSupersede?.();
      const reason = `Freeze CAS drift: ${err.message}`;
      const current = getCohortRunById(run.id);
      if (current !== null && current.status === 'freezing' && current.claimedBy === workerId) {
        const superseded = supersedeCohortRunIfUnchanged(
          run.id,
          { claimedBy: current.claimedBy, leaseExpiresAt: current.leaseExpiresAt, status: current.status },
          reason,
        );
        if (superseded) {
          const supersededRow = getCohortRunById(run.id);
          if (supersededRow) return supersededRow;
        }
      }
      console.warn(
        `[CohortCurator] Freeze CAS supersede skipped for run ${run.id}: ownership changed after the failed CAS (no mutation — the run survives with its new owner).`,
      );
      throw err;
    }
    throw err;
  }
}

// ─── verifyFrozen implementation for reclaim (contract A, D5) ─────────────────

/**
 * Production `verifyFrozen` verdict for lease reclaim. True ('match') when the
 * run may be resumed:
 * - a `freezing` run with NULL frozen hashes is a crash mid-freeze → vacuous
 *   match ONLY while the run is still actively reclaimable (`status ===
 *   'freezing'`). A cancelled/failed/superseded NULL-hash run is NOT a
 *   vacuous match — it must be superseded (retry / slot reopen), never
 *   resumed as if it were a live freeze;
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
      // Crash mid-freeze (nothing finalized yet) → resume and re-freeze — but
      // only a run that is STILL a live `freezing` claim. A terminal
      // NULL-hash run (cancelled/failed/superseded) is never a vacuous match.
      return run.status === 'freezing';
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

// ─── PR4 C5: shadow-mode deterministic-only resolution (DECISION-E) ───────────

/** One member's contribution to a shadow observation (PR4 C5). */
export interface CohortShadowObservationMember {
  onboardingItemId: string;
  productSku: string | null;
  productTypeId: string | null;
  /** 'keyword' when the deterministic matcher produced the match, else null
   *  (shadow never invokes the LLM ranker — DECISION-E). */
  source: 'keyword' | 'llm' | null;
}

/** One ready cohort's deterministic-only Execution Product Type observation. */
export interface CohortShadowObservation {
  cohortId: string;
  outcome: ExecutionProductTypeOutcome;
  perMember: CohortShadowObservationMember[];
}

/**
 * PR4 C5 shadow-mode observation (architecture-report §7, DECISION-E).
 *
 * Runs the DETERMINISTIC-ONLY cohort Execution Product Type resolver
 * (`evidenceFromProjection` + `matchMemberDeterministically` +
 * `resolveCohortProductType`, the C3 pure module) over every READY,
 * non-superseded cohort in the workspace, from the CURRENT world (members →
 * items → extraction sources → frozen evidence projections). Member runtime
 * snapshots are built IN-MEMORY (never persisted) purely to resolve the
 * product type options from the current config authority — the same evidence
 * the freeze-time active-mode resolution consumes, minus any model calls.
 *
 * Write NOTHING and invoke NO model calls:
 * - no `execution_product_type_id` / `product_type_confidence` /
 *   `product_type_outcome` / `final_membership_hash` writes — run rows are
 *   never created or mutated;
 * - no `classification_proposal_dependencies` rows;
 * - the LLM ranker is never invoked (`memberLlmResults` stays empty — shadow
 *   measures the deterministic outcome only; LLM-vs-deterministic divergence
 *   is exactly the metric shadow should surface).
 *
 * The caller (worker poll leg) invokes this ONLY under
 * `cohortCurationV2Enabled && cohortShadowOnly`; flag OFF / active mode stay
 * byte-identical (this function is simply not called). Returns the
 * observations so tests can assert the computed outcome without parsing
 * logs; the caller logs the `cohort_product_type_shadow` line.
 */
export function observeCohortShadowTypeResolution(
  workspaceId: string,
  workspacePath: string,
): CohortShadowObservation[] {
  const observations: CohortShadowObservation[] = [];
  const readyCohorts = listCohortsByWorkspace(workspaceId).filter(
    cohort => cohort.status === 'ready' && cohort.supersededAt === null,
  );
  if (readyCohorts.length === 0) return observations;

  // The CURRENT config authority (read-only): member snapshots resolve the
  // same product type options a freeze would freeze.
  const activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  const confidenceFloor = cohortProductTypeConfidenceFloor();

  for (const cohort of readyCohorts) {
    try {
      const members = getCohortMembers(cohort.id);
      if (members.length === 0) continue;
      const items = listItemsByBatch(cohort.batchId);
      const itemsById = new Map(items.map(item => [item.id, item]));
      const extractionSources = getLatestExtractionSourcesByItemIds(members.map(member => member.onboardingItemId));

      const memberInputs: CohortMemberInput[] = [];
      for (const member of members) {
        const item = itemsById.get(member.onboardingItemId);
        if (!item) continue;
        const memberProjection = buildExecutionEvidenceProjectionMember(
          member,
          item,
          extractionSources.get(item.id) ?? null,
        );
        // In-memory snapshot — never persisted; only the product-type option
        // resolution path is consumed by the resolver.
        const snapshot = buildRuntimeSnapshot({
          workspaceId,
          workspacePath,
          productSku: item.upc ?? '',
          authority,
          configSnapshotRef: { id: '', hash: '', sourceCommit: null, createdAt: '' },
          sourceProductHash: '',
        });
        memberInputs.push({ projection: memberProjection, memberSnapshot: snapshot });
      }
      if (memberInputs.length === 0) continue;

      // DECISION-E: deterministic-only — no `memberLlmResults`, so the
      // run-bound LLM ranker is never invoked in shadow mode.
      const resolution = resolveCohortProductType({ confidenceFloor, members: memberInputs });
      observations.push({
        cohortId: cohort.id,
        outcome: resolution.outcome,
        perMember: resolution.perMember.map(member => ({
          onboardingItemId: member.onboardingItemId,
          productSku: member.productSku,
          productTypeId: member.productTypeId,
          source: member.source,
        })),
      });
    } catch (err) {
      // Shadow observation is best-effort: a cohort that cannot be projected
      // (e.g. mid-refresh membership) is skipped, never fatal.
      console.warn(`[CohortCurator] Shadow type resolution failed for cohort ${cohort.id} (non-blocking):`, err);
    }
  }
  return observations;
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
  /**
   * Ownership assertion injected by `processCohort` (PR3 hardening A2). The
   * member pipeline calls it before its terminal child write (`completeRun`)
   * so the in-flight member work is completed only while the parent claim is
   * still held — it throws `HeartbeatLostError` once a reclaiming sibling owns
   * the run. Absent in legacy (non-cohort) invocations and when no keeper is
   * installed.
   */
  assertOwnershipHeld?: () => void;
  /**
   * Frozen product-line sibling context (PR3 hardening, Commit B / R2). Built
   * ONCE by `processCohort` via `buildFrozenProductLineContext` from the
   * persisted cohort + the FULL frozen execution-evidence projections.
   * Prepared mode consumes ONLY this — never a live `listItemsByBatch` /
   * `determineProductGroup` sibling read (a post-freeze sibling mutation is
   * never visible to title/page coordination).
   */
  productLineContext?: {
    groupId: string;
    groupLabel: string;
    siblingNames: string[];
    siblingWebTitles: string[];
    siblingOcrTitles: string[];
    siblingSkus: string[];
  };
  /** Frozen per-SKU sibling snapshots (projection-derived) for cohort page coordination. */
  productLineItems?: ProductLineItemSnapshot[];
  /** Frozen member `OnboardingItem` views (projection-derived) for title coordination. */
  frozenBatchItems?: OnboardingItem[];
  /**
   * Cohort-level Execution Product Type resolved at freeze (issue #30 PR4
   * C4b). Filled by `buildPreparedCohortContextForMember` from the parent run
   * row's `execution_product_type_id` / `product_type_confidence` /
   * `product_type_outcome` — ONLY when the id is non-null (coherent /
   * coherent_with_abstentions). Absent when the flag was OFF, the cohort
   * abstained/conflicted (id stays NULL by design), or the run predates PR4.
   * Metadata only: PR4 consumes it to stamp ONE `execution_product_type`
   * dependency row per proposal inside the member-projection atomic commit;
   * no gate logic reads it (review authority is unchanged).
   */
  cohortExecutionType?: {
    id: string | null;
    confidence: number | null;
    outcome: 'coherent' | 'coherent_with_abstentions' | 'conflicted' | 'abstained' | null;
  };
  /**
   * PR5 (DECISION-H/J): the member's effective Curation Product Type — the
   * reviewed (accepted) Primary Product Type from the frozen snapshot's
   * provenance-compatible facts first, the cohort Execution Product Type as
   * fallback, else none. Resolved ONCE in
   * `buildPreparedCohortContextForMember` via `getEffectiveCurationTypeForSnapshot`,
   * so the stages (via `StageContext.cohortExecutionType`) and the
   * member-projection dependency stamping agree by construction. Only
   * `source === 'execution'` with a non-null id triggers
   * `execution_product_type` dependency rows (reviewed-override and `none`
   * members stamp nothing), and the value is exposed read-only on the
   * member's `curation_data_json` as `effectiveProductType` (cohort mode
   * only). Absent for legacy (non-cohort) invocations.
   */
  effectiveType?: { id: string | null; source: 'reviewed' | 'execution' | 'none' };
}

/**
 * Build the frozen per-member execution view (PR3 hardening, Commit B / R2).
 *
 * Prepared mode CONSTRUCTS the executed member FROM the frozen projection — it
 * never overlays onto live semantic evidence. Identity fields (id, upc,
 * batchId, rowNumber, stage/status) are pipeline state and come from the live
 * item; every SEMANTIC field comes from the projection:
 * - `name`/`expectedName`/`brandHint`/`departmentHint`/`price`/`quantity`
 *   from `spreadsheetIdentity`;
 * - `sourceUrl` from the projection VERBATIM — an authoritative null STAYS
 *   null, never `?? item.sourceUrl`;
 * - `extractionData` constructed purely from projection fields (title/brand/
 *   description/weight/bulletPoints/searchKeywords/customFields/
 *   fieldProvenance/primaryImage/additionalImages/packagingTitle/ocr
 *   {outcome,packagingOcrData,ocrInputHash,ocrExecutionDigest}/piEvidence) —
 *   NO live `...ext` spread, so a post-freeze mutation of
 *   `extraction_data_json`/`source_url`/`name`/`brand_hint` is never visible.
 */

/** The frozen `extractionData` view for one member projection — shared by
 *  `buildFrozenItem` (live identity) and `frozenItemFromProjection` (synthetic
 *  sibling views). Constructed PURELY from projection fields. */
function frozenExtractionData(
  projection: ExecutionEvidenceProjectionMemberV1,
): OnboardingItem['extractionData'] {
  const frozen = projection.extraction;
  return {
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
    ocrInputHash: frozen.ocr.ocrInputHash,
    ocrExecutionDigest: frozen.ocr.ocrExecutionDigest ?? null,
    productIntelligenceEvidence: frozen.piEvidence.map(entry => ({
      runId: entry.runId,
      resultHash: entry.resultHash,
      importRecordId: entry.importRecordId,
    })),
    // Member-local evidence identity (H2) from the frozen projection — the
    // executed member's extraction view carries the same evidence identity
    // the execution contract is bound to.
    evidenceHash: projection.evidenceHash,
  } as unknown as OnboardingItem['extractionData'];
}

export function buildFrozenItem(
  projection: ExecutionEvidenceProjectionMemberV1,
  liveItem: OnboardingItem,
): OnboardingItem {
  const spread = projection.spreadsheetIdentity;
  // PR3 hardening C (4): the executed member is CONSTRUCTED — never assembled
  // by spreading the live item. (a) the permitted live identity/pipeline
  // fields below (pipeline state, not semantic evidence); (b) every SEMANTIC
  // field from the frozen projection: spreadsheet identity, authoritative
  // sourceUrl, sourcingDecision, and a purely projection-built extraction
  // view. Live semantic fields (sourcingDecision, accepted attempt IDs, prior
  // curation data, source type) can never leak into the executed member.
  return {
    // (a) Live identity / pipeline state.
    id: liveItem.id,
    upc: liveItem.upc,
    batchId: liveItem.batchId,
    rowNumber: liveItem.rowNumber,
    stage: liveItem.stage,
    stageStatus: liveItem.stageStatus,
    status: 'curated',
    errorMessage: null,
    retryCount: 0,
    isDuplicate: false,
    existingSku: null,
    createdAt: liveItem.createdAt,
    updatedAt: liveItem.updatedAt,
    // (b) Projection semantics — NO live spread.
    name: spread.name,
    expectedName: spread.expectedName,
    brandHint: spread.brandHint,
    departmentHint: spread.departmentHint,
    price: spread.price,
    quantity: spread.quantity,
    // Authoritative null STAYS null — never fall back to a post-freeze live value.
    sourceUrl: projection.sourceUrl,
    sourceType: 'official_page',
    coordinatedTitle: null,
    acceptedEvidenceAttemptId: null,
    acceptedEvidenceAttemptIds: [],
    sourcingDecision: projection.sourcingDecision,
    curationData: null,
    extractionData: frozenExtractionData(projection),
  };
}

/** Minimal frozen `OnboardingItem` view for ONE member — identity from the
 *  projection (member item id, sku, ordinal) + spreadsheet identity + frozen
 *  extraction. Used ONLY as the frozen sibling input for title coordination
 *  (`coordinateCohortItemsOnce`); never persisted. */
function frozenItemFromProjection(
  projection: ExecutionEvidenceProjectionMemberV1,
  batchId: string,
): OnboardingItem {
  const spread = projection.spreadsheetIdentity;
  return {
    id: projection.onboardingItemId,
    batchId,
    upc: projection.productSku ?? '',
    name: spread.name,
    price: spread.price,
    quantity: spread.quantity,
    brandHint: spread.brandHint,
    departmentHint: spread.departmentHint,
    sourceUrl: projection.sourceUrl,
    expectedName: spread.expectedName,
    sourceType: 'official_page',
    acceptedEvidenceAttemptIds: [],
    acceptedEvidenceAttemptId: null,
    sourcingDecision: projection.sourcingDecision,
    stage: 'curation',
    stageStatus: 'pending',
    status: 'curated',
    errorMessage: null,
    retryCount: 0,
    isDuplicate: false,
    existingSku: null,
    extractionData: frozenExtractionData(projection),
    curationData: null,
    rowNumber: spread.rowNumber,
    createdAt: '',
    updatedAt: '',
  };
}

/**
 * Frozen product-line sibling context (PR3 hardening, Commit B / R2).
 *
 * Derived ENTIRELY from the persisted cohort + the FULL frozen
 * execution-evidence projections — sibling skus/names/brands from
 * `spreadsheetIdentity`, webTitles from projection titles, ocrTitles from
 * projection OCR, descriptions from the projection. NO `listItemsByBatch` /
 * `determineProductGroup` live reads: a post-freeze mutation of a sibling's
 * `extraction_data_json`/`name`/`brand_hint` is never visible to title/page
 * coordination. `frozenBatchItems` are frozen `OnboardingItem` views (one per
 * member) consumed as the title-coordination input; `productLineItems` are the
 * frozen per-SKU snapshots consumed by cohort page coordination.
 */
export interface FrozenProductLineContext {
  productLineContext: {
    groupId: string;
    groupLabel: string;
    siblingNames: string[];
    siblingWebTitles: string[];
    siblingOcrTitles: string[];
    siblingSkus: string[];
  };
  productLineItems: ProductLineItemSnapshot[];
  frozenBatchItems: OnboardingItem[];
}

export function buildFrozenProductLineContext(
  cohort: CurationCohort,
  members: CurationCohortMember[],
  projections: ExecutionEvidenceProjectionMemberV1[],
): FrozenProductLineContext {
  const ordered = [...projections].sort((a, b) => a.ordinal - b.ordinal);
  const siblingNames: string[] = [];
  const siblingWebTitles: string[] = [];
  const siblingOcrTitles: string[] = [];
  const siblingSkus: string[] = [];
  const productLineItems: ProductLineItemSnapshot[] = [];
  const frozenBatchItems: OnboardingItem[] = [];

  for (const projection of ordered) {
    const name = projection.spreadsheetIdentity.name;
    const sku = projection.productSku ?? '';
    const ocr = projection.extraction.ocr.packagingOcrData;
    siblingNames.push(name);
    siblingWebTitles.push(projection.extraction.title ?? '');
    const ocrTitle = ocr?.productName?.trim() || projection.extraction.packagingTitle?.trim() || '';
    if (ocrTitle) siblingOcrTitles.push(ocrTitle);
    if (sku) siblingSkus.push(sku);
    productLineItems.push({
      sku,
      name,
      webTitle: projection.extraction.title ?? null,
      // PR3 hardening C (5): the frozen sibling brand comes from
      // spreadsheetIdentity (the trusted import hint) — never the
      // web-extracted brand.
      brand: projection.spreadsheetIdentity.brandHint ?? null,
      description: projection.extraction.description ?? '',
      species: ocr?.species ?? [],
      flavor: ocr?.flavorVariety ?? null,
      lifeStage: ocr?.lifeStage ?? null,
      productForm: ocr?.productForm ?? null,
      healthConcern: ocr?.healthConcernFunction ?? [],
    });
    frozenBatchItems.push(frozenItemFromProjection(projection, cohort.batchId));
  }

  return {
    productLineContext: {
      groupId: cohort.groupKey,
      groupLabel: cohort.groupLabel,
      siblingNames,
      siblingWebTitles,
      siblingOcrTitles,
      siblingSkus,
    },
    productLineItems,
    frozenBatchItems,
  };
}

// ─── Cohort execution (PR3 M3, contract D step 6) ─────────────────────────────

/** One member's execution outcome (recorded, never silently dropped). */
export interface CohortMemberExecutionResult {
  itemId: string;
  productSku: string | null;
  ok: boolean;
  error: string | null;
}

/** Parent completion summary returned by `processCohort`. */
export interface CohortExecutionSummary {
  parentStatus: 'completed' | 'completed_with_abstentions' | 'completed_with_member_failures';
  completedMembers: number;
  memberCount: number;
  memberFailures: CohortMemberExecutionResult[];
}



/**
 * Test-only crash simulation signal (PR3 hardening, Commit B / R3). Thrown by
 * the `afterMemberPipeline` test seam to deterministically simulate a worker
 * crash EXACTLY between a member's pipeline completion and its atomic
 * projection commit. Like `HeartbeatLostError`, it aborts the member/cohort
 * with NO member-failure write — the child stays `running`, no
 * `curation_data_json`, no item stage write — and a reclaim re-executes the
 * member. Documented test-only (mirrors the `beforeFinalCas` freeze seam);
 * production callers never throw it.
 */
export class MemberCommitCrashSimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberCommitCrashSimulationError';
  }
}

/**
 * Scoped ownership-guarded lease keeper (PR3 hardening, Commit A2).
 *
 * Wraps ONE long-awaited operation (a freeze member's OCR pull-forward, a
 * cohort member's execution pipeline). While the operation is in flight the
 * keeper renews the parent cohort run's lease via `heartbeatCohortRun` on a
 * TTL/3 cadence, so a live-but-slow owner can no longer silently outlive the
 * lease and be legitimately reclaimed mid-call. A renewal that returns false
 * means the run is no longer ours (a sibling worker reclaimed it, or it went
 * terminal/superseded): the keeper marks `lost`, and the operation's
 * continuation calls `assertHeld()` before EVERY subsequent write —
 * `assertHeld()` performs an immediate ownership re-assertion (so a loss
 * between renewal ticks is still caught) and throws `HeartbeatLostError` when
 * the claim is gone, aborting with NO further side effects. `stop()` (called
 * in `finally`) clears the renewal timer.
 */
class CohortLeaseKeeper {
  private readonly runId: string;
  private readonly workerId: string;
  private readonly leaseTtlMs: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lost = false;

  constructor(runId: string, workerId: string, leaseTtlMs: number) {
    this.runId = runId;
    this.workerId = workerId;
    this.leaseTtlMs = leaseTtlMs;
    this.intervalMs = Math.max(1, Math.floor(leaseTtlMs / 3));
  }

  /** Start the periodic renewal; the wrapped operation always begins with a
   *  freshly asserted lease. Idempotent. PR3 hardening C: the INITIAL renewal
   *  runs BEFORE the timer is installed and a rejected renewal throws
   *  `HeartbeatLostError` IMMEDIATELY — callers must never begin OCR/pipeline
   *  side effects after ownership is already known lost. */
  start(): this {
    if (this.timer) return this;
    // Renew BEFORE installing the timer: if the run is no longer claimed by
    // us (a sibling reclaimed it, or it went terminal/superseded), ownership
    // is already lost — throw before any side effect begins.
    if (!this.renew()) {
      this.lost = true;
      throw new HeartbeatLostError(
        `Claim ownership already lost at operation start (run ${this.runId} is no longer claimed by ${this.workerId}).`,
      );
    }
    this.timer = setInterval(() => {
      this.renew();
    }, this.intervalMs);
    return this;
  }

  /** Attempt one lease renewal. Marks `lost` on rejection. */
  renew(): boolean {
    if (this.stopped || this.lost) return false;
    const held = heartbeatCohortRun(this.runId, this.workerId, this.leaseTtlMs);
    if (!held) this.lost = true;
    return held;
  }

  /**
   * Ownership assertion for a continuation write. Throws `HeartbeatLostError`
   * when the lease was lost — including a loss that happened between renewal
   * ticks (this is an immediate ownership re-assertion, never a flag-only
   * check), so NO write can occur after the claim moved to another worker.
   */
  assertHeld(): void {
    if (this.lost || !this.renew()) {
      throw new HeartbeatLostError(
        `Claim ownership lost during a long-running operation (run ${this.runId} is no longer claimed by ${this.workerId}).`,
      );
    }
  }

  /** Clear the renewal timer (always called from the operation's `finally`). */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Rebuild the prepared-cohort context for one member from the freeze-persisted
 * child run: the child run's `config_snapshot_*` refs point at the member's
 * frozen runtime snapshot (persisted by `freezeCohortForExecution`); the
 * shared authorities (config ref, verified Page catalog, frozen fieldOptions,
 * model-policy view) are read back from that immutable snapshot — never
 * re-captured live.
 */
function buildPreparedCohortContextForMember(
  parentRun: CohortRun,
  memberProjection: ExecutionEvidenceProjectionMemberV1,
  childRun: ClassificationRunRow,
  workspaceId: string,
): PreparedCohortContext {
  if (!childRun.configSnapshotId || !childRun.configSnapshotHash) {
    throw new Error(
      `processCohort: member ${memberProjection.onboardingItemId} child run ${childRun.id} has no frozen snapshot refs.`,
    );
  }
  const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, childRun.configSnapshotHash);
  if (!memberSnapshot) {
    throw new Error(
      `processCohort: frozen member runtime snapshot ${childRun.configSnapshotHash} not found for item ${memberProjection.onboardingItemId}.`,
    );
  }
  // PR4 C4b: the cohort Execution Product Type is read from the parent run row
  // (written once at freeze inside the final CAS). Filled ONLY when the id is
  // non-null — flag OFF / abstained / conflicted runs leave it absent, so the
  // member pipeline never sees (or records) an execution-type context.
  const cohortExecutionType = parentRun.executionProductTypeId !== null
    ? {
        id: parentRun.executionProductTypeId,
        confidence: parentRun.productTypeConfidence,
        outcome: parentRun.productTypeOutcome,
      }
    : undefined;
  // PR5 (DECISION-H/J): resolve the member's effective Curation Product Type
  // ONCE here — reviewed facts from the member's frozen snapshot first, the
  // cohort Execution Product Type as fallback, else none. The stages
  // (`getEffectiveCurationProductType`) and the member-projection dependency
  // stamping read the SAME resolution, so they agree by construction.
  const resolvedEffectiveType = getEffectiveCurationTypeForSnapshot(
    memberSnapshot,
    parentRun.executionProductTypeId,
  );
  const effectiveType = {
    id: resolvedEffectiveType.effectiveTypeId,
    source: resolvedEffectiveType.source,
  };
  return {
    memberProjection,
    parentRunId: parentRun.id,
    memberSnapshotId: childRun.configSnapshotId,
    memberSnapshotHash: childRun.configSnapshotHash,
    sharedAuthorities: {
      configSnapshotRef: memberSnapshot.configSnapshotRef,
      pages: memberSnapshot.pages,
      pageImportId: memberSnapshot.pageImportId,
      pageImportHash: memberSnapshot.pageImportHash,
      fieldOptions: memberSnapshot.fieldOptions,
      focusedFileHashes: memberSnapshot.focusedFileHashes,
      catalogEvidenceHash: memberSnapshot.catalogEvidenceHash,
      modelPolicyView: memberSnapshot.modelPolicy
        ? modelPolicyViewFromConfig(memberSnapshot.modelPolicy as never, memberSnapshot.snapshotHash)
        : null,
    },
    cohortExecutionType,
    effectiveType,
  };
}

/**
 * Execute a frozen (`running`) cohort run (PR3 M3, contract D step 6). Per
 * member in ordinal order: renew the parent lease on a scoped periodic
 * cadence (TTL/3 — ownership-guarded), run `curateItemWithPipeline` in
 * prepared-cohort mode against the freeze-persisted member projection +
 * runtime snapshot, persist `curation_data_json`, mark the item's Curation
 * stage completed, and record failures WITHOUT aborting the cohort — a member
 * failure never stops the remaining members.
 *
 * Parent completion (write-once via `completeCohortRun`):
 * - `completed` — every member completed;
 * - `completed_with_abstentions` — every member completed and at least one
 *   child run completed with reviewable abstentions;
 * - `completed_with_member_failures` — some members individually failed but
 *   the cohort-level semantic work committed (D1);
 * - `failed` — the cohort-level semantic state is unreachable (missing frozen
 *   snapshot / members / items / ownership) — thrown after completing the run.
 *
 * Heartbeat hardening (PR3 hardening, Commit A + A2): the lease is renewed
 * when `now - lastHeartbeatAt > COHORT_LEASE_TTL_MS / 3` (so a long
 * OCR/model/pipeline call can no longer silently outlive the TTL), and a
 * scoped `CohortLeaseKeeper` renews the lease on the same cadence WHILE each
 * long-awaited member pipeline is in flight. Every post-await write
 * (curation_data_json, item stage update) re-asserts ownership first; the
 * member pipeline's own terminal child write is ownership-guarded via
 * `PreparedCohortContext.assertOwnershipHeld`. A heartbeat/renewal that
 * returns false throws `HeartbeatLostError`; the caller aborts the
 * member/cohort deterministically with NO terminal write at all (the run now
 * belongs to the reclaiming worker — the stale owner never fails the child,
 * completes the parent, or writes the item).
 *
 * Frozen execution purity (PR3 hardening, Commit B / R2): sibling context is
 * built ONCE from the persisted cohort + the FULL frozen execution-evidence
 * projections (`buildFrozenProductLineContext`) — the live
 * `listItemsByBatch`/`determineProductGroup` sibling reads are gone from the
 * cohort path, and every member executes on `buildFrozenItem` (projection
 * semantics + live identity only).
 *
 * Member-projection atomic commit (PR3 hardening, Commit B / R3): prepared
 * `curateItemWithPipeline` leaves the child run RUNNING; per member this
 * function writes `curation_data_json` + item `completed` + the child
 * terminal status in ONE transaction. Crash-recovery resume (same run id,
 * reclaim-on-match) re-executes a member UNLESS the recovery skip rule holds:
 * child run terminal-success AND `curation_data_json.classificationRunId ===
 * childRunId` AND item `stageStatus === 'completed'`. The test-only
 * `hooks.afterMemberPipeline` seam (mirrors `beforeFinalCas`) simulates a
 * crash exactly between pipeline completion and that commit — see
 * `MemberCommitCrashSimulationError`.
 */
export async function processCohort(
  run: CohortRun,
  workspacePath: string,
  workspaceId: string,
  hooks?: {
    onPipelineInFlight?: () => void | Promise<void>;
    /** Test-only crash seam (R3): fires after a member pipeline completes and
     *  before its atomic projection commit. Production callers never pass it. */
    afterMemberPipeline?: () => void | Promise<void>;
    /** Test-only in-transaction seam (PR4 review SHOULD-FIX 5): fires INSIDE
     *  the member-projection transaction after the dependency rows are
     *  inserted but before the callback returns, so tests can observe the
     *  uncommitted rows / item projection / child terminal status, or throw
     *  to prove the whole member commit rolls back atomically. Production
     *  callers never pass it. */
    afterMemberProjectionDependencyInsert?: () => void;
  },
): Promise<CohortExecutionSummary> {
  if (run.status !== 'running') {
    const reason = `processCohort aborted: run ${run.id} is not 'running' (status=${run.status}); only a frozen run may be executed.`;
    // Terminal write respecting the hash-required CHECK: a run that carried
    // frozen evidence hashes may complete `failed`; an unfinalized `freezing`
    // run (NULL hashes) can only leave `freezing` via a CHECK-exempt terminal
    // — `cancelled` (supersede is reserved for the reclaim/drift path).
    if (run.evidenceSnapshotHash !== null) {
      completeCohortRun(run.id, 'failed', reason);
    } else {
      cancelFreezingRun(run.id, reason);
    }
    throw new Error(reason);
  }
  const workerId = run.claimedBy;
  if (!workerId) {
    const reason = `processCohort aborted: run ${run.id} has no claim owner.`;
    completeCohortRun(run.id, 'failed', reason);
    throw new Error(reason);
  }

  // The frozen execution-evidence projection is the member execution contract.
  const snapshot = run.evidenceSnapshotHash ? getCohortSnapshotByHash(workspaceId, run.evidenceSnapshotHash) : null;
  if (!snapshot) {
    const reason = `processCohort aborted: run ${run.id} has no persisted execution-evidence snapshot (evidence_snapshot_hash=${run.evidenceSnapshotHash ?? 'null'}).`;
    // Owner-guarded terminal write: a run another worker reclaimed is never
    // failed by this (stale) caller.
    completeCohortRun(run.id, 'failed', reason, { ownerGuard: { workerId } });
    throw new Error(reason);
  }
  let projection: ExecutionEvidenceProjectionV1;
  try {
    projection = ExecutionEvidenceProjectionV1Schema.parse(JSON.parse(snapshot.payloadJson));
  } catch (err) {
    const reason = `processCohort aborted: run ${run.id} snapshot payload is corrupt: ${err instanceof Error ? err.message : String(err)}`;
    completeCohortRun(run.id, 'failed', reason, { ownerGuard: { workerId } });
    throw new Error(reason, { cause: err });
  }

  const cohort = getCohortById(run.cohortId);
  if (!cohort) {
    const reason = `processCohort aborted: cohort ${run.cohortId} not found.`;
    completeCohortRun(run.id, 'failed', reason, { ownerGuard: { workerId } });
    throw new Error(reason);
  }
  const members = getCohortMembers(cohort.id);
  if (members.length === 0) {
    const reason = `processCohort aborted: cohort ${cohort.id} has no members.`;
    completeCohortRun(run.id, 'failed', reason, { ownerGuard: { workerId } });
    throw new Error(reason);
  }
  // PR3 hardening (Commit B / R2): cohort execution loads member identity
  // per-member (pipeline state only — id/upc/stage/status/curation data for
  // the skip rule). NO batch-wide listItemsByBatch read in the cohort path:
  // all SEMANTIC evidence comes from the frozen projection.
  const itemsById = new Map<string, OnboardingItem>();
  for (const memberProjection of projection.members) {
    const liveItem = findItemById(memberProjection.onboardingItemId);
    if (!liveItem) {
      const reason = `processCohort aborted: member item ${memberProjection.onboardingItemId} not found in batch ${cohort.batchId}.`;
      completeCohortRun(run.id, 'failed', reason, { ownerGuard: { workerId } });
      throw new Error(reason);
    }
    itemsById.set(liveItem.id, liveItem);
  }

  // The frozen projection is the authority for member ordering (ordinal).
  const orderedMembers = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const memberFailures: CohortMemberExecutionResult[] = [];
  let hasAbstentions = false;
  let completedMembers = 0;

  // Frozen product-line sibling context (PR3 hardening, Commit B / R2): built
  // ONCE from the persisted cohort + the FULL frozen projections. Prepared
  // members use ONLY this — the live listItemsByBatch/determineProductGroup
  // sibling reads are gone from the cohort execution path, so a post-freeze
  // mutation of a sibling's extraction_data_json/name/brand_hint is never
  // visible to title/page coordination.
  const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);

  // Scoped periodic heartbeat (PR3 hardening, Commit A): the lease is renewed
  // when `now - lastHeartbeatAt > COHORT_LEASE_TTL_MS / 3`, so a long
  // OCR/model/pipeline call can no longer silently outlive the TTL. `lastHeartbeatAt`
  // starts at 0 so the FIRST check always attempts a heartbeat (the lease may be
  // near expiry from the reclaim). A rejected heartbeat throws `HeartbeatLostError`.
  const HEARTBEAT_INTERVAL_MS = Math.floor(COHORT_LEASE_TTL_MS / 3);
  let lastHeartbeatAt = 0;
  const renewHeartbeat = (force = false): void => {
    if (!force && Date.now() - lastHeartbeatAt <= HEARTBEAT_INTERVAL_MS) return;
    if (!heartbeatCohortRun(run.id, workerId, COHORT_LEASE_TTL_MS)) {
      throw new HeartbeatLostError(
        `processCohort lost claim ownership of run ${run.id} (heartbeat rejected: run is no longer claimed by ${workerId} / no longer freezing or running).`,
      );
    }
    lastHeartbeatAt = Date.now();
  };

  // Deterministic abort on ownership loss: NO terminal write at all (PR3
  // hardening A2). The run now belongs to the reclaiming worker — never
  // completeCohortRun, never fail the child, never write the item. Every
  // post-await write was already guarded by the lease keeper's `assertHeld`.
  const abortOnHeartbeatLost = (err: HeartbeatLostError): never => {
    throw err;
  };

  for (const memberProjection of orderedMembers) {
    const item = itemsById.get(memberProjection.onboardingItemId)!;

    // Resume guard (crash-recovery reclaim-on-match keeps the SAME run id).
    // Recovery skip rule (PR3 hardening, Commit B / R3): a member is skipped
    // ONLY IF the child run is terminal-success AND the item's committed
    // projection references exactly that child AND the item stage is
    // completed. Otherwise the member is re-executed (a still-running child
    // with no projection commit is reused via ensureMemberRun).
    const childRow = getDb().query(
      `SELECT id, status FROM classification_runs
       WHERE cohort_run_id = ? AND onboarding_item_id = ?
       ORDER BY started_at DESC LIMIT 1`,
    ).get(run.id, item.id) as { id: string; status: string } | undefined;
    const projectionCommitted =
      childRow !== undefined &&
      (childRow.status === 'completed' || childRow.status === 'completed_with_abstentions') &&
      item.curationData?.classificationRunId === childRow.id &&
      item.stageStatus === 'completed';
    if (projectionCommitted) {
      completedMembers++;
      if (childRow.status === 'completed_with_abstentions') hasAbstentions = true;
      console.log(`[CohortCurator] Member ${item.upc ?? item.id} projection already committed under run ${run.id} (child ${childRow.id}) — resume guard skips re-execution.`);
      continue;
    }

    let curationData: CurationData;
    try {
      // Ownership assertion BEFORE the first member side effect (child create).
      renewHeartbeat();
      const childRun = ensureMemberRun(run.id, item.id, workspaceId, item.upc ?? '', null, null);
      if (!childRun.configSnapshotId || !childRun.configSnapshotHash) {
        // A freshly created child (re-execution after a terminal child with no
        // committed projection — R3 skip-rule recovery) inherits the
        // freeze-persisted member snapshot refs from the prior child under this
        // parent; the member runtime snapshot is immutable, so the refs are
        // exact. With no prior refs, buildPreparedCohortContextForMember fails
        // closed below (deterministic member failure).
        const prior = getDb().query(
          `SELECT config_snapshot_id, config_snapshot_hash FROM classification_runs
           WHERE cohort_run_id = ? AND onboarding_item_id = ?
             AND config_snapshot_id IS NOT NULL AND config_snapshot_hash IS NOT NULL
           ORDER BY started_at DESC LIMIT 1`,
        ).get(run.id, item.id) as { config_snapshot_id: string; config_snapshot_hash: string } | undefined;
        if (prior) {
          getDb().run(
            'UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?',
            [prior.config_snapshot_id, prior.config_snapshot_hash, childRun.id],
          );
          childRun.configSnapshotId = prior.config_snapshot_id;
          childRun.configSnapshotHash = prior.config_snapshot_hash;
        }
      }
      const prepared = buildPreparedCohortContextForMember(run, memberProjection, childRun, workspaceId);

      // Frozen sibling context (Commit B / R2) — attached from the
      // projection-derived line context, never from a live batch query.
      prepared.productLineContext = frozenLineContext.productLineContext;
      prepared.productLineItems = frozenLineContext.productLineItems;
      prepared.frozenBatchItems = frozenLineContext.frozenBatchItems;

      // Scoped ownership-guarded lease keeper around the long-awaited member
      // pipeline (PR3 hardening A2): the parent lease is renewed on a TTL/3
      // cadence WHILE the pipeline is in flight, the member pipeline's own
      // terminal child write is ownership-guarded via
      // `prepared.assertOwnershipHeld`, and the continuation re-asserts
      // ownership before EVERY processCohort write (curation_data_json, item
      // stage) — a sibling reclaim mid-pipeline aborts with NO post-loss
      // writes. The keeper is always cleared in `finally`.
      const pipelineKeeper = new CohortLeaseKeeper(run.id, workerId, COHORT_LEASE_TTL_MS).start();
      try {
        prepared.assertOwnershipHeld = () => pipelineKeeper.assertHeld();
        const pipelinePromise = curateItemWithPipeline(item, workspacePath, workspaceId, prepared);
        await hooks?.onPipelineInFlight?.();
        curationData = await pipelinePromise;
        // Test-only crash seam (R3): simulates a worker crash EXACTLY between
        // the member's pipeline completion and its atomic projection commit.
        // The MemberCommitCrashSimulationError is rethrown by the member catch
        // with NO member-failure write — a reclaim re-executes the member.
        await hooks?.afterMemberPipeline?.();
        // No write after ownership loss: the post-await assertion IS the guard.
        pipelineKeeper.assertHeld();
      } finally {
        pipelineKeeper.stop();
      }

      // ONE atomic member-projection commit (PR3 hardening, Commit B / R3):
      // curation_data_json + item stage completion + the child terminal status
      // (derived from the pipeline result) are written in ONE transaction — a
      // crash never leaves a completed child without its projection, and the
      // recovery skip rule requires all three together. PR4 C4b dependency
      // metadata rows are stamped INSIDE this same transaction: every proposal
      // of the child run gets ONE `execution_product_type` dependency row
      // when the member's effective Curation Product Type actually came from
      // the cohort Execution Product Type (PR5 DECISION-H — execution-source
      // only). A reviewed-override member (effective source `reviewed`) or a
      // `none` member is never execution-driven and stamps NOTHING, so a
      // future execution-type change can never falsely stale reviewed-driven
      // proposals. Written here (and only here) means the rows exist IFF the
      // member projection commit exists — a crash before this transaction
      // leaves zero rows, and a committed projection is never missing its
      // dependencies.
      // PR4 review fix (SHOULD-FIX 3): the stamping targets EVERY proposal row
      // belonging to the child run — including rows persisted by a pre-crash
      // attempt (a crash seam can leave earlier-attempt proposals on the same
      // child run) — not just the current attempt's curation-data list. The
      // insert is idempotent ((proposal_id, dependency_kind) unique + a
      // check-then-insert), so re-stamping is a no-op.
      const childTerminalStatus: 'completed' | 'completed_with_abstentions' =
        curationData.classificationProposals.some(p => p.proposalType === 'reviewable_abstention')
          ? 'completed_with_abstentions'
          : 'completed';
      getDb().transaction(() => {
        updateItemCurationData(item.id, JSON.stringify(curationData));
        updateItemStageStatus(item.id, 'completed');
        completeRun(childRun.id, childTerminalStatus);
        const execType = prepared.cohortExecutionType;
        // PR5 (DECISION-H): stamp `execution_product_type` dependency rows
        // ONLY when the member's effective Curation Product Type came from the
        // cohort Execution Product Type. `source === 'execution'` implies the
        // execution id was non-null (the resolver never emits `execution` for
        // an absent id), so `execType` is defined here; the dependency value
        // hash tuple is unchanged from PR4.
        if (
          prepared.effectiveType?.source === 'execution' &&
          prepared.effectiveType.id !== null &&
          execType !== undefined
        ) {
          const dependencyValueHash = hashCanonicalJson({
            executionProductTypeId: prepared.effectiveType.id,
            productTypeConfidence: execType.confidence,
          });
          const childProposalRows = getDb().query(
            'SELECT id FROM classification_proposals WHERE run_id = ?',
          ).all(childRun.id) as Array<{ id: string }>;
          for (const proposalRow of childProposalRows) {
            insertProposalDependency({
              workspaceId,
              proposalId: proposalRow.id,
              dependencyKind: 'execution_product_type',
              dependencyTargetId: prepared.effectiveType.id,
              dependencyValueHash,
            });
          }
        }
        // Test-only in-transaction seam (PR4 review SHOULD-FIX 5): fires
        // after the dependency rows are inserted, before the callback returns
        // and before the transaction commits.
        hooks?.afterMemberProjectionDependencyInsert?.();
      })();
      completedMembers++;
      if (childTerminalStatus === 'completed_with_abstentions') hasAbstentions = true;

      onboardingEvents.emitItemStatus(cohort.batchId, item.id, 'completed', {
        stage: 'curation',
        cohortRunId: run.id,
        curationData,
      });
      console.log(
        `[CohortCurator] ✓ Member ${item.upc ?? item.id} curated under run ${run.id}: ` +
        `title="${curationData.curatedTitle || 'N/A'}", suggestedPages=[${(curationData.suggestedPages || []).join(', ') || 'none'}]`,
      );
    } catch (err) {
      if (err instanceof HeartbeatLostError) {
        abortOnHeartbeatLost(err);
      }
      // Simulated worker crash (test-only seam): rethrow with NO member-failure
      // write — exactly like the heartbeat-lost abort, the caller observes a
      // process crash and a reclaim re-executes the member atomically.
      if (err instanceof MemberCommitCrashSimulationError) {
        throw err;
      }
      const errorText = redactTransportText(err instanceof Error ? err.message : String(err));
      console.error(`[CohortCurator] Member ${item.upc ?? item.id} failed under run ${run.id}: ${errorText}`);
      // Ownership assertion before the item-failure write: even a general
      // (non-heartbeat) pipeline error must not write the item once the claim
      // was lost to a reclaiming worker.
      renewHeartbeat(true);
      // Record and continue — a member failure never aborts the cohort unless
      // the shared semantic state is unreachable (handled above).
      updateItemStageStatus(item.id, 'failed', errorText);
      onboardingEvents.emitItemStatus(cohort.batchId, item.id, 'failed', {
        stage: 'curation',
        cohortRunId: run.id,
        error: errorText,
      });
      memberFailures.push({ itemId: item.id, productSku: item.upc ?? null, ok: false, error: errorText });
    }
  }

  // Post-execution ownership assertion (forced): if the claim was lost while
  // processing the last member (a sibling reclaimed the lease), the parent
  // completion must not proceed — and a lost claim gets NO terminal write at
  // all (the run now belongs to the reclaiming worker).
  renewHeartbeat(true);

  const parentStatus = memberFailures.length > 0
    ? 'completed_with_member_failures'
    : hasAbstentions
      ? 'completed_with_abstentions'
      : 'completed';
  const errorMessage = memberFailures.length > 0
    ? `${memberFailures.length} member(s) failed: ${memberFailures
        .map(f => `${f.productSku ?? f.itemId}: ${f.error}`)
        .join('; ')
        .slice(0, 2000)}`
    : undefined;
  // Owner-guarded terminal write: only the current claim owner may complete
  // the run (a stale owner's completion is a no-op).
  completeCohortRun(run.id, parentStatus, errorMessage, { ownerGuard: { workerId } });
  console.log(
    `[CohortCurator] ✓ Cohort run ${run.id} completed with status ${parentStatus} ` +
    `(${completedMembers}/${orderedMembers.length} members)`,
  );
  return { parentStatus, completedMembers, memberCount: orderedMembers.length, memberFailures };
}
