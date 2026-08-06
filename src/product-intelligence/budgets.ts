/**
 * PI-10 centralized workspace budgets.
 *
 * Workspace-level limits (concurrent/daily runs, daily search/fetch/browser
 * requests, daily model tokens, daily estimated/actual cost, run runtime,
 * artifact storage) enforced server-side at run start, tool dispatch, and
 * asset persistence. Null/absent fields mean unlimited. Budgets are enforced
 * centrally by deterministic code — never trusted to the agent prompt.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/27
 */
import { z } from 'zod';
import { PolicyDeniedError } from './policy/policy-gateway';
import {
  countPiDailyRuns,
  countPiDailyToolCalls,
  countPiRunningRuns,
  getPiBudgetPolicyRow,
  sumPiAssetPayloadBytes,
  sumPiDailyCost,
  sumPiDailyTokens,
  upsertPiBudgetPolicyRow,
} from '../db/repositories/pi-ops-repo';

export const PiBudgetPolicySchema = z.object({
  maxConcurrentRuns: z.number().int().positive().nullish(),
  maxDailyRuns: z.number().int().positive().nullish(),
  maxDailySearchRequests: z.number().int().positive().nullish(),
  maxDailyFetchRequests: z.number().int().positive().nullish(),
  maxDailyBrowserActions: z.number().int().positive().nullish(),
  maxDailyModelTokens: z.number().int().positive().nullish(),
  maxDailyEstimatedCostUsd: z.number().positive().nullish(),
  maxDailyActualCostUsd: z.number().positive().nullish(),
  maxRunRuntimeMinutes: z.number().int().positive().nullish(),
  maxArtifactStorageBytes: z.number().int().positive().nullish(),
});
export type PiBudgetPolicy = z.infer<typeof PiBudgetPolicySchema>;

/** Default budget policy: no limits configured. */
export const DEFAULT_PI_BUDGET_POLICY: PiBudgetPolicy = {};

/**
 * Tool-name → budget category mapping for the daily request budgets.
 * The browser bucket is reserved for PI-11 interaction tools (none exist yet).
 */
export const PI_TOOL_CATEGORIES = {
  search: [
    'search_upc',
    'search_product_name',
    'search_brand_sitemap',
    'list_cached_search_results',
    'lookup_structured_product_database',
  ],
  fetch: [
    'extract_product_page',
    'extract_structured_page_data',
    'verify_candidate_page',
    'discover_image_candidates',
    'inspect_candidate_image',
    'verify_image_candidate',
    'extract_packaging_evidence',
  ],
  browser: [],
} as const;
export type PiToolCategory = keyof typeof PI_TOOL_CATEGORIES;

/** The budget category a tool name belongs to, or null when unbudgeted. */
export function piToolCategory(toolName: string): PiToolCategory | null {
  for (const category of Object.keys(PI_TOOL_CATEGORIES) as PiToolCategory[]) {
    if ((PI_TOOL_CATEGORIES[category] as readonly string[]).includes(toolName)) return category;
  }
  return null;
}

/** The workspace budget policy (defaults to unlimited when unset). */
export function getPiBudgetPolicy(workspaceId: string): PiBudgetPolicy {
  const row = getPiBudgetPolicyRow(workspaceId);
  if (!row) return {};
  return PiBudgetPolicySchema.parse(JSON.parse(row.policyJson));
}

/** Persist the workspace budget policy; returns the validated policy. */
export function setPiBudgetPolicy(workspaceId: string, policy: PiBudgetPolicy): PiBudgetPolicy {
  const parsed = PiBudgetPolicySchema.parse(policy);
  upsertPiBudgetPolicyRow(workspaceId, JSON.stringify(parsed));
  return parsed;
}

/** ISO start of the current UTC day (budget windows are UTC calendar days). */
export function dayStartIso(): string {
  return new Date(Date.now() - (Date.now() % 86_400_000)).toISOString();
}

/** Budget-denied helper: shapes the PolicyDeniedError detail for the caller. */
function budgetDenied(detail: string): PolicyDeniedError {
  return new PolicyDeniedError({
    allowed: false,
    reasonCode: 'budget_exceeded',
    policyVersion: 'pi-workspace-budget',
    detail,
  });
}

