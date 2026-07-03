import {
  getPendingItemsByStage,
  updateItemStageStatus,
  incrementRetryCount,
  setDiscoverySourceUrl,
  updateItemExpectedName,
} from '../db/repositories/onboarding-item-repo';
import { discoverSources } from './source-discovery';
import {
  insertSources,
  deleteSourcesByItem,
  selectSource,
  type InsertSourceData,
} from '../db/repositories/onboarding-source-repo';
import { findBrandSites } from '../db/repositories/brand-site-repo';
import { extractProductData } from './page-extractor';
import { curateItem } from './product-curator';
import { downloadImages } from './image-downloader';
import { insertExtraction } from '../db/repositories/onboarding-extraction-repo';
import { onboardingEvents } from './sse-emitter';
import { getDb } from '../db/connection';
import type { OnboardingSource, PipelineStage } from '../shared/schemas/onboarding';

const AUTO_STAGES: PipelineStage[] = ['curation', 'extraction', 'discovery'];

// ─── Auto-selection policy helpers ──────────────────────────────────────────────

/**
 * Normalize a domain for comparison: lowercase, trim, strip leading `www.`.
 * Returns an empty string for null/undefined/whitespace input.
 */
export function normalizeDiscoveryDomain(domain: string | null | undefined): string {
  if (!domain) return '';
  return domain.toLowerCase().trim().replace(/^www\./, '');
}

/**
 * True when the candidate domain matches an official mapped brand domain
 * via exact equality or a subdomain suffix (e.g. `us.mywoof.com` matches
 * `mywoof.com`). Broad `includes()` matching is intentionally NOT used to
 * avoid unrelated domains such as `notmywoof.com` matching `mywoof.com`.
 */
export function isOfficialDomainMatch(
  candidateDomain: string | null | undefined,
  officialDomain: string | null | undefined,
): boolean {
  const candidate = normalizeDiscoveryDomain(candidateDomain);
  const official = normalizeDiscoveryDomain(officialDomain);
  if (!candidate || !official) return false;
  return candidate === official || candidate.endsWith('.' + official);
}

/**
 * Return the list of normalized official domains mapped to a brand.
 * Returns an empty array for blank brand hints or when the brand has
 * no entries in `brand_sites`.
 */
export function getOfficialDomainsForBrand(brandHint: string | null | undefined): string[] {
  if (!brandHint || !brandHint.trim()) return [];
  const sites = findBrandSites(brandHint);
  const domains: string[] = [];
  for (const site of sites) {
    const normalized = normalizeDiscoveryDomain(site.domain);
    if (normalized) domains.push(normalized);
  }
  return domains;
}

/**
 * Build a human-readable reason string for why auto-selection was skipped.
 * Returned strings are prefixed with `needs_review:` so the UI can
 * distinguish them from other error messages. When sitemap candidates
 * were discovered but none cleared the auto-select threshold, the
 * reason notes that explicitly so reviewers know to look at them.
 */
function manualReviewReasonForDiscovery(
  item: any,
  bestSource: { domain?: string | null } | undefined,
  officialDomains: string[],
  sitemapCandidateCount = 0,
): string {
  if (!item.brandHint || !String(item.brandHint).trim()) {
    return 'needs_review: no brand assigned for official-domain auto-selection';
  }
  if (officialDomains.length === 0) {
    return `needs_review: no official domain mapped for brand "${String(item.brandHint).trim()}"`;
  }
  const candidateDomain = bestSource?.domain ? String(bestSource.domain) : '(none)';
  const sitemapNote = sitemapCandidateCount > 0
    ? `; ${sitemapCandidateCount} sitemap candidate(s) found but none above the auto-select threshold`
    : '';
  return `needs_review: top candidate domain "${candidateDomain}" does not match official domain(s): ${officialDomains.join(', ')}${sitemapNote}`;
}

