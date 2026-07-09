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
import { verifyTopCandidates, type VerificationResult } from './page-verifier';
import { findBrandSites } from '../db/repositories/brand-site-repo';
import { extractProductData } from './page-extractor';
import { findProfileByDomain } from '../db/repositories/extractor-profile-repo';
import { curateItem, curateItemWithPipeline } from './product-curator';
import { isModularCurationEnabled } from './curation-mode';
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
 * Build a human-readable reason string for why auto-selection was skipped.
 * Returned strings are prefixed with `needs_review:` so the UI can
 * distinguish them from other error messages. When sitemap candidates
 * were discovered but none cleared the auto-select threshold, the
 * reason notes that explicitly so reviewers know to look at them.
 */
function manualReviewReasonForDiscovery(
  item: any,
  bestSource: any,
  officialDomains: string[],
  sitemapCandidateCount = 0,
): string {
  if (bestSource && bestSource.metadataJson) {
    try {
      const meta = JSON.parse(bestSource.metadataJson);
      if (meta.variantResolution?.status === 'ambiguous') {
        return `needs_review: variant resolution is ambiguous for base product page: ${meta.variantResolution.variantTitle || 'unknown'}`;
      }
    } catch {}
  }
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
  // Global concurrency limit across all stages.
  // Extraction has a separate, lower limit to avoid triggering bot
  // detection on target websites during concurrent page scrapes.
  private maxConcurrency = 10;
  private maxExtractionConcurrency = 3;
  private extractionRunning = 0;
  private isProcessing = false;
  private workspacePath: string;
  private workspaceId: string;

  constructor(workspaceId: string, workspacePath: string, maxConcurrency = 10, maxExtractionConcurrency = 3) {
    this.workspaceId = workspaceId;
    this.workspacePath = workspacePath;
    this.maxConcurrency = maxConcurrency;
    this.maxExtractionConcurrency = maxExtractionConcurrency;
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

        // Extraction has a separate concurrency limit to avoid bot detection
        if (stage === 'extraction' && this.extractionRunning >= this.maxExtractionConcurrency) continue;

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

    // ── Brand guard: discovery is useless without a brand ──────────────────
    if (!item.brandHint || !String(item.brandHint).trim()) {
      console.log(`[OnboardingWorker] ⚠ Skipping discovery for "${item.name}" (${item.upc}): no brand assigned`);
      updateItemStageStatus(item.id, 'completed', 'needs_review: no brand assigned — set a brand before discovery');
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
        stage: 'discovery',
        warning: 'No brand assigned',
        needsManualReview: true,
        manualReviewReason: 'no brand assigned — set a brand before discovery',
        consolidatedName: null,
        sitemapMatched: false,
        sitemapCandidateCount: 0,
      });
      return;
    }

    try {
      const discovery = await discoverSources(item.upc, item.name, item.brandHint, {
        price: item.price ? parseFloat(item.price) : null
      });
      const sources = discovery.candidates;
      const consolidatedName = discovery.consolidatedName;

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
        const officialDomains = getOfficialDomainsForBrand(item.brandHint);
        const verificationResults: VerificationResult[] = sources.length > 0
          ? await verifyTopCandidates(sources, {
              upc: item.upc,
              expectedName: consolidatedName || item.name,
              brandHint: item.brandHint,
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

        const autoSelectedResult = verifiedStrong.length > 0
          ? verifiedStrong[0]
          : null;
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
        done();
        return;
      }

      console.log(`[OnboardingWorker] Extraction for ${item.name} from ${item.sourceUrl}`);

      let domain = '';
      try {
        domain = new URL(item.sourceUrl).hostname.replace(/^www\./, '');
      } catch {}
      const profile = domain ? findProfileByDomain(domain) : null;
      if (!profile) {
        const errorMsg = `No extractor profile for ${domain} — profile required`;
        updateItemStageStatus(item.id, 'failed', errorMsg);
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
          stage: 'extraction',
          error: errorMsg,
        });
        done();
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
    let curationData: import('../shared/schemas/onboarding').CurationData;

    try {
      // ── Cohort name coordination ─────────────────────────────────────
      // Before running the pipeline, check if this item already has a
      // pre-computed coordinated title. If not, coordinate the entire
      // batch's product-line groups in ONE LLM call per group.
      if (isModularCurationEnabled() && !item.coordinatedTitle) {
        try {
          const { listItemsByBatch } = await import('../db/repositories/onboarding-item-repo');
          const { coordinateCohortItems } = await import('./cohort-name-coordinator');

          const batchItems = listItemsByBatch(item.batchId);
          const coordinatedTitles = await coordinateCohortItems(batchItems);

          if (coordinatedTitles.size > 0) {
            const db = getDb();
            const now = new Date().toISOString();
            for (const [upc, title] of coordinatedTitles) {
              db.query(
                'UPDATE onboarding_items SET coordinated_title = ?, updated_at = ? WHERE upc = ? AND batch_id = ?',
              ).run(title, now, upc, item.batchId);
            }

            // Re-read this item's coordinated title
            const updated = db.query('SELECT coordinated_title FROM onboarding_items WHERE id = ?').get(item.id) as
              | { coordinated_title: string | null }
              | undefined;
            if (updated?.coordinated_title) {
              item.coordinatedTitle = updated.coordinated_title;
              console.log(`[OnboardingWorker] Cohort coordinated title for ${item.upc}: "${updated.coordinated_title}"`);
            }
          }
        } catch (err: any) {
          console.warn(`[OnboardingWorker] Cohort coordination failed for ${item.upc}, falling back to per-item: ${err.message}`);
        }
      }

      if (isModularCurationEnabled()) {
        console.log(`[OnboardingWorker] Using modular curation pipeline for "${item.name}"`);
        try {
          curationData = await curateItemWithPipeline(item, this.workspacePath, this.workspaceId);
        } catch (modularErr) {
          console.error(`[OnboardingWorker] Modular curation failed for ${item.id}; falling back to legacy:`, modularErr);
          curationData = await curateItem(item, this.workspacePath);
        }
      } else {
        curationData = await curateItem(item, this.workspacePath);
      }

      const db = getDb();
      db.query('UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(curationData),
        now,
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
      // Curation failure is not blocking — populate defaults with classification containers
      const defaultCuration = {
        curatedTitle: item.name,
        packagingOcrTitle: null,
        titleSource: 'web' as const,
        suggestedPages: [],
        suggestedProductType: null,
        curatedAt: now,
        curationMethod: 'auto' as const,
        classificationRunId: null,
        classificationConfigSnapshot: null,
        classificationEvidence: [] as any[],
        classificationProposals: [] as any[],
        classificationDecisions: [] as any[],
        classificationHistory: [] as any[],
      };
      const db = getDb();
      db.query('UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(defaultCuration),
        now,
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
