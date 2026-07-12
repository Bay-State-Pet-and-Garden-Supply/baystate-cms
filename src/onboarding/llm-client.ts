/**
 * Provider-agnostic LLM Client for Onboarding Pipeline.
 *
 * Two layers of configuration:
 *
 * 1. **Provider credentials** in `api_keys` (`deepseek`, `openai`,
 *    `ollama`): hold the actual API key and base URL.
 *
 * 2. **Task routing** in `llm_task_configs`: maps each AI task
 *    (`profile_generation`, `product_name_consolidation`, etc.) to a
 *    provider and model. Provider credentials are looked up from
 *    `api_keys` after the task config resolves the provider.
 *
 * Profile tasks (`profile_generation`, `profile_revision`) require an
 * explicit `llm_task_configs` row — they fail closed if no config is
 * found so a missing config never silently falls back to a model the
 * operator did not pick. Other tasks (`product_name_consolidation`,
 * `product_curation`, `category_classification`,
 * `classification_evidence_extraction`) allow fallback to the generic
 * `getLlmConfig()` so existing call paths keep working.
 *
 * The original `getLlmConfig()` / `callLlm()` functions are kept as
 * the generic fallback and are used by the consolidation/curation
 * paths. New code should prefer `getLlmConfigForTask()` and
 * `callLlmForTask()`.
 */

import { getApiKey } from '../db/repositories/api-key-repo';
import {
  getLlmTaskConfig,
  type LlmProvider,
  type LlmTask,
  type LlmTaskConfig,
} from '../db/repositories/llm-task-config-repo';
import { extractConsensusName } from './lcs-extractor';

// ── LLM Concurrency Gate ──────────────────────────────────────────────────────
// Local Ollama models buckle under parallel requests. Serialize so only one
// callLlm() runs at a time, preventing 3× concurrent timeout pile-ups.
let llmBusy = false;
const llmQueue: Array<() => void> = [];

async function acquireLlmSlot(provider: string): Promise<void> {
  if (provider !== 'ollama') return; // Cloud providers can handle parallelism
  while (llmBusy) {
    await new Promise<void>(resolve => llmQueue.push(resolve));
  }
  llmBusy = true;
}

function releaseLlmSlot(provider: string): void {
  if (provider !== 'ollama') return;
  llmBusy = false;
  const next = llmQueue.shift();
  if (next) next();
}

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Default base URLs when a provider credential has none configured. */
const DEFAULT_BASE_URLS: Record<LlmProvider, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
};

/** Default model names when a credential/model config has none set. */
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  deepseek: 'deepseek-v4-flash',
  openai: 'gpt-4o-mini',
  ollama: 'llama3',
};

/**
 * Thrown when a profile task is requested but no `llm_task_configs`
 * row exists and `allowFallback` is false. Distinct error class so
 * callers (e.g. the page extractor) can map this to a `failed` audit
 * row rather than a generic exception.
 */
export class MissingLlmTaskConfigError extends Error {
  constructor(public readonly task: LlmTask) {
    super(
      `No llm_task_configs row found for task "${task}". ` +
        'Profile tasks require an explicit task-specific configuration ' +
        'in Settings → AI Model Routing.',
    );
    this.name = 'MissingLlmTaskConfigError';
  }
}

/**
 * The set of tasks that fail closed when no `llm_task_configs` row
 * is present. The product decision (grill-me questions 17-19) is
 * that profile generation and revision must not silently fall back
 * to a model the operator did not pick.
 */
// fallow-ignore-next-line unused-export
export const PROFILE_TASKS_REQUIRE_EXPLICIT: ReadonlySet<LlmTask> = new Set([
  'profile_generation',
  'profile_revision',
]);

/**
 * Resolve the generic fallback config. This is the legacy priority
 * order (DeepSeek → OpenAI → Ollama) and is used when no task-
 * specific config is found AND the caller allows fallback.
 */
