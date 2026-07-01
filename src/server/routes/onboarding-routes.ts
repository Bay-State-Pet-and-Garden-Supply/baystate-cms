import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import {
  createBatch,
  findBatchById,
  listBatches,
  updateBatchStatus,
  deleteBatch
} from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  findItemById,
  updateItemStatus,
  updateItemSourceUrl
} from '../../db/repositories/onboarding-item-repo';
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
  upsertBrandSite
} from '../../db/repositories/brand-site-repo';
import {
  listAllProfiles,
  upsertProfile,
  deleteProfile,
  findProfileByDomain
} from '../../db/repositories/extractor-profile-repo';
import { parseSpreadsheet, detectColumnMapping, applyColumnMapping } from '../../onboarding/spreadsheet-parser';
import { matchExistingBrand } from '../../shared/brand-matcher';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { promoteItems } from '../../onboarding/draft-promoter';
import { onboardingEvents } from '../../onboarding/sse-emitter';
import { findProductBySku } from '../../db/repositories/product-index-repo';
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

// ─── START WORKER PIPELINES ────────────────────────────────────────────────────

/**
 * POST /api/onboarding/batches/:id/start-discovery
 * Move batch status to 'discovering' and trigger background polling.
 */
route.post('/onboarding/batches/:id/start-discovery', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  // Update batch status to discovering
  updateBatchStatus(batchId, 'discovering');
  onboardingEvents.emitBatchComplete(batchId, 'discovering');

  // Trigger worker discovery
  const worker = getWorker(workspace.id, workspace.workspacePath);
  worker.poll();

  return c.json({ success: true });
});

/**
 * POST /api/onboarding/batches/:id/start-extraction
 * Move batch status to 'extracting' and trigger background polling.
 */
route.post('/onboarding/batches/:id/start-extraction', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  // Set all confirmed sources / source_found items to 'source_confirmed' so extraction triggers
  const db = getDb();
  db.query(`
    UPDATE onboarding_items 
    SET status = 'source_confirmed' 
    WHERE batch_id = ? AND status = 'source_found' AND source_url IS NOT NULL
  `).run(batchId);

  updateBatchStatus(batchId, 'extracting');
  onboardingEvents.emitBatchComplete(batchId, 'extracting');

  // Trigger worker extraction
  const worker = getWorker(workspace.id, workspace.workspacePath);
  worker.poll();

  return c.json({ success: true });
});

/**
 * POST /api/onboarding/batches/:id/start-curation
 * Move batch status to 'curating' and trigger background curation polling.
 */
route.post('/onboarding/batches/:id/start-curation', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  updateBatchStatus(batchId, 'curating');
  onboardingEvents.emitBatchComplete(batchId, 'curating');

  // Trigger worker curation
  const worker = getWorker(workspace.id, workspace.workspacePath);
  worker.poll();

  return c.json({ success: true });
});

/**
 * POST /api/onboarding/batches/:id/promote
 * Promotes review-approved items to normal product drafts.
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
    const result = await promoteItems(workspace.id, workspace.workspacePath, batchId, itemIds);
    return c.json(result);
  } catch (err) {
    console.error('[OnboardingRoutes] Promotion failed:', err);
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

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return streamSSE(c, async (stream) => {
    const unsubscribe = onboardingEvents.subscribe(batchId, async (event) => {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      });
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
 * POST /api/onboarding/items/:id/retry
 * Reset an item's state to let the background worker try it again.
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

  // Determine retry status
  const resetStatus = item.status === 'failed' && !item.sourceUrl ? 'imported' : 'source_confirmed';
  const db = getDb();
  db.query('UPDATE onboarding_items SET status = ?, retry_count = 0, error_message = NULL WHERE id = ?').run(
    resetStatus,
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
  updateItemSourceUrl(itemId, selected.url);

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

  updateItemSourceUrl(itemId, url);
  return c.json({ success: true });
});

/**
 * POST /api/onboarding/items/:id/skip
 * Marks item as skipped.
 */
route.post('/onboarding/items/:id/skip', (c) => {
  const itemId = c.req.param('id');
  updateItemStatus(itemId, 'skipped');
  return c.json({ success: true });
});

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
  return c.json({ brandSites: sites });
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
    const { domain, titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector } = await c.req.json();
    if (!domain) {
      return c.json({ error: 'domain is required' }, 400);
    }
    const profile = upsertProfile(domain, {
      titleSelector,
      priceSelector,
      descriptionSelector,
      brandSelector,
      imagesSelector,
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

route.post('/onboarding/extractor-profiles/test', async (c) => {
  let browser;
  try {
    const { url, titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector } = await c.req.json();
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
        const imgEls = document.querySelectorAll(sel.imagesSelector);
        res.images = Array.from(imgEls)
          .map(el => {
            const img = el as HTMLImageElement;
            return img.src || img.dataset.src || img.getAttribute('data-lazy-src') || '';
          })
          .filter(Boolean);
      }
      return res;
    }, { titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector });

    return c.json({ success: true, extracted });
  } catch (err) {
    console.error('[OnboardingRoutes] Custom selector test run failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

export default route;
