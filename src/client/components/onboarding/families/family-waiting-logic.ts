/**
 * Epic #46 — Family waiting + processing views logic (pure, unit-tested).
 */
import type { OnboardingWorkState, WorkActivity } from '../../../../shared/schemas/onboarding-work-state';

// ─── Family waiting ────────────────────────────────────────────────────────────

export interface FamilyWaitGroup {
  cohortId: string;
  label: string;
  memberCount: number;
  readyCount: number;
  blockedCount: number;
  /** Waiting-on sibling item ids (self excluded). */
  waitingOnItemIds: string[];
  /** The member items in this family present in the current page. */
  items: OnboardingWorkState[];
}

/**
 * Group waiting-on-family items by cohort. Families sort by smallest
 * ready-fraction first (most-stuck first).
 */
export function groupWaitingFamilies(items: OnboardingWorkState[]): FamilyWaitGroup[] {
  const byCohort = new Map<string, FamilyWaitGroup>();
  for (const item of items) {
    const fam = item.family;
    if (!fam) continue;
    let group = byCohort.get(fam.cohortId);
    if (!group) {
      group = {
        cohortId: fam.cohortId,
        label: fam.label ?? 'Product family',
        memberCount: fam.memberCount,
        readyCount: fam.readyCount,
        blockedCount: fam.blockedCount,
        waitingOnItemIds: [...fam.waitingOnItemIds],
        items: [],
      };
      byCohort.set(fam.cohortId, group);
    } else {
      // Take the most complete readiness data we've seen for the cohort.
      group.memberCount = Math.max(group.memberCount, fam.memberCount);
      group.readyCount = Math.max(group.readyCount, fam.readyCount);
      group.blockedCount = Math.max(group.blockedCount, fam.blockedCount);
      for (const wid of fam.waitingOnItemIds) {
        if (!group.waitingOnItemIds.includes(wid)) group.waitingOnItemIds.push(wid);
      }
    }
    group.items.push(item);
  }
  return [...byCohort.values()].sort((a, b) => {
    const fracA = a.memberCount > 0 ? a.readyCount / a.memberCount : 1;
    const fracB = b.memberCount > 0 ? b.readyCount / b.memberCount : 1;
    if (fracA !== fracB) return fracA - fracB;
    return a.label.localeCompare(b.label);
  });
}

/** '3 / 4 products ready' style line. */
export function readinessLine(group: FamilyWaitGroup): string {
  return `${group.readyCount} / ${group.memberCount} products ready`;
}

export function familyIsBlocked(group: FamilyWaitGroup): boolean {
  return group.blockedCount > 0;
}

// ─── Processing ────────────────────────────────────────────────────────────────

export const ACTIVITY_LABELS: Record<WorkActivity, string> = {
  distributor_lookup: 'Distributor Lookup',
  official_site_search: 'Official Site Search',
  official_url_verification: 'Verifying Page',
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

export interface ActivityCount {
  activity: WorkActivity | null;
  label: string;
  count: number;
}

/** Counts per activity for the Processing status strip, sorted by count desc. */
export function activityCounts(items: OnboardingWorkState[]): ActivityCount[] {
  const counts = new Map<string, ActivityCount>();
  for (const item of items) {
    const key = item.activity ?? 'processing';
    const entry = counts.get(key) ?? {
      activity: item.activity,
      label: item.activity ? ACTIVITY_LABELS[item.activity] : 'Processing',
      count: 0,
    };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** Filter processing items by free-text (UPC/name/brand/domain). */
export function filterProcessing<T extends { upc: string; name: string; brand: string | null; domain: string | null }>(
  items: T[],
  q?: string,
): T[] {
  const needle = (q ?? '').trim().toLowerCase();
  if (!needle) return items;
  return items.filter(it =>
    it.upc.toLowerCase().includes(needle) ||
    it.name.toLowerCase().includes(needle) ||
    (it.brand ?? '').toLowerCase().includes(needle) ||
    (it.domain ?? '').toLowerCase().includes(needle),
  );
}
