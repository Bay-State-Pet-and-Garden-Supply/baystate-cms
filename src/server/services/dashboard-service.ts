import { getDb } from '../../db/connection';

export interface DashboardStatsData {
  metrics: {
    totalProducts: number;
    syncedProducts: number;
    notSyncedProducts: number;
    driftedProducts: number;
    draftChangeSets: number;
    openDrifts: number;
    productsWithWarnings: number;
    customFieldsCount: number;
  };
  connection: {
    cgiBaseUrl: string;
    merchantId: string;
    lastTestedAt: string | null;
    lastTestStatus: string | null;
    lastTestError: string | null;
  } | null;
  recentSyncJobs: Array<{
    id: string;
    changeSetId: string | null;
    kind: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    productCount: number;
    errorSummary: string | null;
  }>;
  recentActivities: Array<{
    id: string;
    entityType: string;
    entityId: string;
    action: string;
    message: string;
    detailsJson: string | null;
    createdAt: string;
  }>;
}

export function getDashboardStatsData(workspaceId: string): DashboardStatsData {
  const db = getDb();

  // 1. Total products
  const productCountRow = db.query('SELECT COUNT(*) as count FROM product_index').get() as { count: number };
  const totalProducts = productCountRow?.count ?? 0;

  // 2. Products by sync status
  const syncedCountRow = db.query("SELECT COUNT(*) as count FROM product_index WHERE sync_status = 'synced'").get() as { count: number };
  const syncedProducts = syncedCountRow?.count ?? 0;

  const notSyncedCountRow = db.query("SELECT COUNT(*) as count FROM product_index WHERE sync_status = 'not_synced'").get() as { count: number };
  const notSyncedProducts = notSyncedCountRow?.count ?? 0;

  const driftedCountRow = db.query("SELECT COUNT(*) as count FROM product_index WHERE sync_status = 'drifted'").get() as { count: number };
  const driftedProducts = driftedCountRow?.count ?? 0;

  // 3. Draft change sets
  const draftChangeSetsRow = db.query("SELECT COUNT(*) as count FROM change_sets WHERE status = 'draft'").get() as { count: number };
  const draftChangeSets = draftChangeSetsRow?.count ?? 0;

  // 4. Open drift items count
  const openDriftRow = db.query("SELECT COUNT(*) as count FROM remote_drift WHERE status = 'open'").get() as { count: number };
  const openDrifts = openDriftRow?.count ?? 0;

  // 5. Recent sync jobs
  const syncJobsRows = db.query("SELECT * FROM sync_jobs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 5").all(workspaceId) as any[];

  // 6. Recent activity feed from audit_log
  const activityRows = db.query("SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 10").all(workspaceId) as any[];

  // 7. Products with warnings
  const warningsRow = db.query("SELECT COUNT(*) as count FROM product_index WHERE has_warnings = 1").get() as { count: number };
  const productsWithWarnings = warningsRow?.count ?? 0;

  // 8. Custom fields registered
  const customFieldsRow = db.query("SELECT COUNT(*) as count FROM field_registry WHERE workspace_id = ?").get(workspaceId) as { count: number };
  const customFieldsCount = customFieldsRow?.count ?? 0;

  // 9. Connection details
  const connectionRow = db.query("SELECT cgi_base_url, merchant_id, last_tested_at, last_test_status, last_test_error FROM shopsite_connection WHERE workspace_id = ?").get(workspaceId) as any;
  const connection = connectionRow ? {
    cgiBaseUrl: connectionRow.cgi_base_url,
    merchantId: connectionRow.merchant_id,
    lastTestedAt: connectionRow.last_tested_at,
    lastTestStatus: connectionRow.last_test_status,
    lastTestError: connectionRow.last_test_error
  } : null;

  return {
    metrics: {
      totalProducts,
      syncedProducts,
      notSyncedProducts,
      driftedProducts,
      draftChangeSets,
      openDrifts,
      productsWithWarnings,
      customFieldsCount
    },
    connection,
    recentSyncJobs: syncJobsRows.map(row => ({
      id: String(row.id),
      changeSetId: row.change_set_id ? String(row.change_set_id) : null,
      kind: String(row.kind),
      status: String(row.status),
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
      productCount: Number(row.product_count),
      errorSummary: row.error_summary ? String(row.error_summary) : null,
    })),
    recentActivities: activityRows.map(row => ({
      id: String(row.id),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      action: String(row.action),
      message: String(row.message),
      detailsJson: row.details_json ? String(row.details_json) : null,
      createdAt: String(row.created_at)
    }))
  };
}
