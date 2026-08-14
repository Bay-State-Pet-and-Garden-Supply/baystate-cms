/**
 * Store Manager history-query service (operations console, Issue 7).
 *
 * Executes a bounded query from the finite server-owned query library. The
 * query ID + parameters are strictly validated; the repository SQL is fixed
 * and workspace-scoped. Unknown queries/params are refused — the surface
 * never broadens to arbitrary DB access.
 */

import { getHistoryQuery } from '../../store-manager/history/query-registry';
import type { StoreManagerHistoryQueryResult } from '../../shared/schemas/store-manager-history';

export class StoreManagerHistoryQueryError extends Error {
  readonly code: 'unknown_query' | 'invalid_params' | 'query_failed';
  constructor(code: StoreManagerHistoryQueryError['code'], message: string) {
    super(message);
    this.name = 'StoreManagerHistoryQueryError';
    this.code = code;
  }
}

export function executeHistoryQuery(
  workspaceId: string,
  queryId: string,
  params: Record<string, unknown>,
): StoreManagerHistoryQueryResult {
  const query = getHistoryQuery(queryId);
  if (!query) {
    throw new StoreManagerHistoryQueryError(
      'unknown_query',
      'Unsupported history query. Supported queries: what_got_worse, recurring_issues, proposals_rejected_repeatedly, field_cleanup_work.',
    );
  }
  const parsed = query.paramSchema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new StoreManagerHistoryQueryError(
      'invalid_params',
      `Invalid parameters for query "${queryId}": ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
    );
  }
  try {
    return { queryId: query.id, ...query.execute(workspaceId, parsed.data as Record<string, unknown>) };
  } catch (err) {
    throw new StoreManagerHistoryQueryError(
      'query_failed',
      err instanceof Error ? err.message.slice(0, 300) : 'History query failed.',
    );
  }
}
