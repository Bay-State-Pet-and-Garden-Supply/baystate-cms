/**
 * Store Manager bounded history-query registry (operations console, Issue 7).
 *
 * The model may choose ONLY among a finite set of read-only history queries;
 * it never emits SQL and never gains arbitrary database access. Each query has
 * a stable ID, version, bounded zod parameter schema, and a FIXED workspace-
 * scoped repository implementation. Unsupported questions return the
 * supported query descriptors — the surface never widens.
 */

import { z } from 'zod';
import type { StoreManagerHistoryQueryId } from '../../shared/schemas/store-manager-history';
import {
  listRepeatedlyRejectedProposals,
  listRecurringInboxFingerprints,
  countReviewDecisionsByField,
} from '../../db/repositories/store-manager-history-repo';
import { countProposalsByField } from '../../db/repositories/catalog-health-proposal-repo';
import { compareStoreManagerRuns } from '../../server/services/store-manager-comparison-service';

export interface StoreManagerHistoryQueryDefinition {
  id: StoreManagerHistoryQueryId;
  version: number;
  description: string;
  paramSpec: unknown;
  paramSchema: z.ZodType<unknown>;
  execute(
    workspaceId: string,
    params: Record<string, unknown>,
  ): {
    matchedRows: number;
    sourceRunIds: string[];
    columns: string[];
    rows: Array<Record<string, string | number | null>>;
    truncated: boolean;
  };
}

function boundedLimit(params: Record<string, unknown>, fallback = 50, max = 200): number {
  const raw = params.limit;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(Math.max(Math.floor(raw), 1), max);
  }
  return fallback;
}

