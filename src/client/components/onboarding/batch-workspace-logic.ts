/**
 * Epic #46 — Batch Workspace pure derivation helpers (Phase 3).
 *
 * All non-trivial presentation logic for the Batch Workspace shell lives here
 * so it can be unit-tested without a DOM. Components consume these helpers and
 * never re-implement ordering/formatting/prominence rules inline.
 */
import type {
  WorkStateCategory,
  WorkStateCounts,
  WorkStateFilters,
  ReviewState,
} from '../../../shared/schemas/onboarding-work-state';

// ─── Tabs ──────────────────────────────────────────────────────────────────────

export type WorkspaceTabId =
  | 'needs_attention'
  | 'processing'
  | 'waiting_on_family'
  | 'review'
  | 'approved'
  | 'ready_to_export';

export interface WorkspaceTabDef {
  id: WorkspaceTabId;
  /** Human-facing tab label (epic UX workstream 1 ordering). */
  label: string;
  /** Primary category the tab's feature view surfaces. */
  category: WorkStateCategory;
  /** Categories whose counts appear on the tab badge. */
  countCategories: WorkStateCategory[];
  /** Plain-language guidance shown when the tab's items are empty. */
  emptyMessage: string;
  /** Subtitle shown under the tab label in the tab bar (accessible context). */
  description: string;
}

/**
 * Canonical tab order. Needs Attention is FIRST because it is the main
 * interactive area while automation is running (epic UX workstream 1).
 */
export const WORKSPACE_TABS: readonly WorkspaceTabDef[] = [
  {
    id: 'needs_attention',
    label: 'Needs Attention',
    category: 'needs_attention',
    countCategories: ['needs_attention'],
    description: 'Products where automation stopped and needs your judgment.',
    emptyMessage: 'Nothing needs you right now — automation is working.',
  },
  {
    id: 'processing',
    label: 'Processing',
    category: 'processing',
    countCategories: ['processing'],
    description: 'Products being handled automatically — no action needed.',
    emptyMessage: 'No products are processing right now.',
  },
  {
    id: 'waiting_on_family',
    label: 'Waiting on Family',
    category: 'waiting_on_family',
    countCategories: ['waiting_on_family'],
    description: 'Products whose family members are not ready for Curation yet.',
    emptyMessage: 'No families are waiting — every family is ready to curate.',
  },
  {
    id: 'review',
    label: 'Review',
    category: 'ready_for_review',
    countCategories: ['ready_for_review'],
    description: 'Completed listings waiting for your final inspection.',
    emptyMessage: 'Nothing to review yet — Curation output will land here.',
  },
  {
    id: 'approved',
    label: 'Approved',
    category: 'approved',
    countCategories: ['approved'],
    description: 'Approved products awaiting export draft creation.',
    emptyMessage: 'No approved products yet — approve reviewed products to see them here.',
  },
  {
    id: 'ready_to_export',
    label: 'Ready to Export',
    category: 'ready_to_export',
    countCategories: ['ready_to_export', 'completed'],
    description: 'Export drafts ready for Store release.',
    emptyMessage: 'No export-ready products yet.',
  },
];

export function getWorkspaceTab(id: WorkspaceTabId): WorkspaceTabDef {
  const tab = WORKSPACE_TABS.find(t => t.id === id);
  if (!tab) {
    throw new Error(`Unknown workspace tab id: ${id}`);
  }
  return tab;
}

/** Sum of the categories a tab's badge should display. */
export function getTabCount(tab: WorkspaceTabDef, counts: WorkStateCounts): number {
  return tab.countCategories.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
}

// ─── Counts / prominence ───────────────────────────────────────────────────────

export function totalItemCount(counts: WorkStateCounts): number {
  return (
    counts.processing +
    counts.needs_attention +
    counts.waiting_on_family +
    counts.ready_for_review +
    counts.approved +
    counts.ready_to_export +
    counts.completed +
    counts.skipped
  );
}

/**
 * Needs Attention is the most prominent number while automation is running:
 * any non-zero attention count is urgent.
 */
export function attentionIsUrgent(counts: WorkStateCounts): boolean {
  return counts.needs_attention > 0;
}

/** Locale-formatted count with thousands separators (e.g. "1,234"). */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

// ─── Filters ───────────────────────────────────────────────────────────────────

export interface WorkspaceFilterInput {
  /** Free-text query across UPC / name / brand. */
  q?: string;
  /** Durable review state filter ('' = any). */
  reviewState?: ReviewState | '';
  /** Source type filter ('' = any). */
  sourceType?: 'official_page' | 'distributor_record' | '';
  /** Category filter ('' = across all categories). */
  category?: WorkStateCategory | '';
}

/** Build server-safe filters from UI state. Trims queries; omits empty values. */
export function buildWorkStateFilters(input: WorkspaceFilterInput): WorkStateFilters {
  const filters: WorkStateFilters = {};
  const q = (input.q ?? '').trim();
  if (q) filters.q = q;
  if (input.reviewState) filters.reviewState = input.reviewState;
  if (input.sourceType) filters.sourceType = input.sourceType;
  if (input.category) filters.category = input.category;
  return filters;
}

/** True when any cross-category filter (not pure category) is active. */
export function hasActiveFilters(filters: WorkStateFilters): boolean {
  return Boolean(filters.q || filters.reviewState || filters.sourceType || filters.domain || filters.cohortId);
}

// ─── Labels ────────────────────────────────────────────────────────────────────

export const WORK_STATE_CATEGORY_LABELS: Record<WorkStateCategory, string> = {
  processing: 'Processing',
  needs_attention: 'Needs Attention',
  waiting_on_family: 'Waiting on Family',
  ready_for_review: 'Ready for Review',
  approved: 'Approved',
  ready_to_export: 'Ready to Export',
  completed: 'Completed',
  skipped: 'Skipped',
};

export function reviewStateLabel(state: ReviewState): string {
  switch (state) {
    case 'not_ready':
      return 'Not ready';
    case 'unreviewed':
      return 'Unreviewed';
    case 'reviewed':
      return 'Reviewed';
    case 'approved':
      return 'Approved';
    default:
      return state;
  }
}

export function sourceTypeLabel(sourceType: 'official_page' | 'distributor_record' | null): string {
  if (sourceType === 'distributor_record') return 'Distributor record';
  if (sourceType === 'official_page') return 'Official page';
  return '—';
}

/** Map a work-state category to the tab that surfaces it ('' stays in results). */
export function workspaceTabForCategory(category: WorkStateCategory): WorkspaceTabId | null {
  switch (category) {
    case 'needs_attention':
      return 'needs_attention';
    case 'processing':
      return 'processing';
    case 'waiting_on_family':
      return 'waiting_on_family';
    case 'ready_for_review':
      return 'review';
    case 'approved':
      return 'approved';
    case 'ready_to_export':
    case 'completed':
      return 'ready_to_export';
    case 'skipped':
      return 'approved';
    default:
      return null;
  }
}
