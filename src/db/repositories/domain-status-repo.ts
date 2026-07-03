import { getDb } from '../connection';

export interface DomainStatus {
  domain: string;
  status: 'ok' | 'blocked' | 'offline' | 'mismatch';
  checkedAt: string;
  reason: string | null;
}

interface DbDomainStatus {
  domain: string;
  status: string;
  checked_at: string;
  reason: string | null;
}

/**
 * Normalizes a domain name by lowercasing and stripping www. prefix.
 */
function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

/**
 * Retrieve the status of a domain.
 * If the status is older than 7 days, it's considered expired (stale),
 * and this function will return null to trigger a re-check.
 */
export function getDomainStatus(domain: string): DomainStatus | null {
  const db = getDb();
  const normDomain = normalizeDomain(domain);

  const row = db.query(
    'SELECT domain, status, checked_at, reason FROM domain_status WHERE domain = ?'
  ).get(normDomain) as DbDomainStatus | undefined;

  if (!row) {
    return null;
  }

  // Check if status is older than 7 days
  const checkedDate = new Date(row.checked_at);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - checkedDate.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays > 7) {
    // Status is expired/stale, delete it and return null to trigger re-check
    db.query('DELETE FROM domain_status WHERE domain = ?').run(normDomain);
    return null;
  }

  return {
    domain: row.domain,
    status: row.status as DomainStatus['status'],
    checkedAt: row.checked_at,
    reason: row.reason,
  };
}

/**
 * Records or updates the status of a domain.
 */
export function recordDomainStatus(
  domain: string,
  status: DomainStatus['status'],
  reason: string | null = null
): DomainStatus {
  const db = getDb();
  const normDomain = normalizeDomain(domain);
  const now = new Date().toISOString();

  db.query(`
    INSERT INTO domain_status (domain, status, checked_at, reason)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET
      status = excluded.status,
      checked_at = excluded.checked_at,
      reason = excluded.reason
  `).run(normDomain, status, now, reason);

  return {
    domain: normDomain,
    status,
    checkedAt: now,
    reason,
  };
}

/**
 * Clear domain status cache (useful for troubleshooting or resetting).
 */
// fallow-ignore-next-line unused-export
export function clearDomainStatus(domain: string): boolean {
  const db = getDb();
  const normDomain = normalizeDomain(domain);
  const result = db.query('DELETE FROM domain_status WHERE domain = ?').run(normDomain);
  return result.changes > 0;
}

/**
 * Read-only listing of every persisted `domain_status` row, sorted
 * alphabetically by domain. Intended for diagnostics surfaces that
 * must surface stale rows (older than 7 days) without deleting them.
 *
 * Unlike `getDomainStatus()`, this function:
 *   - never applies the 7-day expiration rule
 *   - never deletes the row when it is stale
 *   - returns the raw `status`/`checked_at`/`reason` values so the
 *     caller can render its own "stale" indicator.
 */
export function listAllDomainStatuses(): DomainStatus[] {
  const db = getDb();
  const rows = db.query(
    'SELECT domain, status, checked_at, reason FROM domain_status ORDER BY domain ASC',
  ).all() as DbDomainStatus[];

  return rows.map((row) => ({
    domain: row.domain,
    status: row.status as DomainStatus['status'],
    checkedAt: row.checked_at,
    reason: row.reason,
  }));
}
