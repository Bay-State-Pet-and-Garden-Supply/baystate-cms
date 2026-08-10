import {
  claimItemsForProcessing,
  requeueStaleInProgressItems,
  updateItemStageStatus,
  incrementRetryCount,
  setDiscoverySourceUrl,
  updateItemExpectedName,
  updateItemBrandHint,
  listItemsByBatch,
} from '../db/repositories/onboarding-item-repo';
import { randomUUID } from 'node:crypto';
import { discoverSources } from './source-discovery';
import { captureModelPolicySnapshot } from './model-policy-snapshot';
import {
  insertSources,
  deleteSourcesByItem,
  selectSource,
  listSourcesByItem,
  type InsertSourceData,
} from '../db/repositories/onboarding-source-repo';
import { verifyTopCandidates, type VerificationResult } from './page-verifier';
import { findBrandSites } from '../db/repositories/brand-site-repo';
import { extractProductData } from './page-extractor';
import { findProfileByDomain } from '../db/repositories/extractor-profile-repo';
import { curateItemWithPipeline } from './product-curator';
import { refreshCandidateCohorts } from './curation-cohort-service';
import { determineProductGroup } from './product-line-grouper';
import { validateSiblingConsistency } from '../classification/consistency-validator';
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
import { normalizeDiscoveryDomain, isOfficialDomainMatch } from './domain-utils';
export { normalizeDiscoveryDomain, isOfficialDomainMatch };

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
 * Stage-based worker. Polls for items with stage_status = 'pending' across
 * all active batches. Processes items within their current stage but NEVER
 * auto-transitions to the next stage — advancement is always manual.
 */
