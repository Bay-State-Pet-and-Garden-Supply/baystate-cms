import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

/**
 * Milestone 4 (P1-D) — Operation receipt store.
 * Idempotent bulk operations: approve / export. Composite UNIQUE(workspace_id, batch_id, operation, idempotency_key) + request_hash for payload mismatch 409.
 */
export interface OperationReceipt {
  id: string;
  workspaceId: string;
  batchId: string;
  operation: 'approve' | 'export';
  principal: string;
  role: string;
  createdAt: string;
  idempotencyKey: string | null;
  requestHash: string;
  detailsJson: string | null;
  status: 'started' | 'completed' | 'failed';
  startedAt: string | null;
  completedAt: string | null;
}

interface ReceiptRow {
  id: string;
  workspace_id: string;
  batch_id: string;
  operation: string;
  principal: string;
  role: string;
  created_at: string;
  idempotency_key: string | null;
  request_hash: string;
  details_json: string | null;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export function computeRequestHash(itemIds: string[]): string {
  const sorted = [...itemIds].sort();
  const canonical = JSON.stringify(sorted);
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  // Full 64-hex SHA-256 per hardening contract; validate shape
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid request hash shape');
  return hash;
}

export function isValidRequestHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}

function mapRow(r: ReceiptRow): OperationReceipt {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    batchId: r.batch_id,
    operation: r.operation as 'approve' | 'export',
    principal: r.principal,
    role: r.role,
    createdAt: r.created_at,
    idempotencyKey: r.idempotency_key,
    requestHash: r.request_hash ?? '',
    detailsJson: r.details_json,
    status: (r.status as 'started' | 'completed' | 'failed' | null) ?? 'completed',
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
  };
}

export function createReceipt(input: {
  workspaceId: string;
  batchId: string;
  operation: 'approve' | 'export';
  principal: string;
  role: string;
  idempotencyKey?: string | null;
  requestHash: string;
  detailsJson?: string | null;
  status?: 'started' | 'completed' | 'failed';
}): OperationReceipt {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  if (!input.requestHash) throw new Error('requestHash is required');
  if (!isValidRequestHash(input.requestHash)) throw new Error('requestHash must be 64-hex SHA-256');
  const hash = input.requestHash;
  const status = input.status ?? (input.detailsJson ? 'completed' : 'started');
  const startedAt = status === 'started' ? now : null;
  const completedAt = status === 'completed' ? now : null;
  db.run(
    `INSERT INTO onboarding_operation_receipts (id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json, status, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.workspaceId, input.batchId, input.operation, input.principal, input.role, now, input.idempotencyKey ?? null, hash, input.detailsJson ?? null, status, startedAt, completedAt],
  );
  const row = db.query('SELECT * FROM onboarding_operation_receipts WHERE id = ?').get(id) as ReceiptRow;
  return mapRow(row);
}

export function claimReceipt(input: {
  workspaceId: string;
  batchId: string;
  operation: 'approve' | 'export';
  principal: string;
  role: string;
  idempotencyKey: string;
  requestHash: string;
}): { receipt: OperationReceipt; isNew: boolean; isReplay?: boolean; isConflict?: boolean; isInterrupted?: boolean } {
  const existing = findByScopedIdempotencyKey(input.workspaceId, input.batchId, input.operation, input.idempotencyKey);
  if (existing) {
    if (existing.requestHash !== input.requestHash) {
      return { receipt: existing, isNew: false, isConflict: true };
    }
    if (existing.status === 'started') {
      return { receipt: existing, isNew: false, isInterrupted: true };
    }
    if (existing.status === 'completed' && existing.detailsJson) {
      return { receipt: existing, isNew: false, isReplay: true };
    }
    return { receipt: existing, isNew: false };
  }
  const receipt = createReceipt({
    workspaceId: input.workspaceId,
    batchId: input.batchId,
    operation: input.operation,
    principal: input.principal,
    role: input.role,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    detailsJson: null,
    status: 'started',
  });
  return { receipt, isNew: true };
}

export function completeReceipt(id: string, detailsJson: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(`UPDATE onboarding_operation_receipts SET details_json = ?, status = 'completed', completed_at = ? WHERE id = ?`, [detailsJson, now, id]);
}

export function failReceipt(id: string, detailsJson?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (detailsJson) {
    db.run(`UPDATE onboarding_operation_receipts SET details_json = ?, status = 'failed', completed_at = ? WHERE id = ?`, [detailsJson, now, id]);
  } else {
    db.run(`UPDATE onboarding_operation_receipts SET status = 'failed', completed_at = ? WHERE id = ?`, [now, id]);
  }
}

export function findByIdempotencyKey(key: string): OperationReceipt | undefined {
  // Legacy global lookup — kept for backward compat, delegates to scoped version with empty scope (will not match composite)
  if (!key) return undefined;
  const db = getDb();
  const row = db.query('SELECT * FROM onboarding_operation_receipts WHERE idempotency_key = ? LIMIT 1').get(key) as ReceiptRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function findByScopedIdempotencyKey(
  workspaceId: string,
  batchId: string,
  operation: 'approve' | 'export',
  key: string,
): OperationReceipt | undefined {
  if (!key) return undefined;
  const db = getDb();
  const row = db
    .query('SELECT * FROM onboarding_operation_receipts WHERE workspace_id = ? AND batch_id = ? AND operation = ? AND idempotency_key = ?')
    .get(workspaceId, batchId, operation, key) as ReceiptRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function listByBatch(batchId: string): OperationReceipt[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM onboarding_operation_receipts WHERE batch_id = ? ORDER BY created_at DESC').all(batchId) as ReceiptRow[];
  return rows.map(mapRow);
}

/** Find by id */
export function findById(id: string): OperationReceipt | undefined {
  const db = getDb();
  const row = db.query('SELECT * FROM onboarding_operation_receipts WHERE id = ?').get(id) as ReceiptRow | undefined;
  return row ? mapRow(row) : undefined;
}
