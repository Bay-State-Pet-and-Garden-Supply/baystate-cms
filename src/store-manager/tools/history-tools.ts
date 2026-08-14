/**
 * Store Manager history-query tool adapter (operations console, Issue 7).
 *
 * Read-only adapter exposing the FINITE history-query library to the model.
 * The model maps natural language to a query ID + typed parameters only —
 * it never emits SQL and never requests arbitrary database access. The
 * registry/service validate the query ID and parameters strictly.
 */

import { z } from 'zod';
import type { StoreManagerToolAdapter, StoreManagerToolResult } from '../runtime/contracts';
import { okResult, policyDenied } from '../runtime/contracts';
import { executeHistoryQuery, StoreManagerHistoryQueryError } from '../../server/services/store-manager-history-query-service';
import { describeHistoryQueries } from '../history/query-registry';

export const historyQueryAdapter: StoreManagerToolAdapter = {
  name: 'history_query',
  version: 1,
  description:
    'Run one of the finite server-owned history queries (what_got_worse, recurring_issues, proposals_rejected_repeatedly, field_cleanup_work). Map the question to a query id and typed parameters; you cannot write SQL or query arbitrary tables.',
  promptGuidelines:
    'History queries are read-only and bounded. State the query id and matched row count; do not fabricate fields.',
  inputSchema: z.object({
    queryId: z.string().min(1).max(64).describe('One of the supported history query ids.'),
    params: z.record(z.string().min(1).max(20), z.unknown()).optional(),
  }),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  scopeSummary: (input) => `history query ${String(input.queryId ?? '?')}`,
  execute: async ({ queryId, params }, ctx): Promise<StoreManagerToolResult> => {
    try {
      const result = executeHistoryQuery(ctx.workspaceId, String(queryId), (params ?? {}) as Record<string, unknown>);
      return okResult(result);
    } catch (err) {
      if (err instanceof StoreManagerHistoryQueryError) {
        return policyDenied(
          err.code === 'unknown_query' ? 'unsupported' : 'invalid_input',
          err.message,
        );
      }
      return policyDenied('invalid_input', 'History query failed.');
    }
  },
};

export const HISTORY_TOOL_ADAPTERS: readonly StoreManagerToolAdapter[] = [historyQueryAdapter];

/** Supported query descriptors for /plan previews and the client UI. */
export function describeHistoryQuerySurface() {
  return describeHistoryQueries();
}
