import type {
  ClassificationEvidence,
  ClassificationProposal,
  ClassificationConfigSnapshotRef,
} from '../shared/types';

// ─── Stage Identity ────────────────────────────────────────────────────────────

export type ClassificationStageName =
  | 'evidence_extraction'
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
}

// ─── Stage Result ──────────────────────────────────────────────────────────────

export type StageResult =
  | { status: 'succeeded'; output: StageOutput }
  | { status: 'failed'; error: string }
  | { status: 'abstained'; reason: string };

// ─── Stage Context ─────────────────────────────────────────────────────────────

export interface StageContext {
  workspacePath: string;
  workspaceId: string;
  configSnapshotRef: ClassificationConfigSnapshotRef;
  /** Current run ID for recording results */
  runId: string;
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
