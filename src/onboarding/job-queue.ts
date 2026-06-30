import { 
  getNextPendingItems, 
  updateItemStatus, 
  updateItemExtractionData, 
  incrementRetryCount,
  mapRowToItem
} from '../db/repositories/onboarding-item-repo';
import { 
  findBatchById, 
  updateBatchStatus, 
  incrementBatchCounters 
} from '../db/repositories/onboarding-batch-repo';
import { discoverSources } from './source-discovery';
import { insertSources, deleteSourcesByItem } from '../db/repositories/onboarding-source-repo';
import { extractProductData } from './page-extractor';
import { curateItem } from './product-curator';
import { downloadImages } from './image-downloader';
import { insertExtraction } from '../db/repositories/onboarding-extraction-repo';
import { onboardingEvents } from './sse-emitter';
import type { OnboardingItemRow } from '../db/repositories/onboarding-item-repo';
import type { ItemStatus, BatchStatus } from '../shared/schemas/onboarding';

export class OnboardingWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = new Map<string, Promise<void>>();
  private maxConcurrency = 3;
  private isProcessing = false;
  private workspacePath: string;
  private workspaceId: string;

  constructor(workspaceId: string, workspacePath: string, maxConcurrency = 3) {
    this.workspaceId = workspaceId;
    this.workspacePath = workspacePath;
    this.maxConcurrency = maxConcurrency;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.poll(), 2000);
    console.log('[OnboardingWorker] Started worker loop');
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log('[OnboardingWorker] Stopped worker loop');
  }

  async poll(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      if (this.running.size >= this.maxConcurrency) {
        this.isProcessing = false;
        return;
      }

      const db = require('../db/connection').getDb();
      
      const pendingDiscovery = db.query(`
        SELECT i.* FROM onboarding_items i
        JOIN onboarding_batches b ON i.batch_id = b.id
        WHERE b.workspace_id = ? AND b.status = 'discovering' AND i.status = 'imported'
        LIMIT ?
      `).all(this.workspaceId, this.maxConcurrency - this.running.size) as OnboardingItemRow[];

      for (const item of pendingDiscovery) {
        if (this.running.has(item.id)) continue;
        const promise = this.processDiscovery(item);
        this.running.set(item.id, promise);
        promise.finally(() => this.running.delete(item.id));
      }

      if (this.running.size < this.maxConcurrency) {
        const pendingExtraction = db.query(`
          SELECT i.* FROM onboarding_items i
          JOIN onboarding_batches b ON i.batch_id = b.id
          WHERE b.workspace_id = ? AND b.status = 'extracting' AND i.status = 'source_confirmed'
          LIMIT ?
        `).all(this.workspaceId, this.maxConcurrency - this.running.size) as OnboardingItemRow[];
 
        for (const item of pendingExtraction) {
          if (this.running.has(item.id)) continue;
          const promise = this.processExtraction(item);
          this.running.set(item.id, promise);
          promise.finally(() => this.running.delete(item.id));
        }
      }

      if (this.running.size < this.maxConcurrency) {
        const pendingCuration = db.query(`
          SELECT i.* FROM onboarding_items i
          JOIN onboarding_batches b ON i.batch_id = b.id
          WHERE b.workspace_id = ? AND b.status = 'curating' AND i.status = 'needs_review'
          LIMIT ?
        `).all(this.workspaceId, this.maxConcurrency - this.running.size) as OnboardingItemRow[];

        for (const item of pendingCuration) {
          if (this.running.has(item.id)) continue;
          const promise = this.processCuration(item);
          this.running.set(item.id, promise);
          promise.finally(() => this.running.delete(item.id));
        }
      }
    } catch (err) {
      console.error('[OnboardingWorker] Error in poll loop:', err);
    } finally {
      this.isProcessing = false;
    }
  }

  private async processDiscovery(item: OnboardingItemRow): Promise<void> {
    console.log(`[OnboardingWorker] Starting source discovery for ${item.name} (${item.upc})`);
    updateItemStatus(item.id, 'discovering');
    onboardingEvents.emitItemStatus(item.batch_id, item.id, 'discovering');

    try {
      const sources = await discoverSources(item.upc, item.name, item.brand_hint);
      
      deleteSourcesByItem(item.id);

      if (sources.length > 0) {
        insertSources(item.id, sources);
        const bestSource = sources[0];
        if (bestSource.confidence > 0.6) {
          updateItemStatus(item.id, 'source_found');
          const db = require('../db/connection').getDb();
          db.query('UPDATE onboarding_items SET source_url = ?, status = ? WHERE id = ?').run(bestSource.url, 'source_found', item.id);
          
          const insertedSources = db.query('SELECT id FROM onboarding_sources WHERE item_id = ? ORDER BY confidence DESC LIMIT 1').get(item.id) as { id: string } | undefined;
          if (insertedSources) {
            db.query('UPDATE onboarding_sources SET is_selected = 1 WHERE id = ?').run(insertedSources.id);
          }
          
          onboardingEvents.emitItemStatus(item.batch_id, item.id, 'source_found', { sourceUrl: bestSource.url });
        } else {
          updateItemStatus(item.id, 'source_found');
          onboardingEvents.emitItemStatus(item.batch_id, item.id, 'source_found');
        }
        
        incrementBatchCounters(item.batch_id, 'completed_items');
      } else {
        updateItemStatus(item.id, 'failed', 'No matching product pages found');
        onboardingEvents.emitItemStatus(item.batch_id, item.id, 'failed', { error: 'No matching product pages found' });
        incrementBatchCounters(item.batch_id, 'failed_items');
      }
    } catch (err) {
      console.error(`[OnboardingWorker] Discovery error for ${item.id}:`, err);
      const retry = incrementRetryCount(item.id);
      if (retry < 2) {
        updateItemStatus(item.id, 'imported');
        onboardingEvents.emitItemStatus(item.batch_id, item.id, 'imported', { error: String(err) });
      } else {
        updateItemStatus(item.id, 'failed', String(err));
        onboardingEvents.emitItemStatus(item.batch_id, item.id, 'failed', { error: String(err) });
        incrementBatchCounters(item.batch_id, 'failed_items');
      }
    }

    this.checkBatchCompletion(item.batch_id, 'discovering');
  }

  private async processExtraction(item: OnboardingItemRow): Promise<void> {
    if (!item.source_url) {
      updateItemStatus(item.id, 'failed', 'No confirmed source URL');
      onboardingEvents.emitItemStatus(item.batch_id, item.id, 'failed', { error: 'No confirmed source URL' });
      incrementBatchCounters(item.batch_id, 'failed_items');
      this.checkBatchCompletion(item.batch_id, 'extracting');
      return;
    }

    console.log(`[OnboardingWorker] Starting extraction for ${item.name} from ${item.source_url}`);
    updateItemStatus(item.id, 'extracting');
    onboardingEvents.emitItemStatus(item.batch_id, item.id, 'extracting');

    try {
      const extractedData = await extractProductData(item.source_url, {
        name: item.name,
        brandHint: item.brand_hint,
      });

      const imageUrlsToDownload = [];
      if (extractedData.primaryImage) {
        imageUrlsToDownload.push(extractedData.primaryImage);
      }
      if (extractedData.additionalImages && extractedData.additionalImages.length > 0) {
        imageUrlsToDownload.push(...extractedData.additionalImages.slice(0, 5));
      }

      let downloadedImages: any[] = [];
      if (imageUrlsToDownload.length > 0) {
        try {
          downloadedImages = await downloadImages(this.workspacePath, item.upc, imageUrlsToDownload);
          
          const primaryDownloaded = downloadedImages.find(img => img.originalUrl === extractedData.primaryImage);
          if (primaryDownloaded) {
            extractedData.primaryImage = primaryDownloaded.localPath;
            extractedData.fieldProvenance.primaryImage = 'local-download';
          }
          
          extractedData.additionalImages = downloadedImages
            .filter(img => img.originalUrl !== extractedData.primaryImage)
            .map(img => img.localPath);
        } catch (imgErr) {
          console.error(`[OnboardingWorker] Image download error for ${item.id}:`, imgErr);
        }
      }

      insertExtraction({
        itemId: item.id,
        sourceUrl: item.source_url,
        extractionDataJson: JSON.stringify(extractedData),
        extractionMethod: 'crawlee_playwright',
        confidence: extractedData.confidence,
        imagesJson: JSON.stringify(downloadedImages),
        rawStructuredDataJson: JSON.stringify(extractedData.fieldProvenance),
      });

      const db = require('../db/connection').getDb();
      db.query('UPDATE onboarding_items SET extraction_data_json = ?, status = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(extractedData),
        'needs_review',
        new Date().toISOString(),
        item.id
      );

      onboardingEvents.emitItemStatus(item.batch_id, item.id, 'needs_review', { extractedData });
      incrementBatchCounters(item.batch_id, 'completed_items');

    } catch (err) {
      console.error(`[OnboardingWorker] Extraction error for ${item.id}:`, err);
      const retry = incrementRetryCount(item.id);
      if (retry < 2) {
        updateItemStatus(item.id, 'source_confirmed');
        onboardingEvents.emitItemStatus(item.batch_id, item.id, 'source_confirmed', { error: String(err) });
      } else {
        updateItemStatus(item.id, 'failed', String(err));
        onboardingEvents.emitItemStatus(item.batch_id, item.id, 'failed', { error: String(err) });
        incrementBatchCounters(item.batch_id, 'failed_items');
      }
    }

    this.checkBatchCompletion(item.batch_id, 'extracting');
  }

  private async processCuration(item: OnboardingItemRow): Promise<void> {
    console.log(`[OnboardingWorker] Starting curation for ${item.name} (${item.upc})`);
    updateItemStatus(item.id, 'curating');
    onboardingEvents.emitItemStatus(item.batch_id, item.id, 'curating');

    try {
      const mappedItem = mapRowToItem(item);
      const curationData = await curateItem(mappedItem, this.workspacePath);

      const db = require('../db/connection').getDb();
      db.query('UPDATE onboarding_items SET curation_data_json = ?, status = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(curationData),
        'curated',
        new Date().toISOString(),
        item.id
      );

      onboardingEvents.emitItemStatus(item.batch_id, item.id, 'curated', { curationData });
      incrementBatchCounters(item.batch_id, 'completed_items');
    } catch (err) {
      console.error(`[OnboardingWorker] Curation error for ${item.id}:`, err);
      // Curation failure is not blocking - populate defaults
      const defaultCuration = {
        curatedTitle: item.name,
        packagingOcrTitle: null,
        titleSource: 'web' as const,
        suggestedPages: [],
        suggestedProductType: null,
        curatedAt: new Date().toISOString(),
        curationMethod: 'auto' as const,
      };
      const db = require('../db/connection').getDb();
      db.query('UPDATE onboarding_items SET curation_data_json = ?, status = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(defaultCuration),
        'curated',
        new Date().toISOString(),
        item.id
      );
      onboardingEvents.emitItemStatus(item.batch_id, item.id, 'curated', { curationData: defaultCuration });
      incrementBatchCounters(item.batch_id, 'completed_items');
    }

    this.checkBatchCompletion(item.batch_id, 'curating');
  }

  private checkBatchCompletion(batchId: string, phase: 'discovering' | 'extracting' | 'curating'): void {
    const db = require('../db/connection').getDb();
    const counts = db.query(`
      SELECT status, COUNT(*) as count 
      FROM onboarding_items 
      WHERE batch_id = ? 
      GROUP BY status
    `).all(batchId) as Array<{ status: string; count: number }>;

    let total = 0;
    let pendingCount = 0;
    let completedCount = 0;
    let failedCount = 0;

    for (const c of counts) {
      total += c.count;
      // Pending criteria:
      // For discovering/extracting phases: standard status checks
      // For curating phase: need to also wait for items in 'needs_review' to get curated
      const isPendingStatus = c.status === 'imported' || c.status === 'discovering' || c.status === 'extracting' || c.status === 'curating';
      const isAwaitingCuration = phase === 'curating' && c.status === 'needs_review';
      
      if (isPendingStatus || isAwaitingCuration) {
        pendingCount += c.count;
      } else if (c.status === 'failed') {
        failedCount += c.count;
      } else {
        completedCount += c.count;
      }
    }

    db.query(`
      UPDATE onboarding_batches 
      SET completed_items = ?, failed_items = ?, updated_at = ? 
      WHERE id = ?
    `).run(completedCount, failedCount, new Date().toISOString(), batchId);

    onboardingEvents.emitBatchProgress(batchId, completedCount, failedCount, total);

    if (pendingCount === 0) {
      let finalBatchStatus: BatchStatus = 'review';
      if (phase === 'extracting') {
        // Automatically transition batch to curating phase!
        finalBatchStatus = 'curating';
        console.log(`[OnboardingWorker] Batch ${batchId} completed extraction. Automatically transitioning to curating...`);
      } else {
        console.log(`[OnboardingWorker] Batch ${batchId} completed phase ${phase}`);
      }
      
      updateBatchStatus(batchId, finalBatchStatus);
      onboardingEvents.emitBatchComplete(batchId, finalBatchStatus);
    }
  }
}
