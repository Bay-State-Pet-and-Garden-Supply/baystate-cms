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
  completeCohortRun,
  heartbeatCohortRun,
  cancelFreezingRun,
  getCohortSnapshotByHash,
  COHORT_LEASE_TTL_MS,
} from '../db/repositories/classification-cohort-run-repo';
import {
  listItemsByBatch,
  updateItemExtractionData,
  updateItemStageStatus,
} from '../db/repositories/onboarding-item-repo';
import { getLatestExtractionSourcesByItemIds } from '../db/repositories/onboarding-extraction-repo';
import { getRun, completeRun, createRun } from '../db/repositories/classification-run-repo';
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
import { onboardingEvents } from './sse-emitter';
import { determineProductGroup } from './product-line-grouper';
import { redactTransportText } from '../classification/model-policy-gateway';
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

/** Strip URL credentials before hashing — an OCR authority digest never bakes
 *  credentials into even a digest. Deterministic for identical authorities. */
function sanitizeUrlForDigest(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Not a URL — hash the raw string (still a digest, no plaintext leak).
    return url;
  }
}

/**
 * OCR execution-authority digest (PR3 hardening, Commit A / R4 + A2):
 * - v2 snapshots: `hashCanonicalJson({planDigest, ruleVersionsDigest})` over
 *   the member snapshot's `evidence_extraction` model-execution-plan entry
 *   (provider, model, locality, prompt/rule versions, frozen local-VLM route
 *   WITHOUT credentials) plus `runtimeRuleVersions.digest`. The stored OCR is
 *   only reusable when this digest matches the CURRENT snapshot's authority —
 *   a model-policy / local-VLM-route change re-runs OCR under the new
 *   authority.
 * - v1 (legacy) snapshots: a deterministic legacy-authority digest,
 *   `hashCanonicalJson({authorityKind:'v1', snapshotHash})`, bound to the
 *   snapshot's content identity. A changed v1 config/evidence set changes the
 *   snapshot hash and therefore the digest — legacy OCR is NEVER "unbound":
 *   it is always executed under SOME authority digest (Commit A2 fail-closed).
 * Returns null only for an impossible v2 snapshot with a missing plan/rules
 * (the freeze fails closed on that); callers treat null as "never reuse".
 */
export function computeOcrExecutionDigest(snapshot: RuntimeClassificationSnapshot): string | null {
  if (snapshot.schemaVersion !== 2) {
    return hashCanonicalJson({ authorityKind: 'v1', snapshotHash: snapshot.snapshotHash });
  }
  const plan = snapshot.modelExecutionPlan;
  const rules = snapshot.runtimeRuleVersions;
  if (!plan || !rules) return null;
  const entry = plan.entries.find(e => e.operation === 'evidence_extraction');
  if (!entry) return null;
  const planDigest = hashCanonicalJson({
    operation: entry.operation,
    stage: entry.stage,
    provider: entry.provider,
    model: entry.model,
    locality: entry.locality,
    fromOverride: entry.fromOverride,
    promptTemplateVersion: entry.promptTemplateVersion,
    ruleVersion: entry.ruleVersion,
    localVlmBaseUrl: sanitizeUrlForDigest(entry.localVlmBaseUrl),
    localVlmModel: entry.localVlmModel ?? null,
  });
  return hashCanonicalJson({ planDigest, ruleVersionsDigest: rules.digest });
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
          ocrExecutionDigest: storedOcrExecutionDigest(item),
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
 * deterministically simulate a sibling reclaim mid-call. Production callers
 * never pass either.
 */
export async function freezeCohortForExecution(
  run: CohortRun,
  workspacePath: string,
  workspaceId: string,
  hooks?: { beforeFinalCas?: () => void; onOcrInFlight?: () => void | Promise<void> },
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
  //      OCR pull-forward + recompute hash. The parent lease is heartbeated
  //      at member granularity (TTL/3 cadence) so a multi-member freeze with
  //      long OCR calls stays inside the TTL; a rejected heartbeat aborts the
  //      freeze (a sibling owns the run now — no further side effects).
  const frozenMembers: FreezeMemberResult[] = [];
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
        });
        await hooks?.onOcrInFlight?.();
        const ocr = await ocrPromise;
        // No write after ownership loss: the post-await assertion IS the guard.
        ocrKeeper.assertHeld();
        const updatedExt = {
          ...item.extractionData,
          ...(ocr.packagingOcrData
            ? { packagingOcrData: ocr.packagingOcrData, packagingTitle: ocr.packagingOcrData.productName }
            : {}),
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
 * A cohort-level execution abort (claim ownership lost — PR3 hardening,
 * Commit A). Thrown when a heartbeat attempt returns false. The caller
 * aborts the member/cohort deterministically (fails the in-flight child run
 * and the parent) and initiates NO further side effects after the loss.
 * `processCohort` only throws this after all cohort-level validation has
 * passed. (Supersedes the M3 `CohortRunOwnershipAbortError` semantics.)
 */
export class HeartbeatLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeartbeatLostError';
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
   *  freshly asserted lease. Idempotent. */
  start(): this {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.renew();
    }, this.intervalMs);
    this.renew();
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
  parentRunId: string,
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
  return {
    memberProjection,
    parentRunId,
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
 * completes the parent, or writes the item). Crash-recovery resume (same run
 * id, reclaim-on-match) never re-executes a member whose child run already
 * completed under this parent.
 */
