/**
 * Epic #46 — Waiting on Family view (Phase 5).
 *
 * Products whose own extraction evidence is ready but whose cohort cannot
 * start Curation until siblings are ready or unblocked (ADR 0013 barrier).
 * Primary human action: usually NONE from this view — families deep-link
 * directly to the blocking sibling's Needs Attention task.
 *
 * Contract export (cross-agent):
 * `FamilyWaitingView({ batchId, onOpenItem })`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { OnboardingWorkState, WorkStateCategory } from '../../../../shared/schemas/onboarding-work-state';
import type { CurationCohortView } from '../../../../shared/schemas/cohorts';
import { getBatchWorkState, subscribeBatchEvents } from '../../../onboarding-work-api';
import { getBatchCohorts } from '../../../onboarding-api';
import { buildFamilyCards, type FamilyCard } from './family-logic';
import { FamilyReadinessCard } from './FamilyReadinessCard';
import './families.css';

interface FamilyWaitingViewProps {
  batchId: string;
  /** Deep-link opener: the shell opens the sibling's Needs Attention task. */
  onOpenItem?: (itemId: string) => void;
}

type LoadState = 'loading' | 'ready' | 'error';

export function FamilyWaitingView({ batchId, onOpenItem }: FamilyWaitingViewProps) {
  const [cards, setCards] = useState<FamilyCard[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const [payload, attentionPayload, cohortRes] = await Promise.all([
        getBatchWorkState(batchId, { category: 'waiting_on_family', limit: 500 }),
        getBatchWorkState(batchId, { category: 'needs_attention', limit: 500 }).catch(() => null),
        getBatchCohorts(batchId).catch(() => null), // Cohorts are canonical; degrade gracefully.
      ]);
      const waitingItems: OnboardingWorkState[] = payload.items;
      const cohortViews: CurationCohortView[] = cohortRes?.cohorts ?? [];
      // Sibling category map (waiting + needs_attention). Members that are
      // merely processing are absent, so their family action renders as a
      // non-actionable note rather than an irrelevant URL-decision workflow.
      const categories = new Map<string, WorkStateCategory>();
      for (const it of waitingItems) categories.set(it.itemId, it.category);
      for (const it of attentionPayload?.items ?? []) categories.set(it.itemId, it.category);
      setCards(buildFamilyCards(waitingItems, cohortViews, categories));
      setState('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load waiting families');
      setState('error');
    }
  }, [batchId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load();
      if (cancelled) return;
    })();
    const unsubscribe = subscribeBatchEvents(batchId, () => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [batchId, load]);

  if (state === 'error') {
    return (
      <div className="fw-error" role="alert">
        <span>{error}</span>
        <button type="button" className="btn btn-outline" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  if (state === 'loading') {
    return <div className="fw-loading">Loading families…</div>;
  }

  if (cards.length === 0) {
    return (
      <div className="fw-empty">
        <p className="fw-empty-title">No families are waiting right now</p>
        <p className="fw-empty-copy">
          Families wait until every member is extraction-ready before Curation starts — no
          partial-family Curation.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="fw-note">
        <p className="fw-note-text">
          These families are ready except for the members listed below. Once every active member
          is extraction-ready, Curation runs automatically as a cohort.
        </p>
      </div>
      <div className="fw-list">
        {cards.map((card) => (
          <FamilyReadinessCard key={card.cohortId} card={card} onOpenItem={onOpenItem} />
        ))}
      </div>
    </div>
  );
}
