/**
 * Product Intelligence API client (PI-7).
 *
 * Client-side fetch wrapper for the /api/product-intelligence endpoints.
 * Mirrors the `request<T>` pattern from `src/client/api.ts`.
 *
 * Types are defined locally here (mirroring the server wire shapes) so the
 * client never imports from src/db or src/product-intelligence/run-service
 * (those pull bun:sqlite / node:fs and would break the Vite build). Only
 * deep imports from src/product-intelligence/contracts.ts (zod-only) are used.
 */

import type { ProductIntelligenceFlags } from '../product-intelligence/flags';

// ---------------------------------------------------------------------------
// Wire types (mirror server row shapes — JSON strings are left as strings)
// ---------------------------------------------------------------------------

export type { ProductIntelligenceFlags } from '../product-intelligence/flags';

export type PiRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type PiRunMode = 'shadow' | 'interactive' | 'onboarding';

export interface PiRunRow {
  id: string;
  workspaceId: string;
  onboardingItemId: string | null;
  mode: PiRunMode;
  status: PiRunStatus;
  executor: string;
  inputJson: string;
  policyJson: string;
  configSnapshotId: string;
  configSnapshotHash: string;
  codeCommit: string | null;
  promptHash: string | null;
  piVersion: string | null;
  extensionVersionsJson: string;
  startedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  estimatedCost: number | null;
  actualCost: number | null;
  tokenUsageJson: string | null;
}

export interface PiStepView {
  id: string;
  runId: string;
  stepType: string;
  sequence: number;
  status: 'running' | 'completed' | 'failed';
  summary: string | null;
  inputHash: string | null;
  outputRef: string | null;
  startedAt: string;
  completedAt: string | null;
  errorJson: string | null;
}

export interface PiToolCallRow {
  id: string;
  runId: string;
  stepId: string | null;
  sequence: number;
  toolName: string;
  toolVersion: string | null;
  policyOutcome: 'allowed' | 'denied' | 'budget_exceeded';
  requestHash: string | null;
  responseHash: string | null;
  artifactRef: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  startedAt: string;
  completedAt: string | null;
  errorJson: string | null;
}

export interface PiSourceRow {
  id: string;
  runId: string;
  url: string;
  canonicalUrl: string | null;
  domain: string;
  sourceType: string;
  gtinMatchStatus: string;
  variantMatchStatus: string;
  retrievedAt: string | null;
  contentHash: string | null;
  artifactRef: string | null;
  licenseRef: string | null;
  termsRef: string | null;
  createdAt: string;
}

export interface PiEvidenceRow {
  id: string;
  runId: string;
  sourceId: string;
  targetField: string;
  valueJson: string;
  extractionMethod: string | null;
  sourceField: string | null;
  reliability: string | null;
  directSupport: number;
  snippet: string | null;
  metadataJson: string | null;
  createdAt: string;
}

