import { getDb } from '../connection';

export function ensureHandoffTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS handoff_intents (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

export function persistHandoffIntent(runId: string, action: string): void {
  ensureHandoffTable();
  getDb()
    .query(`INSERT INTO handoff_intents (id, run_id, action, created_at) VALUES ($id, $runId, $action, $createdAt)`)
    .run({
      $id: `${runId}:${action}:${Date.now()}`,
      $runId: runId,
      $action: action,
      $createdAt: new Date().toISOString(),
    });
}
