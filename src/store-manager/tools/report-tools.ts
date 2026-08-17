/**
 * Store Manager deterministic report adapter (operations console, Issue 2).
 *
 * `/report` compiles to this read adapter: a bounded, deterministic
 * operational report assembled from authoritative evidence (catalog health,
 * product-field issues, sync state, drift). It is a report artifact, never a
 * model narrative. Catalog-wide by design: with a pinned scope declared it
 * returns scope_unsupported rather than silently broadening a scoped run.
 */

import { z } from 'zod';
import type { StoreManagerToolAdapter, StoreManagerToolResult } from '../runtime/contracts';
import { okResult } from '../runtime/contracts';
import { getCatalogHealthReport } from '../../server/services/product-service';
import { getDashboardStatsData } from '../../server/services/dashboard-service';
import { getProductFieldAudit } from '../../server/services/product-field-audit-service';

const REPORT_FOCUSES = ['health', 'product_fields', 'sync', 'drift', 'full'] as const;

const MAX_FIELD_ISSUES = 100;
const MAX_FIELD_DUPLICATE_GROUPS = 100;

export const getStoreManagerReportAdapter: StoreManagerToolAdapter = {
  name: 'getStoreManagerReport',
  version: 1,
  description:
    'Assemble a bounded deterministic Store Manager operational report from authoritative evidence (catalog health totals, product-field issues, sync state, drift). Read-only; evidence-backed.',
  promptGuidelines:
    'Use for a consolidated operational snapshot. The report is deterministic evidence, not a narrative; do not invent counts beyond it.',
  inputSchema: z.object({
    focus: z.enum(REPORT_FOCUSES).default('full'),
  }),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  supportedScopes: [] as const,
  scopeSummary: (input) =>
    `deterministic operational report${typeof input.focus === 'string' && input.focus !== 'full' ? ` (${input.focus})` : ''}`,
  execute: async ({ focus }, ctx): Promise<StoreManagerToolResult> => {
    const health = getCatalogHealthReport();
    const stats = getDashboardStatsData(ctx.workspaceId);
    const focusValue = typeof focus === 'string' ? focus : 'full';

    const sections: Record<string, unknown> = {};
    if (focusValue === 'health' || focusValue === 'full') {
      sections.health = {
        totalProducts: health.totalProducts,
        healthyProducts: health.healthyProducts,
        unhealthyProducts: health.unhealthyProducts,
        totalErrors: health.totalErrors,
        totalWarnings: health.totalWarnings,
      };
    }
    if (focusValue === 'product_fields' || focusValue === 'full') {
      const fieldIssues = health.issues
        .filter((i) => i.fieldPath && (i.code === 'field_registry' || i.code === 'field_value'))
        .slice(0, MAX_FIELD_ISSUES)
        .map((i) => ({
          sku: i.sku,
          code: i.code,
          fieldPath: i.fieldPath,
          severity: i.severity,
        }));
      const fieldAudit = getProductFieldAudit('ProductField24', MAX_FIELD_DUPLICATE_GROUPS);
      sections.product_fields = {
        fieldIssueCount: fieldIssues.length,
        fieldIssues,
        defaultFieldAudit: {
          field: fieldAudit.field,
          uniqueValueCount: fieldAudit.uniqueValueCount,
          duplicateGroupCount: fieldAudit.totalDuplicateGroupCount,
        },
      };
    }
    if (focusValue === 'sync' || focusValue === 'full') {
      sections.sync = {
        notSyncedProducts: stats.metrics.notSyncedProducts,
        draftChangeSets: stats.metrics.draftChangeSets,
        driftedProducts: stats.metrics.driftedProducts,
      };
    }
    if (focusValue === 'drift' || focusValue === 'full') {
      sections.drift = {
        driftedProducts: stats.metrics.driftedProducts,
      };
    }

    return okResult({
      scope: 'catalog',
      focus: focusValue,
      sections,
      generatedAt: null, // deterministic report: no wall-clock claim
    });
  },
};

export const REPORT_TOOL_ADAPTERS: StoreManagerToolAdapter[] = [getStoreManagerReportAdapter];
