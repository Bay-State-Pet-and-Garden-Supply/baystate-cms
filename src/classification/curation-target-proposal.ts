/**
 * Shared proposal builder for curation target processing.
 *
 * Builds ClassificationProposal objects from matched values, preserving
 * the existing proposal types and shapes that Review/Promotion consume.
 *
 * All proposals default to:
 * - status: 'pending' (not auto-accepted)
 * - isBulkAcceptable: confidence >= 0.7
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
    isBulkAcceptable: params.confidence >= 0.7,
    isStale: false,
    stalenessReason: null,
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
  /** Explicit override for bulk acceptance (e.g. false for brand shortcuts until Issue #10) */
  isBulkAcceptable?: boolean;
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
    isBulkAcceptable: params.isBulkAcceptable ?? (params.confidence >= 0.7),
    isStale: false,
    stalenessReason: null,
    createdAt: now(),
  };
}

export interface CategoryPageProposalParams {
  runId: string;
  sku: string;
  pageName: string;
  /** Optional stable page ID for identity-based assignment */
  pageId?: string;
  confidence: number;
  evidenceIds: string[];
  /** Explicit override for bulk acceptance */
  isBulkAcceptable?: boolean;
}

/**
 * Build a `category_page` proposal.
 * Uses pageName as targetId for backward compatibility with existing Review UI.
 * Includes pageId in proposedValue for identity-based promotion.
 */
export function buildCategoryPageProposal(params: CategoryPageProposalParams): ClassificationProposal {
  return {
    id: randomUUID(),
    runId: params.runId,
    productSku: params.sku,
    proposalType: 'category_page',
    targetId: params.pageName,
    proposedValue: { pageId: params.pageId ?? null, pageName: params.pageName },
    confidence: params.confidence,
    evidenceIds: params.evidenceIds,
    status: 'pending',
    isBulkAcceptable: params.isBulkAcceptable ?? (params.confidence >= 0.7),
    isStale: false,
    stalenessReason: null,
    createdAt: now(),
  };
}
