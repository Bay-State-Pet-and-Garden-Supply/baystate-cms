/**
 * Benchmark Exporter
 *
 * Exports reviewed classification decisions into an immutable Gold benchmark
 * dataset. Rules:
 * - The EXACT reviewed run is exported: gold labels come from the live
 *   (non-superseded) accepted decisions with their effective revised values
 *   and revised targets.
 * - Stale proposals, config-drift runs (no verifiable config snapshot), and
 *   source-drift records are excluded.
 * - Page labels are excluded until verified Page identity exists (an active
 *   verified page import). Until then pageAssignments are always empty.
 * - Examples are content-addressed (exampleHash) and carry the source run,
 *   config snapshot hash, and source product hash.
 * - Splits are deterministic per product family and split seed.
 */

import { getDb } from '../db/connection';
import { normalizeBrand, extractNameStem } from '../onboarding/product-line-grouper';
import { pageNameFromPageValue } from '../shared/proposal-display';
import * as benchmarkRepo from '../db/repositories/benchmark-repo';
import * as classRunRepo from '../db/repositories/classification-run-repo';
import type { BenchmarkGoldLabels } from '../shared/schemas/classification';

export interface ExportBenchmarkOptions {
  name: string;
  holdoutPercent?: number;     // default 20
  splitSeed?: number;          // deterministic reproducibility, default 42
  minDecisionsPerSku?: number; // default 1
}

export interface ExportBenchmarkResult {
  datasetId: string;
  exported: number;
  skipped: number;
  familyCount: number;
  splitDistribution: { train: number; test: number; holdout: number };
  /** Count of SKUs excluded because their run has no verifiable config snapshot. */
  configDriftSkipped: number;
  /** True when Page gold labels were excluded because no verified Page identity exists. */
  pageLabelsExcluded: boolean;
}

