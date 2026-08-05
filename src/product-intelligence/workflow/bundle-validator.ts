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

function validateBundle(bundle: ProductResearchBundle, workspaceId: string, issues: string[]): void {
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

  // Images (PI-6): primary images must satisfy the deterministic
  // commerce-approval rules — provenance is preserved, evidence is cited,
  // rights are established with a referenced basis, and conflicting
  // visible-package evidence blocks primary use. The commerceApproved flag
  // the agent asserts is recomputed from the candidate's own fields.
  const primaries = bundle.imageCandidates.filter((image) => image.role === 'primary');
  if (primaries.length > 1) {
    issues.push(`at most one primary image may be proposed (got ${primaries.length})`);
  }
  for (const image of bundle.imageCandidates) {
    if (image.role !== 'primary') continue;
    // Defaults are applied by the zod schema at submission time; the validator
    // itself stays defensive for direct-call paths.
    const evidenceIds = image.evidenceIds ?? [];
    const conflicts = image.conflicts ?? [];
    const qualityStatus = image.qualityStatus ?? 'usable';
    const exactVariantMatch = image.exactVariantMatch ?? null;
    if (image.rightsStatus === 'unknown') {
      issues.push(`primary image ${image.url} has unknown rights status`);
    }
    const authorized = ['supplier_authorized', 'manufacturer_authorized', 'licensed_dataset', 'retailer_authorized'].includes(image.rightsStatus);
    if (authorized && (!image.rightsBasis || !image.rightsEvidenceRef)) {
      issues.push(`primary image ${image.url} declares ${image.rightsStatus} rights without a rights basis and evidence reference`);
    }
    if (!image.exactProductMatch) {
      issues.push(`primary image ${image.url} is not marked as an exact product match`);
    }
    if (exactVariantMatch === false) {
      issues.push(`primary image ${image.url} is marked as not an exact variant match (parent-product-only images cannot be primary)`);
    }
    if (evidenceIds.length === 0) {
      issues.push(`primary image ${image.url} cites no evidence ids`);
    }
    if (!image.originalContentHash) {
      issues.push(`primary image ${image.url} has no content hash (extraction provenance is required)`);
    } else if (!/^[0-9a-f]{64}$/.test(image.originalContentHash)) {
      issues.push(`primary image ${image.url} content hash is not a SHA-256 hex digest (${image.originalContentHash.slice(0, 24)}...)`);
    }
    if (qualityStatus !== 'usable') {
      issues.push(`primary image ${image.url} quality is '${qualityStatus}', not 'usable'`);
    }
    if (conflicts.length > 0) {
      issues.push(`primary image ${image.url} has conflicting visible-package evidence: ${conflicts.join('; ')}`);
    }
    const recomputed = computeCommerceApproved({
      rightsStatus:
        image.rightsStatus === 'unknown'
          ? 'unknown'
          : ['supplier_authorized', 'manufacturer_authorized', 'licensed_dataset', 'retailer_authorized'].includes(image.rightsStatus)
            ? 'approved'
            : 'restricted',
      exactProductMatch: image.exactProductMatch,
      exactVariantMatch,
      qualityStatus,
      conflicts,
    });
    if (image.commerceApproved !== recomputed) {
      issues.push(`primary image ${image.url} commerceApproved assertion (${image.commerceApproved}) does not match verified status (${recomputed})`);
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
): BundleValidationResult {
  const issues: string[] = [];
  validateCommon(submission, expectedGtin, issues);
  if ('disposition' in submission) {
    validateBundle(submission, workspaceId, issues);
  } else if ('recommendedDisposition' in submission) {
    validateConflictSubmission(submission, issues);
  } else {
    validateInsufficientSubmission(submission, issues);
  }
  return { valid: issues.length === 0, issues };
}