/** @expected-unused */
export function getLlmConfig(): LlmConfig | null {
  // Try DeepSeek first (recommended cloud)
  const deepseek = getApiKey('deepseek');
  if (deepseek && deepseek.api_key) {
    if (deepseek.api_key.includes('•')) {
      console.warn(
        '[LLMClient] DeepSeek API key is redacted/masked in api_keys — skipping. ' +
          'Re-enter the full key in Settings → LLM Providers.',
      );
    } else {
      return {
        provider: 'deepseek',
        apiKey: deepseek.api_key,
        baseUrl: deepseek.base_url || DEFAULT_BASE_URLS.deepseek,
        model: deepseek.model || DEFAULT_MODELS.deepseek,
      };
    }
  }

  // Try OpenAI second
  const openai = getApiKey('openai');
  if (openai && openai.api_key) {
    if (openai.api_key.includes('•')) {
      console.warn(
        '[LLMClient] OpenAI API key is redacted/masked in api_keys — skipping. ' +
          'Re-enter the full key in Settings → LLM Providers.',
      );
    } else {
      return {
        provider: 'openai',
        apiKey: openai.api_key,
        baseUrl: openai.base_url || DEFAULT_BASE_URLS.openai,
        model: openai.model || DEFAULT_MODELS.openai,
      };
    }
  }

  // Try Ollama third (local)
  const ollama = getApiKey('ollama');
  if (ollama && ollama.api_key) {
    if (ollama.api_key.includes('•')) {
      console.warn(
        '[LLMClient] Ollama API key is redacted/masked in api_keys — skipping. ' +
          'Re-enter the full key in Settings → LLM Providers.',
      );
    } else {
      return {
        provider: 'ollama',
        apiKey: ollama.api_key || 'ollama-default',
        baseUrl: ollama.base_url || DEFAULT_BASE_URLS.ollama,
        model: ollama.model || DEFAULT_MODELS.ollama,
      };
    }
  }

  return null;
}

/**
 * Resolve the provider credential row from `api_keys` for the given
 * provider. Returns `null` if the provider is unconfigured or the
 * stored key is a masked placeholder. Logs a warning in the
 * masked-key case so operators can spot the misconfiguration in
 * server logs.
 */
function resolveProviderCredential(
  provider: LlmProvider,
): { apiKey: string; baseUrl: string | null; model: string | null } | null {
  const row = getApiKey(provider);
  if (!row || !row.api_key) {
    console.warn(`[LLMClient] No API key configured for provider "${provider}" in Settings → LLM Providers.`);
    return null;
  }
  if (row.api_key.includes('•')) {
    console.warn(
      `[LLMClient] Provider "${provider}" has a redacted/masked API key in api_keys ` +
        `(value contains '•'). Re-enter the full key in Settings → LLM Providers.`,
    );
    return null;
  }
  return {
    apiKey: row.api_key,
    baseUrl: row.base_url,
    model: row.model,
  };
}

/**
 * Build an `LlmConfig` from a task config + matching provider
 * credential. Returns `null` if the provider credential is missing.
 */
function buildConfigFromTaskConfig(
  taskConfig: LlmTaskConfig,
): LlmConfig | null {
  const cred = resolveProviderCredential(taskConfig.provider);
  if (!cred) return null;
  return {
    provider: taskConfig.provider,
    apiKey: cred.apiKey,
    baseUrl: taskConfig.baseUrlOverride || cred.baseUrl || DEFAULT_BASE_URLS[taskConfig.provider],
    model: taskConfig.model,
  };
}

export interface GetLlmConfigForTaskOptions {
  /**
   * When `true` and no task-specific config is found, fall back to
   * the generic `getLlmConfig()`. Defaults to `true` for non-profile
   * tasks and `false` for profile tasks. Pass an explicit value to
   * override the per-task default.
   */
  allowFallback?: boolean;
}

/**
 * Resolve the LLM config for a specific AI task. Resolution order:
 *
 * 1. Look up `llm_task_configs` for the task.
 * 2. If found, resolve the matching provider credential from
 *    `api_keys` and return the merged `LlmConfig`.
 * 3. If the task config is missing:
 *    - Profile tasks (`profile_generation`, `profile_revision`):
 *      throw `MissingLlmTaskConfigError` (fail-closed) unless
 *      `allowFallback: true` is explicitly passed.
 *    - Other tasks: return the generic `getLlmConfig()` if
 *      `allowFallback !== false`; otherwise `null`.
 *
 * @throws {MissingLlmTaskConfigError} When a profile task is
 *   requested with no task config and no fallback.
 */
export function getLlmConfigForTask(
  task: LlmTask,
  options: GetLlmConfigForTaskOptions = {},
): LlmConfig | null {
  const taskConfig = getLlmTaskConfig(task);
  if (taskConfig) {
    const built = buildConfigFromTaskConfig(taskConfig);
    if (built) return built;
    // Task config exists but provider credential is missing.
    // Fall through to the fallback path (which will likely also fail
    // closed for profile tasks).
  }

  const requiresExplicit = PROFILE_TASKS_REQUIRE_EXPLICIT.has(task);
  const allowFallback =
    options.allowFallback !== undefined
      ? options.allowFallback
      : !requiresExplicit;

  if (allowFallback) {
    return getLlmConfig();
  }

  if (requiresExplicit) {
    throw new MissingLlmTaskConfigError(task);
  }
  return null;
}