/** Deterministic split assignment per family (stable across runs and seeds). */
export function splitForFamily(familyId: string, splitSeed: number, holdoutPercent: number): 'train' | 'test' | 'holdout' {
  let hash = 0x811c9dc5;
  const input = `${familyId}:${splitSeed}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  const score = (hash >>> 0) % 100;
  if (score < holdoutPercent) return 'holdout';
  if (score < holdoutPercent * 2) return 'test';
  return 'train';
}

/** True when an active verified Page import exists (identity is authoritative). */
function hasVerifiedPageIdentity(workspaceId: string): boolean {
  const db = getDb();
  const row = db.query(
    `SELECT COUNT(*) AS c FROM page_imports
     WHERE workspace_id = ? AND status = 'active'
       AND EXISTS (
         SELECT 1 FROM page_index p
         WHERE p.import_id = page_imports.id
           AND p.identity_status = 'verified'
       )`,
  ).get(workspaceId) as { c: number } | undefined;
  return Number(row?.c ?? 0) > 0;
}

export function exportBenchmark(
  workspaceId: string,
  options: ExportBenchmarkOptions,
): ExportBenchmarkResult {
  const db = getDb();
  const holdoutPercent = options.holdoutPercent ?? 20;
  const splitSeed = options.splitSeed ?? 42;
  const minDecisionsPerSku = options.minDecisionsPerSku ?? 1;

  const verifiedPages = hasVerifiedPageIdentity(workspaceId);

  // 1. Create the draft dataset (family review is required before freeze).
  const dataset = benchmarkRepo.createDataset(
    workspaceId,
    options.name,
    'product_family',
    splitSeed,
  );

  // 2. Query qualifying SKUs with reviewed decisions.
  const skuRows = db
    .query(
      `SELECT DISTINCT r.product_sku
       FROM classification_runs r
       JOIN classification_proposals p ON p.run_id = r.id
       JOIN classification_proposal_decisions d ON d.proposal_id = p.id
       WHERE r.workspace_id = ?
         AND r.status IN ('completed', 'completed_with_abstentions')
         AND d.superseded_at IS NULL
         AND p.proposal_type != 'reviewable_abstention'
       GROUP BY r.product_sku
       HAVING COUNT(d.id) >= ?`,
    )
    .all(workspaceId, minDecisionsPerSku) as Array<{ product_sku: string }>;

  let exported = 0;
  let skipped = 0;
  let configDriftSkipped = 0;

  interface CandidateItem {
    sku: string;
    familyId: string;
    inputSnapshotJson: string;
    goldLabels: BenchmarkGoldLabels;
    sourceRunId: string;
    sourceConfigHash: string | null;
    sourceProductHash: string | null;
  }

  const candidates: CandidateItem[] = [];

  for (const { product_sku: sku } of skuRows) {
    const run = classRunRepo.getRecentRun(workspaceId, sku);
    if (!run) {
      skipped++;
      continue;
    }

    // Config-drift exclusion: the run must be bound to a verifiable config
    // snapshot, otherwise its labels cannot be tied to the activated config.
    if (!run.configSnapshotHash) {
      configDriftSkipped++;
      continue;
    }
    const snapshotRow = db.query(
      'SELECT 1 FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
    ).get(workspaceId, run.configSnapshotHash);
    if (!snapshotRow) {
      configDriftSkipped++;
      continue;
    }

    const evidence = classRunRepo.getEvidenceByRun(run.id);
    const proposals = classRunRepo.getProposalsByRun(run.id);
    const decisions = classRunRepo.getLiveDecisionsByRun(run.id);

    const pageAssignments: Array<{ pageName: string; pageId: string | null }> = [];
    const fieldAssignments: Array<{ targetId: string; value: string | null }> = [];
    let productType: string | null = null;
    let brandName = '';
    let productName = sku;

    for (const ev of evidence) {
      if (ev.source === 'catalog_manager_guidance' && ev.snippet) {
        brandName = ev.snippet;
      }
      if (ev.sourceField === 'product_name' && ev.snippet) {
        productName = ev.snippet;
      }
    }

    for (const proposal of proposals) {
      // Source-drift exclusion: stale proposals never become gold.
      if (proposal.isStale) continue;

      const decision = decisions.find(d => d.proposalId === proposal.id);
      if (!decision || decision.decision !== 'accepted') continue;

      let val: string | null;
      if (decision.hasRevisedValue) {
        val = decision.revisedValue === null || decision.revisedValue === undefined
          ? null
          : typeof decision.revisedValue === 'string'
            ? decision.revisedValue
            : JSON.stringify(decision.revisedValue);
      } else {
        val = proposal.proposedValue === null || proposal.proposedValue === undefined
          ? null
          : typeof proposal.proposedValue === 'string'
            ? proposal.proposedValue
            : JSON.stringify(proposal.proposedValue);
      }

      const effectiveTarget = decision.hasRevisedTargetId && decision.revisedTargetId !== undefined
        ? decision.revisedTargetId
        : proposal.targetId;

      if (proposal.proposalType === 'primary_product_type') {
        productType = val;
      } else if (proposal.proposalType === 'category_page') {
        // Page labels are excluded until a verified Page identity exists.
        if (verifiedPages) {
          // Display name comes from the effective value — never the stable
          // Page ID (issue #17 D1).
          const pageName = pageNameFromPageValue(
            decision.hasRevisedValue ? decision.revisedValue : proposal.proposedValue,
            effectiveTarget,
          );
          if (pageName) pageAssignments.push({ pageName, pageId: null });
        }
      } else if (proposal.proposalType === 'field_assignment' && effectiveTarget) {
        fieldAssignments.push({ targetId: effectiveTarget, value: val });
      }
    }

    if (!productType && pageAssignments.length === 0 && fieldAssignments.length === 0) {
      skipped++;
      continue;
    }

    const goldLabels: BenchmarkGoldLabels = {
      productType,
      pageAssignments,
      fieldAssignments,
    };

    const normBrand = normalizeBrand(brandName);
    const stem = extractNameStem(productName);
    const familyId = `family-${normBrand || 'no-brand'}-${stem.slice(0, 30).replace(/\s+/g, '-')}`;

    const inputSnapshotJson = JSON.stringify({
      sku,
      evidence: evidence.map(e => ({
        source: e.source,
        snippet: e.snippet,
        reliability: e.reliability,
        attributeId: e.attributeId,
      })),
    });

    candidates.push({
      sku,
      familyId,
      inputSnapshotJson,
      goldLabels,
      sourceRunId: run.id,
      sourceConfigHash: run.configSnapshotHash,
      sourceProductHash: run.sourceProductHash,
    });
  }

  const uniqueFamilies = new Set(candidates.map(c => c.familyId));
  const splitDistribution = { train: 0, test: 0, holdout: 0 };

  for (const candidate of candidates) {
    const splitGroup = splitForFamily(candidate.familyId, splitSeed, holdoutPercent);
    splitDistribution[splitGroup]++;

    benchmarkRepo.insertExample(
      dataset.id,
      candidate.sku,
      candidate.familyId,
      splitGroup,
      candidate.inputSnapshotJson,
      JSON.stringify(candidate.goldLabels),
      {
        sourceRunId: candidate.sourceRunId,
        sourceConfigHash: candidate.sourceConfigHash,
        sourceProductHash: candidate.sourceProductHash,
      },
    );
    exported++;
  }

  benchmarkRepo.updateDatasetExampleCount(dataset.id);

  return {
    datasetId: dataset.id,
    exported,
    skipped,
    familyCount: uniqueFamilies.size,
    splitDistribution,
    configDriftSkipped,
    pageLabelsExcluded: !verifiedPages,
  };
}
