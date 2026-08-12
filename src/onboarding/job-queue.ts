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
import {
  freezeCohortForExecution,
  processCohort,
  verifyCohortRunFrozen,
  observeCohortShadowTypeResolution,
} from './cohort-curator';
import type { CohortShadowObservation } from './cohort-curator';
import { getCohortCurationFlags } from '../classification/flags';
import type { CohortCurationFlags } from '../classification/flags';
import {
  claimReadyCurationCohorts,
  reclaimExpiredCohortRuns,
  getCurrentCohortRun,
  supersedeCohortRun,
  COHORT_LEASE_TTL_MS,
} from '../db/repositories/classification-cohort-run-repo';
import { getCohortById, listCohortsByWorkspace } from '../db/repositories/curation-cohort-repo';
import type { CohortRun } from '../shared/schemas/cohorts';
import { determineProductGroup } from './product-line-grouper';
import { validateSiblingConsistency, activeCohortSemanticFindingsForItem } from '../classification/consistency-validator';
import { insertExtraction } from '../db/repositories/onboarding-extraction-repo';
import { onboardingEvents } from './sse-emitter';
import { getDb } from '../db/connection';
import type { OnboardingSource, PipelineStage } from '../shared/schemas/onboarding';

const AUTO_STAGES: PipelineStage[] = ['curation', 'extraction', 'discovery'];

// ─── Cohort-centric Curation V2 (issue #30, PR3 M3) ───────────────────────────

/**
 * Flag OFF (default): Curation is per-item, byte-identical to today.
 * Flag ON + shadowOnly: observe-only — the legacy per-item path stays in
 * place and NOTHING claims cohorts (PI shadow precedent: runs may execute,
 * results are never promoted — here: no claiming in shadow).
 * Flag ON + !shadowOnly: Curation is cohort-claimed EXCLUSIVELY — `poll()`
 * never calls `claimItemsForProcessing('curation', ...)`; ownership flows
 * reclaim → reconcile-drift-before-claimable → claimReadyCurationCohorts →
 * freeze → processCohort (implementation-plan section A, D8/D9).
 */
function isCohortCurationActive(flags: CohortCurationFlags): boolean {
  return flags.cohortCurationV2Enabled && !flags.cohortShadowOnly;
}

/** Terminal parent-run states that remain the current historical decision
 *  until drift supersedes them (D9 — never re-claimed while they match). */
