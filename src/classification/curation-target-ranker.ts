/**
 * Shared LLM fallback ranker for curation target proposals.
 *
 * When deterministic matching (keyword scoring, alias resolution) produces
 * no confident results, the ranker makes a single candidate-constrained
 * LLM call to pick the best option(s) from the allowed set.
 *
 * The LLM prompt is constrained so the model can only return exact values
 * from the supplied option list — no hallucination of new options.
 *
 * Uses `category_classification` task routing for all target kinds
 * to avoid widening task-routing scope in this refactor.
 */
import { getLlmConfigForTask, callLlmForTaskWithProvenance, defaultProtectedOperationForTask } from '../onboarding/llm-client';
import type { LlmTask } from '../db/repositories/llm-task-config-repo';
import {
  ModelPolicyDeniedError,
  redactTransportText,
  type ModelPolicyView,
  type ProtectedOperation,
} from './model-policy-gateway';
import type { ModelCallContext } from './model-operation-registry';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';

export interface LlmRankOptionsParams {
  /** Human-readable label for the target kind (e.g. "product type", "flavor", "category page") */
  targetLabel: string;
  /** Allowed option values (strings the LLM may choose from) */
  options: Array<{ value: string; label: string }>;
  /** Single or multiple selection */
  selectionMode: 'single' | 'multiple';
  /** Normalized evidence text for context */
  evidenceText: string;
  /** Max values to select (default: 1 for single, 5 for multiple) */
  maxValues?: number;
  /**
   * LLM task name for configuration routing.
   * Defaults to 'category_classification' for backward compatibility.
   * When set, uses the specific task config for model/provider selection.
   */
  task?: string;
  /**
   * Frozen classification model-policy view (issue #17 item A). Required for
   * protected ranking operations; missing policy denies the call.
   */
  modelPolicy?: ModelPolicyView | null;
  /** Protected operation; defaults from the task name. */
  protectedOperation?: ProtectedOperation;
  /** Durable model-call audit context (issue #17 work item E). */
  modelCall?: ModelCallContext | null;
  /** Runtime snapshot the call is bound to (plan compatibility). */
  snapshot?: RuntimeClassificationSnapshot | null;
}

export interface LlmRankResult {
  values: string[];
  confidence: number;
  /** Durable model-call IDs that produced this ranking (issue #17 E). */
  modelCallIds?: string[];
}

/**
 * Call the LLM to rank/choose from a constrained set of allowed options.
 *
 * Returns null when:
 * - No LLM config is available for 'category_classification'
 * - The LLM response cannot be parsed
 * - No valid option values are returned
 * - The evidence text is too short (< 8 chars)
 */
