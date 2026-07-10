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
  profileToDraft,
  draftToSavePayload,
  draftToValidatePayload,
  draftToTestPayload,
} from '../profileBuilderMapping';
import {
  getExtractorProfiles,
  saveExtractorProfile,
  testExtractorProfile,
  snapshotPageForBuilder,
  generateSelectorFromElement,
  fetchPageHtml,
  validateProfileDraft,
  generateSelectors as generateSelectorsApi,
} from '../../../onboarding-api';
import type { ProfileBuilderProps, ProfileBuilderController, ValidationSample } from '../profileBuilderTypes';

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

  // ── Snapshot + HTML fetch ───────────────────────────────────────────────
  const captureSnapshot = useCallback(async () => {
    const url = state.draft.productUrl;
    if (!url) return;

    dispatch({ type: 'snapshot/start' });
    try {
      const result = await snapshotPageForBuilder({
        url,
        runtime: state.draft.runtime,
        captureScreenshot: true,
        captureNetwork: true,
      });
      if (!result.ok || !result.data) {
        dispatch({
          type: 'snapshot/failed',
          error: result.error ?? 'Snapshot failed',
        });
        return;
      }

      dispatch({ type: 'snapshot/succeeded', snapshot: result.data });

      // Fetch page HTML for local evaluation.
      try {
        const htmlResult = await fetchPageHtml(url);
        if (htmlResult.ok && htmlResult.html) {
          dispatch({ type: 'pageHtml/set', html: htmlResult.html });

          // Evaluate all selectors locally.
          const localResults = evaluateAllSelectorsLocally(
            htmlResult.html,
            state.draft,
            ALL_STANDARD_FIELDS as FieldDefinition[],
          );
          for (const [key, evalResult] of Object.entries(localResults)) {
            dispatch({ type: 'field/selectorEvaluated', key, result: evalResult });
          }

          // Evaluate titleOptionalSelectors.
          if (state.draft.titleOptionalSelectors.length > 0) {
            const titleOptResult = evaluateTitleOptionalSelectors(
              htmlResult.html,
              state.draft.titleOptionalSelectors,
            );
            // Dispatch evaluation result for titleOptionalSelectors as a combined field.
            dispatch({
              type: 'field/selectorEvaluated',
              key: 'titleOptionalSelectors',
              result: {
                status: titleOptResult.status,
                extractedPreview: titleOptResult.concatenatedPreview,
                matchCount: titleOptResult.parts.reduce((sum, p) => sum + p.matchCount, 0),
                warnings: titleOptResult.parts.flatMap((p) => p.warnings),
              },
            });
          }
        }
      } catch {
        // HTML fetch failure is non-fatal — keep snapshot, allow preview/validation.
      }
    } catch (err) {
      dispatch({
        type: 'snapshot/failed',
        error: err instanceof Error ? err.message : 'Snapshot failed',
      });
    }
  }, [state.draft.productUrl, state.draft.runtime, state.draft.titleOptionalSelectors]);

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

  // ── Generate selector from outerHTML ─────────────────────────────────────
  const generateSelectorFromOuterHtml = useCallback(
    async (key: string, outerHTML: string) => {
      if (!state.pageHtml) return;

      dispatch({ type: 'field/generateStarted', key });
      try {
        const result = await generateSelectorFromElement({
          html: state.pageHtml,
          outerHTML,
        });

        if (result.ok && result.data) {
          dispatch({ type: 'field/generateSucceeded', key, result: result.data });
        } else {
          dispatch({
            type: 'field/generateFailed',
            key,
            error: result.error ?? 'Selector generation failed',
          });
        }
      } catch (err) {
        dispatch({
          type: 'field/generateFailed',
          key,
          error: err instanceof Error ? err.message : 'Selector generation failed',
        });
      }
    },
    [state.pageHtml],
  );

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
    // Client-side checks.
    if (!state.draft.domain.trim()) {
      dispatch({ type: 'save/failed', error: 'Domain is required.' });
      return;
    }

    dispatch({ type: 'save/start' });
    try {
      const payload = draftToSavePayload(state.draft);
      const result = await saveExtractorProfile(payload);

      if (result.success) {
        dispatch({ type: 'save/succeeded', profile: result.profile });
        props.onSaved?.(result.profile);
      } else {
        dispatch({ type: 'save/failed', error: 'Save returned no result.' });
      }
    } catch (err) {
      dispatch({
        type: 'save/failed',
        error: err instanceof Error ? err.message : 'Save failed',
      });
    }
  }, [state.draft, props.onSaved]);

  // ── Reset ───────────────────────────────────────────────────────────────
  const resetDraft = useCallback(() => {
    dispatch({ type: 'draft/reset' });
  }, []);

  // ── Selector Generation ────────────────────────────────────────────────
  const generateSelectors = useCallback(async () => {
    const snapshot = state.snapshot;
    if (!snapshot || !state.snapshot) return;
    const htmlRef = (state.snapshot as any).htmlRef;
    if (!htmlRef) return;

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
          jsonLd: snapshot.jsonLd ?? [],
          embeddedProductData: snapshot.embeddedProductData ?? [],
          imageCandidates: ((snapshot as any).imageCandidates ?? []).map((url: string) => ({ url })),
          pageStructureSignals: [],
          warnings: snapshot.warnings ?? [],
        },
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
      generateSelectorFromOuterHtml,
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
      generateSelectorFromOuterHtml,
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