/**
 * Stage-based worker. Polls for items with stage_status = 'pending' across
 * all active batches. Processes items within their current stage but NEVER
 * auto-transitions to the next stage — advancement is always manual.
 */
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

    // Reset any stuck in_progress items back to pending for this workspace upon starting
    try {
      const db = getDb();
      const result = db.query(
        "UPDATE onboarding_items SET stage_status = 'pending' WHERE stage_status = 'in_progress' AND batch_id IN (SELECT id FROM onboarding_batches WHERE workspace_id = ?)"
      ).run(this.workspaceId);
      if (result.changes > 0) {
        console.log(`[OnboardingWorker] Reset ${result.changes} stuck in_progress items to pending for workspace ${this.workspaceId}`);
      }
    } catch (err) {
      console.error('[OnboardingWorker] Failed to reset stuck in_progress items:', err);
    }

    this.interval = setInterval(() => this.poll(), 2000);
    console.log('[OnboardingWorker] Started stage-based worker loop');
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
      // Process stages in priority order: discovery first, then extraction, then curation
      for (const stage of AUTO_STAGES) {
        if (this.running.size >= this.maxConcurrency) break;

        const available = this.maxConcurrency - this.running.size;
        const pendingItems = getPendingItemsByStage(stage, available, this.workspaceId);

        for (const item of pendingItems) {
          if (this.running.has(item.id)) continue;

          const promise = this.processItem(item, stage);
          this.running.set(item.id, promise);
          promise.finally(() => this.running.delete(item.id));

          if (this.running.size >= this.maxConcurrency) break;
        }
      }
    } catch (err) {
      console.error('[OnboardingWorker] Error in poll loop:', err);
    } finally {
      this.isProcessing = false;
    }
  }

  private async processItem(item: any, stage: PipelineStage): Promise<void> {
    console.log(`[OnboardingWorker] Processing ${item.name} (${item.upc}) in stage: ${stage}`);

    // Set to in_progress
    updateItemStageStatus(item.id, 'in_progress');
    onboardingEvents.emitItemStatus(item.batchId, item.id, 'in_progress', { stage });

    try {
      switch (stage) {
        case 'discovery':
          await this.processDiscovery(item);
          break;
        case 'extraction':
          await this.processExtraction(item);
          break;
        case 'curation':
          await this.processCuration(item);
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(`[OnboardingWorker] Error in ${stage} for ${item.id}:`, err);
    }
  }

  private async processDiscovery(item: any): Promise<void> {
    console.log(`[OnboardingWorker] Discovery for ${item.name} (${item.upc})`);

    try {
      const discovery = await discoverSources(item.upc, item.name, item.brandHint);
      const sources = discovery.candidates;
      const consolidatedName = discovery.consolidatedName;

      // ── Sitemap signals ──────────────────────────────────────────────
      // Sitemap candidates come from the brand's own sitemap (sourceMethod
      // starting with 'sitemap_'). Used by the auto-selection policy below
      // and surfaced to the UI via the SSE event so reviewers can see when
      // the sitemap pass produced hits.
      const sitemapCandidates = sources.filter(
        s => (s.sourceMethod ?? '').startsWith('sitemap_'),
      );
      const sitemapCandidateCount = sitemapCandidates.length;
      const sitemapMatched = sitemapCandidateCount > 0;

      // ── Log & persist the consolidated name ──────────────────────────
      if (consolidatedName) {
        console.log(`[OnboardingWorker] ✓ Consolidated name for ${item.upc}: "${consolidatedName}"`);
        updateItemExpectedName(item.id, consolidatedName);
      } else {
        console.log(`[OnboardingWorker] ⚠ No consolidated name for ${item.upc} — keeping raw name "${item.name}"`);
      }

      // ── Log result summary ───────────────────────────────────────────
      if (sources.length > 0) {
        const bestSource = sources[0];
        console.log(
          `[OnboardingWorker] ✓ Discovery complete for "${item.name}" (${item.upc}): ` +
          `${sources.length} source(s) found (${sitemapCandidateCount} from sitemap). Top candidate: ${bestSource.url} (${(bestSource.confidence * 100).toFixed(0)}% confidence, domain: ${bestSource.domain ?? 'n/a'})`
        );
      } else {
        console.log(`[OnboardingWorker] ✗ Discovery complete for "${item.name}" (${item.upc}): 0 sources found.`);
      }

      deleteSourcesByItem(item.id);

      if (sources.length > 0) {
        const insertedSources: OnboardingSource[] = insertSources(item.id, sources);
        const bestSource = sources[0];

        // Auto-selection policy: prefer a sitemap candidate with
        // confidence > 0.7 on an official brand domain (a strong
        // independent signal that the URL is the canonical product
        // page). Otherwise fall back to the existing top-source-on-
        // official-domain check. Open-web candidates are still inserted
        // for manual review either way.
        const officialDomains = getOfficialDomainsForBrand(item.brandHint);
        const eligibleSitemapSource = sitemapCandidates.find(
          sc => sc.confidence > 0.7 && officialDomains.some(d => isOfficialDomainMatch(sc.domain, d)),
        );
        const autoSelectedSource: InsertSourceData | null =
          eligibleSitemapSource ??
          (officialDomains.some(d => isOfficialDomainMatch(bestSource.domain, d))
            ? bestSource
            : null);
        const shouldAutoSelect = autoSelectedSource !== null;

        if (shouldAutoSelect && autoSelectedSource) {
          setDiscoverySourceUrl(item.id, autoSelectedSource.url);

          // Find the inserted counterpart of the auto-selected source
          // by URL — it may not be at index 0 when the eligible
          // sitemap candidate wins over the top Serper result.
          const autoSelectedIndex = sources.findIndex(
            s => s.url === autoSelectedSource.url,
          );
          const autoSelectedInserted = autoSelectedIndex >= 0
            ? insertedSources[autoSelectedIndex]
            : null;
          if (autoSelectedInserted) {
            selectSource(autoSelectedInserted.id);
          }

          console.log(
            `[OnboardingWorker] ✓ Auto-selected official source for "${item.name}" (${item.upc}): ` +
            `${autoSelectedSource.url} (domain ${autoSelectedSource.domain ?? 'n/a'} matches ${officialDomains.join(', ')})`
          );
        } else {
          const manualReviewReason = manualReviewReasonForDiscovery(
            item,
            bestSource,
            officialDomains,
            sitemapCandidateCount,
          );
          updateItemStageStatus(item.id, 'completed', manualReviewReason);

          console.log(
            `[OnboardingWorker] ⚠ Discovery needs manual review for "${item.name}" (${item.upc}): ` +
            `${manualReviewReason}. Top candidate: ${bestSource.url} (${(bestSource.confidence * 100).toFixed(0)}% confidence)`
          );
        }

        onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
          stage: 'discovery',
          sourceUrl: shouldAutoSelect && autoSelectedSource ? autoSelectedSource.url : null,
          autoSelected: shouldAutoSelect,
          needsManualReview: !shouldAutoSelect,
          manualReviewReason: shouldAutoSelect
            ? null
            : manualReviewReasonForDiscovery(item, bestSource, officialDomains, sitemapCandidateCount),
          bestCandidateUrl: bestSource.url,
          bestCandidateDomain: bestSource.domain ?? null,
          officialDomains,
          consolidatedName: consolidatedName || null,
          sourcesCount: sources.length,
          topConfidence: bestSource.confidence,
          sitemapMatched,
          sitemapCandidateCount,
        });
      } else {
        updateItemStageStatus(item.id, 'completed', 'No matching product pages found');
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
          stage: 'discovery',
          warning: 'No sources found',
          needsManualReview: true,
          manualReviewReason: 'No sources found',
          consolidatedName: consolidatedName || null,
          sitemapMatched: false,
          sitemapCandidateCount: 0,
        });
      }
    } catch (err) {
      console.error(`[OnboardingWorker] Discovery error for ${item.id}:`, err);
      const retry = incrementRetryCount(item.id);
      if (retry < 2) {
        updateItemStageStatus(item.id, 'pending');
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'pending', {
          stage: 'discovery',
          error: String(err),
        });
      } else {
        updateItemStageStatus(item.id, 'failed', String(err));
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
          stage: 'discovery',
          error: String(err),
        });
      }
    }
  }

  private async processExtraction(item: any): Promise<void> {
    if (!item.sourceUrl) {
      updateItemStageStatus(item.id, 'failed', 'No confirmed source URL');
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
        stage: 'extraction',
        error: 'No confirmed source URL',
      });
      return;
    }

    console.log(`[OnboardingWorker] Extraction for ${item.name} from ${item.sourceUrl}`);

    try {
      const extractedData = await extractProductData(item.sourceUrl, {
        name: item.expectedName || item.name,
        brandHint: item.brandHint,
        price: item.price,
      });

      // Download images — filter primary so it's not re-added as additional
      const imageUrlsToDownload = [];
      const originalPrimaryUrl = extractedData.primaryImage;
      if (originalPrimaryUrl) {
        imageUrlsToDownload.push(originalPrimaryUrl);
      }
      if (extractedData.additionalImages && extractedData.additionalImages.length > 0) {
        // Don't include the primary URL in additional images list
        const additionalFiltered = extractedData.additionalImages.filter(
          (url: string) => url !== originalPrimaryUrl,
        );
        imageUrlsToDownload.push(...additionalFiltered.slice(0, 5));
      }

      let downloadedImages: any[] = [];
      if (imageUrlsToDownload.length > 0) {
        try {
          downloadedImages = await downloadImages(
            this.workspacePath,
            item.upc,
            imageUrlsToDownload,
            extractedData.brand || item.brandHint || undefined,
          );

          const primaryDownloaded = downloadedImages.find(
            (img: any) => img.originalUrl === originalPrimaryUrl,
          );
          if (primaryDownloaded) {
            extractedData.primaryImage = primaryDownloaded.localPath;
            extractedData.fieldProvenance.primaryImage = 'local-download';
          }

          // Map remaining downloaded images (excluding primary) to local paths
          extractedData.additionalImages = downloadedImages
            .filter((img: any) => img.originalUrl !== originalPrimaryUrl)
            .map((img: any) => img.localPath);
        } catch (imgErr) {
          console.error(`[OnboardingWorker] Image download error for ${item.id}:`, imgErr);
        }
      }

      insertExtraction({
        itemId: item.id,
        sourceUrl: item.sourceUrl,
        extractionDataJson: JSON.stringify(extractedData),
        extractionMethod: 'crawlee_playwright',
        confidence: extractedData.confidence,
        imagesJson: JSON.stringify(downloadedImages),
        rawStructuredDataJson: JSON.stringify(extractedData.fieldProvenance),
      });

      const db = getDb();
      db.query('UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(extractedData),
        new Date().toISOString(),
        item.id,
      );

      updateItemStageStatus(item.id, 'completed');
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
        stage: 'extraction',
        extractedData,
      });

      console.log(
        `[OnboardingWorker] ✓ Extraction complete for "${item.name}" (${item.upc}): ` +
        `title="${extractedData.title || 'N/A'}", brand="${extractedData.brand || 'N/A'}", ` +
        `price="${extractedData.price || 'N/A'}", confidence=${(extractedData.confidence * 100).toFixed(0)}%, ` +
        `images=${downloadedImages.length}`
      );
    } catch (err) {
      console.error(`[OnboardingWorker] Extraction error for ${item.id}:`, err);
      const retry = incrementRetryCount(item.id);
      if (retry < 2) {
        updateItemStageStatus(item.id, 'pending');
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'pending', {
          stage: 'extraction',
          error: String(err),
        });
      } else {
        updateItemStageStatus(item.id, 'failed', String(err));
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
          stage: 'extraction',
          error: String(err),
        });
      }
    }
  }

  private async processCuration(item: any): Promise<void> {
    console.log(`[OnboardingWorker] Curation for ${item.name} (${item.upc})`);

    try {
      // item is already an OnboardingItem — pass directly, no need for mapRowToItem
      const curationData = await curateItem(item, this.workspacePath);

      const db = getDb();
      db.query('UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(curationData),
        new Date().toISOString(),
        item.id,
      );

      updateItemStageStatus(item.id, 'completed');
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
        stage: 'curation',
        curationData,
      });

      console.log(
        `[OnboardingWorker] ✓ Curation complete for "${item.name}" (${item.upc}): ` +
        `curatedTitle="${curationData.curatedTitle || 'N/A'}", ` +
        `titleSource=${curationData.titleSource}, ` +
        `suggestedPages=[${(curationData.suggestedPages || []).join(', ') || 'none'}], ` +
        `productType=${curationData.suggestedProductType || 'N/A'}`
      );
    } catch (err) {
      console.error(`[OnboardingWorker] Curation error for ${item.id}:`, err);
      // Curation failure is not blocking — populate defaults
      const defaultCuration = {
        curatedTitle: item.name,
        packagingOcrTitle: null,
        titleSource: 'web' as const,
        suggestedPages: [],
        suggestedProductType: null,
        curatedAt: new Date().toISOString(),
        curationMethod: 'auto' as const,
      };
      const db = getDb();
      db.query('UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(defaultCuration),
        new Date().toISOString(),
        item.id,
      );

      updateItemStageStatus(item.id, 'completed');
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
        stage: 'curation',
        curationData: defaultCuration,
      });
    }
  }
}
