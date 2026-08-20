// @ts-nocheck
/**
 * useProfileBuilderController — async orchestration hook for the profile builder.
 *
 * Owns all API call workflows, dispatches reducer actions, and exposes
 * a stable controller interface to presentational components.
 *
 * No Bun-only imports — safe for Vite/React frontend.
 */

import { useReducer, useEffect, useCallback, useMemo, useRef } from 'react';

/** Simple unique ID generator (no external dependency). */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
import { profileBuilderReducer, createInitialState, deriveFieldStatus } from '../profileBuilderReducer';
import {
  evaluateAllSelectorsLocally,
  evaluateSelectorLocally,
  evaluateTitleOptionalSelectors,
} from '../selectorEvaluation';
import { getFieldDefinition, ALL_STANDARD_FIELDS, CORE_FIELDS, STANDARD_CUSTOM_FIELDS } from '../fieldCatalog';
import type { FieldDefinition } from '../fieldCatalog';
import {
  draftToSavePayload,
  draftToValidatePayload,
  draftToTestPayload,
} from '../profileBuilderMapping';
import {
  getExtractorProfiles,
  saveExtractorProfile,
  testExtractorProfile,
  snapshotPageForBuilder,
  validateProfileDraft,
  generateSelectors as generateSelectorsApi,
} from '../../../onboarding-api';
import type { ProfileBuilderProps, ProfileBuilderController, ValidationSample } from '../profileBuilderTypes';
// story: e07s03 — click→ranked recipes (shared with ValuePreviewGrid)
import * as cheerio from 'cheerio';
import { buildStableSelector } from '../../../../shared/selector-utils';

export type RankedRecipe = {
  selector: string;
  stability: 'high' | 'medium' | 'low';
  source: 'jsonld' | 'css-stable' | 'shopify' | 'semantic' | 'generic';
  score: number;
};

/**
 * Rank candidate recipes for a field given a capture (dom+html).
 * Prefers structured JSON-LD, then [data-testid], then shopify, then semantic, then generic.
 * Deterministic, no network.
 */
