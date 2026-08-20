// story: e06s02 — explicit waiver for <3 product URLs
import { getDb } from '../connection';
import { normalizeDomain } from './brand-url-index-repo';
import { createHash } from 'node:crypto';

export interface DomainWaiver {
  domain: string;
  reason: string;
  actor: string;
  artifactHash: string;
  createdAt: string;
}

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS domain_waiver (
      domain TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      actor TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export function createWaiver(domain: string, reason: string, actor: string): DomainWaiver {
  if (!reason?.trim()) throw new Error('waiver reason required');
  if (!actor?.trim()) throw new Error('waiver actor required');
  ensureTable();
  const db = getDb();
  const norm = normalizeDomain(domain);
  const now = new Date().toISOString();
  const hash = createHash('sha256').update(`${norm}|${reason}|${actor}|${now}`).digest('hex').slice(0, 16);
  db.prepare(`
    INSERT INTO domain_waiver (domain, reason, actor, artifact_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET reason=excluded.reason, actor=excluded.actor, artifact_hash=excluded.artifact_hash, created_at=excluded.created_at
  `).run(norm, reason.trim(), actor.trim(), hash, now);
  return { domain: norm, reason: reason.trim(), actor: actor.trim(), artifactHash: hash, createdAt: now };
}

export function getWaiver(domain: string): DomainWaiver | null {
  ensureTable();
  const db = getDb();
  const norm = normalizeDomain(domain);
  const row = db.query('SELECT domain, reason, actor, artifact_hash as artifactHash, created_at as createdAt FROM domain_waiver WHERE domain = ?').get(norm) as { domain: string; reason: string; actor: string; artifactHash: string; createdAt: string } | undefined;
  if (!row) return null;
  return row;
}

export function hasValidWaiver(domain: string): boolean {
  return getWaiver(domain) !== null;
}
