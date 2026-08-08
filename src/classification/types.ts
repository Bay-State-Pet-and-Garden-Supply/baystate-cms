import type {
  ClassificationEvidence,
  ClassificationProposal,
  ClassificationConfigSnapshotRef,
} from '../shared/types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';

// ─── Stage Identity ────────────────────────────────────────────────────────────

export type ClassificationStageName =
  | 'evidence_extraction'
  | 'name_consolidation'
  | 'primary_product_type_proposal'
  | 'attribute_applicability'
  | 'product_attribute_proposals'
  | 'category_page_proposals'
  | 'product_draft_projection';

// ─── Stage Input ───────────────────────────────────────────────────────────────

export interface StageInput {
  /** The product SKU being classified */
  sku: string;
  /** The onboarding item ID, if applicable */
  onboardingItemId?: string;
  /** Source kind of the classification run */
  sourceKind?: 'onboarding' | 'catalog_product';
  /** Previously extracted evidence from upstream stages */
  evidence: ClassificationEvidence[];
  /** Previously accepted proposals from upstream stages */
  acceptedProposals: ClassificationProposal[];
  /** All proposals from this run (including pending/stale) */
  allProposals: ClassificationProposal[];
}

// ─── Stage Output ──────────────────────────────────────────────────────────────

export interface StageOutput {
  /** New evidence produced by this stage */
  evidence: ClassificationEvidence[];
  /** New classification proposals produced by this stage */
  proposals: ClassificationProposal[];
  /** If true, the stage intentionally produced no proposals */
  abstained: boolean;
  /** Reason for abstention or failure */
  message?: string;
  /** Arbitrary metadata returned by the stage (e.g. compatibility data for CurationData fields).
   * This data is NOT represented as proposals and does NOT appear in the Review UI. */
  metadata?: Record<string, unknown>;
}

// ─── Stage Result ──────────────────────────────────────────────────────────────

export type StageResult =
  | { status: 'succeeded'; output: StageOutput }
  | { status: 'failed'; error: string }
  | { status: 'abstained'; reason: string; output?: StageOutput };

// ─── Stage Context ─────────────────────────────────────────────────────────────

export interface ProductLineItemSnapshot {
  sku: string;
  name: string;
  webTitle: string | null;
  brand: string | null;
  description: string;
  species: string[];
  flavor: string | null;
  lifeStage: string | null;
  productForm: string | null;
  healthConcern: string[];
}

export interface StageContext {
  workspacePath: string;
  workspaceId: string;
  configSnapshotRef: ClassificationConfigSnapshotRef;
  /**
   * Immutable runtime snapshot resolved once before run creation. When present,
   * stages MUST consume snapshot data (config, resolved targets, profiles,
   * mappings, brands, data policy, pages) instead of reloading workspace
   * classification files or querying mutable caches.
   */
  snapshot?: RuntimeClassificationSnapshot;
  /** Current run ID for recording results */
  runId: string;
  /**
   * Optional product-line group context for sibling-aware processing.
   * Populated before name_consolidation when the item belongs to a
   * product line with sibling items in the same batch.
   */
  productLineContext?: {
    groupId: string;
    groupLabel: string;
    siblingNames: string[];
    siblingWebTitles: string[];
    siblingOcrTitles: string[];
    siblingSkus: string[];
  };
  /** Frozen, read-only per-SKU inputs used for cohort page coordination. */
  productLineItems?: ProductLineItemSnapshot[];
  /** Pre-computed coordinated title from cohort LLM call. When present,
   *  name_consolidation uses this instead of making its own LLM call. */
  preComputedTitle?: string;
  /** Source of the pre-computed title, required when preComputedTitle is set. */
  preComputedTitleSource?: 'llm_cohort' | 'cohort_fallback';
  /** Catalog product classification context. Present only for catalog_product runs. */
  catalogContext?: {
    sourceProductHash: string;
    existingPageIds: Array<{ pageId: string; pageName: string }>;
  };
  /** Retrieval-augmented classification context. */
  retrievalContext?: {
    enabled: boolean;
    topK?: number;
    minSimilarity?: number;
  };
}

// ─── Stage Definition ──────────────────────────────────────────────────────────

/**
 * A classification stage is a function that takes an input snapshot and context,
 * and returns a structured result. Stages may use LLMs, VLMs, deterministic rules,
 * or the database to produce evidence and proposals.
 */
export type ClassificationStage = (
  input: StageInput,
  context: StageContext,
) => Promise<StageResult>;

// ─── Stage Dependency ──────────────────────────────────────────────────────────

export interface StageDefinition {
  name: ClassificationStageName;
  /** Stages that must run before this one and whose proposals are needed */
  requires: ClassificationStageName[];
  /** Optional upstream evidence sources */
  evidenceFrom: ClassificationStageName[];
  execute: ClassificationStage;
}

// ─── Pipeline Run ──────────────────────────────────────────────────────────────

export interface PipelineRun {
  sku: string;
  onboardingItemId?: string;
  stages: ClassificationStageName[];
  stageOrder: ClassificationStageName[];
}

// ─── Pipeline Run Result ─────────────────────────────────────────────────────────

/**
 * Aggregated result from a full classification pipeline run.
 */
export interface PipelineRunResult {
  /** All evidence accumulated across all stages */
  evidence: ClassificationEvidence[];
  /** All proposals accumulated across all stages */
  proposals: ClassificationProposal[];
  /** Per-stage output metadata, keyed by stage name */
  stageOutputs: Partial<Record<ClassificationStageName, StageOutput>>;
}
