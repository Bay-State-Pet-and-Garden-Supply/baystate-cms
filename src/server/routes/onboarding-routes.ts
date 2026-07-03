import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import {
  createBatch,
  findBatchById,
  listBatches,
  deleteBatch,
  isBatchComplete,
  setBatchArchived,
} from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  findItemById,
  updateItemSourceUrl,
  setDiscoverySourceUrl,
  listItemsByBatchStaged,
  advanceItemsToNextStage,
  updateItemStageStatus,
  completeReviewStage,
  completePromotionStage,
  resetItemsToPending,
  resetItemsToStage,
  skipItems,
} from '../../db/repositories/onboarding-item-repo';
import type { PipelineStage } from '../../shared/schemas/onboarding';
import {
  listSourcesByItem,
  selectSource
} from '../../db/repositories/onboarding-source-repo';
import {
  getLatestExtraction
} from '../../db/repositories/onboarding-extraction-repo';
import {
  upsertApiKey,
  getApiKey,
  listApiKeys,
  deleteApiKey
} from '../../db/repositories/api-key-repo';
import {
  listAllBrandSites,
  deleteBrandSite,
  findBrandSites,
  upsertBrandSite,
  updateBrandSiteDomain
} from '../../db/repositories/brand-site-repo';
import {
  listAllProfiles,
  upsertProfile,
  deleteProfile,
  findProfileByDomain
} from '../../db/repositories/extractor-profile-repo';
import {
  listLlmTaskConfigs,
  getLlmTaskConfig,
  upsertLlmTaskConfig,
  deleteLlmTaskConfig,
  LLM_TASKS,
} from '../../db/repositories/llm-task-config-repo';
import {
  listAllProfileGenerations,
  listProfileGenerationsByDomain,
  findProfileGenerationById,
  insertProfileGeneration,
  deleteProfileGeneration,
} from '../../db/repositories/profile-generation-repo';
import {
  findProfileGenerationRevisionById,
  listRevisionsByGeneration,
  updateRevisionSelectors,
  updateProfileGenerationRevisionStatus,
} from '../../db/repositories/profile-generation-revision-repo';
import {
  listFieldDecisionsByDomain,
  findProfileFieldDecisionById,
} from '../../db/repositories/profile-generation-field-decision-repo';
import {
  listDomainProfileGovernance,
  createInitialRevisionForGeneration,
  validateRevisionAcrossConfirmedSamples,
  reviseProfileFromStructuredFeedback,
  approveRevisionFields,
  rejectRevisionFields,
  rollbackProfileFieldBy,
  listAllActiveProfiles,
  listFieldDecisionsForGeneration,
  listValidationResultsForRevision,
} from '../../onboarding/profile-governance-service';
import {
  type SelectorKey,
} from '../../onboarding/profile-promoter';
import {
  LlmTaskConfigUpsertSchema,
  ApprovedSelectorFieldsSchema,
  ApproveRevisionFieldsRequestSchema,
  RejectRevisionFieldsRequestSchema,
  RollbackFieldRequestSchema,
  ReviseFromFeedbackRequestSchema,
  ValidateRevisionRequestSchema,
  SELECTOR_FIELDS,
  type LlmTask,
  type SelectorField,
  type StructuredFeedback,
  type ProfileBlockedItem,
} from '../../shared/schemas/onboarding';
import {
  SnapshotRequestSchema,
  ValidateRequestSchema,
  GenerateSelectorRequestSchema,
  PickElementRequestSchema,
} from '../../shared/schemas/extraction-worker';
import { parseSpreadsheet, detectColumnMapping, applyColumnMapping } from '../../onboarding/spreadsheet-parser';
import { matchExistingBrand } from '../../shared/brand-matcher';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { getDomainDiagnosticsResponse } from '../../onboarding/domain-diagnostics-service';
import {
  getWorkerHealth,
  snapshotPage,
  validateProfile,
  generateSelectorFromElement,
  pickElement,
} from '../extraction-worker-client';
import { upsertDomainConfig, DomainConfigUpsertSchema } from '../../onboarding/domain-config-service';
import {
  isProfileGenerationEnabled,
  generateExtractorProfile,
  validateGeneratedProfile,
  buildSeedPreview,
  getMinimizedDom,
} from '../../onboarding/profile-generator';
import { callLlmForTask } from '../../onboarding/llm-client';
import { fetchAndParseSitemap } from '../../onboarding/sitemap-fetcher';
import { listAllSitemapCaches, insertSitemapCache } from '../../db/repositories/sitemap-cache-repo';
import { HTTP_EXTRACTION_HEADERS } from '../../onboarding/page-extractor';
import { promoteItems } from '../../onboarding/draft-promoter';
import { onboardingEvents } from '../../onboarding/sse-emitter';
import { findProductBySku } from '../../db/repositories/product-index-repo';
import { recordDecision, recordHistoryEvent, updateProposalReviewValue } from '../../db/repositories/classification-run-repo';
import { getDb } from '../../db/connection';

const route = new Hono();

// Global map to hold the worker instance for the current workspace
let activeWorker: OnboardingWorker | null = null;

function getWorker(workspaceId: string, workspacePath: string): OnboardingWorker {
  if (!activeWorker) {
    activeWorker = new OnboardingWorker(workspaceId, workspacePath);
    activeWorker.start();
  }
  return activeWorker;
}

// ─── BATCH UPLOAD AND CRUD ──────────────────────────────────────────────────────

/**
 * POST /api/onboarding/batches/upload
 * Parse uploaded file, return headers & auto-detected mappings.
 */