/**
 * Enforce the run-start budgets (concurrency, daily runs, daily tokens,
 * daily estimated/actual cost). Throws PolicyDeniedError when a configured
 * limit is reached; unset limits are never enforced.
 */
export function checkPiRunStartBudget(workspaceId: string): void {
  const policy = getPiBudgetPolicy(workspaceId);
  if (policy.maxConcurrentRuns != null) {
    const used = countPiRunningRuns(workspaceId);
    if (used >= policy.maxConcurrentRuns) {
      throw budgetDenied(`concurrent run budget exhausted (${used}/${policy.maxConcurrentRuns})`);
    }
  }
  if (policy.maxDailyRuns != null) {
    const used = countPiDailyRuns(workspaceId, dayStartIso());
    if (used >= policy.maxDailyRuns) {
      throw budgetDenied(`daily run budget exhausted (${used}/${policy.maxDailyRuns})`);
    }
  }
  if (policy.maxDailyModelTokens != null) {
    const used = sumPiDailyTokens(workspaceId, dayStartIso());
    if (used >= policy.maxDailyModelTokens) {
      throw budgetDenied(`daily model token budget exhausted (${used}/${policy.maxDailyModelTokens})`);
    }
  }
  if (policy.maxDailyEstimatedCostUsd != null) {
    const used = sumPiDailyCost(workspaceId, dayStartIso(), 'estimated_cost');
    if (used >= policy.maxDailyEstimatedCostUsd) {
      throw budgetDenied(`daily estimated cost budget exhausted ($${used}/${policy.maxDailyEstimatedCostUsd})`);
    }
  }
  if (policy.maxDailyActualCostUsd != null) {
    const used = sumPiDailyCost(workspaceId, dayStartIso(), 'actual_cost');
    if (used >= policy.maxDailyActualCostUsd) {
      throw budgetDenied(`daily actual cost budget exhausted ($${used}/${policy.maxDailyActualCostUsd})`);
    }
  }
}

/**
 * Enforce the daily per-category request budgets (search/fetch/browser) at
 * tool dispatch. Tools outside any category are never limited. Throws
 * PolicyDeniedError when the category limit is reached.
 */
export function checkPiToolCategoryBudget(workspaceId: string, toolName: string): void {
  const category = piToolCategory(toolName);
  if (!category) return;
  const policy = getPiBudgetPolicy(workspaceId);
  const max =
    category === 'search' ? policy.maxDailySearchRequests
    : category === 'fetch' ? policy.maxDailyFetchRequests
    : policy.maxDailyBrowserActions;
  if (max == null) return;
  const used = countPiDailyToolCalls(workspaceId, dayStartIso(), [...PI_TOOL_CATEGORIES[category]]);
  if (used >= max) {
    throw budgetDenied(`daily ${category} request budget exhausted (${used}/${max})`);
  }
}

/**
 * Enforce the artifact storage budget at the durable asset persistence point.
 * Throws PolicyDeniedError when the stored payload bytes (plus any pending
 * extra) exceed the configured cap.
 */
/**
 * PI-10: the per-run runtime budget (maxRunRuntimeMinutes) caps the run
 * deadline below the policy's own deadlineMs. Returns the effective cap.
 * The Pi executor applies this before creating the session timeout.
 */
export function effectivePiRuntimeCapMs(workspaceId: string, defaultMs: number): number {
  const policy = getPiBudgetPolicy(workspaceId);
  if (policy.maxRunRuntimeMinutes == null) return defaultMs;
  return Math.min(defaultMs, policy.maxRunRuntimeMinutes * 60_000);
}

export function checkPiStorageBudget(workspaceId: string, extraBytes = 0): void {
  const policy = getPiBudgetPolicy(workspaceId);
  if (policy.maxArtifactStorageBytes == null) return;
  const used = sumPiAssetPayloadBytes(workspaceId) + extraBytes;
  if (used > policy.maxArtifactStorageBytes) {
    throw budgetDenied(`artifact storage budget exhausted (${used}/${policy.maxArtifactStorageBytes} bytes)`);
  }
}
