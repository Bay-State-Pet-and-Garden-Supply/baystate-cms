/**
 * Production SQLite persistence repository for Specialist Orchestrator workflows (epic #47, issue #56).
 *
 * Persists phase transitions, capability invocation IDs, extraction artifact references,
 * step events, route records, and usage ledgers to SQLite for auditability, inspection,
 * and crash recovery.
 */
import { getDb } from '../connection';
import type {
  SpecialistWorkflowRecord,
  SpecialistWorkflowPersistenceRepository,
} from '../../product-intelligence/workflow/orchestrator';

function ensureTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS product_intelligence_specialist_workflows (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      status TEXT NOT NULL,
      current_phase TEXT NOT NULL,
      retries_count INTEGER NOT NULL,
      total_dispatches INTEGER NOT NULL,
      product_seed_json TEXT NOT NULL,
      invocations_json TEXT NOT NULL,
      capability_invocations_json TEXT NOT NULL,
      extraction_artifact_refs_json TEXT NOT NULL,
      route_records_json TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      step_events_json TEXT NOT NULL,
      artifact_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pi_specialist_workflows_workspace
      ON product_intelligence_specialist_workflows(workspace_id, status, updated_at);
  `);
}

export class SqliteSpecialistWorkflowRepository implements SpecialistWorkflowPersistenceRepository {
  public constructor() {
    ensureTable();
  }

  public save(record: SpecialistWorkflowRecord): void {
    ensureTable();
    const db = getDb();
    db.query(`
      INSERT INTO product_intelligence_specialist_workflows (
        run_id, workflow_id, workspace_id, workflow_version, status, current_phase,
        retries_count, total_dispatches, product_seed_json, invocations_json,
        capability_invocations_json, extraction_artifact_refs_json, route_records_json,
        usage_json, step_events_json, artifact_ids_json, created_at, updated_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        current_phase = excluded.current_phase,
        retries_count = excluded.retries_count,
        total_dispatches = excluded.total_dispatches,
        product_seed_json = excluded.product_seed_json,
        invocations_json = excluded.invocations_json,
        capability_invocations_json = excluded.capability_invocations_json,
        extraction_artifact_refs_json = excluded.extraction_artifact_refs_json,
        route_records_json = excluded.route_records_json,
        usage_json = excluded.usage_json,
        step_events_json = excluded.step_events_json,
        artifact_ids_json = excluded.artifact_ids_json,
        updated_at = excluded.updated_at,
        error = excluded.error
    `).run(
      record.runId,
      record.workflowId,
      record.workspaceId,
      record.workflowVersion,
      record.status,
      record.currentPhase,
      record.retriesCount,
      record.totalDispatches,
      JSON.stringify(record.productSeed),
      JSON.stringify(record.invocations),
      JSON.stringify(record.capabilityInvocationIds),
      JSON.stringify(record.extractionArtifactRefs),
      JSON.stringify(record.routeRecords),
      JSON.stringify(record.usage),
      JSON.stringify(record.stepEvents),
      JSON.stringify(record.artifactIds),
      record.createdAt,
      record.updatedAt,
      record.error ?? null,
    );
  }

  public get(runId: string): SpecialistWorkflowRecord | null {
    ensureTable();
    const db = getDb();
    const row = db.query('SELECT * FROM product_intelligence_specialist_workflows WHERE run_id = ?').get(runId) as any;
    if (!row) return null;

    return {
      runId: row.run_id,
      workflowId: row.workflow_id,
      workspaceId: row.workspace_id,
      workflowVersion: row.workflow_version,
      status: row.status,
      currentPhase: row.current_phase,
      retriesCount: row.retries_count,
      totalDispatches: row.total_dispatches,
      productSeed: JSON.parse(row.product_seed_json),
      invocations: JSON.parse(row.invocations_json),
      capabilityInvocationIds: JSON.parse(row.capability_invocations_json),
      extractionArtifactRefs: JSON.parse(row.extraction_artifact_refs_json),
      routeRecords: JSON.parse(row.route_records_json),
      usage: JSON.parse(row.usage_json),
      stepEvents: JSON.parse(row.step_events_json),
      artifactIds: JSON.parse(row.artifact_ids_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      error: row.error ?? undefined,
    };
  }
}

export function specialistWorkflowPersistence(): SpecialistWorkflowPersistenceRepository {
  return new SqliteSpecialistWorkflowRepository();
}
