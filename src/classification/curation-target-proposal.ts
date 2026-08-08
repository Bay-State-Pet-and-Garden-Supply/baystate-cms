/**
 * Shared proposal builder for curation target processing.
 *
 * Builds ClassificationProposal objects from matched values, preserving
 * the existing proposal types and shapes that Review/Promotion consume.
 *
 * All proposals default to:
 * - status: 'pending' (not auto-accepted)
 * - isBulkAcceptable: false (Issue #10: requires calibrated policy approval)
 * - isStale: false
 * - createdAt: now
 */
import { randomUUID } from 'node:crypto';
import type { ClassificationProposal } from '../shared/schemas/classification';

const now = () => new Date().toISOString();

export interface ProductTypeProposalParams {
  runId: string;
  sku: string;
  productTypeId: string;
  confidence: number;
  evidenceIds: string[];
  matchedWords?: string[];
  /** Explicit override for bulk acceptance (Issue #10) */
  isBulkAcceptable?: boolean;
  /** Immutable runtime snapshot hash this proposal was built under. */
  snapshotHash?: string | null;
}

/**
 * Build a `primary_product_type` proposal.
 * Preserves the existing proposal shape for Review/Promotion compatibility.
 */
export function buildProductTypeProposal(params: ProductTypeProposalParams): ClassificationProposal {
  return {
    id: randomUUID(),
    runId: params.runId,
    productSku: params.sku,
    proposalType: 'primary_product_type',
    targetId: params.productTypeId,
    proposedValue: {
      productTypeId: params.productTypeId,
      matchedWords: params.matchedWords ?? [],
    },
    confidence: params.confidence,
    evidenceIds: params.evidenceIds,
    status: 'pending',
    isBulkAcceptable: params.isBulkAcceptable ?? false,
    isStale: false,
    stalenessReason: null,
    snapshotHash: params.snapshotHash ?? null,
    createdAt: now(),
  };
}

export interface FieldAssignmentProposalParams {
  runId: string;
  sku: string;
  attributeId: string;
  value: unknown;
  confidence: number;
  evidenceIds: string[];
  /** Single value or array depending on selectionMode */
  isMultiple: boolean;
  /** Explicit override for bulk acceptance (Issue #10) */
  isBulkAcceptable?: boolean;
  /** Immutable runtime snapshot hash this proposal was built under. */
  snapshotHash?: string | null;
}

/**
 * Build a `field_assignment` proposal for a product attribute.
 * Preserves the existing proposal shape: scalar value for single, array for multiple.
 */
export function buildFieldAssignmentProposal(params: FieldAssignmentProposalParams): ClassificationProposal {
  const proposedValue = params.isMultiple && Array.isArray(params.value)
    ? params.value
    : Array.isArray(params.value) && !params.isMultiple
      ? params.value[0] ?? params.value
      : params.value;

  return {
    id: randomUUID(),
    runId: params.runId,
    productSku: params.sku,
    proposalType: 'field_assignment',
    targetId: params.attributeId,
    proposedValue,
    confidence: params.confidence,
    evidenceIds: params.evidenceIds,
    status: 'pending',
    isBulkAcceptable: params.isBulkAcceptable ?? false,
    isStale: false,
    stalenessReason: null,
    snapshotHash: params.snapshotHash ?? null,
    createdAt: now(),
  };
}

export interface CategoryPageProposalParams {
  runId: string;
  sku: string;
  pageName: string;
  /** Optional stable page ID for identity-based assignment */
  pageId?: string;
  /** Whether the referenced page identity is verified in the active import */
  verifiedPageIdentity?: boolean;
  confidence: number;
  evidenceIds: string[];
  /** Explicit override for bulk acceptance */
  isBulkAcceptable?: boolean;
  /** Immutable runtime snapshot hash this proposal was built under. */
  snapshotHash?: string | null;
}

/**
 * Build a `category_page` proposal.
 * Uses pageName as targetId for backward compatibility with existing Review UI.
 * Includes pageId and the identity-verification flag in proposedValue. An
 * unverified identity is review context only — serialization consumers must
 * re-check the active import before writing ProductOnPages.
 */
export function buildCategoryPageProposal(params: CategoryPageProposalParams): ClassificationProposal {
  return {
    id: randomUUID(),
    runId: params.runId,
    productSku: params.sku,
    proposalType: 'category_page',
    // Stable Page ID is the identity; display name is data in the value.
    targetId: params.pageId ?? params.pageName,
    proposedValue: {
      pageId: params.pageId ?? null,
      pageName: params.pageName,
      identityVerified: params.verifiedPageIdentity ?? false,
    },
    confidence: params.confidence,
    evidenceIds: params.evidenceIds,
    status: 'pending',
    isBulkAcceptable: params.isBulkAcceptable ?? false,
    isStale: false,
    stalenessReason: null,
    snapshotHash: params.snapshotHash ?? null,
    createdAt: now(),
  };
}
