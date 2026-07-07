import { tool } from 'ai';
import { z } from 'zod';
import { getDashboardStatsData } from './dashboard-service';
import { getCatalogHealthReport } from './product-service';
import { listProductIndex } from './product-service';
import { getProductFieldAudit, proposeProductFieldNormalization } from './product-field-audit-service';
import {
  generateDeterministicProposals,
  listProposals,
  applyProposal,
  dismissProposal,
} from './product-field-refactor-service';

export interface StoreManagerToolContext {
  workspaceId: string;
  workspacePath: string;
}

export function createStoreManagerTools(context: StoreManagerToolContext) {
  const { workspaceId, workspacePath } = context;

  return {
    getDashboardStats: tool({
      description: 'Retrieve overall metrics and status for the store manager dashboard, including product counts, sync statuses, drift items, warnings, and recent activity.',
      inputSchema: z.object({}),
      execute: async () => {
        return getDashboardStatsData(workspaceId);
      },
    }),

    getCatalogHealthReport: tool({
      description: 'Retrieve the overall catalog health report summary, showing counts of healthy/unhealthy products, blockers, and warnings.',
      inputSchema: z.object({}),
      execute: async () => {
        const report = getCatalogHealthReport();
        return {
          totalProducts: report.totalProducts,
          healthyProducts: report.healthyProducts,
          unhealthyProducts: report.unhealthyProducts,
          totalErrors: report.totalErrors,
          totalWarnings: report.totalWarnings,
        };
      },
    }),

    listCatalogHealthIssues: tool({
      description: 'List detailed catalog health issues with optional filters for severity, code, field path, or a general search query.',
      inputSchema: z.object({
        severity: z.enum(['blocker', 'warning', 'info']).optional(),
        code: z.string().optional(),
        fieldPath: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      execute: async ({ severity, code, fieldPath, search, limit }) => {
        const report = getCatalogHealthReport();
        let issues = report.issues;

        if (severity) {
          issues = issues.filter(i => i.severity === severity);
        }
        if (code) {
          issues = issues.filter(i => i.code === code);
        }
        if (fieldPath) {
          issues = issues.filter(i => i.fieldPath === fieldPath);
        }
        if (search) {
          const lower = search.toLowerCase();
          issues = issues.filter(i =>
            i.sku.toLowerCase().includes(lower) ||
            i.title.toLowerCase().includes(lower) ||
            (i.message && i.message.toLowerCase().includes(lower))
          );
        }

        return issues.slice(0, limit);
      },
    }),

    searchProducts: tool({
      description: 'Search the product index for active products matching a query or filter parameters.',
      inputSchema: z.object({
        search: z.string().optional(),
        status: z.string().optional(),
        inventoryStatus: z.string().optional(),
        minPrice: z.string().optional(),
        maxPrice: z.string().optional(),
        customFilters: z.record(z.string(), z.string()).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      execute: async (filter) => {
        const result = listProductIndex(filter);
        return result.products;
      },
    }),

    getProductFieldAudit: tool({
      description: 'Scan active products and perform a detailed ProductField value audit, counting unique/missing values and detecting casing, whitespace, and separator duplicate groups.',
      inputSchema: z.object({
        field: z.string().describe('ProductField name, e.g. ProductField24 or ProductField16'),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      execute: async ({ field, limit }) => {
        return getProductFieldAudit(field, limit);
      },
    }),

    proposeProductFieldNormalization: tool({
      description: 'Generate transient, in-memory proposals for a custom ProductField under a selected strategy. Read-only: does not save to the database.',
      inputSchema: z.object({
        field: z.string(),
        strategy: z.enum(['case_only', 'trim_whitespace', 'separator_cleanup', 'safe_duplicates']).default('safe_duplicates'),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      execute: async ({ field, strategy, limit }) => {
        return proposeProductFieldNormalization(field, strategy, limit);
      },
    }),

    generateNormalizationProposals: tool({
      description: 'Generate and store normalization proposals in the database for a custom ProductField, making them ready to list and apply.',
      inputSchema: z.object({
        field: z.string().describe('ProductField name, e.g. ProductField24'),
      }),
      execute: async ({ field }) => {
        const proposals = generateDeterministicProposals(workspaceId, field);
        return { success: true, proposalCount: proposals.length };
      },
    }),

    listStoredProposals: tool({
      description: 'List stored normalization proposals from the database, with optional filters for field or status ("proposed", "applied", "dismissed").',
      inputSchema: z.object({
        field: z.string().optional(),
        status: z.enum(['proposed', 'applied', 'dismissed']).optional(),
      }),
      execute: async ({ field, status }) => {
        const proposals = listProposals(workspaceId, { field, status });
        return proposals;
      },
    }),

    applyNormalizationProposal: tool({
      description: 'Apply a stored proposal by its UUID, staging value updates for all affected products inside the active Change Set.',
      inputSchema: z.object({
        proposalId: z.string().describe('The UUID of the proposal to apply'),
      }),
      execute: async ({ proposalId }) => {
        const res = applyProposal(workspaceId, workspacePath, proposalId);
        return { success: true, changeSetId: res.changeSetId };
      },
    }),

    dismissNormalizationProposal: tool({
      description: 'Dismiss a stored proposal by its UUID so it will not be suggested or applied.',
      inputSchema: z.object({
        proposalId: z.string().describe('The UUID of the proposal to dismiss'),
      }),
      execute: async ({ proposalId }) => {
        dismissProposal(proposalId);
        return { success: true };
      },
    }),

    explainNextActions: tool({
      description: 'Return a ranked list of recommended next actions based on current catalog health, drift status, and change sets.',
      inputSchema: z.object({
        focus: z.enum(['health', 'product_fields', 'sync', 'drift', 'onboarding']).optional(),
      }),
      execute: async () => {
        const report = getCatalogHealthReport();
        const stats = getDashboardStatsData(workspaceId);
        const actions: string[] = [];

        if (report.totalErrors > 0) {
          actions.push(`Fix the ${report.totalErrors} blocking errors in your catalog to enable remote sync.`);
        }
        if (stats.metrics.driftedProducts > 0) {
          actions.push(`Resolve the ${stats.metrics.driftedProducts} drifted products under Products -> Drift.`);
        }
        if (stats.metrics.productsWithWarnings > 0) {
          actions.push(`Review the ${stats.metrics.productsWithWarnings} warnings under Catalog Health.`);
        }
        if (stats.metrics.draftChangeSets > 0) {
          actions.push(`Review and approve the ${stats.metrics.draftChangeSets} active drafts in your Change Sets.`);
        }
        if (actions.length === 0) {
          actions.push('All catalog metrics look clean! You are ready to publish or run catalog exports.');
        }

        return { actions };
      },
    }),
  };
}
