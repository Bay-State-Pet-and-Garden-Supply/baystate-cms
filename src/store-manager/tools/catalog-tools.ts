/**
 * Store Manager catalog/read tool adapters (epic #42, #40).
 *
 * Read adapters are pure callers of existing services — no raw SQL, fetch, or
 * filesystem access here. Every result is a structured StoreManagerToolResult
 * with bounded data.
 */

import { z } from 'zod';
import type { StoreManagerToolAdapter, StoreManagerToolResult } from '../runtime/contracts';
import { okResult, noResult, policyDenied } from '../runtime/contracts';
import { getDashboardStatsData } from '../../server/services/dashboard-service';
import { getCatalogHealthReport, listProductIndex } from '../../server/services/product-service';
import {
  getProductFieldAudit,
  proposeProductFieldNormalization,
} from '../../server/services/product-field-audit-service';
import { listProposals } from '../../server/services/product-field-refactor-service';

// ---------------------------------------------------------------------------
// Evidence-focused next-actions ranking (deterministic; #40 change 9)
// ---------------------------------------------------------------------------

export const NEXT_ACTIONS_FOCUSES = ['health', 'product_fields', 'sync', 'drift', 'onboarding'] as const;
export type NextActionsFocus = (typeof NEXT_ACTIONS_FOCUSES)[number];

interface NextActionEvidence {
  focus: NextActionsFocus;
  action: string;
  priority: number;
  evidenceKey: string;
}

/**
 * Deterministic evidence collection for next actions. Each action carries an
 * `evidenceKey` derived from authoritative service data so a caller can trace
 * the recommendation to the underlying counts/rows. When a focus has no
 * supporting evidence the adapter returns `no_result` instead of guessing.
 */
