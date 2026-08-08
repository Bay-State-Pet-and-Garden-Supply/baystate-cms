/**
 * Deterministic ProductResearchBundle validation (PI-4).
 *
 * CMS-side enforcement of the workflow rules — the agent's bundle passes
 * through this validator before it becomes a durable result. Rules:
 * - the GTIN must match the run input (the GTIN is the primary identity key);
 * - every non-null factual value cites at least one evidence id and one
 *   extraction method;
 * - parent_product_only / wrong_variant / conflicting_identity identities can
 *   never be submitted as research_complete;
 * - blocking conflicts require the identity_conflict disposition;
 * - classification proposals must reference existing CMS-controlled targets
 *   and allowed values (no invented taxonomy ids);
 * - primary images must have non-unknown rights and exact-product match;
 * - disposition insufficient_evidence belongs to the abstention tool, not the
 *   full bundle.
 *
 * LLM extraction can never override deterministic identity conflicts — this
 * validator is that enforcement boundary.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/21
 */
import {
  getCachedAttributes,
  getCachedProductTypes,
} from '../../db/repositories/classification-config-repo';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { computeCommerceApproved } from '../assets/rights';
import { canonicalVerifiedAgainstHash, type VerifiedAgainstSnapshot } from '../assets/verification';
import { createRequire } from 'node:module';
import type {
  IdentityConflictSubmission,
  InsufficientEvidenceSubmission,
  ProductResearchBundle,
  TerminalSubmission,
} from './bundle';

/** True when the submission is a PI-4 workflow submission (not the PI-1 envelope). */
export function isWorkflowSubmission(value: unknown): value is TerminalSubmission {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    'disposition' in candidate ||
    'recommendedDisposition' in candidate ||
    ('reason' in candidate && 'actionableNextStep' in candidate)
  );
}

// ---------------------------------------------------------------------------
// Round-3 (review finding 5): durable verified-asset resolution for primary
// images. Lazy require keeps this module importable in vitest (no bun:sqlite
// in the module graph); with no DB the resolver fails closed — primary images
// citing anything cannot validate, which is the safe direction.
// ---------------------------------------------------------------------------
interface LazyAssetRow {
  id: string;
  runId: string;
  sourceUrl: string;
  rightsStatus: 'approved' | 'restricted' | 'unknown';
  rightsBasis: string | null;
  rightsEvidenceRef: string | null;
  originalContentHash: string;
  perceptualHash: string | null;
  exactProductMatch: number;
  exactVariantMatch: number | null;
  qualityStatus: string;
  commerceApproved: number;
  conflictsJson: string;
  /** Round-4: canonical identity hash the asset was verified against. */
  verifiedAgainstHash: string | null;
}

let _assetRepo: {
  getPiAssetsByIds: (ids: string[]) => LazyAssetRow[];
  getPiRun: (runId: string) => { inputJson: string } | undefined;
} | undefined;

const lazyRequire = createRequire(import.meta.url);

function loadAssetRepo(): {
  getPiAssetsByIds: (ids: string[]) => LazyAssetRow[];
  getPiRun: (runId: string) => { inputJson: string } | undefined;
} {
  if (!_assetRepo) {
    try {
      const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
      if (!conn.isDbInitialized?.()) {
        _assetRepo = { getPiAssetsByIds: () => [], getPiRun: () => undefined };
        return _assetRepo;
      }
    } catch {
      _assetRepo = { getPiAssetsByIds: () => [], getPiRun: () => undefined };
      return _assetRepo;
    }
    try {
      _assetRepo = lazyRequire('../../db/repositories/product-intelligence-repo') as NonNullable<typeof _assetRepo>;
    } catch {
      _assetRepo = { getPiAssetsByIds: () => [], getPiRun: () => undefined };
    }
  }
  return _assetRepo;
}

