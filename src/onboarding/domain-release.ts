/**
 * Epic #46 Phase 2 — automation-owned progression: domain-level extraction
 * release.
 *
 * When an extractor profile for a domain becomes usable, blocked extraction
 * items on that domain (stage `extraction`, stage_status `failed`/`needs_input`)
 * must be automatically re-queued — WITHOUT the Store Manager opening each
 * SKU. This module owns that deterministic release:
 *
 * - `releaseDomainExtractionItems(workspaceId, domain, options?)` — the
 *   canonical release primitive (also exposed via the routes agent's
 *   `POST /api/onboarding/domains/:domain/release` endpoint).
 * - `sweepDomainReleases(workspaceId)` — the worker poll-loop sweep: every
 *   blocked extraction item whose domain NOW has a usable profile is released
 *   automatically.
 *
 * Safety properties (fail closed):
 * - distributor-record sources are never released (no page; deterministic
 *   materialization — a profile has nothing to do with them);
 * - by default only PROFILE-BLOCKED failures are released (error text
 *   `No extractor profile for …`); generic scrape failures stay manual so the
 *   sweep can never hot-loop a product-data failure;
 * - the profile must be NEWER than the item's last update (`updatedAt` guard)
 *   — a profile older than the failure cannot be the fix, and this prevents
 *   pathological release→fail→release loops;
 * - releases are idempotent (guarded UPDATE re-asserts blocked status).
 */
import {
  listBlockedExtractionItemsByWorkspace,
  requeueBlockedExtractionItem,
} from '../db/repositories/onboarding-item-repo';
import { findProfileByDomain } from '../db/repositories/extractor-profile-repo';
import { onboardingEvents } from './sse-emitter';

/** Error signature written by `processExtraction` when a profile is missing. */
export const PROFILE_BLOCKED_ERROR_PATTERN = /No extractor profile for/i;

/** Normalize a domain for comparison (lowercase, trim, strip leading `www.`). */
export function normalizeReleaseDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

/** Normalized hostname of a URL (lowercase, `www.` stripped); '' when unparsable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export interface DomainReleaseResult {
  domain: string;
  profileAvailable: boolean;
  releasedIds: string[];
  skipped: Array<{ itemId: string; reason: string }>;
}

export interface DomainReleaseOptions {
  /**
   * When true, every blocked (failed/needs_input) extraction item on the
   * domain is released once a usable profile exists, regardless of the
   * failure text. Intended for the explicit operator-triggered endpoint
   * (profile just set up → release everything on that domain). The worker
   * sweep always uses the default (profile-blocked errors only).
   */
  releaseAllBlocked?: boolean;
  /**
   * Profile `updated_at` override. When provided, the loop-guard comparison
   * uses this instead of the live profile row's `updated_at`. Used by the
   * sweep so every domain is compared against the same snapshot; callers
   * normally omit it.
   */
  minProfileUpdatedAt?: string;
}

/**
 * Canonical domain release. Re-queues eligible blocked extraction items on
 * the domain (guards above). Emits an SSE `item:status` (pending, stage
 * extraction, autoReleased) per released item.
 */
export function releaseDomainExtractionItems(
  workspaceId: string,
  domain: string,
  options: DomainReleaseOptions = {},
): DomainReleaseResult {
  const normalized = normalizeReleaseDomain(domain);
  const profile = findProfileByDomain(normalized);
  if (!profile) {
    return {
      domain: normalized,
      profileAvailable: false,
      releasedIds: [],
      skipped: [{ itemId: '', reason: 'no_usable_profile' }],
    };
  }

  const profileUpdatedAt = options.minProfileUpdatedAt ?? profile.updatedAt;
  const eligible = listBlockedExtractionItemsByWorkspace(workspaceId).filter(row => {
    if (!row.source_url) return false;
    if (hostOf(row.source_url) !== normalized) return false;
    // Loop guard: only re-queue when the blocker changed AFTER the failure —
    // a profile older than the failure cannot be the fix (and repeated
    // release→fail→release cycles are impossible).
    if (Date.parse(profileUpdatedAt) <= Date.parse(row.updated_at)) return false;
    if (!options.releaseAllBlocked && !PROFILE_BLOCKED_ERROR_PATTERN.test(row.error_message ?? '')) {
      return false;
    }
    return true;
  });

  const releasedIds: string[] = [];
  const skipped: Array<{ itemId: string; reason: string }> = [];
  for (const row of eligible) {
    if (requeueBlockedExtractionItem(row.id)) {
      releasedIds.push(row.id);
      onboardingEvents.emitItemStatus(row.batch_id, row.id, 'pending', {
        stage: 'extraction',
        autoReleased: true,
        reason: 'extractor profile now usable',
        domain: normalized,
      });
    } else {
      skipped.push({ itemId: row.id, reason: 'transition_failed' });
    }
  }
  return { domain: normalized, profileAvailable: true, releasedIds, skipped };
}

export interface DomainReleaseSweepResult {
  releasedIds: string[];
  domains: string[];
}

/**
 * Worker poll-loop sweep: find every domain with blocked extraction items
 * that NOW has a usable extractor profile and release those items. One scoped
 * query + per-domain profile lookups; no-op (and cheap) when nothing is
 * blocked. Uses the default profile-blocked-only filter so generic scrape
 * failures never hot-loop.
 */
export function sweepDomainReleases(workspaceId: string): DomainReleaseSweepResult {
  const blocked = listBlockedExtractionItemsByWorkspace(workspaceId);
  const domains = new Set<string>();
  for (const row of blocked) {
    if (!row.source_url) continue;
    const host = hostOf(row.source_url);
    if (host) domains.add(host);
  }
  const releasedIds: string[] = [];
  const releasedDomains: string[] = [];
  for (const domain of domains) {
    const res = releaseDomainExtractionItems(workspaceId, domain);
    if (res.releasedIds.length > 0) {
      releasedIds.push(...res.releasedIds);
      releasedDomains.push(domain);
    }
  }
  return { releasedIds, domains: releasedDomains };
}