export async function llmRankOptions(params: LlmRankOptionsParams): Promise<LlmRankResult | null> {
  const { targetLabel, options, selectionMode, evidenceText, maxValues } = params;
  const taskName = params.task ?? 'category_classification';

  if (options.length === 0 || evidenceText.trim().length < 8) return null;

  let operation: ProtectedOperation | null;
  let llmConfig: import('../onboarding/llm-client').LlmConfig | null;
  try {
    operation =
      params.protectedOperation ??
      defaultProtectedOperationForTask(taskName as LlmTask);

    // Protected ranking operation with no frozen policy context: deterministic
    // abstain. The LLM is never called without a policy (issue #17 pass 1c).
    if (operation && params.modelPolicy === undefined) {
      return null;
    }

    llmConfig = getLlmConfigForTask(taskName as any, {
      allowFallback: true,
      modelPolicy: params.modelPolicy,
      ...(operation ? { protectedOperation: operation } : {}),
    });
  } catch (err) {
    if (err instanceof ModelPolicyDeniedError && params.modelPolicy === undefined) {
      return null;
    }
    throw err;
  }
  if (!llmConfig) return null;

  const maxVals = maxValues ?? (selectionMode === 'multiple' ? Math.min(5, options.length) : 1);
  const optionList = options.slice(0, 150).map(o => o.label);
  const selectionDesc = selectionMode === 'multiple' ? `up to ${maxVals}` : 'one';

  const prompt = `Choose ${selectionDesc} value(s) for the product field "${targetLabel}" from the allowed options only.

Allowed options:
${JSON.stringify(optionList)}

Product evidence:
${evidenceText.slice(0, 3000)}

Return ONLY valid JSON in this exact shape: {"values":["exact allowed option"],"confidence":0.0}. If none fit, return {"values":[],"confidence":0}. Do not invent options.`;

  try {
    const auditedCall = params.modelCall
      ? { modelCall: params.modelCall, snapshot: params.snapshot }
      : {};
    const response = await callLlmForTaskWithProvenance(
      taskName as any,
      prompt,
      'You are a strict catalog classifier. You only return exact values from the allowed options.',
      {
        allowFallback: true,
        modelPolicy: params.modelPolicy,
        ...(operation ? { protectedOperation: operation } : {}),
        ...auditedCall,
      },
    );

    if (!response) return null;

    // Parse JSON response with repair for common formatting issues
    let parsed = parseRankerResponse(response.content);
    // The call that produced the final accepted parse (primary or retry).
    let acceptedCallId = response.callId;

    // Retry only when parsing failed. A valid empty values array is an
    // intentional abstention and must not be turned into an invented match.
    if (!parsed) {
      try {
        const retryResponse = await callLlmForTaskWithProvenance(
          taskName as any,
          `The previous response was not valid JSON. Fix the JSON format:\n\n${response.content.slice(0, 1000)}\n\nReturn ONLY valid JSON in this exact shape: {"values":["exact allowed option"],"confidence":0.0}. If none fit, return {"values":[],"confidence":0}. Do not invent options.`,
          'You are a precise JSON fixer. Return only valid JSON matching the requested shape.',
          {
            allowFallback: true,
            modelPolicy: params.modelPolicy,
            ...(operation ? { protectedOperation: operation } : {}),
            ...auditedCall,
          },
        );
        if (retryResponse) {
          parsed = parseRankerResponse(retryResponse.content);
          acceptedCallId = retryResponse.callId;
        }
      } catch {
        // Retry also failed - fall through to null return below
      }
    }

    if (!parsed || !parsed.values || parsed.values.length === 0) return null;

    // Normalize returned values against allowed options
    const values = parsed.values
      .map((raw: unknown) => normalizeToOptions(raw, optionList))
      .filter((v: string | null): v is string => v != null)
      .filter((v: string, i: number, arr: string[]) => arr.indexOf(v) === i) // deduplicate
      .slice(0, maxVals);

    if (values.length === 0) return null;

    const confidence = Math.max(0.35, Math.min(0.85, parsed.confidence ?? 0.55));
    return { values, confidence, modelCallIds: [acceptedCallId] };
  } catch (err: any) {
    console.warn(`[CurationTargetRanker] LLM ranking failed for "${targetLabel}": ${redactTransportText(err.message)}`);
    return null;
  }
}

// ─── Response Parsing ─────────────────────────────────────────────────────────

interface RawRankerResponse {
  values?: unknown[];
  value?: unknown;
  pages?: unknown[];
  confidence?: number;
}

/**
 * Parse the LLM JSON response with tolerance for alternative response shapes.
 * Handles `{ values: [...] }`, `{ value: "..." }`, and `{ pages: [...] }` shapes.
 */
function parseRankerResponse(raw: string): RawRankerResponse | null {
  // Clean up common issues
  let cleaned = raw.trim();

  // Remove markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*|```\s*$/gi, '').trim();

  // Try to find JSON object in the response
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) return null;

  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(cleaned) as RawRankerResponse;

    // Normalize various response shapes
    let values: unknown[] = [];

    if (Array.isArray(parsed.values)) {
      values = parsed.values;
    } else if (parsed.value !== undefined) {
      values = [parsed.value];
    } else if (Array.isArray(parsed.pages)) {
      values = parsed.pages;
    }

    return {
      values,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.55,
    };
  } catch {
    // Try to extract a value from free-text response
    return null;
  }
}

/**
 * Normalize a candidate value against the allowed options list (case-insensitive).
 */
function normalizeToOptions(candidate: unknown, options: string[]): string | null {
  const raw = String(candidate ?? '').trim();
  if (!raw) return null;
  return options.find(o => o.toLowerCase() === raw.toLowerCase()) ?? null;
}