export const STORE_MANAGER_HISTORY_QUERIES: readonly StoreManagerHistoryQueryDefinition[] = [
  {
    id: 'what_got_worse',
    version: 1,
    description:
      'Compare two compatible report runs and list the deterministic numeric fields that grew (e.g. issue counts) — what got worse between the two periods.',
    paramSpec: {
      runIdA: { type: 'string', required: true, note: 'Source run id (workspace-scoped).' },
      runIdB: { type: 'string', required: true, note: 'Comparison run id (workspace-scoped).' },
    },
    paramSchema: z
      .object({
        runIdA: z.string().min(1).max(64),
        runIdB: z.string().min(1).max(64),
      })
      .strict(),
    execute(workspaceId, params) {
      const result = compareStoreManagerRuns(workspaceId, String(params.runIdA), String(params.runIdB));
      if (!result.comparable || !result.delta) {
        return {
          matchedRows: 0,
          sourceRunIds: [String(params.runIdA), String(params.runIdB)],
          columns: ['field', 'before', 'after', 'worse'],
          rows: [],
          truncated: false,
        };
      }
      const worse = result.delta.filter((d) => {
        if (typeof d.after === 'number' && typeof d.before === 'number') return d.after > d.before;
        return d.before !== d.after;
      });
      return {
        matchedRows: worse.length,
        sourceRunIds: [String(params.runIdA), String(params.runIdB)],
        columns: ['field', 'before', 'after', 'worse'],
        rows: worse.slice(0, 200).map((d) => ({
          field: d.field,
          before: d.before === null ? '' : String(d.before),
          after: d.after === null ? '' : String(d.after),
          worse: typeof d.after === 'number' && typeof d.before === 'number' ? String(d.after - d.before) : 'yes',
        })),
        truncated: worse.length > 200,
      };
    },
  },
  {
    id: 'recurring_issues',
    version: 1,
    description:
      'List Inbox findings whose dedupe fingerprint has appeared more than once (a finding that re-appeared after resolution).',
    paramSpec: {
      minOccurrences: { type: 'number', required: false, note: 'Minimum reappearances (default 2).' },
      limit: { type: 'number', required: false },
    },
    paramSchema: z
      .object({
        minOccurrences: z.number().int().min(2).max(100).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    execute(workspaceId, params) {
      const rows = listRecurringInboxFingerprints(workspaceId, {
        minOccurrences: params.minOccurrences === undefined ? 2 : Number(params.minOccurrences),
        limit: boundedLimit(params),
      });
      return {
        matchedRows: rows.length,
        sourceRunIds: [],
        columns: ['dedupe_key', 'kind', 'occurrences', 'first_seen_at', 'last_seen_at', 'lifecycle'],
        rows: rows.map((r) => ({
          dedupe_key: r.dedupeKey.slice(0, 200),
          kind: r.kind,
          occurrences: r.occurrences,
          first_seen_at: r.firstSeenAt.slice(0, 40),
          last_seen_at: r.lastSeenAt.slice(0, 40),
          lifecycle: r.lifecycle,
        })),
        truncated: rows.length >= boundedLimit(params),
      };
    },
  },
  {
    id: 'proposals_rejected_repeatedly',
    version: 1,
    description:
      'Proposals dismissed/denied more than once, with their decision history (durable review-decision events).',
    paramSpec: {
      minRejections: { type: 'number', required: false, note: 'Minimum rejection count (default 2).' },
      limit: { type: 'number', required: false },
    },
    paramSchema: z
      .object({
        minRejections: z.number().int().min(2).max(100).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    execute(workspaceId, params) {
      const rows = listRepeatedlyRejectedProposals(workspaceId, {
        minRejections: params.minRejections === undefined ? 2 : Number(params.minRejections),
        limit: boundedLimit(params),
      });
      return {
        matchedRows: rows.length,
        sourceRunIds: rows.flatMap((r) =>
          r.decisions.map((d) => d.run_id).filter((id): id is string => typeof id === 'string' && id.length > 0),
        ),
        columns: ['proposal_id', 'field', 'rejections', 'decisions'],
        rows: rows.map((r) => ({
          proposal_id: r.proposalId.slice(0, 200),
          field: r.field,
          rejections: r.rejections,
          decisions: JSON.stringify(r.decisions.map((d) => ({ decision: d.decision, actor: d.actor, at: d.created_at }))).slice(0, 1000),
        })),
        truncated: rows.length >= boundedLimit(params),
      };
    },
  },
  {
    id: 'field_cleanup_work',
    version: 1,
    description:
      'ProductFields ranked by cleanup work: stored proposals (by status) plus recorded review decisions per field.',
    paramSpec: { limit: { type: 'number', required: false } },
    paramSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
    execute(workspaceId, params) {
      const proposals = countProposalsByField(workspaceId);
      const decisions = countReviewDecisionsByField(workspaceId);
      const fields = new Set([...Object.keys(proposals), ...Object.keys(decisions)]);
      const rows = [...fields]
        .map((field) => ({
          field,
          proposals: proposals[field] ?? 0,
          review_decisions: decisions[field] ?? 0,
          total: (proposals[field] ?? 0) + (decisions[field] ?? 0),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, boundedLimit(params));
      return {
        matchedRows: rows.length,
        sourceRunIds: [],
        columns: ['field', 'proposals', 'review_decisions', 'total'],
        rows: rows.map((r) => ({ field: r.field.slice(0, 200), proposals: r.proposals, review_decisions: r.review_decisions, total: r.total })),
        truncated: fields.size > boundedLimit(params),
      };
    },
  },
];

/** Resolve a query by id (undefined = unknown query). */
export function getHistoryQuery(id: string): StoreManagerHistoryQueryDefinition | undefined {
  return STORE_MANAGER_HISTORY_QUERIES.find((q) => q.id === id);
}

/** Supported query descriptors (server-owned; the model never lists more). */
export function describeHistoryQueries(): Array<{ queryId: string; version: number; description: string; paramSpec: unknown }> {
  return STORE_MANAGER_HISTORY_QUERIES.map((q) => ({
    queryId: q.id,
    version: q.version,
    description: q.description,
    paramSpec: q.paramSpec,
  }));
}
