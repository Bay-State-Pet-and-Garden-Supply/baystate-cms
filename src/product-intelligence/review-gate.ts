/**
 * Review gate (P1-2 review remediation).
 *
 * Agent Lab import requires a durable human approval bound to the EXACT
 * stored result: the decision row's result_hash must equal the run's stored
 * result hash (product_intelligence_results.result_hash, computed at insert
 * time from the persisted result). Using the stored hash avoids any
 * canonicalization drift — the gate compares against the same bytes the
 * executor persisted.
 *
 * Lazy requires (createRequire) keep this module importable under vitest
 * (no bun:sqlite in the module graph) — see pi-executor for the pattern.
 */
import { createRequire } from 'node:module';
import { canonicalJsonStringify, sha256Hex } from '../shared/stable-id';

const lazyRequire = createRequire(import.meta.url);

let _lazy:
  | {
      getPiResult: (runId: string) => { resultHash: string } | undefined;
      hasApprovalForResult: (runId: string, resultHash: string) => boolean;
    }
  | undefined;

function load(): NonNullable<typeof _lazy> {
  if (!_lazy) {
    _lazy = {
      getPiResult: lazyRequire('../db/repositories/product-intelligence-repo').getPiResult as (runId: string) => { resultHash: string } | undefined,
      hasApprovalForResult: lazyRequire('../db/repositories/pi-review-decision-repo').hasApprovalForResult as (runId: string, resultHash: string) => boolean,
    };
  }
  return _lazy;
}

/**
 * Canonical result hash (stable across key orderings). Matches the
 * persisted result_hash convention (sha256 over the result JSON) while
 * using the canonical serializer so identical payloads hash identically.
 */
export function computeResultHash(result: unknown): string {
  return sha256Hex(canonicalJsonStringify(result));
}

/**
 * Fail-closed gate: throws unless the run has a stored result AND the
 * latest review decision approves exactly that stored result hash.
 */
export function assertRunApprovedForImport(runId: string): void {
  const { getPiResult, hasApprovalForResult } = load();
  const stored = getPiResult(runId);
  if (!stored) {
    throw new Error(`run ${runId} has no stored result to import`);
  }
  if (!hasApprovalForResult(runId, stored.resultHash)) {
    throw new Error('run has no durable approval for this result');
  }
}