export interface PiConflictRow {
  id: string;
  runId: string;
  field: string;
  severity: 'low' | 'medium' | 'high';
  status: 'open' | 'resolved' | 'dismissed';
  competingValuesJson: string;
  evidenceIdsJson: string;
  resolutionJson: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface PiResultRow {
  id: string;
  runId: string;
  schemaVersion: number;
  disposition: 'submitted' | 'abstained' | 'unavailable';
  resultJson: string;
  resultHash: string;
  createdAt: string;
}

export interface PiComparisonRow {
  id: string;
  runId: string;
  baselineType: string;
  baselineRef: string;
  metricsJson: string;
  createdAt: string;
}

export interface ProductAssetEvidence {
  sourceUrl: string;
  sourcePageUrl: string | null;
  sourceType: string;
  sourcePath: string | null;
  sourceArtifactId: string;
  extractionMethod: string;
  retrievedAt: string;
  originalContentHash: string;
  perceptualHash: string | null;
  variantReference: string | null;
  rightsStatus: 'approved' | 'restricted' | 'unknown';
  rightsBasis: string | null;
  rightsEvidenceRef: string | null;
  observedBrand: string | null;
  observedProductName: string | null;
  observedVariant: string | null;
  observedNetContent: { value: number; unit: string } | null;
  observedPackCount: number | null;
  observedGtin: string | null;
  exactProductMatch: boolean;
  exactVariantMatch: boolean | null;
  qualityStatus: 'usable' | 'low_quality' | 'invalid';
  commerceApproved: boolean;
  conflicts: string[];
  id?: string;
  runId?: string;
  sourceId?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface PiRunProjection {
  run: PiRunRow;
  steps: PiStepView[];
  toolCalls: PiToolCallRow[];
  sources: PiSourceRow[];
  evidence: PiEvidenceRow[];
  conflicts: PiConflictRow[];
  assets: ProductAssetEvidence[];
  result: PiResultRow | null;
  comparisons: PiComparisonRow[];
  eventCount: number;
}

export interface PiLiveEvent {
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface CreateRunInput {
  gtin: string;
  registerName: string;
  brandHint?: string;
  departmentHint?: string;
  price?: string;
  quantity?: number;
  mode?: PiRunMode;
}

export interface CreateRunResponse {
  runId: string;
  executor: string;
  status: PiRunStatus;
}

export interface CancelRunResponse {
  cancelled: boolean;
  runId: string;
}

export interface ComparisonResponse {
  comparison: PiComparisonRow;
}

export interface FlagsResponse {
  flags: ProductIntelligenceFlags;
}

export interface ListRunsResponse {
  runs: PiRunRow[];
}

export interface PiImportRow {
  id: string;
  runId: string | null;
  onboardingItemId: string;
  resultHash: string;
  mode: 'create' | 'augment';
  importingUser: string | null;
  status: 'active' | 'superseded' | 'stale';
  fieldSelectionJson: string;
  excludedValuesJson: string;
  overriddenValuesJson: string;
  importedSourceIdsJson: string;
  importedEvidenceIdsJson: string;
  importedImageIdsJson: string;
  createdAt: string;
}

export interface ImportRunResponse {
  import: PiImportRow;
  itemId: string;
  batchId: string | null;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Fetch wrapper (mirrors src/client/api.ts)
// ---------------------------------------------------------------------------

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    const errorMsg =
      (data as Record<string, unknown>).error as string | undefined ||
      (Array.isArray((data as Record<string, unknown>).errors)
        ? ((data as Record<string, unknown[]>).errors as string[]).join('; ')
        : null) ||
      ((data as Record<string, unknown>).message as string | undefined) ||
      `HTTP ${res.status}`;
    throw new Error(errorMsg);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export function getPiFlags(): Promise<FlagsResponse> {
  return request<FlagsResponse>('/product-intelligence/flags');
}

export function listPiRuns(params?: {
  status?: PiRunStatus;
  limit?: number;
  offset?: number;
}): Promise<ListRunsResponse> {
  const search = new URLSearchParams();
  if (params?.status) search.set('status', params.status);
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  if (params?.offset !== undefined) search.set('offset', String(params.offset));
  const qs = search.toString();
  return request<ListRunsResponse>(`/product-intelligence/runs${qs ? `?${qs}` : ''}`);
}

export function getPiRun(id: string): Promise<PiRunProjection> {
  return request<PiRunProjection>(`/product-intelligence/runs/${encodeURIComponent(id)}`);
}

export function createPiRun(input: CreateRunInput): Promise<CreateRunResponse> {
  const body: Record<string, unknown> = {
    input: {
      gtin: input.gtin,
      registerName: input.registerName,
      ...(input.brandHint !== undefined ? { brandHint: input.brandHint } : {}),
      ...(input.departmentHint !== undefined ? { departmentHint: input.departmentHint } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
    },
    ...(input.mode ? { mode: input.mode } : {}),
  };
  return request<CreateRunResponse>('/product-intelligence/runs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function cancelPiRun(id: string): Promise<CancelRunResponse> {
  return request<CancelRunResponse>(`/product-intelligence/runs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
}

// Physical deletion is retention/maintenance-only (P2-1): no user-facing
// delete API exists — rejection is a durable review decision.

export function comparePiRun(
  id: string,
  baselineType: string,
  baselineRef: string,
): Promise<ComparisonResponse> {
  return request<ComparisonResponse>(`/product-intelligence/runs/${encodeURIComponent(id)}/compare`, {
    method: 'POST',
    body: JSON.stringify({ baselineType, baselineRef }),
  });
}

export interface ImportRunToOnboardingBody {
  mode: 'create' | 'augment';
  onboardingItemId?: string | null;
  fieldSelection?: string[];
  price?: string | null;
  quantity?: number | null;
  importingUser?: string | null;
}

/** POST /product-intelligence/runs/:id/import — import a reviewed result. */
export function importRunToOnboarding(
  runId: string,
  body: ImportRunToOnboardingBody,
): Promise<ImportRunResponse> {
  const payload: Record<string, unknown> = { mode: body.mode };
  if (body.onboardingItemId != null) payload.onboardingItemId = body.onboardingItemId;
  if (body.fieldSelection) payload.fieldSelection = body.fieldSelection;
  if (body.price != null) payload.price = body.price;
  if (body.quantity != null) payload.quantity = body.quantity;
  if (body.importingUser != null) payload.importingUser = body.importingUser;
  return request<ImportRunResponse>(`/product-intelligence/runs/${encodeURIComponent(runId)}/import`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface PiReviewerActor {
  actorType: string;
  authentication: string;
  displayLabel: string | null;
}

/** Parse the server-stored reviewer (JSON actor object; tolerate legacy plain strings). */
function parseReviewerActor(reviewer: string): PiReviewerActor {
  try {
    const parsed: unknown = JSON.parse(reviewer);
    if (parsed && typeof parsed === 'object') {
      const actor = parsed as Record<string, unknown>;
      return {
        actorType: typeof actor.actorType === 'string' ? actor.actorType : 'unknown',
        authentication: typeof actor.authentication === 'string' ? actor.authentication : 'unknown',
        displayLabel: typeof actor.displayLabel === 'string' ? actor.displayLabel : null,
      };
    }
  } catch {
    // fall through to legacy plain-string handling
  }
  return { actorType: 'unknown', authentication: 'unknown', displayLabel: reviewer };
}

export interface PiReviewDecision {
  id: string;
  runId: string;
  decision: 'approve' | 'reject';
  resultHash: string;
  supersedesDecisionId: string | null;
  reviewer: string;
  /** Structured reviewer actor (parsed from the server-side JSON). */
  reviewerActor: PiReviewerActor;
  note: string | null;
  createdAt: string;
}

export interface PiRunReviewState {
  decision: PiReviewDecision | null;
  /** True when the latest decision approves the run's current stored result. */
  approved: boolean;
}

/** Hydrate a raw wire decision (reviewer is a JSON string) with the parsed actor. */
function hydrateReviewDecision(raw: PiReviewDecision): PiReviewDecision {
  return { ...raw, reviewerActor: parseReviewerActor(raw.reviewer) };
}

/** POST /product-intelligence/runs/:id/review — durable approve/reject (P1-2). */
export async function reviewPiRun(
  runId: string,
  body: { decision: 'approve' | 'reject'; reviewer: string; note?: string },
): Promise<{ decision: PiReviewDecision }> {
  const res = await request<{ decision: PiReviewDecision }>(`/product-intelligence/runs/${encodeURIComponent(runId)}/review`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { decision: hydrateReviewDecision(res.decision) };
}

/** GET /product-intelligence/runs/:id/review — latest decision + approval state. */
export async function getPiRunReview(runId: string): Promise<PiRunReviewState> {
  const res = await request<PiRunReviewState>(`/product-intelligence/runs/${encodeURIComponent(runId)}/review`);
  return {
    ...res,
    decision: res.decision ? hydrateReviewDecision(res.decision) : null,
  };
}



// ---------------------------------------------------------------------------
// Helpers (parse JSON string columns — safe / null on invalid)
// ---------------------------------------------------------------------------

export function parseRunInput(row: PiRunRow): Record<string, unknown> | null {
  try {
    return JSON.parse(row.inputJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseRunPolicy(row: PiRunRow): Record<string, unknown> | null {
  try {
    return JSON.parse(row.policyJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}