export class OnboardingWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = new Map<string, Promise<void>>();
  // Global concurrency limit across all stages.
  // Extraction has a separate, lower limit to avoid triggering bot
  // detection on target websites during concurrent page scrapes.
  private maxConcurrency = 10;
  private maxExtractionConcurrency = 3;
  private extractionRunning = 0;
  private isProcessing = false;
  private workspacePath: string;
  private workspaceId: string;
  private workerId: string;

  constructor(workspaceId: string, workspacePath: string, maxConcurrency = 10, maxExtractionConcurrency = 3) {
    this.workspaceId = workspaceId;
    this.workspacePath = workspacePath;
    this.maxConcurrency = maxConcurrency;
    this.maxExtractionConcurrency = maxExtractionConcurrency;
    this.workerId = randomUUID();
  }

  start(): void {
    if (this.interval) return;

    // Requeue only items whose claim has gone stale (older than 5 minutes).
    // A live worker's in_progress items are left alone.
    try {
      const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      requeueStaleInProgressItems(this.workspaceId, staleBefore);
    } catch (err) {
      console.error('[OnboardingWorker] Failed to requeue stale in_progress items:', err);
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
      // Batches with in-flight (claimed) items — refreshed once per poll.
      const inFlightBatches = new Set<string>();

      // Process stages in priority order: discovery first, then extraction, then curation
      for (const stage of AUTO_STAGES) {
        if (this.running.size >= this.maxConcurrency) break;

        // Extraction has a separate concurrency limit to avoid bot detection
        if (stage === 'extraction' && this.extractionRunning >= this.maxExtractionConcurrency) continue;

        const available = this.maxConcurrency - this.running.size;
        const claimedItems = claimItemsForProcessing(stage, available, this.workspaceId, this.workerId);

        for (const item of claimedItems) {
          if (this.running.has(item.id)) continue;

          // Re-check extraction concurrency limit in loop since processItem increments it synchronously
          if (stage === 'extraction' && this.extractionRunning >= this.maxExtractionConcurrency) {
            break;
          }

          inFlightBatches.add(item.batchId);

          const promise = this.processItem(item, stage);
          this.running.set(item.id, promise);
          promise.finally(() => this.running.delete(item.id));

          if (this.running.size >= this.maxConcurrency) break;
        }
      }

      // Issue #30 PR2: refresh candidate cohorts for every batch with in-flight
      // items (cheap, idempotent). Family readiness must stay current while
      // items are being processed; failures never block the worker loop.
      for (const batchId of inFlightBatches) {
        try {
          await refreshCandidateCohorts(this.workspaceId, batchId);
        } catch (err) {
          console.warn(`[OnboardingWorker] Candidate cohort refresh failed for batch ${batchId} (non-blocking):`, err);
        }
      }
    } catch (err) {
      console.error('[OnboardingWorker] Error in poll loop:', err);
    } finally {
      this.isProcessing = false;
    }
  }

  private async processItem(item: any, stage: PipelineStage): Promise<void> {
    console.log(`[OnboardingWorker] Processing ${item.name} (${item.upc}) in stage: ${stage} (claimed by ${this.workerId})`);

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

    // Protected discovery calls route through the frozen classification
    // model policy (issue #17 item A). No valid policy ⇒ disabled ⇒ the
    // discovery helpers use deterministic fallbacks.
    const policySnapshot = captureModelPolicySnapshot(this.workspacePath, undefined, this.workspaceId);

    try {
      const existingSources = listSourcesByItem(item.id);
      const upcSources = existingSources.filter(s => s.sourceMethod === 'serper_upc');

      const discovery = await discoverSources(item.upc, item.name, item.brandHint, {
        price: item.price ? parseFloat(item.price) : null,
        existingExpectedName: item.expectedName,
        existingUpcCandidates: upcSources.length > 0 ? upcSources : null,
        modelPolicy: policySnapshot.state === 'configured' ? policySnapshot.view : null,
      });
      const sources = discovery.candidates;
      const consolidatedName = discovery.consolidatedName;
      const inferredBrand = discovery.inferredBrand;

      // ── Persist the inferred brand if discovery inferred one ────────────
      let activeBrandHint = item.brandHint;
      if (inferredBrand) {
        console.log(`[OnboardingWorker] ✓ Persisted inferred brand for ${item.upc}: "${inferredBrand.brand}"`);
        updateItemBrandHint(item.id, inferredBrand.brand);
        activeBrandHint = inferredBrand.brand;
      }

      // ── Hold on discovery if brand has no domain ───────────────────────
      if (discovery.noDomainMapped) {
        console.log(`[OnboardingWorker] ⚠ Brand "${activeBrandHint}" has no official domain configured. Parking item in Discovery stage.`);
        deleteSourcesByItem(item.id);
        if (sources.length > 0) {
          insertSources(item.id, sources);
        }

        const reviewReason = `needs_review: no domain mapped for brand "${activeBrandHint}" — map a domain in Settings to complete discovery`;
        updateItemStageStatus(item.id, 'completed', reviewReason);

        onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
          stage: 'discovery',
          needsManualReview: true,
          manualReviewReason: reviewReason,
          inferredBrand: inferredBrand || null,
          sourcesCount: sources.length,
          sitemapMatched: false,
          sitemapCandidateCount: 0,
        });
        return;
      }

      // ── Sitemap signals ──────────────────────────────────────────────
      // Sitemap candidates come from the brand's own sitemap (sourceMethod
      // starting with 'sitemap_'). Used by the auto-selection policy below
      // and surfaced to the UI via the SSE event so reviewers can see when
      // the sitemap pass produced hits.
      // Count sitemap-derived candidates, including those whose sourceMethod
      // was rewritten to 'shopify_variant' but carry originalSourceMethod in
      // their metadataJson (preserving correct reporting).
      const sitemapCandidates = sources.filter(s => {
        const method = s.sourceMethod ?? '';
        if (method.startsWith('sitemap_')) return true;
        if (method === 'shopify_variant' && s.metadataJson) {
          try {
            const meta = JSON.parse(s.metadataJson);
            return (meta.originalSourceMethod ?? '').startsWith('sitemap_');
          } catch { /* corrupt metadata — skip */ }
        }
        return false;
      });
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

        // ── Candidate verification pass ──────────────────────────────
        // Fetch and score the top candidates' page content for
        // product-identity signals BEFORE auto-selection. This prevents
        // confidently saving the wrong URL just because its slug looked
        // tasty on a high-confidence domain.
        const officialDomains = getOfficialDomainsForBrand(activeBrandHint);
        const verificationResults: VerificationResult[] = sources.length > 0
          ? await verifyTopCandidates(sources, {
              upc: item.upc,
              expectedName: consolidatedName || item.name,
              brandHint: activeBrandHint,
              price: item.price ? parseFloat(item.price) : null,
              officialDomains,
            })
          : [];

        // Log verification outcomes for diagnostics.
        for (const vr of verificationResults) {
          console.log(
            `[OnboardingWorker] Verification for ${item.upc}: ${vr.decisionReason} ` +
            `(url: ${vr.candidate.url})`,
          );
        }

        // ── Auto-selection policy (tightened with verification) ──────
        // A candidate may be auto-selected ONLY when the page verifier
        // finds strong proof of product identity. The old threshold-
        // based logic (sitemap > 0.7 on official domain) is replaced
        // by evidence-gated selection: UPC match, Shopify variant
        // resolution, or verified JSON-LD/title match.
        const isAmbiguous = (s: InsertSourceData) => {
          if (!s.metadataJson) return false;
          try {
            const meta = JSON.parse(s.metadataJson);
            return meta.variantResolution?.status === 'ambiguous';
          } catch {
            return false;
          }
        };

        const verifiedStrong = verificationResults
          .filter(vr => vr.hasStrongProof && !isAmbiguous(vr.candidate));

        // Prefer any valid product page candidate on the official brand domain
        // (even with relaxed verification thresholds) over retailer pages, to ensure
        // consistent image and details sourcing from the brand's official site.
        const officialDomainResult = verificationResults.find(vr => {
          const sig = vr.signals;
          return (
            sig.domainOfficial &&
            !sig.isListingOrSearchPage &&
            !sig.isBlogOrCmsPage &&
            (sig.titleSimilarity >= 0.25 || sig.titleNameOverlap >= 0.25 || sig.skuInPage) &&
            !isAmbiguous(vr.candidate)
          );
        });

        const autoSelectedResult = officialDomainResult
          ? officialDomainResult
          : (verifiedStrong.length > 0 ? verifiedStrong[0] : null);
        const autoSelectedSource = autoSelectedResult?.candidate ?? null;
        const shouldAutoSelect = autoSelectedSource !== null;

        if (shouldAutoSelect && autoSelectedSource) {
          const resolvedUrl = autoSelectedSource.url;
          setDiscoverySourceUrl(item.id, resolvedUrl);

          // Find the inserted counterpart of the auto-selected source
          // by URL.
          const autoSelectedInserted = insertedSources.find(
            s => s.url === resolvedUrl,
          );
          if (autoSelectedInserted) {
            selectSource(autoSelectedInserted.id);
          }

          console.log(
            `[OnboardingWorker] ✓ Auto-selected verified source for "${item.name}" (${item.upc}): ` +
            `${resolvedUrl} (${autoSelectedResult?.decisionReason})`
          );
        } else {
          // Build a detailed reason that includes verification signals
          // so the reviewer knows WHY auto-selection was skipped.
          const topVerification = verificationResults[0];
          const verificationDetail = topVerification
            ? ` | verification: ${topVerification.decisionReason}`
            : '';
          const manualReviewReason =
            `needs_review: no candidate passed verification${verificationDetail}`;
          updateItemStageStatus(item.id, 'completed', manualReviewReason);

          console.log(
            `[OnboardingWorker] ⚠ Discovery needs manual review for "${item.name}" (${item.upc}): ` +
            `${manualReviewReason}`
          );
        }

        const topVerificationForEvent = verificationResults[0];
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
          stage: 'discovery',
          sourceUrl: shouldAutoSelect && autoSelectedSource ? autoSelectedSource.url : null,
          autoSelected: shouldAutoSelect,
          needsManualReview: !shouldAutoSelect,
          manualReviewReason: shouldAutoSelect
            ? null
            : `needs_review: no candidate passed verification` +
              (topVerificationForEvent ? ` | ${topVerificationForEvent.decisionReason}` : ''),
          bestCandidateUrl: bestSource.url,
          bestCandidateDomain: bestSource.domain ?? null,
          officialDomains,
          consolidatedName: consolidatedName || null,
          inferredBrand: inferredBrand || null,
          sourcesCount: sources.length,
          topConfidence: bestSource.confidence,
          sitemapMatched,
          sitemapCandidateCount,
          verificationResults: verificationResults.map(vr => ({
            url: vr.candidate.url,
            score: vr.verificationScore,
            hasStrongProof: vr.hasStrongProof,
            decisionReason: vr.decisionReason,
            signals: vr.signals,
          })),
        });
      } else {
        updateItemStageStatus(item.id, 'completed', 'No matching product pages found');
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
          stage: 'discovery',
          warning: 'No sources found',
          needsManualReview: true,
          manualReviewReason: 'No sources found',
          consolidatedName: consolidatedName || null,
          inferredBrand: inferredBrand || null,
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
    this.extractionRunning++;
    const done = () => { this.extractionRunning = Math.max(0, this.extractionRunning - 1); };
    try {
      if (!item.sourceUrl) {
        updateItemStageStatus(item.id, 'failed', 'No confirmed source URL');
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
          stage: 'extraction',
          error: 'No confirmed source URL',
        });
        return;
      }

      console.log(`[OnboardingWorker] Extraction for ${item.name} from ${item.sourceUrl}`);

      let domain = '';
      try {
        domain = new URL(item.sourceUrl).hostname.replace(/^www\./, '');
      } catch {
        // Keep the empty domain so the missing-profile failure below remains explicit.
      }
      const profile = domain ? findProfileByDomain(domain) : null;
      if (!profile) {
        const errorMsg = `No extractor profile for ${domain} — profile required`;
        updateItemStageStatus(item.id, 'failed', errorMsg);
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
          stage: 'extraction',
          error: errorMsg,
        });
        return;
      }

      try {
        const extractedData = await extractProductData(item.sourceUrl, {
          name: item.expectedName || item.name,
          brandHint: item.brandHint,
          price: item.price,
        });

        if (item.brandHint && !extractedData.brand) extractedData.brand = item.brandHint;
        if (item.price && !extractedData.price) extractedData.price = item.price;

        insertExtraction({
          itemId: item.id,
          sourceUrl: item.sourceUrl,
          extractionDataJson: JSON.stringify(extractedData),
          extractionMethod: 'worker_crawlee_camoufox',
          confidence: extractedData.confidence,
          imagesJson: null,
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
          `images=${extractedData.additionalImages ? extractedData.additionalImages.length : 0}`
        );

        // Issue #30 PR2: after extraction completes, refresh the batch's
        // candidate cohorts so family readiness reflects the new evidence.
        // Refresh failure must never fail extraction.
        try {
          await refreshCandidateCohorts(this.workspaceId, item.batchId);
        } catch (err) {
          console.warn(`[OnboardingWorker] Candidate cohort refresh failed for batch ${item.batchId} (non-blocking):`, err);
        }
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
    } finally {
      done();
    }
  }

  private async processCuration(item: any): Promise<void> {
    console.log(`[OnboardingWorker] Curation for ${item.name} (${item.upc})`);

    const now = new Date().toISOString();

    // ── Sibling context for family-aware curation ────────────────────────
    // Before running the pipeline, determine product-line groups so the
    // name_consolidation and page-assignment stages receive sibling INPUT
    // context (names, web titles, OCR titles, SKUs) as read-only hints.
    // listItemsByBatch returns full OnboardingItem objects (camelCase).
    let siblingGroup: ReturnType<typeof determineProductGroup> | null = null;
    try {
      const batchItems = listItemsByBatch(item.batchId);
      siblingGroup = determineProductGroup(item as any, batchItems as any);
      if (siblingGroup) {
        console.log(`[OnboardingWorker] Sibling context for ${item.upc}: group "${siblingGroup.groupId}", ${siblingGroup.siblingNames.length} sibling(s)`);
      }
    } catch (err: any) {
      console.warn(`[OnboardingWorker] Sibling context discovery failed (non-blocking): ${err.message}`);
    }

    // Pass sibling context through to the pipeline as read-only input.
    // product-curator.ts checks this first and falls back to its own internal query.
    (item as any).siblingGroup = siblingGroup;

    try {
      const curationData = await curateItemWithPipeline(item, this.workspacePath, this.workspaceId);

      const db = getDb();
      db.query('UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(curationData),
        now,
        item.id,
      );

      updateItemStageStatus(item.id, 'completed');

      // Run cross-sibling consistency check and include warnings in SSE event
      let consistencyWarnings: Array<{ field: string; message: string }> = [];
      try {
        const allWarnings = validateSiblingConsistency(item.batchId);
        consistencyWarnings = allWarnings
          .filter(w => {
            // w.values is Record<sku, string[]> — check if this item's SKU is a key
            return Object.prototype.hasOwnProperty.call(w.values, item.upc);
          })
          .map(w => ({ field: w.field, message: w.message }));
        if (consistencyWarnings.length > 0) {
          console.warn(`[OnboardingWorker] Consistency warnings for ${item.upc}:`, JSON.stringify(consistencyWarnings));
        }
      } catch (err: any) {
        console.warn(`[OnboardingWorker] Consistency check failed (non-blocking): ${err.message}`);
      }

      onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
        stage: 'curation',
        curationData,
        consistencyWarnings: consistencyWarnings.length > 0 ? consistencyWarnings : undefined,
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
      updateItemStageStatus(item.id, 'failed', String(err));
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
        stage: 'curation',
        error: String(err),
      });
    }
  }
}