const COHORT_RUN_TERMINAL = new Set([
  'completed',
  'completed_with_abstentions',
  'completed_with_member_failures',
  'failed',
  'cancelled',
]);

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
  // PR4 C5: cohortId → last logged shadow observation line. The shadow
  // observer recomputes on every poll (ready cohorts are cheap and few); the
  // log line is emitted only when the outcome detail CHANGES so shadow mode
  // never floods the worker log.
  private shadowObservedOutcomes = new Map<string, string>();

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

    // PR3 M3 (issue #30): startup recovery for crashed cohort workers — reclaim
    // expired cohort-run leases (resume-on-match / supersede-on-drift) right
    // next to the item stale sweep. Flag-gated: OFF/shadow mode never touches
    // cohort runs. Resumed runs are dispatched to the freeze/execute path so a
    // crash never strands a claimed cohort.
    const flags = getCohortCurationFlags();
    if (isCohortCurationActive(flags)) {
      try {
        // PR3 hardening (Commit A): expiry timestamps compare to NOW — the
        // caller passes `new Date().toISOString()`, never `now - TTL` (a lease
        // is reclaimable the moment it passes its TTL, not a full TTL later).
        const nowIso = new Date().toISOString();
        const reclaim = reclaimExpiredCohortRuns(
          this.workspaceId,
          nowIso,
          run => verifyCohortRunFrozen(run, this.workspacePath, this.workspaceId) ? 'match' : 'drift',
          this.workerId,
          COHORT_LEASE_TTL_MS,
        );
        if (reclaim.resumed.length > 0) {
          console.log(`[OnboardingWorker] Startup reclaim: resumed ${reclaim.resumed.length} expired cohort run(s): ${reclaim.resumed.map(r => r.id).join(', ')}`);
        }
        if (reclaim.superseded.length > 0) {
          console.warn(`[OnboardingWorker] Startup reclaim: superseded ${reclaim.superseded.length} drifted cohort run(s).`);
        }
        for (const run of reclaim.resumed) this.dispatchCohortRun(run);
      } catch (err) {
        console.error('[OnboardingWorker] Failed to reclaim expired cohort runs on startup:', err);
      }
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

  /** Await all in-flight processing promises (tests, graceful shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
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

        // PR3 M3 (issue #30): with the cohort flag active, Curation is
        // cohort-claimed EXCLUSIVELY — reclaim expired leases, reconcile
        // drift-before-claimable, claim ready cohorts and dispatch them to
        // the freeze/execute path. `claimItemsForProcessing('curation', ...)`
        // is NEVER called in this mode; Discovery/Extraction stay per-item.
        if (stage === 'curation' && isCohortCurationActive(getCohortCurationFlags())) {
          this.claimAndDispatchCohortRuns(inFlightBatches);
          continue;
        }
        // PR4 C5 (DECISION-E): shadow mode (`cohortCurationV2Enabled` ON +
        // `cohortShadowOnly`) — run the DETERMINISTIC-ONLY cohort Execution
        // Product Type resolution over ready cohorts, log the outcome, write
        // NOTHING (no runs claimed, no PR4 columns, no dependency rows, no
        // model calls). The legacy per-item Curation path below then runs
        // unchanged — byte-identical PR3 shadow semantics.
        if (stage === 'curation') {
          const curationFlags = getCohortCurationFlags();
          if (curationFlags.cohortCurationV2Enabled && curationFlags.cohortShadowOnly) {
            try {
              this.observeCohortTypeShadow();
            } catch (err) {
              console.error('[OnboardingWorker] Shadow cohort type observation failed (non-blocking):', err);
            }
          }
        }

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

  // ─── Cohort-centric Curation V2 (issue #30, PR3 M3) ─────────────────────────

  /**
   * The cohort curation leg of `poll()` (flag ON + !shadowOnly only):
   * 1. reclaim expired cohort-run leases (live sibling recovery; reconcile
   *    drift BEFORE deciding claimability — D9);
   * 2. reconcile ready cohorts whose CURRENT terminal run no longer matches
   *    the frozen world (supersede opens the claim slot); a matching terminal
   *    run stays the current historical decision (no new run);
   * 3. claim ready curation cohorts and dispatch each to the freeze/execute
   *    path.
   *
   * Everything is best-effort — a failure here never breaks the poll loop,
   * and ordinary GET/read endpoints never mutate runs (D9: this runs ONLY in
   * the worker poll path).
   */
  private claimAndDispatchCohortRuns(inFlightBatches: Set<string>): void {
    try {
      // PR3 hardening (Commit A): expiry timestamps compare to NOW.
      const nowIso = new Date().toISOString();
      const reclaim = reclaimExpiredCohortRuns(
        this.workspaceId,
        nowIso,
        run => verifyCohortRunFrozen(run, this.workspacePath, this.workspaceId) ? 'match' : 'drift',
        this.workerId,
        COHORT_LEASE_TTL_MS,
      );
      if (reclaim.resumed.length > 0) {
        console.log(`[OnboardingWorker] Reclaimed ${reclaim.resumed.length} expired cohort run(s): ${reclaim.resumed.map(r => r.id).join(', ')}`);
        for (const run of reclaim.resumed) this.dispatchCohortRun(run, inFlightBatches);
      }
      if (reclaim.superseded.length > 0) {
        console.warn(`[OnboardingWorker] Superseded ${reclaim.superseded.length} drifted cohort run(s) during reclaim.`);
      }

      this.reconcileDriftedTerminalRuns();

      const available = this.maxConcurrency - this.running.size;
      if (available <= 0) return;
      const claimed = claimReadyCurationCohorts(this.workspaceId, available, this.workerId, COHORT_LEASE_TTL_MS);
      for (const run of claimed) this.dispatchCohortRun(run, inFlightBatches);
    } catch (err) {
      console.error('[OnboardingWorker] Cohort curation leg failed (non-blocking):', err);
    }
  }

  /**
   * D9 reconcile-before-claimable: for every READY cohort whose current
   * (non-superseded) run is in a terminal state, verify the frozen world
   * still matches (`verifyCohortRunFrozen`). Drift → supersede the old run
   * (opens the slot so the claim can create a fresh run); match → leave the
   * terminal run as the current historical decision (never re-claimed until
   * drift supersedes it). Never runs from read endpoints.
   *
   * PR3 hardening (Commit A, R5): a `cancelled` current run is a RETRYABLE
   * terminal — a cancelled pre-freeze run never carries frozen evidence (it
   * left `freezing` via `cancelFreezingRun` with NULL hashes), so it is
   * superseded unconditionally before claiming and the slot reopens. A
   * `failed`/completed run is re-verified against the frozen world as before.
   */
  private reconcileDriftedTerminalRuns(): void {
    const readyCohorts = listCohortsByWorkspace(this.workspaceId).filter(c => c.status === 'ready');
    for (const cohort of readyCohorts) {
      const current = getCurrentCohortRun(cohort.id);
      if (!current || !COHORT_RUN_TERMINAL.has(current.status)) continue;
      // Cancelled ⇒ retryable: supersede so the claim slot reopens. This never
      // needs a frozen-world re-verification (there is no frozen world to
      // match — a cancelled pre-freeze run has no evidence snapshot).
      if (current.status === 'cancelled') {
        supersedeCohortRun(current.id, 'Cancelled run retry (slot reopen)');
        console.warn(`[OnboardingWorker] Superseded cancelled run ${current.id} for ready cohort ${cohort.id} — slot reopened.`);
        continue;
      }
      if (verifyCohortRunFrozen(current, this.workspacePath, this.workspaceId)) {
        // Frozen world still matches — the terminal run is the current
        // historical decision; a new run is NOT created.
        continue;
      }
      supersedeCohortRun(current.id, 'Authority drift during pre-claim reconciliation');
      console.warn(`[OnboardingWorker] Superseded drifted terminal run ${current.id} for ready cohort ${cohort.id}.`);
    }
  }

  /**
   * PR4 C5 shadow-mode observation (DECISION-E): compute the deterministic-only
   * cohort Execution Product Type resolution over every ready cohort and log a
   * structured `cohort_product_type_shadow` line (cohort id, outcome,
   * per-member ids/sources) on change. The observer writes NOTHING — no run
   * rows, no PR4 columns, no dependency rows, no model calls — and the log
   * line is the only artifact (byte-identical PR3 shadow behavior otherwise).
   */
  private observeCohortTypeShadow(): void {
    let observations: CohortShadowObservation[];
    try {
      observations = observeCohortShadowTypeResolution(this.workspaceId, this.workspacePath);
    } catch (err) {
      console.warn(`[OnboardingWorker] Shadow cohort type resolution failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const observation of observations) {
      const detail = observation.perMember
        .map(member =>
          `${member.onboardingItemId}${member.productSku ? `(${member.productSku})` : ''}:${member.productTypeId ?? 'abstained'}@${member.source ?? 'none'}`,
        )
        .join('; ');
      const line = `cohort_product_type_shadow: cohort=${observation.cohortId} outcome=${observation.outcome} members=[${detail}]`;
      if (this.shadowObservedOutcomes.get(observation.cohortId) === line) continue;
      this.shadowObservedOutcomes.set(observation.cohortId, line);
      console.log(line);
    }
  }

  /** Dispatch a claimed/resumed cohort run to the freeze + execute path. */
  private dispatchCohortRun(run: CohortRun, inFlightBatches?: Set<string>): void {
    if (this.running.has(run.id)) return;
    if (inFlightBatches) {
      try {
        const cohort = getCohortById(run.cohortId);
        if (cohort) inFlightBatches.add(cohort.batchId);
      } catch { /* best-effort refresh set */ }
    }
    const promise = this.processCohortRun(run);
    this.running.set(run.id, promise);
    promise.finally(() => this.running.delete(run.id));
  }

  /**
   * Execute one cohort run: `freezing` → freeze (CAS; superseded-on-drift is
   * a normal outcome) → `running` → `processCohort`. Errors are logged and
   * never break the poll loop; a run that fails to freeze stays claimed and
   * is recovered by a later reclaim once its lease expires.
   */
  private async processCohortRun(run: CohortRun): Promise<void> {
    console.log(`[OnboardingWorker] Processing cohort run ${run.id} (cohort ${run.cohortId}, status=${run.status})`);
    try {
      let current = run;
      if (current.status === 'freezing') {
        const finalized = await freezeCohortForExecution(current, this.workspacePath, this.workspaceId);
        if (finalized.status !== 'running') {
          console.warn(`[OnboardingWorker] Cohort run ${run.id} freeze did not finalize (${finalized.status}): ${finalized.errorMessage ?? 'no reason'}`);
          return;
        }
        current = finalized;
      }
      if (current.status === 'running') {
        await processCohort(current, this.workspacePath, this.workspaceId);
      }
    } catch (err) {
      console.error(`[OnboardingWorker] Cohort run ${run.id} failed:`, err);
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

      // PR9 C3 (issue #30, DECISION-C): in ACTIVE cohort mode an item whose
      // active run is a cohort child surfaces the NEW validator's findings
      // instead of the legacy `validateSiblingConsistency` warnings
      // (legacy/shadow keep the legacy warnings byte-identical — the
      // defensive branch below is unreachable in practice because active mode
      // curates cohorts exclusively). PR9 review R1 (B6): the discriminated
      // surface never falls back to legacy live-regrouping in active mode.
      const semanticSurface = activeCohortSemanticFindingsForItem(item);
      // Run cross-sibling consistency check and include warnings in SSE event
      let consistencyWarnings: Array<{ field: string; message: string }> = [];
      try {
        if (semanticSurface.mode === 'active') {
          consistencyWarnings = semanticSurface.semanticValidation.findings.map(finding => ({
            field: finding.code,
            message: finding.message,
          }));
        } else {
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
        }
      } catch (err: any) {
        console.warn(`[OnboardingWorker] Consistency check failed (non-blocking): ${err.message}`);
      }

      onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
        stage: 'curation',
        curationData,
        consistencyWarnings: consistencyWarnings.length > 0 ? consistencyWarnings : undefined,
        semanticValidation: semanticSurface.mode === 'active' ? semanticSurface.semanticValidation : undefined,
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
