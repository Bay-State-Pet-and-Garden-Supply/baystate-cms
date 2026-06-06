import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

export interface ValidationResultRow {
  id: string;
  scopeType: string;
  scopeId: string;
  severity: string;
  code: string;
  message: string;
  fieldPath: string | null;
  createdAt: string;
}

export function addValidationResult(result: Omit<ValidationResultRow, 'id' | 'createdAt'>): ValidationResultRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO validation_results (id, scope_type, scope_id, severity, code, message, field_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, result.scopeType, result.scopeId, result.severity, result.code, result.message, result.fieldPath, now],
  );
  return { id, ...result, createdAt: now };
}

export function listValidationResults(scopeType: string, scopeId: string): ValidationResultRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM validation_results WHERE scope_type = ? AND scope_id = ? ORDER BY created_at ASC',
  ).all(...[scopeType, scopeId]) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function clearValidationResults(scopeType: string, scopeId: string): void {
  const db = getDb();
  db.run('DELETE FROM validation_results WHERE scope_type = ? AND scope_id = ?', [scopeType, scopeId]);
}

export function hasBlockers(scopeType: string, scopeId: string): boolean {
  const db = getDb();
  const row = db.query(
    'SELECT COUNT(*) as cnt FROM validation_results WHERE scope_type = ? AND scope_id = ? AND severity = ?',
  ).get(...[scopeType, scopeId, 'blocker']) as { cnt: number };
  return row.cnt > 0;
}

function mapRow(row: Record<string, unknown>): ValidationResultRow {
  return {
    id: String(row.id),
    scopeType: String(row.scope_type),
    scopeId: String(row.scope_id),
    severity: String(row.severity),
    code: String(row.code),
    message: String(row.message),
    fieldPath: row.field_path ? String(row.field_path) : null,
    createdAt: String(row.created_at),
  };
}
