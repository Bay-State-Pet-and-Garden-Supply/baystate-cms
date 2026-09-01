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
}

export function computeRequestHash(itemIds: string[]): string {
  const sorted = [...itemIds].sort();
  const canonical = JSON.stringify(sorted);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
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
}): OperationReceipt {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  if (!input.requestHash) throw new Error('requestHash is required');
  const hash = input.requestHash;
  db.run(
    `INSERT INTO onboarding_operation_receipts (id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.workspaceId, input.batchId, input.operation, input.principal, input.role, now, input.idempotencyKey ?? null, hash, input.detailsJson ?? null],
  );
  const row = db.query('SELECT * FROM onboarding_operation_receipts WHERE id = ?').get(id) as ReceiptRow;
  return mapRow(row);
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
