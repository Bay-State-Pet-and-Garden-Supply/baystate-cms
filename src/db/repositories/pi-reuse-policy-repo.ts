/**
 * PI reuse grants (P0-6 review remediation).
 *
 * Server-authoritative image reuse authorization, resolved independently of
 * source identity: a canonical manufacturer/supplier domain proves where an
 * asset came from, NOT that reuse is permitted. Reuse requires a durable
 * workspace-scoped grant matching the declared source tier and the asset's
 * domain. Absence of a grant always fails closed (no reuse).
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

const now = () => new Date().toISOString();

export interface PiReusePolicyRow {
  id: string;
  workspaceId: string;
  sourceTier: string;
  domainPattern: string;
  allowed: number;
  terms: string | null;
  createdAt: string;
}

const ROW_SELECT = `
  SELECT id, workspace_id AS workspaceId, source_tier AS sourceTier,
         domain_pattern AS domainPattern, allowed, terms, created_at AS createdAt
  FROM pi_reuse_policies
`;

function mapRow(row: Record<string, unknown>): PiReusePolicyRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    sourceTier: String(row.sourceTier),
    domainPattern: String(row.domainPattern),
    allowed: Number(row.allowed),
    terms: row.terms ? String(row.terms) : null,
    createdAt: String(row.createdAt),
  };
}

export function listReusePolicies(workspaceId: string): PiReusePolicyRow[] {
  const db = getDb();
  return (db.query(`${ROW_SELECT} WHERE workspace_id = ? ORDER BY created_at ASC`).all(workspaceId) as Record<string, unknown>[]).map(mapRow);
}

export function upsertReusePolicy(input: {
  workspaceId: string;
  sourceTier: string;
  domainPattern: string;
  allowed: boolean | number;
  terms?: string | null;
}): PiReusePolicyRow {
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT INTO pi_reuse_policies (id, workspace_id, source_tier, domain_pattern, allowed, terms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, source_tier, domain_pattern) DO UPDATE SET
       allowed = excluded.allowed,
       terms = excluded.terms,
       created_at = excluded.created_at`,
    [id, input.workspaceId, input.sourceTier, input.domainPattern, input.allowed ? 1 : 0, input.terms ?? null, now()],
  );
  return mapRow(
    db
      .query(`${ROW_SELECT} WHERE workspace_id = ? AND source_tier = ? AND domain_pattern = ?`)
      .get(input.workspaceId, input.sourceTier, input.domainPattern) as Record<string, unknown>,
  );
}

/**
 * Domain-pattern match: '*' matches everything; otherwise a
 * case-insensitive exact match or subdomain suffix (pattern 'example.com'
 * matches 'example.com' and 'cdn.example.com').
 */
export function domainMatches(pattern: string, domain: string): boolean {
  if (pattern === '*') return true;
  const p = pattern.toLowerCase();
  const d = domain.toLowerCase();
  if (p === d) return true;
  if (d.endsWith(`.${p}`)) return true;
  return false;
}

/**
 * Build a workspace-scoped reuse grant resolver. Returns false (fail
 * closed) for any tier/domain without an explicit allowed grant.
 */
export function buildReuseGrantResolver(
  workspaceId: string,
): (sourceTier: string, domain: string) => boolean {
  return (sourceTier: string, domain: string): boolean => {
    const rows = listReusePolicies(workspaceId);
    return rows.some(
      (r) => r.allowed === 1 && r.sourceTier === sourceTier && domainMatches(r.domainPattern, domain),
    );
  };
}