export interface CallLlmForTaskOptions {
  /** Override the default fallback policy for this task. */
  allowFallback?: boolean;
  /** Optional temperature override (uses the task config's temperature when set). */
  temperature?: number;
}

/**
 * Call the LLM configured for a specific AI task. Resolution matches
 * `getLlmConfigForTask()`. Throws `MissingLlmTaskConfigError` for
 * profile tasks with no config; returns `null` for other tasks when
 * no config and no fallback is available.
 */
export async function callLlmForTask(
  task: LlmTask,
  prompt: string,
  systemPrompt = 'You are a helpful product cataloging assistant.',
  options: CallLlmForTaskOptions = {},
): Promise<string | null> {
  let config: LlmConfig | null;
  try {
    config = getLlmConfigForTask(task, { allowFallback: options.allowFallback });
  } catch (err) {
    if (err instanceof MissingLlmTaskConfigError) {
      // Re-throw so the caller can map this to a failed audit row.
      throw err;
    }
    throw err;
  }
  if (!config) return null;

  // Resolve the task's temperature override (if any). Caller-provided
  // options.temperature wins over the task config's stored value.
  const taskConfig = getLlmTaskConfig(task);
  const temperature =
    options.temperature !== undefined
      ? options.temperature
      : taskConfig?.temperature !== null && taskConfig?.temperature !== undefined
        ? taskConfig.temperature
        : 0.1;
  const reasoningEffort = taskConfig?.reasoningEffort ?? null;

  await acquireLlmSlot(config.provider);
  try {
    const timeoutMs = config.provider === 'ollama' ? 120_000 : 60_000;
    const requestBody: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature,
    };
    if (reasoningEffort) {
      requestBody.reasoning_effort = reasoningEffort;
    }
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API request failed (${config.provider}): ${response.status} - ${text}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('LLM returned an empty response.');
    }

    return content.trim();
  } finally {
    releaseLlmSlot(config.provider);
  }
}

/**
 * Call completion API of the active LLM provider (generic fallback).
 * Existing callers that have not yet been migrated to `callLlmForTask`
 * continue to use this. New code should prefer the task-specific
 * helper.
 */
// fallow-ignore-next-line unused-export
export async function callLlm(
  prompt: string,
  systemPrompt = 'You are a helpful product cataloging assistant.',
): Promise<string> {
  const config = getLlmConfig();
  if (!config) {
    throw new Error('No LLM API keys configured in settings.');
  }

  // Serialize Ollama calls to avoid flooding the local model with parallel requests
  await acquireLlmSlot(config.provider);
  try {
    const timeoutMs = config.provider === 'ollama' ? 120_000 : 60_000;
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API request failed (${config.provider}): ${response.status} - ${text}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('LLM returned an empty response.');
    }

    return content.trim();
  } finally {
    releaseLlmSlot(config.provider);
  }
}

/**
 * Consolidate a canonical product name from Serper search titles and snippets.
 * Falls back to the LCS algorithm if the LLM is not configured or fails.
 *
 * Uses the `product_name_consolidation` task config when present;
 * otherwise falls back to the generic `callLlm()` / LCS path. The
 * fallback is intentional: product name consolidation is the
 * "least-stakes" AI task and a configured local Ollama should
 * continue to work even before a task-specific config has been
 * created.
 */

/**
 * Extract protected size/weight/count/volume tokens from a raw product name.
 * These are identity-bearing details that must survive expected name generation
 * (brand, size, flavor, variant, count, weight, etc.).
 *
 * Exported for testing.
 */
// fallow-ignore-next-line unused-export — used by tests
export function extractProtectedTokens(rawName: string): string[] {
  const tokens: string[] = [];
  const lower = rawName;

  // Match weight/size: number followed by unit (with optional space)
  // e.g. "2.64OZ", "10.5 OZ", "5LB", "6 oz", "100G", "16OZ"
  const weightPattern = /(\d+(?:\.\d+)?)\s*(OZ|OZS?|LB|LBS?|OUNCE|OUNCES|GRAM|GRAMS|G|KG|ML|GAL|QT|LTR)\b/gi;
  let match;
  while ((match = weightPattern.exec(lower)) !== null) {
    tokens.push(match[0].trim());
  }

  // Match count/pack: number followed by PK, CT, COUNT, etc.
  // e.g. "3PK", "6 Pack", "12CT", "5COUNT"
  const countPattern = /(\d+)\s*(PK|CT|COUNT|PACK|CAN|BAG|PC|PCS|PIECE|PIECES)\b/gi;
  while ((match = countPattern.exec(lower)) !== null) {
    tokens.push(match[0].trim());
  }

  // Match variant size abbreviations that stand alone
  const sizeAbbrPattern = /\b(SM|MD|LG|XL|XXL|XS)\b/g;
  while ((match = sizeAbbrPattern.exec(lower)) !== null) {
    tokens.push(match[0].trim());
  }

  return tokens;
}

