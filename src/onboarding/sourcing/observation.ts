import { normalizeGtin } from './contracts';
import type { SourcingEngine } from './contracts';
import {
  getCurrentSourcingGeneration,
  getCurrentGenerationAttempts,
  startSourcingGeneration,
} from '../../db/repositories/onboarding-evidence-repo';

/**
 * Bounded observation helper for Sourcing `observe` mode (ADR 0014
 * Amendment A, Milestone C).
 *
 * Observe mode is SHADOW data collection: the worker looks up distributor
 * connections and persists immutable, generation-scoped evidence attempts
 * (with measured per-attempt `durationMs`) so operators can later evaluate
 * provider quality against the measured rollout gates — but it NEVER writes
 * conflicts, acceptances, decisions, or stage transitions, and an
 * observation failure NEVER becomes a Discovery failure.
 *
 * Idempotency: observation runs ONCE per item (one generation). A repeated
 * poll sees the existing current generation and skips — attempts stay
 * append-only and generation-scoped, and nothing is duplicated or re-run.
 *
 * The caller (the Discovery worker leg) owns the abort/deadline contract;
 * the engine enforces the bounded per-generation deadline internally.
 */

export interface SourcingObservationReport {
  /** False when observation was skipped (not observe-eligible or already observed). */
  observed: boolean;
  generationId: string | null;
  attemptsCreated: number;
  skipped: string[];
  /** Total wall time of this observation attempt (ms). */
  durationMs: number;
}

export async function observeSourcingCandidates(params: {
  item: { id: string; upc: string | null; brandHint?: string | null };
  workspaceId: string;
  engine: SourcingEngine;
}): Promise<SourcingObservationReport> {
  const startedAt = Date.now();
  const { item, workspaceId, engine } = params;

  // Idempotent: an existing current generation means this item was already
  // observed — repeat polling must not duplicate or re-run.
  const existing = getCurrentSourcingGeneration(item.id);
  if (existing) {
    const priorAttempts = getCurrentGenerationAttempts(item.id);
    return {
      observed: false,
      generationId: existing.id,
      attemptsCreated: priorAttempts.length,
      skipped: [],
      durationMs: Date.now() - startedAt,
    };
  }

  // No usable identifier: nothing to look up (never a brand-only lookup).
  if (normalizeGtin(String(item.upc ?? '')) === null) {
    return {
      observed: false,
      generationId: null,
      attemptsCreated: 0,
      skipped: ['no_identifier'],
      durationMs: Date.now() - startedAt,
    };
  }

  const generation = startSourcingGeneration(item.id, 'automatic');
  const result = await engine.runGeneration({
    itemId: item.id,
    generationId: generation.id,
    workspaceId,
    upc: String(item.upc),
    gtin: null,
    brandHint: item.brandHint ?? null,
    signal: AbortSignal.timeout(60_000),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });

  return {
    observed: true,
    generationId: generation.id,
    attemptsCreated: result.attempts.length,
    skipped: result.skipped.map((s) => s.reason),
    durationMs: Date.now() - startedAt,
  };
}