function parseConflicts(conflictsJson: string | null): string[] {
  if (!conflictsJson) return [];
  try {
    const parsed = JSON.parse(conflictsJson);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export interface BundleValidationResult {
  valid: boolean;
  issues: string[];
}

/** Rules that apply to every terminal submission shape. */
function validateCommon(submission: TerminalSubmission, expectedGtin: string, issues: string[]): void {
  const gtin = 'gtin' in submission ? submission.gtin : null;
  if (!gtin || gtin.replace(/\D/g, '') !== expectedGtin.replace(/\D/g, '')) {
    issues.push(`gtin "${gtin}" does not match the run input GTIN ${expectedGtin}`);
  }
  if ('evidenceIds' in submission && submission.evidenceIds.length === 0) {
    issues.push('submission cites no evidence ids');
  }
}

function validateBundle(bundle: ProductResearchBundle, workspaceId: string, issues: string[], runId?: string | null): void {
  const { identity } = bundle;

  // Identity semantics: blocked identities cannot be completed research.
  if (['parent_product_only', 'wrong_variant', 'conflicting_identity', 'insufficient_evidence'].includes(identity.status)) {
    if (bundle.disposition === 'research_complete') {
      issues.push(`identity.status '${identity.status}' cannot be submitted as research_complete`);
    }
  }

  // Evidence on every non-null identity fact.
  for (const [field, value] of [
    ['brand', identity.brand],
    ['canonicalName', identity.canonicalName],
    ['variant', identity.variant],
    ['manufacturer', identity.manufacturer],
    ['netContent', identity.netContent],
    ['packCount', identity.packCount],
  ] as const) {
    if (value !== null && identity.evidenceIds.length === 0) {
      issues.push(`identity.${field} is set but identity cites no evidence ids`);
    }
  }

  // Every commerce fact cites evidence and an extraction method.
  for (const fact of bundle.commerceFacts) {
    if (fact.value !== null && fact.value !== undefined && fact.evidenceIds.length === 0) {
      issues.push(`commerceFacts.${fact.field} has a value but cites no evidence ids`);
    }
    if (fact.extractionMethods.length === 0) {
      issues.push(`commerceFacts.${fact.field} has no extraction method`);
    }
  }

  // Classification proposals must reference existing CMS-controlled targets.
  const productTypes = new Set(getCachedProductTypes(workspaceId).map((t) => String(t.id)));
  const pages = new Set(listVerifiedPageOptions(workspaceId).map((p) => p.id));
  const attributes = new Map(getCachedAttributes(workspaceId).map((a) => [a.name, a.allowedValues ?? []]));
  for (const proposal of bundle.classificationProposals) {
    const attributeAllowed = attributes.get(proposal.targetId);
    if (productTypes.has(proposal.targetId)) {
      // selectedOptionId must be a configured product type label or the id itself.
      if (proposal.selectedOptionId !== proposal.targetId) {
        issues.push(`classification ${proposal.targetId}: selectedOptionId "${proposal.selectedOptionId}" is not the target id`);
      }
    } else if (pages.has(proposal.targetId)) {
      if (proposal.selectedOptionId !== proposal.targetId) {
        issues.push(`classification ${proposal.targetId}: selectedOptionId must equal the page id`);
      }
    } else if (attributeAllowed !== undefined) {
      if (attributeAllowed.length > 0 && !attributeAllowed.includes(proposal.selectedOptionId)) {
        issues.push(`classification ${proposal.targetId}: "${proposal.selectedOptionId}" is not an allowed value`);
      }
    } else {
      issues.push(`classification targetId "${proposal.targetId}" is not a configured Product Type, Category Page, or attribute`);
    }
  }

  // Images (PI-6, round-3): primary-image authority resolves from DURABLE
  // server-verified asset rows cited by `verifiedAssetIds` — agent-supplied
  // exactProductMatch/rightsStatus/rightsBasis/rightsEvidenceRef/
  // originalContentHash/qualityStatus/commerceApproved are IGNORED. The
  // deterministic commerce-approval rules then re-run over the resolved
  // server-side fields.
  const primaries = bundle.imageCandidates.filter((image) => image.role === 'primary');
  if (primaries.length > 1) {
    issues.push(`at most one primary image may be proposed (got ${primaries.length})`);
  }
  const assetRepo = loadAssetRepo();
  for (const image of bundle.imageCandidates) {
    if (image.role !== 'primary') continue;
    const verifiedAssetIds = image.verifiedAssetIds ?? [];
    if (verifiedAssetIds.length === 0) {
      issues.push(`primary image ${image.url} cites no verified asset id (authority must resolve from a durable server-verified asset)`);
      continue;
    }
    // Round-4 (review P0): exactly ONE verified asset per terminal candidate
    // — the binding must be unambiguous.
    if (verifiedAssetIds.length > 1) {
      issues.push(`primary image ${image.url} cites ${verifiedAssetIds.length} verified asset ids; exactly one is required`);
      continue;
    }
    const assets = assetRepo.getPiAssetsByIds(verifiedAssetIds);
    if (assets.length === 0) {
      issues.push(`primary image ${image.url} cites no resolvable durable verified asset (ids: ${verifiedAssetIds.join(', ')})`);
      continue;
    }
    const verified = assets[0];
    // Round-4 (review P0): the verified asset must belong to the CURRENT run
    // (no cross-run borrowing — asset.run_id is part of the binding).
    if (runId && verified.runId !== runId) {
      issues.push(`primary image ${image.url} cites verified asset from another run (${verified.runId}); asset must belong to the current run ${runId}`);
      continue;
    }
    // Round-4 (review P0): the terminal candidate URL must equal the durable
    // source URL of the verified asset (no URL A asset cited for URL B).
    if (verified.sourceUrl !== image.url) {
      issues.push(`primary image ${image.url} url does not match the verified asset's source url (${verified.sourceUrl})`);
      continue;
    }
    // Round-4 (review P0): the asset must be verified against the CURRENT
    // run's immutable product identity — recompute the canonical hash from
    // the run input and compare. Cross-identity borrowing (verify image Y
    // against GTIN Y, submit GTIN X) is refused.
    if (!runId) {
      issues.push(`primary image ${image.url} verified asset cannot be bound to a run (no run id for validation)`);
      continue;
    }
    if (!verified.verifiedAgainstHash) {
      issues.push(`primary image ${image.url} verified asset has no verified-against identity snapshot (cross-run borrowing is refused)`);
      continue;
    }
    const runInput = runInputSnapshot(assetRepo, runId);
    if (!runInput) {
      issues.push(`primary image ${image.url} current run has no input identity to bind the verified asset against`);
      continue;
    }
    if (verified.verifiedAgainstHash !== canonicalVerifiedAgainstHash(runInput)) {
      issues.push(`primary image ${image.url} verified asset was verified against a different product identity (hash mismatch — cross-run/cross-identity borrowing refused)`);
      continue;
    }
    const rightsStatus = verified.rightsStatus;
    if (rightsStatus === 'unknown') {
      issues.push(`primary image ${image.url} verified asset has unknown rights status`);
    } else if (rightsStatus !== 'approved') {
      issues.push(`primary image ${image.url} verified asset rights are '${rightsStatus}', not approved (durable reuse grant required)`);
    }
    if (!verified.exactProductMatch) {
      issues.push(`primary image ${image.url} verified asset is not an exact product match`);
    }
    if (verified.exactVariantMatch === 0) {
      issues.push(`primary image ${image.url} verified asset is not an exact variant match (parent-product-only images cannot be primary)`);
    }
    if (!verified.originalContentHash) {
      issues.push(`primary image ${image.url} verified asset has no content hash (extraction provenance is required)`);
    } else if (!/^[0-9a-f]{64}$/.test(verified.originalContentHash)) {
      issues.push(`primary image ${image.url} verified asset content hash is not a SHA-256 hex digest (${verified.originalContentHash.slice(0, 24)}...)`);
    }
    if (verified.qualityStatus !== 'usable') {
      issues.push(`primary image ${image.url} verified asset quality is '${verified.qualityStatus}', not 'usable'`);
    }
    const conflicts = parseConflicts(verified.conflictsJson);
    if (conflicts.length > 0) {
      issues.push(`primary image ${image.url} verified asset has conflicting visible-package evidence: ${conflicts.join('; ')}`);
    }
    const recomputed = computeCommerceApproved({
      rightsStatus: rightsStatus === 'unknown' ? 'unknown' : rightsStatus === 'approved' ? 'approved' : 'restricted',
      exactProductMatch: !!verified.exactProductMatch,
      exactVariantMatch: verified.exactVariantMatch === 1 ? true : verified.exactVariantMatch === 0 ? false : null,
      qualityStatus: (verified.qualityStatus ?? 'usable') as 'usable' | 'low_quality' | 'invalid',
      conflicts,
    });
    if (!recomputed) {
      issues.push(`primary image ${image.url} verified asset does not satisfy the deterministic commerce-approval rules`);
    } else if (verified.commerceApproved !== (recomputed ? 1 : 0)) {
      issues.push(`primary image ${image.url} stored commerce approval (${verified.commerceApproved}) does not match the recomputed verified status (${recomputed})`);
    }
  }

  // Conflicts drive disposition.
  const hasBlocking = bundle.conflicts.some((c) => c.severity === 'blocking');
  if (hasBlocking && bundle.disposition !== 'identity_conflict') {
    issues.push('blocking conflicts require disposition identity_conflict');
  }
  if (bundle.disposition === 'identity_conflict' && !hasBlocking) {
    issues.push('disposition identity_conflict requires at least one blocking conflict');
  }
  if (bundle.disposition === 'insufficient_evidence') {
    issues.push('disposition insufficient_evidence must use submit_insufficient_evidence instead of the bundle');
  }
}

function validateConflictSubmission(submission: IdentityConflictSubmission, issues: string[]): void {
  if (submission.conflicts.length === 0) {
    issues.push('identity-conflict submission requires at least one conflict');
  }
  if (submission.conflicts.every((c) => c.severity !== 'blocking')) {
    issues.push('identity-conflict submission should include at least one blocking conflict');
  }
  for (const conflict of submission.conflicts) {
    if (conflict.evidenceIds.length === 0) {
      issues.push(`conflict ${conflict.field} cites no evidence ids`);
    }
  }
}

function validateInsufficientSubmission(submission: InsufficientEvidenceSubmission, issues: string[]): void {
  if (!submission.reason.trim()) issues.push('abstention requires a reason');
  if (!submission.actionableNextStep.trim()) issues.push('abstention requires an actionable next step');
  if (submission.attemptedSteps.length === 0) {
    issues.push('abstention should list attempted steps');
  }
}

/**
 * Validate a terminal submission. Returns the issues; a `valid` result is
 * required before the submission becomes a durable result.
 */
export function validateTerminalSubmission(
  submission: TerminalSubmission,
  expectedGtin: string,
  workspaceId: string,
  runId?: string | null,
): BundleValidationResult {
  const issues: string[] = [];
  validateCommon(submission, expectedGtin, issues);
  if ('disposition' in submission) {
    validateBundle(submission, workspaceId, issues, runId);
  } else if ('recommendedDisposition' in submission) {
    validateConflictSubmission(submission, issues);
  } else {
    validateInsufficientSubmission(submission, issues);
  }
  return { valid: issues.length === 0, issues };
}

/** Round-4 (review P0): the canonical identity snapshot derived from the
 *  current run's input (same shape the verifier used at tool time). */
function runInputSnapshot(
  assetRepo: ReturnType<typeof loadAssetRepo>,
  runId: string,
): VerifiedAgainstSnapshot | null {
  try {
    const run = assetRepo.getPiRun(runId);
    if (!run) return null;
    const input = JSON.parse(run.inputJson) as { gtin?: unknown; registerName?: unknown };
    const gtin = input.gtin !== undefined && input.gtin !== null ? String(input.gtin).replace(/\D/g, '') : null;
    const name = input.registerName !== undefined && input.registerName !== null ? String(input.registerName) : null;
    if (!gtin && !name) return null;
    return { runId, gtin: gtin && gtin.length >= 8 ? gtin : null, name };
  } catch {
    return null;
  }
}
