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
import { getLlmConfigForTask, callLlmForTask } from '../onboarding/llm-client';

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
}

export interface LlmRankResult {
  values: string[];
  confidence: number;
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

  const llmConfig = getLlmConfigForTask(taskName as any, { allowFallback: true });
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
    const response = await callLlmForTask(
      taskName as any,
      prompt,
      'You are a strict catalog classifier. You only return exact values from the allowed options.',
      { allowFallback: true },
    );

    if (!response) return null;

    // Parse JSON response with repair for common formatting issues
    const parsed = parseRankerResponse(response, optionList);

    if (!parsed || !parsed.values || parsed.values.length === 0) return null;

    // Normalize returned values against allowed options
    const values = parsed.values
      .map((raw: unknown) => normalizeToOptions(raw, optionList))
      .filter((v: string | null): v is string => v != null)
      .filter((v: string, i: number, arr: string[]) => arr.indexOf(v) === i) // deduplicate
      .slice(0, maxVals);

    if (values.length === 0) return null;

    const confidence = Math.max(0.35, Math.min(0.85, parsed.confidence ?? 0.55));
    return { values, confidence };
  } catch (err: any) {
    console.warn(`[CurationTargetRanker] LLM ranking failed for "${targetLabel}": ${err.message}`);
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
function parseRankerResponse(raw: string, allowedOptions: string[]): RawRankerResponse | null {
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
