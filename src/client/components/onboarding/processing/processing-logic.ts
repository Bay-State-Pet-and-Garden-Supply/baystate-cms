/**
 * Epic #46 — Processing view pure derivation logic (Phase 5).
 *
 * Groups processing work-state items by the server-derived activity and
 * derives stable human-facing labels. All display text comes from the
 * work-state projection (label/detail); this module only groups/orders.
 */
import type {
  OnboardingWorkState,
  WorkActivity,
} from '../../../../shared/schemas/onboarding-work-state';

/** Human-facing group title for each automated activity. */
export const ACTIVITY_TITLES: Record<WorkActivity, string> = {
  distributor_lookup: 'Distributor Lookup',
  official_site_search: 'Official Site Search',
  official_url_verification: 'Official URL Verification',
  extraction: 'Extracting Product Data',
  curation: 'Curating Product Family',
  review: 'Review',
  approval: 'Approval',
  export: 'Export',
};

/** Deterministic group order: acquisition → extraction → curation. */
export const ACTIVITY_ORDER: readonly (WorkActivity | null)[] = [
  'distributor_lookup',
  'official_site_search',
  'extraction',
  'curation',
  null, // null/unknown activities land last as "Other"
];

/** Fallback for unknown/null activities (never crashes on future values). */
export const OTHER_ACTIVITY_TITLE = 'Other';

export function activityTitle(activity: WorkActivity | null): string {
  if (!activity) return OTHER_ACTIVITY_TITLE;
  return ACTIVITY_TITLES[activity] ?? OTHER_ACTIVITY_TITLE;
}

export interface ActivityGroup {
  activity: WorkActivity | null;
  title: string;
  items: OnboardingWorkState[];
}

/**
 * Group processing items by activity in deterministic order.
 * Items with unknown/null activities are grouped under "Other" (last).
 */
export function groupByActivity(items: OnboardingWorkState[]): ActivityGroup[] {
  const byActivity = new Map<WorkActivity | null, OnboardingWorkState[]>();
  for (const item of items) {
    const key = item.activity ?? null;
    const list = byActivity.get(key);
    if (list) list.push(item);
    else byActivity.set(key, [item]);
  }
  const groups: ActivityGroup[] = [];
  for (const activity of ACTIVITY_ORDER) {
    const list = byActivity.get(activity);
    if (list && list.length > 0) {
      groups.push({ activity, title: activityTitle(activity), items: list });
    }
  }
  // Any activity not in the ordered list (future server values) — stable sort.
  const remaining = [...byActivity.entries()]
    .filter(([activity]) => !ACTIVITY_ORDER.includes(activity))
    .sort(([a], [b]) => (a ?? '').localeCompare(b ?? ''));
  for (const [activity, list] of remaining) {
    groups.push({ activity, title: activityTitle(activity), items: list });
  }
  return groups;
}

/**
 * Stable status line for a processing row: prefer the server-derived label,
 * fall back to the activity title. Detail is rendered separately by the row.
 */
export function statusText(item: OnboardingWorkState): string {
  if (item.label && item.label.trim()) return item.label;
  return activityTitle(item.activity);
}
