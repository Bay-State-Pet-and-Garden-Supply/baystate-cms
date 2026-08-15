/**
 * Epic #46 — Review workspace shared types (Phase 6).
 */
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ItemDetailResponse } from '../../../onboarding-api';

/** An inspector-loaded item: server projection + enriched detail. */
export interface ReviewInspectorItem {
  workState: OnboardingWorkState;
  /** Enriched detail from GET /onboarding/items/:id (null while loading). */
  detail: ItemDetailResponse | null;
  /** Detail load failure (never silently swallowed). */
  detailError: string | null;
}

/** Editable listing fields surfaced for inline editing during review. */
export interface ReviewDraft {
  curatedTitle: string;
  curatedDescription: string;
  searchKeywords: string;
  brandHint: string;
}