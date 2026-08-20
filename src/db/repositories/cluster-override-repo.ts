// story: e07s02 — cluster overrides (merge/split/replace)
import { getDb } from '../connection';
import { normalizeDomain } from './brand-url-index-repo';

export type ClusterOverride = {
  domain: string;
  clusterKey: string;
  action: string;
  actor: string;
  createdAt: string;
};

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_overrides (
      domain TEXT NOT NULL,
      cluster_key TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (domain, cluster_key)
    );
  `);
}

export function getClusterOverrides(domain: string): ClusterOverride[] {
  ensureTable();
  const norm = normalizeDomain(domain);
  const db = getDb();
  const rows = db.query('SELECT domain, cluster_key as clusterKey, action, actor, created_at as createdAt FROM cluster_overrides WHERE domain = ? ORDER BY created_at').all(norm) as ClusterOverride[];
  return rows;
}

export function setClusterOverride(domain: string, clusterKey: string, action: string, actor: string): ClusterOverride {
  if (!clusterKey.trim()) throw new Error('clusterKey required');
  if (!action.trim()) throw new Error('action required');
  if (!actor.trim()) throw new Error('actor required');
  ensureTable();
  const norm = normalizeDomain(domain);
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO cluster_overrides (domain, cluster_key, action, actor, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(domain, cluster_key) DO UPDATE SET action = excluded.action, actor = excluded.actor, created_at = excluded.created_at`,
  ).run(norm, clusterKey.trim(), action.trim(), actor.trim(), now);
  return { domain: norm, clusterKey: clusterKey.trim(), action: action.trim(), actor: actor.trim(), createdAt: now };
}

export function applyOverrides<T extends { key: string }>(clusters: T[], overrides: ClusterOverride[]): T[] {
  if (overrides.length === 0) return clusters;
  const byKey = new Map(overrides.map((o) => [o.clusterKey, o.action]));
  const mergedKey = overrides.find((o) => o.action === 'merge')?.clusterKey;
  if (mergedKey) {
    const kept = clusters.filter((c) => c.key !== mergedKey || c.key === clusters[0]?.key);
    return kept;
  }
  return clusters.filter((c) => !byKey.has(c.key) || byKey.get(c.key) !== 'split_exclude');
}