export function rankCandidates(capture: { dom: string; html: string }, field: string): RankedRecipe[] {
  const html = (capture.html ?? capture.dom ?? '') as string;
  const dom = (capture.dom ?? html) as string;
  const candidates: RankedRecipe[] = [];
  const lower = html.toLowerCase();
  // 1) JSON-LD — high
  if (lower.includes('application/ld+json')) {
    candidates.push({ selector: 'jsonld:Product.name', stability: 'high', source: 'jsonld', score: 100 });
  }
  // 2) [data-testid] etc. — high (use buildStableSelector if we can find an element with data-testid)
  const hasStableAttr = /data-testid|data-test|data-cy|data-qa/.test(lower);
  if (hasStableAttr) {
    // try to build a real selector via cheerio for the first element with that attr
    try {
      const $ = cheerio.load(dom);
      const el = $('[data-testid],[data-test],[data-cy],[data-qa]').get(0) as unknown as import('domhandler').Element | undefined;
      if (el) {
        const built = buildStableSelector($, el);
        candidates.push({ selector: built.selector, stability: built.stability, source: 'css-stable', score: 90 });
      } else {
        candidates.push({ selector: '[data-testid="product"]', stability: 'high', source: 'css-stable', score: 90 });
      }
    } catch {
      candidates.push({ selector: '[data-testid="product"]', stability: 'high', source: 'css-stable', score: 90 });
    }
  }
  // 3) shopify — medium
  if (lower.includes('shopify') || lower.includes('cdn.shopify')) {
    candidates.push({ selector: '[id^="shopify-section"] h1', stability: 'medium', source: 'shopify', score: 70 });
  }
  // 4) semantic class/id — medium (check semantic hints for field)
  const semanticHints: Record<string, string> = { title: 'product-title', description: 'description', price: 'price', brand: 'brand', image: 'product-image' };
  const hint = semanticHints[field] ?? 'title';
  if (lower.includes(hint)) {
    candidates.push({ selector: `h1.${hint}`, stability: 'medium', source: 'semantic', score: 60 });
  }
  // 5) generic — low
  candidates.push({ selector: 'h1', stability: 'low', source: 'generic', score: 10 });
  // already scored in order high→low; ensure deterministic sort
  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Instant local eval for value previews — DOMParser-style but via cheerio for tests.
 * Labeled "instant preview — not evidence" in UI; never satisfies testsPass.
 */
export function evaluateValuesInstant(capture: { html: string }, selector: string): string | null {
  try {
    const $ = cheerio.load(capture.html);
    const els = $(selector);
    if (els.length === 0) return null;
    const text = els.first().text().replace(/\s+/g, ' ').trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Normalize a domain string for matching:
 * lowercase, trim, strip leading www.
 */
function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

/**
 * Find the profile whose domain matches the given input.
 */
function findMatchingProfile(
  profiles: Array<{ domain: string }>,
  rawDomain: string,
): { domain: string } | null {
  const needle = normalizeDomain(rawDomain);
  if (!needle) return null;
  return profiles.find((p) => normalizeDomain(p.domain) === needle) ?? null;
}

export function useProfileBuilderController(
  props: ProfileBuilderProps,
): ProfileBuilderController {
  const [state, dispatch] = useReducer(
    profileBuilderReducer,
    { initialDomain: props.initialDomain, initialProductUrl: props.initialProductUrl },
    createInitialState,
  );

  // Track whether we've auto-seeded the initial URL as a validation sample
  const seededRef = useRef(false);

  // ── Load profiles on mount ──────────────────────────────────────────────
  const loadProfiles = useCallback(async () => {
    dispatch({ type: 'profiles/loadStarted' });
    try {
      const result = await getExtractorProfiles();
      dispatch({ type: 'profiles/loadSucceeded', profiles: result.extractorProfiles });
    } catch (err) {
      dispatch({
        type: 'profiles/loadFailed',
        error: err instanceof Error ? err.message : 'Failed to load profiles',
      });
    }
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  // ── Domain matching (when profiles change or domain changes) ──────────
  useEffect(() => {
    const rawDomain = state.draft.domain;
    if (!rawDomain || state.profiles.length === 0) return;

    const match = findMatchingProfile(state.profiles, rawDomain);
    if (match) {
      const profile = state.profiles.find((p) => p.id === (match as any).id) ?? match as any;
      if ('id' in profile) {
        dispatch({ type: 'activeProfile/set', profile });
        dispatch({ type: 'draft/hydrateFromProfile', profile });
      }
    } else {
      dispatch({ type: 'activeProfile/set', profile: null });
    }
  }, [state.draft.domain, state.profiles]);

  // ── Auto-seed validation sample from initial URL ───────────────────────
  useEffect(() => {
    if (seededRef.current) return;
    const url = state.draft.productUrl;
    if (!url || state.samples.length > 0) return;
    // Wait until profiles are loaded before seeding
    if (state.requests.loadProfiles.loading) return;
    seededRef.current = true;
    dispatch({
      type: 'sample/add',
      sample: {
        id: generateId(),
        url,
        confirmed: true,
        expectedName: state.draft.titleSelector || undefined,
      },
    });
  }, [state.draft.productUrl, state.samples.length, state.requests.loadProfiles.loading]);

  // ── Domain setter ───────────────────────────────────────────────────────
  const setDomain = useCallback((domain: string) => {
    dispatch({ type: 'domain/set', domain });
  }, []);

  // ── Product URL setter ──────────────────────────────────────────────────
  const setProductUrl = useCallback((url: string) => {
    dispatch({ type: 'productUrl/set', url });
  }, []);

  // ── Runtime setter ──────────────────────────────────────────────────────
  const setRuntime = useCallback((runtime: 'static' | 'rendered') => {
    dispatch({ type: 'runtime/set', runtime });
  }, []);

  // ── Snapshot (single capture artifact — e07s03) ───────────────────────
  // Single capture (DOM + screenshot + runtime + hash, networkidle+1s) is the source of truth.
  // Independent HTML-fetch hop deleted — previously raced with snapshot.
  const captureSnapshot = useCallback(async () => {
    const url = state.draft.productUrl;
    if (!url) return;

    dispatch({ type: 'snapshot/start' });
    try {
      const res = await fetch('/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, runtime: state.draft.runtime }),
      });
      const data = (await res.json()) as { ok: boolean; dom?: string; screenshotBase64?: string; runtime?: string; hash?: string; capturedAt?: string; error?: string };
      if (!res.ok || !data.ok || !data.dom) {
        dispatch({ type: 'snapshot/failed', error: data.error ?? 'Snapshot failed' });
        return;
      }
      const snapshot = {
        url,
        dom: data.dom,
        screenshotBase64: (data as any).screenshotBase64 ?? '',
        screenshotRef: (data as any).screenshotRef ?? null,
        runtime: data.runtime ?? state.draft.runtime,
        hash: data.hash ?? '',
        capturedAt: data.capturedAt ?? new Date().toISOString(),
      };
      dispatch({ type: 'snapshot/succeeded', snapshot: snapshot as unknown as any });
      dispatch({ type: 'pageHtml/set', html: data.dom });
      const localResults = evaluateAllSelectorsLocally(data.dom, state.draft, ALL_STANDARD_FIELDS as FieldDefinition[]);
      for (const [key, evalResult] of Object.entries(localResults)) {
        dispatch({ type: 'field/selectorEvaluated', key, result: evalResult });
      }
    } catch (err) {
      dispatch({ type: 'snapshot/failed', error: err instanceof Error ? err.message : 'Snapshot failed' });
    }
  }, [state.draft.productUrl, state.draft.runtime, state.draft])

  // ── Selector update ─────────────────────────────────────────────────────
  const updateSelector = useCallback(
    (key: string, selector: string) => {
      dispatch({ type: 'field/selectorChanged', key, selector });

      // Locally evaluate if pageHtml is available.
      if (state.pageHtml) {
        const fieldDef = getFieldDefinition(key);
        if (fieldDef) {
          const result = evaluateSelectorLocally(state.pageHtml, selector, fieldDef);
          dispatch({ type: 'field/selectorEvaluated', key, result });
        }
      }
    },
    [state.pageHtml],
  );

  // ── Title optional operations ───────────────────────────────────────────
  const addTitleOptionalSelector = useCallback(
    (selector?: string) => {
      dispatch({ type: 'titleOptional/add', selector: selector ?? '' });
    },
    [],
  );

  const updateTitleOptionalSelector = useCallback(
    (index: number, selector: string) => {
      dispatch({ type: 'titleOptional/update', index, selector });
    },
    [],
  );

  const removeTitleOptionalSelector = useCallback(
    (index: number) => {
      dispatch({ type: 'titleOptional/remove', index });
    },
    [],
  );

  // paste-HTML generator deleted (e07s03) — local DOMParser eval stays as instant preview — not evidence (see captureSnapshot comment).

  // ── Custom field operations ─────────────────────────────────────────────
  const addCustomField = useCallback((name: string) => {
    dispatch({ type: 'customField/add', key: name });
  }, []);

  const removeCustomField = useCallback((key: string) => {
    dispatch({ type: 'customField/remove', key });
  }, []);

  // ── Preview ─────────────────────────────────────────────────────────────
  const runPreview = useCallback(async () => {
    dispatch({ type: 'preview/start' });
    try {
      const payload = draftToTestPayload(state.draft);
      const result = await testExtractorProfile(payload);

      if (result.success) {
        dispatch({ type: 'preview/succeeded', extracted: result.extracted });
      } else {
        dispatch({ type: 'preview/failed', error: 'Preview returned no data' });
      }
    } catch (err) {
      dispatch({
        type: 'preview/failed',
        error: err instanceof Error ? err.message : 'Preview failed',
      });
    }
  }, [state.draft]);

  // ── Sample operations ───────────────────────────────────────────────────
  const addSample = useCallback((url: string) => {
    const sample: ValidationSample = {
      id: generateId(),
      url,
      confirmed: false,
    };
    dispatch({ type: 'sample/add', sample });
  }, []);

  const updateSample = useCallback(
    (id: string, patch: Partial<ValidationSample>) => {
      dispatch({ type: 'sample/update', id, patch });
    },
    [],
  );

  const removeSample = useCallback((id: string) => {
    dispatch({ type: 'sample/remove', id });
  }, []);

  // ── Validation ──────────────────────────────────────────────────────────
  const runValidation = useCallback(async () => {
    if (state.samples.length === 0) return;

    dispatch({ type: 'validation/start' });
    try {
      const payload = draftToValidatePayload(state.draft, state.samples);
      const result = await validateProfileDraft(payload);

      if (result.ok && result.data) {
        dispatch({ type: 'validation/succeeded', validation: result.data });

        // Update field statuses based on validation.
        for (const fieldKey of Object.keys(state.fields)) {
          const localResult = state.fields[fieldKey];
          const status = deriveFieldStatus({
            selector: localResult.selector,
            localResult: undefined,
            previewResult: state.extractionPreview,
            validation: result.data,
            fieldKey,
          }) as 'unassigned' | 'assigned' | 'tested' | 'warning' | 'failed' | 'validated';
          dispatch({
            type: 'field/selectorEvaluated',
            key: fieldKey,
            result: {
              status,
              extractedPreview: localResult.extractedPreview ?? null,
              matchCount: localResult.matchCount ?? 0,
              warnings: localResult.warnings,
            },
          });
        }
      } else {
        dispatch({
          type: 'validation/failed',
          error: result.error ?? 'Validation failed',
        });
      }
    } catch (err) {
      dispatch({
        type: 'validation/failed',
        error: err instanceof Error ? err.message : 'Validation failed',
      });
    }
  }, [state.draft, state.samples, state.fields, state.extractionPreview]);

  // ── Save ────────────────────────────────────────────────────────────────
  const saveProfile = useCallback(async () => {
    if (!state.draft.domain.trim()) {
      dispatch({ type: 'save/failed', error: 'Domain is required.' });
      return;
    }
    dispatch({ type: 'save/start' });
    try {
      const selectors: Record<string, unknown> = {
        titleSelector: state.draft.titleSelector,
        titleOptionalSelectors: (state.draft as any).titleOptionalSelectors,
        priceSelector: state.draft.priceSelector,
        descriptionSelector: state.draft.descriptionSelector,
        brandSelector: state.draft.brandSelector,
        imagesSelector: state.draft.imagesSelector,
      };
      const sampleIds = state.samples.map(s => s.id);
      const snapHash = (state.snapshot as any)?.hash as string | undefined;
      const artifactHashes = snapHash ? [snapHash].sort() : sampleIds.slice().sort();
      const provenance = { provider: 'client', model: 'manual', configId: 'manual' };
      const res = await fetch('/api/profile-versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: state.draft.domain, selectors, runtime: state.draft.runtime, sampleIds, artifactHashes, validationSummary: { rowCount: sampleIds.length }, provenance, approver: 'operator', reason: 'save' }),
      });
      const data = await res.json().catch(() => ({})) as any;
      if (!res.ok || !data?.id) {
        dispatch({ type: 'save/failed', error: data?.error ?? 'Version create failed' });
        return;
      }
      const payload = draftToSavePayload(state.draft);
      const legacy = await saveExtractorProfile(payload).catch(() => null);
      dispatch({ type: 'save/succeeded', profile: (legacy as any)?.profile ?? { id: data.id, domain: state.draft.domain } });
      (props.onSaved as any)?.(data);
    } catch (err) {
      dispatch({ type: 'save/failed', error: err instanceof Error ? err.message : 'Save failed' });
    }
  }, [state.draft, state.samples, state.snapshot, props.onSaved]);

  // ── Reset ───────────────────────────────────────────────────────────────
  const resetDraft = useCallback(() => {
    dispatch({ type: 'draft/reset' });
  }, []);

  // ── Selector Generation ────────────────────────────────────────────────
  const generateSelectors = useCallback(async () => {
    const snapshot = state.snapshot as unknown as { dom?: string; htmlRef?: string; jsonLd?: unknown[]; embeddedProductData?: unknown[]; warnings?: unknown[] } | null;
    if (!snapshot) return;
    const dom = (snapshot as any).dom ?? (snapshot as any).htmlRef;
    if (!dom) return;
    const htmlRef = dom;

    // Build the field list from CORE_FIELDS, STANDARD_CUSTOM_FIELDS, and custom fields
    const fields: Array<{
      key: string;
      label: string;
      origin: 'core' | 'standard_custom' | 'draft_custom';
      valueType: 'text' | 'html' | 'url' | 'image' | 'list';
      multiple: boolean;
      description: string | null;
    }> = [];
    const allFieldDefs = CORE_FIELDS.concat(STANDARD_CUSTOM_FIELDS);
    for (const f of allFieldDefs) {
      const origin = f.outputTarget === 'core' ? 'core' : 'standard_custom';
      // Map fieldCatalog value types to the Zod-accepted generation value types
      const valueType = f.valueType === 'image' ? 'image' : f.valueType === 'array' ? 'list' : 'text';
      fields.push({
        key: f.key,
        label: f.label,
        origin,
        valueType,
        multiple: f.cardinality === 'multiple',
        description: null,
      });
    }

    dispatch({
      type: 'selectorGenerationStarted',
      payload: { htmlRef, requestedFieldKeys: fields.map((f) => f.key) },
    });

    try {
      const result = await generateSelectorsApi({
        htmlRef,
        sourceUrl: state.draft.productUrl,
        runtime: state.draft.runtime,
        fields,
        snapshotContext: {
          jsonLd: (snapshot as any).jsonLd ?? [],
          embeddedProductData: (snapshot as any).embeddedProductData ?? [],
          imageCandidates: (((snapshot as any).imageCandidates ?? []) as string[]).map((url: string) => ({ url }) as any),
          pageStructureSignals: [],
          warnings: (snapshot as any).warnings ?? [],
        } as any,
      });

      if (result.ok) {
        dispatch({ type: 'selectorGenerationSucceeded', payload: result.data });
      } else {
        dispatch({ type: 'selectorGenerationFailed', payload: result.error });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Generation failed';
      console.error('[ProfileBuilder] Generate selectors error:', msg);
      dispatch({
        type: 'selectorGenerationFailed',
        payload: {
          code: 'INTERNAL_ERROR',
          message: msg,
          retryable: true,
        },
      });
    }
  }, [state.snapshot, state.draft.productUrl, state.draft.runtime]);

  const acceptSelectorSuggestion = useCallback((fieldKey: string) => {
    dispatch({ type: 'selectorSuggestionAccepted', payload: { fieldKey } });
  }, []);

  const rejectSelectorSuggestion = useCallback((fieldKey: string) => {
    dispatch({ type: 'selectorSuggestionRejected', payload: { fieldKey } });
  }, []);

  const acceptCustomFieldSuggestion = useCallback((key: string) => {
    dispatch({ type: 'customFieldSuggestionAccepted', payload: { key } });
  }, []);

  const rejectCustomFieldSuggestion = useCallback((key: string) => {
    dispatch({ type: 'customFieldSuggestionRejected', payload: { key } });
  }, []);

  // ── Category toggle ────────────────────────────────────────────────────
  const toggleCategory = useCallback((category: any) => {
    dispatch({ type: 'category/toggle', category });
  }, []);

  // ── Assemble controller (memoize for stable identity) ──────────────────
  const controller = useMemo<ProfileBuilderController>(
    () => ({
      state,

      setDomain,
      setProductUrl,
      setRuntime,
      loadProfiles,
      captureSnapshot,
      updateSelector,
      addTitleOptionalSelector,
      updateTitleOptionalSelector,
      removeTitleOptionalSelector,
      // paste-HTML generator deleted (e07s03)
      addCustomField,
      removeCustomField,
      runPreview,
      addSample,
      updateSample,
      removeSample,
      runValidation,
      saveProfile,
      resetDraft,
      generateSelectors,
      acceptSelectorSuggestion,
      rejectSelectorSuggestion,
      acceptCustomFieldSuggestion,
      rejectCustomFieldSuggestion,
      toggleCategory,
    }),
    [
      state,
      setDomain,
      setProductUrl,
      setRuntime,
      loadProfiles,
      captureSnapshot,
      updateSelector,
      addTitleOptionalSelector,
      updateTitleOptionalSelector,
      removeTitleOptionalSelector,
      addCustomField,
      removeCustomField,
      runPreview,
      addSample,
      updateSample,
      removeSample,
      runValidation,
      saveProfile,
      resetDraft,
      generateSelectors,
      acceptSelectorSuggestion,
      rejectSelectorSuggestion,
      acceptCustomFieldSuggestion,
      rejectCustomFieldSuggestion,
      toggleCategory,
    ],
  );

  return controller;
}
