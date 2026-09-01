import { createHash } from 'node:crypto';
import { timingSafeCompare } from '../shared/timing-safe';

/**
 * Milestone 4 (P1-D) — Server-derived principal.
 * Never trusts client reviewerId for actor identity. Derives from
 * Authorization: Bearer <token> compared to BAYSTATE_CMS_API_TOKEN via
 * timingSafeCompare (fixed-length hash, no length leak). Returns catalog_approver / catalog_exporter or 401.
 */
export type Principal = {
  actor: string;
  role: 'catalog_approver' | 'catalog_exporter' | 'operator' | 'system';
  tokenHash: string | null;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Derive principal from Hono context.
 * - No BAYSTATE_CMS_API_TOKEN configured => system (dev) — allowed as system role
 * - Token matches via timingSafeCompare => catalog_approver (hash derived)
 * - Mismatch or missing when token is configured => null (caller must return 401)
 */
export function derivePrincipal(c: { req: { header: (name: string) => string | undefined } }): Principal | null {
  const auth = c.req.header('Authorization') ?? c.req.header('authorization') ?? '';
  const envToken = process.env.BAYSTATE_CMS_API_TOKEN;
  if (!envToken) {
    // Dev mode: treat as system so route allows (system bypasses catalog_approver check)
    return { actor: 'system', role: 'system', tokenHash: null };
  }
  const expected = `Bearer ${envToken}`;
  // Use fixed-length hash compare to avoid length-dependent early return leak
  if (!timingSafeCompare(auth, expected)) {
    return null;
  }
  const token = auth.slice('Bearer '.length);
  const h = hashToken(token);
  return { actor: `catalog_approver:${h}`, role: 'catalog_approver', tokenHash: h };
}

/**
 * Derive principal for a specific operation (approve vs export).
 * Maps catalog_approver <-> catalog_exporter based on operation while keeping timing-safe check.
 */
export function derivePrincipalForOperation(
  c: { req: { header: (name: string) => string | undefined } },
  operation: 'approve' | 'export',
): Principal | null {
  const base = derivePrincipal(c);
  if (!base) return null;
  if (base.role === 'system') return base;
  if (operation === 'export' && base.role === 'catalog_approver') {
    // Token that is approver is also allowed as exporter? Keep distinct if needed
    return { ...base, role: 'catalog_exporter' };
  }
  return base;
}