export function collectNextActionEvidence(workspaceId: string): NextActionEvidence[] {
  const report = getCatalogHealthReport();
  const stats = getDashboardStatsData(workspaceId);
  const evidence: NextActionEvidence[] = [];

  // health
  const blockerIssues = report.issues.filter((i) => i.severity === 'blocker');
  const warningIssues = report.issues.filter((i) => i.severity === 'warning');
  if (blockerIssues.length > 0) {
    evidence.push({
      focus: 'health',
      priority: 1,
      evidenceKey: `catalog_health.blockers.${blockerIssues.length}`,
      action: `Fix the ${blockerIssues.length} blocking catalog health error(s) to enable remote sync.`,
    });
  }
  if (warningIssues.length > 0) {
    evidence.push({
      focus: 'health',
      priority: 2,
      evidenceKey: `catalog_health.warnings.${warningIssues.length}`,
      action: `Review the ${warningIssues.length} catalog health warning(s).`,
    });
  }
  if (report.totalErrors === 0 && report.totalWarnings === 0) {
    evidence.push({
      focus: 'health',
      priority: 5,
      evidenceKey: 'catalog_health.clean',
      action: 'All catalog health metrics look clean.',
    });
  }

  // product_fields
  const fieldIssues = report.issues.filter(
    (i) => i.fieldPath && (i.code === 'field_registry' || i.code === 'field_value'),
  );
  if (fieldIssues.length > 0) {
    evidence.push({
      focus: 'product_fields',
      priority: 2,
      evidenceKey: `catalog_health.field_issues.${fieldIssues.length}`,
      action: `Audit ${fieldIssues.length} product field issue(s) flagged in catalog health.`,
    });
  }
  const brandAudit = getProductFieldAudit('ProductField16', 100);
  if (brandAudit.uniqueValueCount > 0 && brandAudit.totalDuplicateGroupCount > 0) {
    evidence.push({
      focus: 'product_fields',
      priority: 3,
      evidenceKey: `product_field.ProductField16.duplicate_groups.${brandAudit.totalDuplicateGroupCount}`,
      action: `Normalize ${brandAudit.totalDuplicateGroupCount} casing/whitespace duplicate group(s) in Brand (ProductField16).`,
    });
  }

  // drift
  if (stats.metrics.driftedProducts > 0) {
    evidence.push({
      focus: 'drift',
      priority: 2,
      evidenceKey: `dashboard.drifted_products.${stats.metrics.driftedProducts}`,
      action: `Resolve the ${stats.metrics.driftedProducts} drifted product(s) under Products -> Drift.`,
    });
  }

  // sync
  if (stats.metrics.notSyncedProducts > 0) {
    evidence.push({
      focus: 'sync',
      priority: 3,
      evidenceKey: `dashboard.not_synced_products.${stats.metrics.notSyncedProducts}`,
      action: `${stats.metrics.notSyncedProducts} product(s) are not yet synced; run a catalog sync when ready.`,
    });
  }

  // change sets (shared evidence: appears under health and sync contexts)
  if (stats.metrics.draftChangeSets > 0) {
    evidence.push({
      focus: 'sync',
      priority: 2,
      evidenceKey: `dashboard.draft_change_sets.${stats.metrics.draftChangeSets}`,
      action: `Review and approve the ${stats.metrics.draftChangeSets} active Change Set draft(s).`,
    });
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export const getDashboardStatsAdapter: StoreManagerToolAdapter = {
  name: 'getDashboardStats',
  version: 1,
  description:
    'Retrieve overall metrics and status for the store manager dashboard, including product counts, sync statuses, drift items, warnings, and recent activity.',
  promptGuidelines: 'Use before recommending any catalog-level action.',
  inputSchema: z.object({}),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  supportedScopes: [] as const,
  scopeSummary: () => 'dashboard metrics',
  execute: async (_params, ctx): Promise<StoreManagerToolResult> => {
    const data = getDashboardStatsData(ctx.workspaceId);
    return okResult({
      metrics: data.metrics,
      recentActivities: data.recentActivities?.slice(0, 10) ?? [],
    });
  },
};

export const getCatalogHealthReportAdapter: StoreManagerToolAdapter = {
  name: 'getCatalogHealthReport',
  version: 1,
  description: 'Retrieve the overall catalog health report summary, showing counts of healthy/unhealthy products, blockers, and warnings.',
  promptGuidelines: 'Use for any claim about catalog health totals.',
  inputSchema: z.object({}),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  supportedScopes: [] as const,
  scopeSummary: () => 'catalog health summary',
  execute: async (): Promise<StoreManagerToolResult> => {
    const report = getCatalogHealthReport();
    return okResult({
      totalProducts: report.totalProducts,
      healthyProducts: report.healthyProducts,
      unhealthyProducts: report.unhealthyProducts,
      totalErrors: report.totalErrors,
      totalWarnings: report.totalWarnings,
    });
  },
};

export const listCatalogHealthIssuesAdapter: StoreManagerToolAdapter = {
  name: 'listCatalogHealthIssues',
  version: 1,
  description: 'List detailed catalog health issues with optional filters for severity, code, field path, or a general search query.',
  promptGuidelines: 'Use for specific issue lists; results are bounded.',
  inputSchema: z.object({
    severity: z.enum(['blocker', 'warning', 'info']).optional(),
    code: z.string().optional(),
    fieldPath: z.string().optional(),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  supportedScopes: [] as const,
  scopeSummary: (input) =>
    `catalog health issues${typeof input.search === 'string' && input.search ? ` matching "${input.search}"` : ''}`,
  execute: async (params): Promise<StoreManagerToolResult> => {
    const report = getCatalogHealthReport();
    const severity = typeof params.severity === 'string' ? params.severity : undefined;
    const code = typeof params.code === 'string' ? params.code : undefined;
    const fieldPath = typeof params.fieldPath === 'string' ? params.fieldPath : undefined;
    const search = typeof params.search === 'string' ? params.search : undefined;
    const limit = typeof params.limit === 'number' ? params.limit : 25;
    let issues = report.issues;
    if (severity) issues = issues.filter((i) => i.severity === severity);
    if (code) issues = issues.filter((i) => i.code === code);
    if (fieldPath) issues = issues.filter((i) => i.fieldPath === fieldPath);
    if (search) {
      const lower = search.toLowerCase();
      issues = issues.filter(
        (i) =>
          i.sku.toLowerCase().includes(lower) ||
          i.title.toLowerCase().includes(lower) ||
          (i.message && i.message.toLowerCase().includes(lower)),
      );
    }
    return okResult(issues.slice(0, limit));
  },
};

export const searchProductsAdapter: StoreManagerToolAdapter = {
  name: 'searchProducts',
  version: 1,
  description: 'Search the product index for active products matching a query or filter parameters.',
  promptGuidelines: 'Use for product-level searches; results come from the authoritative product index.',
  inputSchema: z.object({
    search: z.string().optional(),
    status: z.string().optional(),
    inventoryStatus: z.string().optional(),
    minPrice: z.string().optional(),
    maxPrice: z.string().optional(),
    customFilters: z.record(z.string(), z.string()).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  supportedScopes: ['sku_set'] as const,
  scopeSummary: (input) =>
    `product search${typeof input.search === 'string' && input.search ? ` for "${input.search}"` : ''}`,
  execute: async (filter, ctx): Promise<StoreManagerToolResult> => {
    const result = listProductIndex(filter as Parameters<typeof listProductIndex>[0]);
    const pinnedSkus = ctx.pinnedScope?.kind === 'sku_set' ? ctx.pinnedScope.skus : null;
    if (pinnedSkus) {
      const set = new Set(pinnedSkus);
      const limit = typeof filter.limit === 'number' ? filter.limit : 25;
      return okResult(result.products.filter((p) => set.has(p.sku)).slice(0, limit));
    }
    return okResult(result.products);
  },
};

export const getProductFieldAuditAdapter: StoreManagerToolAdapter = {
  name: 'getProductFieldAudit',
  version: 1,
  description: 'Scan active products and perform a detailed ProductField value audit, counting unique/missing values and detecting casing, whitespace, and separator duplicate groups.',
  promptGuidelines: 'Use before proposing field normalization; evidence-backed.',
  inputSchema: z.object({
    field: z.string().min(1).max(200).optional().describe('ProductField name, e.g. ProductField24 or ProductField16; defaults to the pinned product_field scope'),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  supportedScopes: ['product_field'] as const,
  scopeSummary: (input) => `ProductField ${String(input.field ?? '(pinned)')} audit`,
  execute: async ({ field, limit }, ctx): Promise<StoreManagerToolResult> => {
    const effectiveField =
      typeof field === 'string' && field
        ? field
        : ctx.pinnedScope?.kind === 'product_field'
          ? ctx.pinnedScope.field
          : undefined;
    if (!effectiveField) {
      return policyDenied('invalid_input', 'getProductFieldAudit requires a field or a pinned product_field scope.');
    }
    return okResult(getProductFieldAudit(effectiveField, Number(limit)));
  },
};

export const previewProductFieldNormalizationAdapter: StoreManagerToolAdapter = {
  name: 'preview_product_field_normalization',
  version: 1,
  description:
    'Generate transient, in-memory normalization previews for a custom ProductField under a selected strategy. Read-only: nothing is persisted.',
  promptGuidelines:
    'Use to preview normalization options; the result is an in-memory recommendation only.',
  inputSchema: z.object({
    field: z.string().min(1).max(200).optional().describe('ProductField name; defaults to the pinned product_field scope'),
    strategy: z
      .enum(['case_only', 'trim_whitespace', 'separator_cleanup', 'safe_duplicates'])
      .default('safe_duplicates'),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  riskClass: 'read',
  sideEffects: 'none (transient in-memory preview; nothing is persisted)',
  requiresApproval: false,
  stateTransition: 'none (in-memory recommendation only)',
  allowedPhases: ['investigate', 'verify'] as const,
  supportedScopes: ['product_field'] as const,
  scopeSummary: (input) =>
    `transient ${String(input.strategy ?? 'safe_duplicates')} normalization preview for ${String(input.field ?? '(pinned)')}`,
  execute: async ({ field, strategy, limit }, ctx): Promise<StoreManagerToolResult> => {
    const effectiveField =
      typeof field === 'string' && field
        ? field
        : ctx.pinnedScope?.kind === 'product_field'
          ? ctx.pinnedScope.field
          : undefined;
    if (!effectiveField) {
      return policyDenied('invalid_input', 'preview_product_field_normalization requires a field or a pinned product_field scope.');
    }
    return okResult(proposeProductFieldNormalization(effectiveField, strategy as never, Number(limit)));
  },
};

export const listStoredProposalsAdapter: StoreManagerToolAdapter = {
  name: 'listStoredProposals',
  version: 1,
  description: 'List stored normalization proposals from the database, with optional filters for field or status ("proposed", "applied", "dismissed").',
  promptGuidelines: 'Use to enumerate stored proposals before staging decisions.',
  inputSchema: z.object({
    field: z.string().optional(),
    status: z.enum(['proposed', 'applied', 'dismissed']).optional(),
  }),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  supportedScopes: ['product_field'] as const,
  scopeSummary: (input) =>
    `stored proposals${typeof input.field === 'string' && input.field ? ` for ${input.field}` : ''}`,
  execute: async ({ field, status }, ctx): Promise<StoreManagerToolResult> => {
    const effectiveField =
      typeof field === 'string' && field
        ? field
        : ctx.pinnedScope?.kind === 'product_field'
          ? ctx.pinnedScope.field
          : undefined;
    const proposals = listProposals(ctx.workspaceId, {
      field: effectiveField,
      status: typeof status === 'string' ? status : undefined,
    });
    return okResult(proposals);
  },
};

export const explainNextActionsAdapter: StoreManagerToolAdapter = {
  name: 'explainNextActions',
  version: 2,
  description:
    'Return a ranked list of recommended next actions based on current catalog health, drift status, sync state, and change sets. Use the focus parameter to filter to one evidence area.',
  promptGuidelines:
    'The focus parameter filters deterministic evidence; when a focus has no supporting evidence the result reports no_result rather than guessing.',
  inputSchema: z.object({
    focus: z.enum(NEXT_ACTIONS_FOCUSES).optional(),
  }),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  supportedScopes: [] as const,
  scopeSummary: (input) =>
    `next actions${typeof input.focus === 'string' ? ` focused on ${input.focus}` : ''}`,
  execute: async ({ focus }, ctx): Promise<StoreManagerToolResult> => {
    const evidence = collectNextActionEvidence(ctx.workspaceId);
    const selected =
      typeof focus === 'string' && focus.length > 0
        ? evidence
            .filter((e) => e.focus === focus)
            .sort((a, b) => a.priority - b.priority)
        : evidence.slice().sort((a, b) => a.priority - b.priority);

    if (selected.length === 0) {
      return noResult(
        typeof focus === 'string'
          ? `No evidence found for the "${focus}" focus.`
          : 'No evidence found for next-action recommendations.',
        { focus: typeof focus === 'string' ? focus : null, actions: [] },
      );
    }

    return okResult({
      focus: typeof focus === 'string' ? focus : null,
      actions: selected.map((e) => ({ action: e.action, evidenceKey: e.evidenceKey })),
    });
  },
};

/** All read/catalog adapters in stable registration order. */
export const CATALOG_TOOL_ADAPTERS: StoreManagerToolAdapter[] = [
  getDashboardStatsAdapter,
  getCatalogHealthReportAdapter,
  listCatalogHealthIssuesAdapter,
  searchProductsAdapter,
  getProductFieldAuditAdapter,
  previewProductFieldNormalizationAdapter,
  listStoredProposalsAdapter,
  explainNextActionsAdapter,
];