route.post('/onboarding/batches/upload', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  try {
    const body = await c.req.parseBody();
    const file = body.file as File;
    if (!file) {
      return c.json({ error: 'No file uploaded' }, 400);
    }

    const buffer = await file.arrayBuffer();
    const parsed = parseSpreadsheet(buffer, file.name);
    const mapping = detectColumnMapping(parsed.headers);

    return c.json({
      fileName: file.name,
      headers: parsed.headers,
      mapping,
      rowsCount: parsed.totalRows,
      // Store temporary parsed rows in response so the frontend can send them back with the finalized mapping
      tempRows: parsed.rows
    });
  } catch (err) {
    console.error('[OnboardingRoutes] Upload failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/onboarding/batches
 * Confirms mapping and creates the onboarding batch & item queue.
 */
route.post('/onboarding/batches', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  try {
    const { name, fileName, mapping, rows, brandMappings } = await c.req.json();
    if (!name || !fileName || !mapping || !rows) {
      return c.json({ error: 'Missing batch info, mapping, or rows' }, 400);
    }

    const { valid, errors } = applyColumnMapping(rows, mapping);
    if (valid.length === 0) {
      return c.json({ error: 'No valid rows to import. Please check your mapping.', validationErrors: errors }, 400);
    }

    // Fetch all existing brand names to match against register names
    const existingBrands = listAllBrandSites().map(b => b.brandName);

    // Check duplicate UPCs against existing catalog and skip already existing ones
    const finalItems = [];
    for (const item of valid) {
      const existingProduct = findProductBySku(item.upc);
      if (existingProduct) {
        continue;
      }

      let assignedBrandHint = item.brandHint;
      if (!assignedBrandHint) {
        const matched = matchExistingBrand(item.name, existingBrands);
        if (matched) {
          assignedBrandHint = matched;
        }
      }

      finalItems.push({
        ...item,
        brandHint: assignedBrandHint,
        isDuplicate: false,
        existingSku: null,
      });
    }

    if (finalItems.length === 0) {
      return c.json({ error: 'All products in this spreadsheet already exist in the catalog.', validationErrors: errors }, 400);
    }

    // Save/upsert brand mappings to database if provided
    if (brandMappings && typeof brandMappings === 'object') {
      const db = getDb();
      db.transaction(() => {
        for (const [brand, domain] of Object.entries(brandMappings)) {
          if (brand && domain && typeof domain === 'string' && domain.trim()) {
            upsertBrandSite(brand, domain.trim());
          }
        }
      })();
    }

    const batch = createBatch({
      workspaceId: workspace.id,
      name,
      fileName,
      totalItems: finalItems.length,
      columnMappingJson: JSON.stringify(mapping),
    });

    insertItems(batch.id, finalItems);

    return c.json({ batch, validationErrors: errors });
  } catch (err) {
    console.error('[OnboardingRoutes] Create batch failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/onboarding/batches
 * List all batches.
 */
route.get('/onboarding/batches', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  // Ensure worker is running for the active workspace
  getWorker(workspace.id, workspace.workspacePath);

  const batches = listBatches(workspace.id);
  return c.json({ batches });
});

/**
 * GET /api/onboarding/batches/:id
 * Get single batch details.
 */
route.get('/onboarding/batches/:id', async (c) => {
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  return c.json({ batch });
});

/**
 * DELETE /api/onboarding/batches/:id
 * Delete a batch.
 */
route.delete('/onboarding/batches/:id', async (c) => {
  const batchId = c.req.param('id');
  const deleted = deleteBatch(batchId);
  if (!deleted) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  return c.json({ success: true });
});

/**
 * GET /api/onboarding/batches/:id/items
 * List items in a batch.
 */
route.get('/onboarding/batches/:id/items', async (c) => {
  const batchId = c.req.param('id');
  const status = c.req.query('status');

  const items = listItemsByBatch(batchId, status ? (status as any) : undefined);
  return c.json({ items });
});

/**
 * POST /api/onboarding/batches/:id/bulk-brand
 * Bulk assign a brand and domain to multiple items in a batch.
 */
route.post('/onboarding/batches/:id/bulk-brand', async (c) => {
  const batchId = c.req.param('id');
  const { itemIds, brandHint, brandDomain } = await c.req.json();
  const db = getDb();

  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  db.transaction(() => {
    // 1. Update brand_hint for all items
    const placeholders = itemIds.map(() => '?').join(', ');
    db.query(`UPDATE onboarding_items SET brand_hint = ? WHERE id IN (${placeholders})`)
      .run(brandHint ? brandHint.trim() : null, ...itemIds);

    // 2. If domain is provided, update/upsert brand site domain mapping
    if (brandHint && brandHint.trim() && brandDomain && brandDomain.trim()) {
      updateBrandSiteDomain(brandHint.trim(), brandDomain.trim());
    }
  })();

  return c.json({ success: true });
});

// ─── STAGE-BASED PIPELINE ENDPOINTS ─────────────────────────────────────────────

/**
 * GET /api/onboarding/batches/:id/staged
 * Returns items grouped by stage for the Kanban Pipeline Board.
 */
route.get('/onboarding/batches/:id/staged', (c) => {
  const batchId = c.req.param('id');
  const staged = listItemsByBatchStaged(batchId);
  return c.json({ staged });
});

/**
 * POST /api/onboarding/items/advance
 * Advances selected items to the next pipeline stage.
 * Body: { itemIds: string[] }
 * Only advances items with stage_status = 'completed'.
 */
route.post('/onboarding/items/advance', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const { itemIds } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  const result = advanceItemsToNextStage(itemIds);

  // Trigger worker to pick up newly pending items
  const worker = getWorker(workspace.id, workspace.workspacePath);
  worker.poll();

  return c.json(result);
});

/**
 * POST /api/onboarding/items/reset
 * Resets selected items to pending in their current stage (retry).
 * Body: { itemIds: string[] }
 */
route.post('/onboarding/items/reset', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const { itemIds } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  resetItemsToPending(itemIds);

  const worker = getWorker(workspace.id, workspace.workspacePath);
  worker.poll();

  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/reset-to-stage
 * Moves items to a specific pipeline stage with 'completed' status,
 * preserving extraction/curation data. The worker won't re-process them.
 * Body: { itemIds: string[], targetStage: string }
 */
route.post('/onboarding/items/reset-to-stage', async (c) => {
  const { itemIds, targetStage } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }
  if (!targetStage || typeof targetStage !== 'string') {
    return c.json({ error: 'targetStage string is required' }, 400);
  }
  const validStages = ['discovery', 'extraction', 'curation', 'review', 'promotion'];
  if (!validStages.includes(targetStage)) {
    return c.json({ error: `Invalid stage: ${targetStage}` }, 400);
  }

  const result = resetItemsToStage(itemIds, targetStage as PipelineStage);
  return c.json({ success: true, reset: result.reset });
});

/**
 * POST /api/onboarding/items/skip-bulk
 * Marks items as skipped in their current stage.
 * Body: { itemIds: string[] }
 */
route.post('/onboarding/items/skip-bulk', async (c) => {
  const { itemIds } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  skipItems(itemIds);
  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/review-complete
 * Marks review-stage items as completed (stage_status = 'completed').
 * Body: { itemIds: string[] }
 */
route.post('/onboarding/items/review-complete', async (c) => {
  const { itemIds } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  for (const id of itemIds) {
    completeReviewStage(id);
  }
  return c.json({ success: true, count: itemIds.length });
});

/**
 * POST /api/onboarding/batches/:id/promote
 * Promotes promotion-stage items to CMS product drafts.
 * Marks items as stage_status='completed' on success, 'failed' on error.
 */
route.post('/onboarding/batches/:id/promote', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const batchId = c.req.param('id');
  const { itemIds } = await c.req.json();
  if (!itemIds || !Array.isArray(itemIds)) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  try {
    // Validate items are in promotion stage
    const db = getDb();
    const invalid = db.query(
      `SELECT COUNT(*) as count FROM onboarding_items WHERE id IN (${itemIds.map(() => '?').join(',')}) AND stage != 'promotion'`
    ).all(...itemIds) as Array<{ count: number }>;
    if (invalid.length > 0 && invalid[0].count > 0) {
      return c.json({ error: 'All items must be in the promotion stage' }, 400);
    }

    const result = await promoteItems(workspace.id, workspace.workspacePath, batchId, itemIds);

    // Mark promoted items as completed in promotion stage
    db.transaction(() => {
      for (const id of itemIds) {
        completePromotionStage(id, true);
      }
    })();

    // Archive batch if all items are done
    if (isBatchComplete(batchId)) {
      setBatchArchived(batchId, true);
    }

    return c.json(result);
  } catch (err) {
    console.error('[OnboardingRoutes] Promotion failed:', err);

    // Mark items as failed
    const db = getDb();
    for (const id of itemIds) {
      completePromotionStage(id, false, err instanceof Error ? err.message : String(err));
    }

    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ─── SSE STREAM ─────────────────────────────────────────────────────────────────

/**
 * GET /api/onboarding/batches/:id/events
 * Streams real-time progress for a batch.
 */
route.get('/onboarding/batches/:id/events', async (c) => {
  const batchId = c.req.param('id');
  const workspace = findWorkspace();
  if (workspace) {
    getWorker(workspace.id, workspace.workspacePath);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  c.header('Content-Encoding', 'identity');
  c.header('X-Content-Type-Options', 'nosniff');

  return streamSSE(c, async (stream) => {
    const unsubscribe = onboardingEvents.subscribe(batchId, async (event) => {
      try {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
      } catch (err) {
        console.warn(`[SSE] Failed to write event to batch ${batchId}:`, err);
      }
    });

    // Send initial heart beat/welcome message
    await stream.writeSSE({
      event: 'welcome',
      data: JSON.stringify({ message: 'SSE connection established', batchId }),
    });

    // Cleanup on disconnect
    stream.onAbort(() => {
      unsubscribe();
      console.log(`[SSE] Disconnected from batch ${batchId}`);
    });

    // Keep connection alive with periodic pings every 15s
    while (true) {
      await new Promise(r => setTimeout(r, 15000));
      try {
        await stream.writeSSE({
          event: 'ping',
          data: JSON.stringify({ time: new Date().toISOString() }),
        });
      } catch {
        break;
      }
    }
  });
});

// ─── INDIVIDUAL ITEM ACTIONS ────────────────────────────────────────────────────

/**
 * GET /api/onboarding/items/:id
 * Get full details of an item (including sources & latest extraction).
 */
route.get('/onboarding/items/:id', async (c) => {
  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }

  const sources = listSourcesByItem(itemId);
  const extraction = getLatestExtraction(itemId);

  return c.json({
    item,
    sources,
    extraction: extraction ? JSON.parse(extraction.extraction_data_json) : null
  });
});

/**
 * PUT /api/onboarding/items/:id
 * Update item details (allows overriding price, title, category, extraction_data_json).
 */
route.put('/onboarding/items/:id', async (c) => {
  const itemId = c.req.param('id');
  const body = await c.req.json();
  const db = getDb();

  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }

  db.transaction(() => {
    if (body.name) {
      db.query('UPDATE onboarding_items SET name = ? WHERE id = ?').run(body.name, itemId);
    }
    if (body.price !== undefined) {
      db.query('UPDATE onboarding_items SET price = ? WHERE id = ?').run(body.price, itemId);
    }
    if (body.source_url !== undefined) {
      db.query('UPDATE onboarding_items SET source_url = ? WHERE id = ?').run(body.source_url, itemId);
    }
    if (body.status) {
      db.query('UPDATE onboarding_items SET status = ? WHERE id = ?').run(body.status, itemId);
    }
    if (body.brandHint !== undefined) {
      const oldBrandHint = item.brandHint;
      db.query('UPDATE onboarding_items SET brand_hint = ? WHERE id = ?').run(body.brandHint, itemId);
      
      if (body.propagateBrandName && oldBrandHint && oldBrandHint.trim()) {
        db.query('UPDATE onboarding_items SET brand_hint = ? WHERE batch_id = ? AND brand_hint = ?').run(body.brandHint, item.batchId, oldBrandHint);
      }
    }
    if (body.brandDomain !== undefined) {
      const activeBrand = body.brandHint !== undefined ? body.brandHint : item.brandHint;
      if (activeBrand && activeBrand.trim() && body.brandDomain !== null) {
        updateBrandSiteDomain(activeBrand, body.brandDomain.trim());
      }
    }
    if (body.extraction_data) {
      db.query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(
        JSON.stringify(body.extraction_data),
        itemId
      );
    }
    if (body.curation_data) {
      db.query('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?').run(
        JSON.stringify(body.curation_data),
        itemId
      );
    }
  })();

  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/:id/decisions
 * Record classification proposal decisions for an onboarding item.
 */
route.post('/onboarding/items/:id/decisions', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const itemId = c.req.param('id');
  const body = await c.req.json();

  const { decisions } = body;
  if (!decisions || !Array.isArray(decisions)) {
    return c.json({ error: 'decisions array is required' }, 400);
  }

  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }

  try {
    const db = getDb();

    // Bulk validation: only explicit bulk-accept calls require every proposal to
    // be marked bulk-acceptable. The review drawer submits multiple individual
    // decisions at once, including manually revised values.
    if (body.bulk === true && decisions.length > 1) {
      const proposalIds = decisions.map((d: any) => d.proposalId);
      const existing = db.query(
        'SELECT id, is_bulk_acceptable FROM classification_proposals WHERE id IN (' +
        proposalIds.map(() => '?').join(',') + ')'
      ).all(...proposalIds) as Record<string, any>[];

      for (const row of existing) {
        if (!Number(row.is_bulk_acceptable)) {
          return c.json({
            error: `Proposal ${row.id} is not eligible for bulk acceptance. Use individual review instead.`,
          }, 400);
        }
      }
    }

    db.transaction(() => {
      for (const d of decisions) {
        if (Object.prototype.hasOwnProperty.call(d, 'proposedValue')) {
          updateProposalReviewValue(
            d.proposalId,
            d.proposedValue,
            Object.prototype.hasOwnProperty.call(d, 'targetId') ? d.targetId ?? null : undefined,
          );
        }
        recordDecision({
          id: d.id || '',
          proposalId: d.proposalId,
          decision: d.decision,
          revisedFromId: d.revisedFromId ?? null,
          reviewerId: d.reviewerId ?? null,
          reviewerNote: d.reviewerNote ?? null,
          createdAt: new Date().toISOString(),
        });
        recordHistoryEvent(
          workspace.id,
          item.upc,
          'proposal_decision',
          { proposalId: d.proposalId, decision: d.decision, proposedValue: d.proposedValue ?? null, targetId: d.targetId ?? null },
          undefined,
          d.proposalId,
          d.id,
        );
      }
    })();

    // Mark the review stage as completed (stage-based)
    db.query(
      "UPDATE onboarding_items SET status = 'ready', stage_status = 'completed', updated_at = ? WHERE id = ? AND stage = 'review'",
    ).run(new Date().toISOString(), itemId);

    return c.json({ success: true, count: decisions.length });
  } catch (err) {
    console.error('[OnboardingRoutes] Record decisions failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/onboarding/items/:id/retry
 * Reset an item's stage_status to 'pending' to let the background worker try again.
 * Uses stage-based reset instead of legacy status field.
 */
route.post('/onboarding/items/:id/retry', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }

  const db = getDb();
  db.query('UPDATE onboarding_items SET stage_status = ?, status = ?, retry_count = 0, error_message = NULL WHERE id = ?').run(
    'pending',
    item.stage === 'discovery' ? 'imported' : 'source_confirmed',
    itemId
  );

  // Trigger worker polling
  const worker = getWorker(workspace.id, workspace.workspacePath);
  worker.poll();

  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/:id/select-source
 * Confirms a selected discovery source candidate.
 */
route.post('/onboarding/items/:id/select-source', async (c) => {
  const itemId = c.req.param('id');
  const { sourceId } = await c.req.json();
  if (!sourceId) {
    return c.json({ error: 'sourceId is required' }, 400);
  }

  const sources = listSourcesByItem(itemId);
  const selected = sources.find(s => s.id === sourceId);
  if (!selected) {
    return c.json({ error: 'Source candidate not found' }, 404);
  }

  selectSource(sourceId);
  setDiscoverySourceUrl(itemId, selected.url);

  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/:id/set-url
 * Manually set the URL for an onboarding item.
 */
route.post('/onboarding/items/:id/set-url', async (c) => {
  const itemId = c.req.param('id');
  const { url } = await c.req.json();
  if (!url) {
    return c.json({ error: 'url is required' }, 400);
  }

  try {
    new URL(url);
  } catch {
    return c.json({ error: 'Invalid URL format' }, 400);
  }

  setDiscoverySourceUrl(itemId, url);
  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/:id/skip
 * Marks item as skipped in its current stage (stage-based).
 */
route.post('/onboarding/items/:id/skip', (c) => {
  const itemId = c.req.param('id');
  skipItems([itemId]);
  return c.json({ success: true });
});

// ─── DEPRECATED BATCH LIFECYCLE ROUTES ─────────────────────────────────────────
// These remain for backward compatibility during migration.
// Use /onboarding/items/advance in the new stage-based model.

// ─── API KEYS AND CACHED BRAND SITES SETTINGS ────────────────────────────────────

route.get('/onboarding/settings/api-keys', (c) => {
  const keys = listApiKeys();
  // Redact actual keys for safety
  const redacted = keys.map(k => ({
    id: k.id,
    service: k.service,
    apiKey: k.api_key ? '••••••••' + k.api_key.slice(-4) : '',
    baseUrl: k.base_url,
    model: k.model
  }));
  return c.json({ keys: redacted });
});

const KNOWN_DEEPSEEK_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
];

route.get('/onboarding/settings/ollama/models', async (c) => {
  const row = getApiKey('ollama');
  const storedBaseUrl = row?.base_url || 'http://localhost:11434/v1';

  const queryBaseUrl = c.req.query('baseUrl');
  const baseUrl = (queryBaseUrl || storedBaseUrl).replace(/\/+$/, '');

  const models = new Set<string>();

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: {
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(3000),
    });

    if (res.ok) {
      const data = await res.json() as { data: Array<{ id: string }> };
      if (data && Array.isArray(data.data)) {
        for (const m of data.data) {
          models.add(m.id);
        }
      }
    }
  } catch {
    // If OpenAI-compatible endpoint failed, try Ollama-native endpoint /api/tags
    try {
      const nativeUrl = baseUrl.replace(/\/v1\/?$/, '');
      const nativeRes = await fetch(`${nativeUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (nativeRes.ok) {
        const data = await nativeRes.json() as { models: Array<{ name: string }> };
        if (data && Array.isArray(data.models)) {
          for (const m of data.models) {
            models.add(m.name);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Fallback defaults
  if (models.size === 0) {
    models.add('llama3.2:3b');
    models.add('qwen2.5:3b');
    models.add('qwen2.5vl:latest');
    models.add('llama3.2');
  }

  return c.json({ models: [...models] });
});

route.get('/onboarding/settings/deepseek/models', async (c) => {
  const row = getApiKey('deepseek');
  let apiKey = row?.api_key;
  const storedBaseUrl = row?.base_url || 'https://api.deepseek.com';

  const queryKey = c.req.query('apiKey');
  if (queryKey) {
    apiKey = queryKey;
  }

  const queryBaseUrl = c.req.query('baseUrl');
  const baseUrl = (queryBaseUrl || storedBaseUrl).replace(/\/+$/, '');

  const models = new Set(KNOWN_DEEPSEEK_MODELS);

  if (apiKey) {
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const data = await res.json() as { data: Array<{ id: string }> };
        for (const m of data.data) {
          models.add(m.id);
        }
      }
    } catch {
      // Remote models fetch is best-effort; fall back to known list
    }
  }

  return c.json({ models: [...models] });
});

const KNOWN_OPENAI_MODELS = [
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
  'o4-mini',
  'o3-mini',
];

route.get('/onboarding/settings/openai/models', async (c) => {
  const row = getApiKey('openai');
  let apiKey = row?.api_key;
  const storedBaseUrl = row?.base_url || 'https://api.openai.com/v1';

  const queryKey = c.req.query('apiKey');
  if (queryKey) {
    apiKey = queryKey;
  }

  const queryBaseUrl = c.req.query('baseUrl');
  const baseUrl = (queryBaseUrl || storedBaseUrl).replace(/\/+$/, '');

  const models = new Set(KNOWN_OPENAI_MODELS);

  if (apiKey) {
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const data = await res.json() as { data: Array<{ id: string }> };
        for (const m of data.data) {
          models.add(m.id);
        }
      }
    } catch {
      // Remote models fetch is best-effort; fall back to known list
    }
  }

  return c.json({ models: [...models] });
});

route.put('/onboarding/settings/api-keys/:service', async (c) => {
  const service = c.req.param('service');
  const { apiKey, baseUrl, model } = await c.req.json();
  if (!apiKey) {
    return c.json({ error: 'apiKey is required' }, 400);
  }

  upsertApiKey(service, apiKey, baseUrl, model);
  return c.json({ success: true });
});

route.delete('/onboarding/settings/api-keys/:service', (c) => {
  const service = c.req.param('service');
  deleteApiKey(service);
  return c.json({ success: true });
});

route.get('/onboarding/settings/brand-sites', (c) => {
  const sites = listAllBrandSites();
  const db = getDb();
  
  let brandField = 'ProductField16';
  const registryRow = db.query("SELECT xml_field FROM field_registry WHERE LOWER(label) = 'brand' OR LOWER(xml_field) = 'brand' LIMIT 1").get() as { xml_field: string } | undefined;
  if (registryRow) {
    brandField = registryRow.xml_field;
  }

  let catalogBrands: string[] = [];
  try {
    const queryStr = `
      SELECT DISTINCT json_extract(custom_fields, '$.' || ?) AS brandName 
      FROM product_index 
      WHERE brandName IS NOT NULL AND brandName != ''
      ORDER BY brandName ASC
    `;
    const rows = db.query(queryStr).all(brandField) as { brandName: string }[];
    catalogBrands = rows.map(r => r.brandName.trim());
  } catch (e) {
    console.error('Failed to retrieve catalog brands:', e);
  }

  return c.json({ brandSites: sites, catalogBrands });
});

route.post('/onboarding/settings/brand-sites/resolve', async (c) => {
  try {
    const { brands } = await c.req.json();
    if (!brands || !Array.isArray(brands)) {
      return c.json({ error: 'brands array is required' }, 400);
    }

    const mappings: Record<string, string | null> = {};
    for (const brand of brands) {
      if (!brand) continue;
      const sites = findBrandSites(brand);
      mappings[brand] = sites.length > 0 ? sites[0].domain : null;
    }

    return c.json({ mappings });
  } catch (err) {
    console.error('[OnboardingRoutes] Resolve brand domains failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

route.delete('/onboarding/settings/brand-sites/:id', (c) => {
  const id = c.req.param('id');
  deleteBrandSite(id);
  return c.json({ success: true });
});

route.get('/onboarding/settings/extractor-profiles', (c) => {
  const profiles = listAllProfiles();
  return c.json({ extractorProfiles: profiles });
});

route.post('/onboarding/settings/extractor-profiles', async (c) => {
  try {
    const { domain, titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector, sitemapProductUrlPattern, customSelectors } = await c.req.json();
    if (!domain) {
      return c.json({ error: 'domain is required' }, 400);
    }
    const profile = upsertProfile(domain, {
      titleSelector,
      priceSelector,
      descriptionSelector,
      brandSelector,
      imagesSelector,
      sitemapProductUrlPattern,
      customSelectors,
    });
    return c.json({ success: true, profile });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

route.delete('/onboarding/settings/extractor-profiles/:id', (c) => {
  const id = c.req.param('id');
  deleteProfile(id);
  return c.json({ success: true });
});

/**
 * GET /api/onboarding/settings/domain-diagnostics
 * Read-only aggregate of every known domain's profile, sitemap,
 * health, brand, and generated-profile signals. The handler does
 * not write, delete, or fetch anything; it only reads through the
 * diagnostics repository variants and returns the resulting
 * snapshot. Intended for the Onboarding Settings UI's
 * "Domain Diagnostics" section.
 */
route.get('/onboarding/settings/domain-diagnostics', (c) => {
  return c.json(getDomainDiagnosticsResponse());
});

/**
 * GET /api/onboarding/settings/extraction-worker/health
 * Returns the extraction worker's health and capabilities.
 * Used by the Onboarding Settings UI to show worker status
 * without exposing worker-host details to the frontend.
 */
route.get('/onboarding/settings/extraction-worker/health', async (c) => {
  const health = await getWorkerHealth();
  if (!health) {
    return c.json({
      ok: false,
      capabilities: { playwright: false, crawlee: false, stagehand: false },
      version: 'unavailable',
    });
  }
  return c.json(health);
});

/**
 * POST /api/onboarding/settings/profile-tooling/snapshot
 * Proxies to the extraction worker's snapshot endpoint.
 * Validates request body with SnapshotRequestSchema before forwarding.
 * Returns { ok, data } on success, { ok: false, error } on failure.
 */
route.post('/onboarding/settings/profile-tooling/snapshot', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const parsed = SnapshotRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    }, 400);
  }

  const result = await snapshotPage(parsed.data);
  if (!result.ok) {
    return c.json({
      ok: false,
      error: result.error,
    });
  }
  return c.json({ ok: true, data: result.data });
});

/**
 * POST /api/onboarding/settings/profile-tooling/generate-selector
 * Proxies to the extraction worker's generate-selector endpoint.
 * Accepts pasted element outerHTML + full page HTML, returns a
 * stable CSS selector + extracted text/images preview.
 */
route.post('/onboarding/settings/profile-tooling/generate-selector', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const parsed = GenerateSelectorRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    }, 400);
  }

  const result = await generateSelectorFromElement(parsed.data);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error });
  }
  return c.json({ ok: true, data: result.data });
});

/**
 * POST /api/onboarding/settings/profile-tooling/fetch-html
 * Fetches raw HTML from a URL server-side (avoids CORS issues).
 * Used by the paste-element selector generation flow.
 */
route.post('/onboarding/settings/profile-tooling/fetch-html', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const url = (body as any)?.url;
  if (!url || typeof url !== 'string') {
    return c.json({ ok: false, error: 'url is required' }, 400);
  }

  // Block private/internal IP ranges (SSRF protection)
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('172.') ||
      hostname === '[::1]'
    ) {
      return c.json({ ok: false, error: 'URL points to a private network address' }, 400);
    }
  } catch {
    return c.json({ ok: false, error: 'Invalid URL' }, 400);
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return c.json({ ok: false, error: `HTTP ${response.status}` });
    }
    const html = await response.text();
    return c.json({ ok: true, html });
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * POST /api/onboarding/settings/profile-tooling/pick-element
 * Launches a headful browser for the user to click on an element.
 * Returns the generated selector + extracted preview.
 */
route.post('/onboarding/settings/profile-tooling/pick-element', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const parsed = PickElementRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    }, 400);
  }

  const result = await pickElement(parsed.data);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error });
  }
  return c.json({ ok: true, data: result.data });
});

/**
 * POST /api/onboarding/settings/profile-tooling/validate
 * Proxies to the extraction worker's validate endpoint.
 * Validates request body with ValidateRequestSchema before forwarding.
 * Returns { ok, data } on success, { ok: false, error } on failure.
 */
route.post('/onboarding/settings/profile-tooling/validate', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const parsed = ValidateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    }, 400);
  }

  const result = await validateProfile(parsed.data);
  if (!result.ok) {
    return c.json({
      ok: false,
      error: result.error,
    });
  }
  return c.json({ ok: true, data: result.data });
});

/**
 * GET /api/onboarding/settings/domain-diagnostics/:domain
 * Single-domain diagnostics fetch. Filters full diagnostics by domain,
 * returns entry or 404.
 */
route.get('/onboarding/settings/domain-diagnostics/:domain', (c) => {
  const domain = c.req.param('domain');
  const diagnostics = getDomainDiagnosticsResponse();
  const entry = diagnostics.entries.find(
    (e) => e.domain === domain || e.domain === domain.replace(/^www\./, ''),
  );
  if (!entry) {
    return c.json({ error: 'Domain not found' }, 404);
  }
  return c.json(entry);
});

/**
 * PUT /api/onboarding/settings/domains/:domain
 * Unified domain config: upserts extractor profile selectors and replaces
 * brand associations atomically for a single domain. Returns the updated
 * DomainDiagnosticsEntry for the domain.
 */
route.put('/onboarding/settings/domains/:domain', async (c) => {
  const domain = c.req.param('domain');
  if (!domain) {
    return c.json({ error: 'domain param is required' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = DomainConfigUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }

  try {
    const entry = upsertDomainConfig(domain, parsed.data);
    return c.json({ domain: entry });
  } catch (err) {
    console.error('[OnboardingRoutes] Domain config upsert failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/onboarding/settings/domain-diagnostics/:domain/generate-profile
 * On-demand AI profile generation for a domain. Profiles are
 * domain-scoped (one profile per domain), so this endpoint produces
 * exactly one proposal.
 *
 * Uses a single anchor product URL from the domain's cached sitemap
 * (or a fresh sitemap fetch). If an open (non-rejected, non-failed)
 * proposal already exists for the domain, the existing proposal ID
 * is returned instead of creating a duplicate.
 *
 * Requires SHOPSITE_CMS_PROFILE_GENERATION_ENABLED and
 * an explicit llm_task_configs row for `profile_generation`.
 * Slow path: fetches a remote page and calls an LLM (10–30s).
 */
route.post('/onboarding/settings/domain-diagnostics/:domain/generate-profile', async (c) => {
  const domain = c.req.param('domain');
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

  if (!isProfileGenerationEnabled()) {
    return c.json({
      error: 'Profile generation is disabled. Set SHOPSITE_CMS_PROFILE_GENERATION_ENABLED to enable.',
    }, 400);
  }

  // Dedup: if an open proposal already exists for this domain
  // (non-rejected, non-failed), return it instead of creating
  // a duplicate. Profiles are domain-scoped — one proposal per
  // domain is correct.
  const existingOpen = listProfileGenerationsByDomain(normalizedDomain, {
    orderBy: 'created_at',
    orderDirection: 'DESC',
    limit: 1,
  }).filter(g => g.status !== 'rejected' && g.status !== 'failed');
  if (existingOpen.length > 0) {
    return c.json({
      success: true,
      generationId: existingOpen[0].id,
      existing: true,
      domain: normalizedDomain,
    });
  }

  // Pick a single anchor product URL. Try the cached sitemap first,
  // then a fresh sitemap fetch, then a user-supplied anchor URL.
  let rawUrls: string[] = [];
  const allCaches = listAllSitemapCaches();
  const cache = allCaches.find(row => row.domain === normalizedDomain);
  if (cache && cache.sitemapUrlsCount > 0) {
    rawUrls = cache.urls;
  } else {
    try {
      const sitemapResult = await fetchAndParseSitemap(normalizedDomain);
      if (sitemapResult.urls.length > 0) {
        rawUrls = sitemapResult.urls;
        try { insertSitemapCache(normalizedDomain, sitemapResult.urls, sitemapResult.sourceUrl); } catch { /* best-effort */ }
      }
    } catch (err) {
      console.warn(`[GenerateProfile] Sitemap fetch failed for ${normalizedDomain}:`, err);
    }
  }

  // Allow the client to supply an explicit anchor URL (for domains
  // where the sitemap is stale or the operator wants a specific page).
  let anchorUrl: string | null = null;
  try {
    const body = await c.req.json().catch(() => ({}));
    anchorUrl = (body as { anchorUrl?: string }).anchorUrl ?? null;
  } catch { /* use sitemap only */ }

  // Filter to product-page URLs only.
  const profile = findProfileByDomain(normalizedDomain);
  let urlPattern: RegExp | null = null;
  if (profile?.sitemapProductUrlPattern) {
    try {
      urlPattern = new RegExp(profile.sitemapProductUrlPattern, 'i');
    } catch { /* invalid regex — ignore */ }
  }
  const isProductUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/+$/, '');
      if (path === '' || path === '/') return false;
      if (urlPattern) return urlPattern.test(url);
      return parsed.pathname.startsWith('/products/');
    } catch {
      return false;
    }
  };

  // Resolve the anchor URL: explicit > sitemap > error.
  let resolvedUrl: string;
  if (anchorUrl) {
    resolvedUrl = anchorUrl;
  } else {
    const validUrls = rawUrls.filter(isProductUrl);
    if (validUrls.length === 0) {
      return c.json({
        error: `No product URLs found for ${normalizedDomain}. Run source discovery or supply an anchorUrl in the request body.`,
      }, 400);
    }
    resolvedUrl = validUrls[0];
  }

  try {
    const response = await fetch(resolvedUrl, {
      headers: HTTP_EXTRACTION_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return c.json({
        error: `Failed to fetch ${resolvedUrl}: HTTP ${response.status}`,
      }, 502);
    }
    const html = await response.text();
    const generated = await generateExtractorProfile(resolvedUrl, html, {
      domain: normalizedDomain,
      sourceUrl: resolvedUrl,
    });
    if (!generated) {
      return c.json({
        error: `Profile generation returned null for ${resolvedUrl}. Check that the LLM is configured (Settings → AI Model Routing → profile_generation) and the page HTML is accessible.`,
      }, 500);
    }

    const validation = validateGeneratedProfile(html, generated, {
      domain: normalizedDomain,
      sourceUrl: resolvedUrl,
    });
    const seedPreview = buildSeedPreview(html, generated, resolvedUrl);
    const rec = insertProfileGeneration({
      domain: normalizedDomain,
      sourceUrl: resolvedUrl,
      expectedName: null,
      brandHint: null,
      selectors: generated as unknown as Record<string, unknown>,
      fieldSamples: {
        ...validation.fieldSamples,
        seedPreview,
      } as unknown as Record<string, unknown>,
      validation: {
        valid: validation.valid,
        confidence: validation.confidence,
        status: validation.status,
        reason: validation.reason,
        readyForReview: validation.readyForReview,
      } as unknown as Record<string, unknown>,
      status: 'proposed',
      confidence: validation.confidence,
      llmProvider: null,
      llmModel: null,
      errorMessage: validation.status === 'failed' ? validation.reason : null,
    });

    return c.json({
      success: true,
      generationId: rec.id,
      existing: false,
      domain: normalizedDomain,
      anchorUrl: resolvedUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[GenerateProfile] Failed for ${resolvedUrl}:`, msg);
    return c.json({
      error: `Profile generation failed: ${msg}`,
    }, 500);
  }
});

route.post('/onboarding/extractor-profiles/test', async (c) => {
  let browser;
  try {
    const { url, titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector, shopifyJSONPath, variantSelectionStrategy, customSelectors } = await c.req.json();
    if (!url) {
      return c.json({ error: 'url is required' }, 400);
    }

    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Quick load (30s timeout)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for JS content
    await page.waitForTimeout(1500);

    const customSelectorsJson = JSON.stringify(customSelectors || {});
    const extracted = await page.evaluate((sel: any) => {
      const res: Record<string, string | string[]> = {};
      
      if (sel.titleSelector) {
        res.title = document.querySelector(sel.titleSelector)?.textContent?.trim() || '';
      }
      if (sel.priceSelector) {
        res.price = document.querySelector(sel.priceSelector)?.textContent?.trim() || '';
      }
      if (sel.descriptionSelector) {
        res.description = document.querySelector(sel.descriptionSelector)?.textContent?.trim() || '';
      }
      if (sel.brandSelector) {
        res.brand = document.querySelector(sel.brandSelector)?.textContent?.trim() || '';
      }
      if (sel.imagesSelector) {
        const parseSrcsetCandidates = (srcset: string | null | undefined): string[] => {
          if (!srcset) return [];
          return srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
        };
        const isUsableImageSource = (src: string | null | undefined): src is string => {
          if (!src) return false;
          const trimmed = src.trim();
          if (!trimmed) return false;
          const lower = trimmed.toLowerCase();
          if (lower.startsWith('data:')) return false;
          if (lower.split(/[?#]/)[0].endsWith('.svg')) return false;
          return true;
        };
        const imageSourcesForElement = (el: Element): string[] => {
          const target = el instanceof HTMLImageElement || el instanceof HTMLSourceElement
            ? el
            : el.querySelector('img,source');
          if (!target) return [];
          const sources: string[] = [];
          if (target instanceof HTMLImageElement && isUsableImageSource(target.currentSrc)) sources.push(target.currentSrc.trim());
          for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-image', 'data-zoom-image']) {
            const value = target.getAttribute(attr);
            if (isUsableImageSource(value)) sources.push(value.trim());
          }
          for (const attr of ['srcset', 'data-srcset']) {
            for (const candidate of parseSrcsetCandidates(target.getAttribute(attr))) {
              if (isUsableImageSource(candidate)) sources.push(candidate.trim());
            }
          }
          return sources;
        };
        const seen = new Set<string>();
        res.images = Array.from(document.querySelectorAll(sel.imagesSelector))
          .flatMap(imageSourcesForElement)
          .filter(src => {
            if (seen.has(src)) return false;
            seen.add(src);
            return true;
          });
      }
      return res;
    }, { titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector });

    // Custom selectors — extracted separately to avoid Playwright evaluate type issues
    if (customSelectors) {
      for (const [fieldName, selector] of Object.entries(customSelectors)) {
        if (!selector) continue;
        try {
          const val = await page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            return el?.textContent?.trim() || '';
          }, selector);
          if (val) extracted[fieldName] = val;
        } catch { /* skip bad selectors */ }
      }
    }

    // Shopify productJSON extraction (when flagged)
    let shopifyImages: string[] = [];
    let shopifyVariantOptions: string[] = [];
    if (shopifyJSONPath) {
      try {
        const pj = await page.evaluate(() => {
          const w = window as any;
          const data = w.productJSON || w.ShopifyAnalytics?.product || null;
          if (!data) return null;
          return {
            title: data.title || null,
            images: Array.isArray(data.images) ? data.images.map((i: any) => i.src || i.url || '').filter(Boolean) : [],
            options: Array.isArray(data.options) ? data.options.flatMap((o: any) => Array.isArray(o.values) ? o.values : []) : [],
          };
        });
        if (pj) {
          if (pj.title && !extracted.title) extracted.title = pj.title;
          if (pj.images.length > 0) shopifyImages = pj.images;
          shopifyVariantOptions = pj.options;
        }
      } catch { /* fallback to CSS selectors */ }
    }

    const result: Record<string, any> = { ...extracted };
      if (shopifyVariantOptions.length > 0) result.variantOptions = shopifyVariantOptions;
      if (shopifyImages.length > 0) result.shopifyImages = shopifyImages;
      return c.json({ success: true, extracted: result });
  } catch (err) {
    console.error('[OnboardingRoutes] Custom selector test run failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

/**
 * GET /api/onboarding/products/*
 * Serves product images/assets directly from the active workspace directory.
 */
route.get('/onboarding/products/*', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.text('No active workspace loaded', 400);
  }

  const prefix = '/api/onboarding/';
  const relativePath = c.req.path.slice(prefix.length);

  const absolutePath = path.resolve(workspace.workspacePath, relativePath);
  if (!absolutePath.startsWith(path.resolve(workspace.workspacePath))) {
    return c.text('Forbidden', 403);
  }

  if (!fs.existsSync(absolutePath)) {
    return c.text('File not found', 404);
  }

  try {
    const fileContent = fs.readFileSync(absolutePath);
    const ext = path.extname(absolutePath).toLowerCase();
    let contentType = 'application/octet-stream';
    if (ext === '.png') contentType = 'image/png';
    else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    else if (ext === '.webp') contentType = 'image/webp';
    else if (ext === '.gif') contentType = 'image/gif';
    else if (ext === '.svg') contentType = 'image/svg+xml';

    c.header('Content-Type', contentType);
    return c.body(fileContent);
  } catch (err) {
    return c.text(`Error reading asset: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
});

// ─── Profile Governance API (Phase 3) ──────────────────────────────────────

// LLM task configs ───────────────────────────────────────────────────────────

/**
 * GET /api/onboarding/settings/llm-task-configs
 * List all task-routing rows. Provider credentials stay in `api_keys`;
 * these rows only carry provider + model + base URL override.
 */
route.get('/onboarding/settings/llm-task-configs', (c) => {
  const rows = listLlmTaskConfigs();
  return c.json({ taskConfigs: rows, knownTasks: LLM_TASKS });
});

/**
 * PUT /api/onboarding/settings/llm-task-configs/:task
 * Upsert the model + provider for a single AI task.
 */
route.put('/onboarding/settings/llm-task-configs/:task', async (c) => {
  const task = c.req.param('task') as LlmTask;
  if (!LLM_TASKS.includes(task)) {
    return c.json({ error: `Unknown task: ${task}` }, 400);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = LlmTaskConfigUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }
  const row = upsertLlmTaskConfig({
    task,
    provider: parsed.data.provider,
    model: parsed.data.model,
    baseUrlOverride: parsed.data.baseUrlOverride ?? null,
    temperature: parsed.data.temperature ?? null,
  });
  return c.json({ success: true, taskConfig: row });
});

/**
 * DELETE /api/onboarding/settings/llm-task-configs/:task
 * Remove the task routing row. A missing row returns 200 with
 * success=false so the UI can stop showing the row gracefully.
 */
route.delete('/onboarding/settings/llm-task-configs/:task', (c) => {
  const task = c.req.param('task') as LlmTask;
  if (!LLM_TASKS.includes(task)) {
    return c.json({ error: `Unknown task: ${task}` }, 400);
  }
  const removed = deleteLlmTaskConfig(task);
  return c.json({ success: removed });
});

// Domain profile governance ──────────────────────────────────────────────────

/**
 * GET /api/onboarding/settings/profile-governance/:domain
 * Domain-level governance summary: active profile, generations,
 * revisions, decisions, sample count.
 */
route.get('/onboarding/settings/profile-governance/:domain', (c) => {
  const domain = c.req.param('domain');
  const summary = listDomainProfileGovernance(domain);
  return c.json(summary);
});

/**
 * GET /api/onboarding/settings/profile-generations?domain=&status=
 * List generated profile proposals. When `domain` is provided, results
 * are scoped to that domain; without `domain`, the route returns the
 * newest proposals across all domains so proposals are visible before
 * an active extractor profile exists.
 */
route.get('/onboarding/settings/profile-generations', (c) => {
  const domain = c.req.query('domain');
  const status = c.req.query('status');
  const options: { status?: 'proposed' | 'validated' | 'rejected' | 'promoted' | 'failed' } = {};
  if (status === 'proposed' || status === 'validated' || status === 'rejected' || status === 'promoted' || status === 'failed') {
    options.status = status;
  }
  const generations = domain
    ? listProfileGenerationsByDomain(domain, options)
    : listAllProfileGenerations(options);
  return c.json({ generations });
});

/**
 * GET /api/onboarding/settings/profile-generations/:id
 * Single generation with its revisions, field decisions, and validation
 * results. The UI uses this for the review drawer.
 */
route.get('/onboarding/settings/profile-generations/:id', (c) => {
  const id = c.req.param('id');
  const generation = findProfileGenerationById(id);
  if (!generation) {
    return c.json({ error: 'Generation not found' }, 404);
  }
  // Ensure revisions exist for legacy generations (backfill on read).
  const backfilledRevision = createInitialRevisionForGeneration(id);
  void backfilledRevision;
  const revisions = listRevisionsByGeneration(id);
  const fieldDecisions = listFieldDecisionsForGeneration(id);
  const validationResults = revisions.flatMap((r) =>
    listValidationResultsForRevision(r.id),
  );
  return c.json({
    generation,
    revisions,
    fieldDecisions,
    validationResults,
  });
});

/**
 * DELETE /api/onboarding/settings/profile-generations/:id
 * Remove a profile generation proposal and all of its cascade
 * children (revisions, validation results, field decisions).
 */
route.delete('/onboarding/settings/profile-generations/:id', (c) => {
  const id = c.req.param('id');
  const deleted = deleteProfileGeneration(id);
  if (!deleted) {
    return c.json({ error: 'Generation not found' }, 404);
  }
  return c.json({ success: true });
});

/**
 * POST /api/onboarding/settings/profile-generations/:id/revisions
 * Create a new revision from structured store-manager feedback.
 */
route.post('/onboarding/settings/profile-generations/:id/revisions', async (c) => {
  const generationId = c.req.param('id');
  const generation = findProfileGenerationById(generationId);
  if (!generation) {
    return c.json({ error: 'Generation not found' }, 404);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = ReviseFromFeedbackRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }
  const revision = reviseProfileFromStructuredFeedback({
    generationId,
    parentRevisionId: parsed.data.parentRevisionId ?? null,
    feedback: parsed.data.feedback,
    notes: parsed.data.notes ?? null,
  });
  if (!revision) {
    return c.json({ error: 'Could not create revision' }, 500);
  }

  // ── AI revision: call the LLM to revise selectors based on feedback ──
  // This is deliberately a best-effort step. If the LLM is not configured
  // or the call fails, the feedback revision is still created so the
  // operator can see it. The `draft` status signals that the revision
  // needs an AI pass.
  let finalRevision = revision;
  try {
    const pageUrl = generation.sourceUrl;
    const promptFeedback = parsed.data.feedback;
    const currentSelectors = revision.selectors;

    // Fetch the source page HTML.
    const response = await fetch(pageUrl, {
      headers: HTTP_EXTRACTION_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      const html = await response.text();
      const minimized = getMinimizedDom(html);

      const systemPrompt =
        'You are a precise assistant that returns ONLY valid JSON. No markdown, no commentary, no code fences.';

      const userPrompt = `You are a CSS selector expert. Revise the following selectors based on operator feedback.

CURRENT SELECTORS:
${JSON.stringify(currentSelectors, null, 2)}

OPERATOR FEEDBACK:
${JSON.stringify(promptFeedback, null, 2)}

PAGE DOM (minimized):
${minimized.slice(0, 150_000)}

Return ONLY a valid JSON object with exactly these keys:
{ "titleSelector": string|null, "priceSelector": string|null, "descriptionSelector": string|null, "brandSelector": string|null, "imagesSelector": string|null }`;

      const llmResult = await callLlmForTask('profile_revision', userPrompt, systemPrompt, { allowFallback: false });

      if (llmResult) {
        // Strip code fences and parse.
        let cleaned = llmResult.trim();
        const fenceMatch = cleaned.match(/^\`\`\`(?:json|JSON)?\s*\n?/);
        if (fenceMatch) cleaned = cleaned.slice(fenceMatch[0].length);
        if (cleaned.endsWith('\`\`\`')) cleaned = cleaned.slice(0, -3).trim();

        const parsedSelectors = JSON.parse(cleaned);
        if (parsedSelectors && typeof parsedSelectors === 'object' && !Array.isArray(parsedSelectors)) {
          const selectorFields = ['titleSelector', 'priceSelector', 'descriptionSelector', 'brandSelector', 'imagesSelector'];
          const sanitized: Record<string, unknown> = {};
          for (const key of selectorFields) {
            const val = (parsedSelectors as Record<string, unknown>)[key];
            sanitized[key] = typeof val === 'string' && val.trim() ? val.trim() : null;
          }

          // Update the revision with the new selectors.
          const updated = updateRevisionSelectors(revision.id, sanitized, {
            status: 'validated',
            llmTask: 'profile_revision',
          });
          if (updated) finalRevision = updated;
        }
      }
    }
  } catch (err) {
    // The revision was still created; log the LLM failure but do not
    // reject the request. The revision stays in 'draft' status so the
    // operator knows the AI pass did not complete.
    console.warn(`[Revisions] LLM revision pass failed for ${generationId}:`, err);
  }

  return c.json({ success: true, revision: finalRevision });
});

/**
 * POST /api/onboarding/settings/profile-generations/:id/revisions/:revisionId/validate
 * Re-run validation across confirmed same-domain samples and persist
 * per-field/per-sample results.
 */
route.post(
  '/onboarding/settings/profile-generations/:id/revisions/:revisionId/validate',
  async (c) => {
    const revisionId = c.req.param('revisionId');
    const revision = findProfileGenerationRevisionById(revisionId);
    if (!revision) {
      return c.json({ error: 'Revision not found' }, 404);
    }
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const parsed = ValidateRevisionRequestSchema.safeParse(body ?? {});
    const sampleLimit = parsed.success ? parsed.data.sampleLimit : undefined;
    const generation = findProfileGenerationById(revision.generationId);
    if (!generation) {
      return c.json({ error: 'Parent generation not found' }, 404);
    }
    const result = await validateRevisionAcrossConfirmedSamples(
      revisionId,
      generation.domain,
      { sampleLimit },
    );
    return c.json({ success: true, result });
  },
);

/**
 * POST /api/onboarding/settings/profile-generations/:id/revisions/:revisionId/decisions
 * Approve or reject selected selector fields. The body uses
 * `mode: 'approve' | 'reject'` to route to the right service.
 */
route.post(
  '/onboarding/settings/profile-generations/:id/revisions/:revisionId/decisions',
  async (c) => {
    const revisionId = c.req.param('revisionId');
    const revision = findProfileGenerationRevisionById(revisionId);
    if (!revision) {
      return c.json({ error: 'Revision not found' }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const raw = body as { mode?: string } | null;
    const mode = raw && typeof raw === 'object' ? raw.mode : undefined;
    if (mode !== 'approve' && mode !== 'reject') {
      return c.json({ error: 'Body must include mode: "approve" or "reject"' }, 400);
    }
    if (mode === 'approve') {
      const parsed = ApproveRevisionFieldsRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'Invalid approval body', details: parsed.error.flatten() }, 400);
      }
      const result = approveRevisionFields({
        generationId: revision.generationId,
        approvedFields: parsed.data.approvedFields,
        notes: parsed.data.notes ?? null,
        decidedBy: parsed.data.decidedBy ?? null,
        imagePreviewsReviewed: parsed.data.imagePreviewsReviewed === true,
      });
      return c.json({ success: result.imageApprovalAccepted, ...result });
    }
    // mode === 'reject'
    const parsed = RejectRevisionFieldsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid rejection body', details: parsed.error.flatten() }, 400);
    }
    const result = rejectRevisionFields({
      generationId: revision.generationId,
      rejectedFields: parsed.data.rejectedFields as SelectorKey[],
      reason: parsed.data.reason ?? null,
      notes: parsed.data.notes ?? null,
      decidedBy: parsed.data.decidedBy ?? null,
    });
    return c.json({ success: true, ...result });
  },
);

/**
 * POST /api/onboarding/settings/profile-field-decisions/:decisionId/rollback
 * Roll back a previously approved field decision.
 */
route.post('/onboarding/settings/profile-field-decisions/:decisionId/rollback', async (c) => {
  const decisionId = c.req.param('decisionId');
  const decision = findProfileFieldDecisionById(decisionId);
  if (!decision) {
    return c.json({ error: 'Decision not found' }, 404);
  }
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const parsed = RollbackFieldRequestSchema.safeParse(body ?? {});
  const result = rollbackProfileFieldBy({
    decisionId,
    domain: decision.domain,
    selectorField: decision.selectorField as SelectorKey,
    notes: parsed.success ? parsed.data.notes ?? null : null,
    decidedBy: parsed.success ? parsed.data.decidedBy ?? null : null,
  });
  return c.json({ success: result.rolledBack, ...result });
});

// ─── Profile Retry Preview ──────────────────────────────────────────────────────

/**
 * GET /api/onboarding/settings/profile-retry-preview/:domain
 * Query all active batches' items blocked in Extraction with profile-related errors.
 * Filters by domain (sourceUrl hostname or brandHint).
 * Returns items matching ProfileBlockedItemSchema shape.
 */
route.get('/onboarding/settings/profile-retry-preview/:domain', (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const domain = c.req.param('domain');
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

  const batches = listBatches(workspace.id).filter(b => b.status === 'active');
  const db = getDb();

  // Profile-related error patterns to match against error_message
  const profileErrorPatterns = [
    'profile',
    'selector',
    'extraction failed',
    'no data extracted',
    'missing selector',
    'health',
    'blocked',
    'unhealthy',
  ];

  const items: ProfileBlockedItem[] = [];

  for (const batch of batches) {
    const staged = listItemsByBatchStaged(batch.id);
    const extractionItems = staged.extraction || [];

    for (const item of extractionItems) {
      if (item.stageStatus !== 'failed') continue;

      // Filter by domain match (sourceUrl hostname or brandHint)
      const matchesDomain = (): boolean => {
        if (item.brandHint && item.brandHint.toLowerCase() === normalizedDomain) return true;
        if (item.brandHint && normalizedDomain.includes(item.brandHint.toLowerCase())) return true;
        if (item.brandHint && item.brandHint.toLowerCase().includes(normalizedDomain)) return true;
        if (item.sourceUrl) {
          try {
            const hostname = new URL(item.sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
            if (hostname === normalizedDomain || hostname.endsWith('.' + normalizedDomain)) return true;
          } catch {
            // ignore invalid URLs
          }
        }
        return false;
      };
      if (!matchesDomain()) continue;

      // Filter by error message matching profile-related patterns
      if (item.errorMessage) {
        const lowerError = item.errorMessage.toLowerCase();
        const matchesProfileError = profileErrorPatterns.some(p => lowerError.includes(p));
        if (!matchesProfileError) continue;
      }

      items.push({
        itemId: item.id,
        upc: item.upc,
        name: item.name,
        expectedName: item.expectedName ?? null,
        brandHint: item.brandHint ?? null,
        sourceUrl: item.sourceUrl ?? null,
        errorMessage: item.errorMessage,
        blockedAt: item.updatedAt,
      });
    }
  }

  return c.json({ items });
});

/**
 * POST /api/onboarding/settings/profile-retry-preview/:domain/retry
 * Accept { itemIds: string[] } and reset each item's stage_status to 'pending'
 * so the worker picks it up. Returns { accepted: number }.
 */
route.post('/onboarding/settings/profile-retry-preview/:domain/retry', async (c) => {
  const domain = c.req.param('domain');
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

  let body: { itemIds?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { itemIds } = body;
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
    return c.json({ error: 'itemIds array is required' }, 400);
  }

  for (const itemId of itemIds) {
    const item = findItemById(itemId);
    if (!item) {
      return c.json({ error: `Item ${itemId} not found` }, 404);
    }
    const itemDomain = item.sourceUrl
      ? new URL(item.sourceUrl).hostname.replace(/^www\./, '')
      : item.brandHint || '';
    if (itemDomain !== normalizedDomain) {
      return c.json({ error: `Item ${itemId} does not belong to domain ${domain}` }, 400);
    }
  }

  let accepted = 0;
  for (const itemId of itemIds) {
    updateItemStageStatus(itemId, 'pending');
    accepted++;
  }

  return c.json({ accepted });
});

export default route;
