/**
 * Pipeline Board family indicator hook (issue #30, PR2).
 *
 * Fetches the batch's active candidate curation cohorts
 * (`GET /api/onboarding/batches/:id/cohorts`) and derives a per-item family
 * state map for the curation-stage badge. Derived state only — cohort
 * execution does not exist yet. Failures are silently ignored so the family
 * indicator can never break the Pipeline Board.
 */
import { useCallback, useEffect, useState } from 'react';
import { getBatchCohorts } from '../onboarding-api';
import type { CurationCohortView } from '../../shared/schemas/cohorts';

export interface CohortFamilyStateByItem {
  [itemId: string]: {
    groupLabel: string;
    cohortStatus: string;
    memberCount: number;
    readyCount: number;
    waitingOnCount: number;
    blockedReason: string | null;
  };
}

export interface CohortFamilyState {
  cohorts: CurationCohortView[];
  byItem: CohortFamilyStateByItem;
  refresh: () => Promise<void>;
}

export function useCohortFamilyState(batchId: string): CohortFamilyState {
  const [cohorts, setCohorts] = useState<CurationCohortView[]>([]);
  const [byItem, setByItem] = useState<CohortFamilyStateByItem>({});

  const refresh = useCallback(async () => {
    if (!batchId) return;
    try {
      const res = await getBatchCohorts(batchId);
      const views = res.cohorts ?? [];
      setCohorts(views);
      const map: CohortFamilyStateByItem = {};
      for (const view of views) {
        for (const member of view.members) {
          map[member.onboardingItemId] = {
            groupLabel: view.cohort.groupLabel,
            cohortStatus: view.status,
            memberCount: view.memberCount,
            readyCount: view.readyCount,
            waitingOnCount: view.waitingOn.length,
            blockedReason: view.blockedReason,
          };
        }
      }
      setByItem(map);
    } catch {
      // Cohort state is derived and optional — never surface errors on the board.
    }
  }, [batchId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { cohorts, byItem, refresh };
}
