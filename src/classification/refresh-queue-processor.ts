import { getDb } from '../db/connection';
import { curateItemWithPipeline } from '../onboarding/product-curator';

/**
 * Processes pending rows in the classification_refresh_queue.
 * For each queued refresh, re-runs the classification pipeline
 * for the affected product SKU. Skips deferred items.
 *
 * Returns the count of successfully processed refreshes.
 */
export async function processRefreshQueue(
  workspaceId: string,
  workspacePath: string,
): Promise<number> {
  const db = getDb();
  let processed = 0;

  const rows = db.query(
    `SELECT rq.* FROM classification_refresh_queue rq
     WHERE rq.workspace_id = ? AND rq.status = 'queued'
     AND NOT EXISTS (
       SELECT 1 FROM classification_refresh_deferrals d
       WHERE d.refresh_queue_id = rq.id
     )
     LIMIT 50`,
  ).all(workspaceId) as Record<string, any>[];

  for (const row of rows) {
    const sku = String(row.product_sku);
    try {
      const itemRow = db.query(
        'SELECT * FROM onboarding_items WHERE upc = ? AND status NOT IN (?, ?) ORDER BY created_at DESC LIMIT 1',
      ).get(sku, 'promoted', 'skipped') as Record<string, any> | undefined;

      if (!itemRow) {
        db.run(
          "UPDATE classification_refresh_queue SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?",
          ['No active onboarding item found for SKU', new Date().toISOString(), row.id],
        );
        continue;
      }

      // Build a minimal onboarding item for curateItemWithPipeline
      const item = {
        id: String(itemRow.id),
        batchId: String(itemRow.batch_id),
        upc: sku,
        name: String(itemRow.name),
        price: itemRow.price ? String(itemRow.price) : null,
        quantity: itemRow.quantity ? Number(itemRow.quantity) : null,
        brandHint: itemRow.brand_hint ? String(itemRow.brand_hint) : null,
        departmentHint: itemRow.department_hint ? String(itemRow.department_hint) : null,
        sourceUrl: itemRow.source_url ? String(itemRow.source_url) : null,
        status: String(itemRow.status),
        errorMessage: itemRow.error_message ? String(itemRow.error_message) : null,
        retryCount: Number(itemRow.retry_count ?? 0),
        isDuplicate: Number(itemRow.is_duplicate) === 1,
        existingSku: itemRow.existing_sku ? String(itemRow.existing_sku) : null,
        extractionData: itemRow.extraction_data_json
          ? JSON.parse(String(itemRow.extraction_data_json))
          : null,
        curationData: itemRow.curation_data_json
          ? JSON.parse(String(itemRow.curation_data_json))
          : null,
        rowNumber: Number(itemRow.row_number ?? 0),
        createdAt: String(itemRow.created_at),
        updatedAt: String(itemRow.updated_at),
      };

      const curationData = await curateItemWithPipeline(item as any, workspacePath, workspaceId);

      // Persist the updated curation data so the Review UI reflects changes
      try {
        db.query('UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(curationData),
          new Date().toISOString(),
          item.id,
        );
      } catch (persistErr: any) {
        console.error(`[RefreshQueue] Failed to persist curation data for ${sku}: ${persistErr.message}`);
      }

      db.run(
        "UPDATE classification_refresh_queue SET status = 'completed', completed_at = ? WHERE id = ?",
        [new Date().toISOString(), row.id],
      );
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.run(
        "UPDATE classification_refresh_queue SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?",
        [msg, new Date().toISOString(), row.id],
      );
    }
  }

  return processed;
}