export async function processCohort(
  run: CohortRun,
  workspacePath: string,
  workspaceId: string,
  hooks?: { onPipelineInFlight?: () => void | Promise<void> },
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
  const items = listItemsByBatch(cohort.batchId);
  const itemsById = new Map(items.map(item => [item.id, item]));
  for (const memberProjection of projection.members) {
    if (!itemsById.has(memberProjection.onboardingItemId)) {
      const reason = `processCohort aborted: member item ${memberProjection.onboardingItemId} not found in batch ${cohort.batchId}.`;
      completeCohortRun(run.id, 'failed', reason, { ownerGuard: { workerId } });
      throw new Error(reason);
    }
  }

  // The frozen projection is the authority for member ordering (ordinal).
  const orderedMembers = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const memberFailures: CohortMemberExecutionResult[] = [];
  let hasAbstentions = false;
  let completedMembers = 0;
  const nowIso = new Date().toISOString();

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

    // Resume guard (crash-recovery reclaim-on-match keeps the SAME run id): a
    // member whose child run already completed under THIS parent is never
    // re-executed.
    const completedChild = getDb().query(
      `SELECT status FROM classification_runs
       WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status IN ('completed','completed_with_abstentions')
       ORDER BY started_at DESC LIMIT 1`,
    ).get(run.id, item.id) as { status: string } | undefined;
    if (completedChild) {
      completedMembers++;
      if (completedChild.status === 'completed_with_abstentions') hasAbstentions = true;
      console.log(`[CohortCurator] Member ${item.upc ?? item.id} already completed under run ${run.id} — resume guard skips re-execution.`);
      continue;
    }

    let curationData: CurationData;
    try {
      // Ownership assertion BEFORE the first member side effect (child create).
      renewHeartbeat();
      const childRun = ensureMemberRun(run.id, item.id, workspaceId, item.upc ?? '', null, null);
      const prepared = buildPreparedCohortContextForMember(run.id, memberProjection, childRun, workspaceId);

      // Sibling context for family-aware curation (read-only hints) — the same
      // handoff the legacy per-SKU worker uses (item.siblingGroup).
      const batchItems = listItemsByBatch(cohort.batchId);
      try {
        (item as any).siblingGroup = determineProductGroup(item as any, batchItems as any) ?? null;
      } catch (err) {
        console.warn(`[CohortCurator] Sibling context for ${item.upc ?? item.id} failed (non-blocking): ${redactTransportText(err instanceof Error ? err.message : String(err))}`);
      }

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
        // No write after ownership loss: the post-await assertion IS the guard.
        pipelineKeeper.assertHeld();
      } finally {
        pipelineKeeper.stop();
      }

      // Persist curation_data_json exactly as the legacy worker does.
      getDb().query('UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(curationData),
        nowIso,
        item.id,
      );
      updateItemStageStatus(item.id, 'completed');
      completedMembers++;
      const childStatus = getRun(childRun.id)?.status;
      if (childStatus === 'completed_with_abstentions') hasAbstentions = true;

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