/**
 * Normalize a raw protected token to its expected display form.
 * E.g. "2.64OZ" → "2.64 oz", "3PK" → "3-Pack", "SM" → "Small"
 *
 * Exported for testing.
 */
// fallow-ignore-next-line unused-export — used by tests
export function normalizeProtectedToken(token: string): string {
  const t = token.trim();

  // Weight/volume: normalize unit
  const weightMatch = /^(\d+(?:\.\d+)?)\s*(OZ|OZS?|LB|LBS?|OUNCE|OUNCES|GRAM|GRAMS|G|KG|ML|GAL|QT|LTR)$/i.exec(t);
  if (weightMatch) {
    const num = weightMatch[1];
    const unit = weightMatch[2].toLowerCase();
    const unitMap: Record<string, string> = {
      ozs: 'oz', lbs: 'lb', ounce: 'oz', ounces: 'oz',
      gram: 'g', grams: 'g',
      gallon: 'gal', quarts: 'qt', quart: 'qt', liter: 'ltr',
    };
    return `${num} ${unitMap[unit] ?? unit}`;
  }

  // Count/pack
  const countMatch = /^(\d+)\s*(PK|CT|COUNT|PACK|CAN|BAG|PC|PCS|PIECE|PIECES)$/i.exec(t);
  if (countMatch) {
    const num = countMatch[1];
    const type = countMatch[2].toUpperCase();
    if (type === 'PK' || type === 'PACK') return `${num}-Pack`;
    if (type === 'CT' || type === 'COUNT') return `${num} ct`;
    if (type === 'PC' || type === 'PCS') return `${num} pc`;
    if (type === 'CAN') return `${num} Can`;
    if (type === 'BAG') return `${num} Bag`;
    if (type === 'PIECE' || type === 'PIECES') return `${num}-Piece`;
  }

  // Size abbreviations
  const sizeMap: Record<string, string> = {
    SM: 'Small', MD: 'Medium', LG: 'Large',
    XL: 'X-Large', XXL: 'XX-Large', XS: 'X-Small',
  };
  const upper = t.toUpperCase();
  if (sizeMap[upper]) return sizeMap[upper];

  return t;
}

/**
 * Verify that all protected tokens from the raw register name survived
 * in the LLM-generated expected name. If any are missing, append them
 * in normalized form so identity-bearing details are never lost.
 *
 * Exported for testing.
 */
// fallow-ignore-next-line unused-export — used by tests
export function verifyAndRestoreProtectedTokens(expectedName: string, rawName: string): string {
  const protectedTokens = extractProtectedTokens(rawName);
  if (protectedTokens.length === 0) return expectedName;

  const expectedLower = expectedName.toLowerCase();
  const missing: string[] = [];

  for (const token of protectedTokens) {
    const normalized = normalizeProtectedToken(token);
    // Check if the token's core content (number + significant chars) appears
    // in the expected name. Use loose matching so "2.64 oz" matches
    // against expected name containing "2.64"
    const tokenNumber = token.match(/\d+(?:\.\d+)?/)?.[0];
    if (tokenNumber && !expectedLower.includes(tokenNumber)) {
      missing.push(normalized);
    } else if (!tokenNumber && !expectedLower.includes(token.toLowerCase())) {
      missing.push(normalized);
    }
  }

  if (missing.length > 0) {
    const restored = `${expectedName.trim()} ${missing.join(' ')}`;
    console.log(`[LLMClient] Restored missing protected tokens: "${missing.join(', ')}" → "${restored}"`);
    return restored;
  }

  return expectedName;
}

/**
 * Apply protected-token preservation to LCS fallback output.
 * If the raw register name contains size/weight/count tokens that the
 * LCS consensus omitted, append them.
 */
function lcsWithTokenGuard(titles: string[], originalName: string | undefined): string | null {
  const consensus = extractConsensusName(titles);
  if (!consensus || !originalName) return consensus;
  return verifyAndRestoreProtectedTokens(consensus, originalName);
}

