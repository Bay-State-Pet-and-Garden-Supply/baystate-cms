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
  packaging_ocr: 'Packaging OCR',
  cohort_freezing: 'Cohort Freezing',
  title_coordination: 'Title Coordination',
  page_coordination: 'Page Coordination',
  attribute_curation: 'Attribute Curation',
  semantic_validation: 'Semantic Validation',
  review: 'Review',
  approval: 'Approval',
  export: 'Export',
};

/** Deterministic group order: acquisition → extraction → granular curation → fallback. */
export const ACTIVITY_ORDER: readonly (WorkActivity | null)[] = [
  'distributor_lookup',
  'official_site_search',
  'extraction',
  'packaging_ocr',
  'cohort_freezing',
  'title_coordination',
  'page_coordination',
  'attribute_curation',
  'semantic_validation',
  'curation',
  null, // null/unknown activities land last as "Other"
];

/** Compact badge label for granular curation telemetry (Operate mode: scannable pill). */
export const ACTIVITY_BADGE_LABELS: Record<string, string> = {
  packaging_ocr: '[OCR] Packaging text extraction',
  cohort_freezing: '[Freeze] Resolving product type agreement',
  title_coordination: '[Titles] Coordinating sibling titles',
  page_coordination: '[Pages] Assigning category pages',
  attribute_curation: '[Attr] Curating variant attributes',
  semantic_validation: '[Validate] Validating family consistency',
  curation: 'Curating product family',
  extraction: 'Extracting product data',
  distributor_lookup: 'Distributor lookup',
  official_site_search: 'Official site search',
  official_url_verification: 'URL verification',
};

/** Tooltip explanation for each granular activity. */
export const ACTIVITY_BADGE_TOOLTIPS: Record<string, string> = {
  packaging_ocr: 'Running packaging OCR on the primary image — extracting visible text for brand and attribute evidence.',
  cohort_freezing: 'Resolving family product-type agreement and capturing cohort snapshots before curation.',
  title_coordination: 'Generating and validating synchronized titles across sibling variants in the family.',
  page_coordination: 'Assigning verified store category pages for each curated product.',
  attribute_curation: 'Executing member attribute rules and value extraction for each variant.',
  semantic_validation: 'Validating family consistency — shared brand, product type, and attribute applicability.',
  curation: 'Family curation is active — a granular sub-stage will appear when telemetry is available.',
};

export function getActivityBadgeLabel(activity: WorkActivity | null): string {
  if (!activity) return 'Processing';
  return ACTIVITY_BADGE_LABELS[activity] ?? activityTitle(activity);
}

export function getActivityBadgeTooltip(activity: WorkActivity | null, detail?: string | null): string {
  if (detail && detail.trim()) return detail;
  if (!activity) return 'Automation is handling this item.';
  return ACTIVITY_BADGE_TOOLTIPS[activity] ?? activityTitle(activity);
}

export function isGranularCurationActivity(activity: WorkActivity | null): boolean {
  return (
    activity === 'packaging_ocr' ||
    activity === 'cohort_freezing' ||
    activity === 'title_coordination' ||
    activity === 'page_coordination' ||
    activity === 'attribute_curation' ||
    activity === 'semantic_validation'
  );
}

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
