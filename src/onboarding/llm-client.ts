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
        temperature,
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
export async function consolidateProductName(
  upc: string,
  searchResults: Array<{ title: string; snippet: string }>,
  originalName?: string,
  brandHint?: string | null,
): Promise<string | null> {
  if (searchResults.length === 0 && !originalName) return null;

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
      return extractConsensusName(titles);
    }

    const itemsText = searchResults.length > 0
      ? searchResults
          .slice(0, 5)
          .map((r, i) => `[Result ${i + 1}]\nTitle: ${r.title}\nSnippet: ${r.snippet}`)
          .join('\n\n')
      : 'No search results found.';

    const systemPrompt = 'You are a precise product cataloging assistant. Your job is to extract or clean up a clean, canonical product name.';

    const prompt = `We have a product in our catalog with the following metadata:
- Raw Catalog Name: "${originalName || 'Unknown'}"
- Brand Hint: "${brandHint || 'Unknown'}"
- UPC/Barcode: "${upc}"

We searched Google for the UPC and got these top results:
${itemsText}

Task:
Generate a clean, human-readable, and canonical product name.

Rules:
1. Evaluate if the search results actually match the catalog product ("${originalName || ''}"). If the search results are completely unrelated (e.g. they represent random items, general retail mismatch, or different products due to a bad barcode lookup), IGNORE the search results and focus on cleaning up the Raw Catalog Name.
2. When cleaning the Raw Catalog Name, expand common abbreviations to make it natural and readable (e.g. expand "DNTL" to "Dental", "SM" to "Small", "LG" to "Large", "CHKN" or "CKN" to "Chicken", "TRKY" to "Turkey", "BEEF" to "Beef", "PATE" to "Pâté", "WET" to "Wet").
3. PRESERVE variant-distinguishing pack counts and sizes (e.g. "6 Pack", "3 Pack", "Value Pack", "Single", "Small", "Medium", "Large", "X-Large") — these are essential product identifiers that differentiate one variant from another. Only strip truly internal inventory codes like "5CT", "2.64OZ", "10.5OZ" that are clearly dimension-only and do not distinguish the product.
4. Ensure the brand name is present at the start of the canonical name.
5. Return ONLY the final product name string. Do not include quotes, explanatory text, bullet points, or markdown.

Clean Canonical Product Name:`;

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
      return cleaned;
    }
  } catch (err) {
    console.error('[LLMClient] LLM name consolidation failed, falling back to LCS:', err);
  }

  // Fallback to LCS
  const titles = searchResults.map(r => r.title);
  if (originalName) titles.push(originalName);
  return extractConsensusName(titles);
}