export async function consolidateProductName(
  upc: string,
  searchResults: Array<{ title: string; snippet: string }>,
  originalName?: string,
  brandHint?: string | null,
): Promise<string | null> {
  if (searchResults.length === 0 && !originalName) return null;

  // Extract protected tokens from the raw register name BEFORE any LLM call
  // so we can verify they survive.
  const protectedTokens = originalName ? extractProtectedTokens(originalName) : [];
  if (protectedTokens.length > 0) {
    console.log(`[LLMClient] Protected tokens from raw name "${originalName}": [${protectedTokens.join(', ')}]`);
  }

  try {
    let useTaskConfig = true;
    let config: LlmConfig | null = null;
    try {
      config = getLlmConfigForTask('product_name_consolidation', {
        allowFallback: true,
      });
    } catch {
      useTaskConfig = false;
      config = getLlmConfig();
    }
    if (!config) {
      console.log('[LLMClient] No LLM config found, falling back to LCS name extraction');
      const titles = searchResults.map(r => r.title);
      if (originalName) titles.push(originalName);
      return lcsWithTokenGuard(titles, originalName);
    }

    const itemsText = searchResults.length > 0
      ? searchResults
          .slice(0, 5)
          .map((r, i) => `[Result ${i + 1}]\nTitle: ${r.title}\nSnippet: ${r.snippet}`)
          .join('\n\n')
      : 'No search results found.';

    const systemPrompt = 'You are a precise product cataloging assistant. Your job is to generate a register-aligned expected product name from the raw catalog name and search hints.';

    const prompt = `We have a product in our catalog with the following metadata:
- Raw Catalog Name (authoritative): "${originalName || 'Unknown'}"
- Brand Hint: "${brandHint || 'Unknown'}"
- UPC/Barcode: "${upc}"

We searched Google for the UPC and got these top results:
${itemsText}

Task:
Generate a register-aligned expected product name. The Raw Catalog Name is the AUTHORITATIVE identity of the exact SKU we are adding. Search results are enrichment hints only.

Rules:
1. The Raw Catalog Name is authoritative. If search results are completely unrelated (e.g. random items, retail mismatch, bad barcode lookup), IGNORE them and focus on expanding the Raw Catalog Name.
2. Use search results to expand abbreviations, improve casing, add accents (e.g. "PATE" → "Pâté"), and confirm product-line wording — but NEVER remove or contradict identity-bearing details from the Raw Catalog Name.
3. PRESERVE ALL size, weight, count, volume, flavor, and variant tokens from the Raw Catalog Name as-is or normalized. These ARE product identifiers, NOT internal codes. Examples:
   - "2.64OZ" → "2.64 oz"
   - "10.5OZ" → "10.5 oz"
   - "5LB" → "5 lb"
   - "3PK" → "3-Pack"
   - "5CT" → "5 ct"
   - "SM" → "Small"
   - "LG" → "Large"
   - "XL" → "X-Large"
   - "6OZ" → "6 oz"
   - "48OZ" → "48 oz"
   - "30PK" → "30-Pack"
   Never drop these tokens. If a token from the Raw Catalog Name can be normalized, do so — but never remove it.
4. Expand common abbreviations naturally: "DNTL" → "Dental", "CHKN" or "CKN" → "Chicken", "TRKY" → "Turkey", "BEEF" → "Beef", "PATE" → "Pâté", "WET" → "Wet", "SLMN" → "Salmon".
5. Ensure the brand name is present at the start of the expected name.
6. Return ONLY the final expected name string. No quotes, explanations, bullet points, or markdown.

Register-Aligned Expected Name:`;

    console.log(`[LLMClient] Calling LLM (${config.provider}:${config.model}) for UPC ${upc}`);
    const name = useTaskConfig
      ? await callLlmForTask('product_name_consolidation', prompt, systemPrompt, { allowFallback: true })
      : await callLlm(prompt, systemPrompt);
    if (name == null) {
      throw new Error('LLM call returned null');
    }

    // Clean up potential quotes or markdown return structures from the LLM
    const cleaned = name.replace(/^['"`\s]+|['"`\s]+$/g, '').trim();
    if (cleaned.length > 5) {
      // Verify all protected tokens from the raw name survived
      const restored = originalName
        ? verifyAndRestoreProtectedTokens(cleaned, originalName)
        : cleaned;
      return restored;
    }
  } catch (err) {
    console.error('[LLMClient] LLM name consolidation failed, falling back to LCS:', err);
  }

  // Fallback to LCS with token guard
  const titles = searchResults.map(r => r.title);
  if (originalName) titles.push(originalName);
  return lcsWithTokenGuard(titles, originalName);
}
