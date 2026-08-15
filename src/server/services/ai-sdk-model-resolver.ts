import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { getLlmConfig, getLlmConfigForTask } from '../../onboarding/llm-client';
import { getApiKey } from '../../db/repositories/api-key-repo';
import { getFullAiRoutingConfig } from '../../db/repositories/provider-connection-repo';
import { getProviderDefinition } from '../../ai/provider-registry';
import { getModelProfile, listModelProfiles, type ModelProfile } from '../../ai/model-registry';
import { getModelPricing, type CostBasis } from '../../ai/model-pricing';

export type ModelResolutionReason = 'explicit' | 'task_config' | 'global_default';

/**
 * Authoritative resolved-model metadata. Every consumer (streaming, telemetry,
 * persistence, UI) must use this single struct so provider/model/locality
 * cannot drift between the model that actually executed and what is recorded.
 */
export interface ResolvedAiSdkModel {
  modelInstance: LanguageModel;
  /** Provider identifier (e.g. 'deepseek', 'openai', 'ollama', or custom connection ID). */
  provider: string;
  /** Registered model identifier (e.g. 'deepseek-v4-flash', 'qwen3.8:27b'). */
  modelId: string;
  locality: 'local' | 'cloud';
  resolutionReason: ModelResolutionReason;
}

export interface ResolveAiSdkModelOptions {
  provider?: string;
  model?: string;
}

/**
 * Thrown when an explicitly selected or default-resolved model cannot be
 * used. Carries a stable `code` so callers can map it to a 4xx
 * `model_unavailable` response instead of a generic 500. The message names
 * the corrective setting without exposing credentials.
 */
export class ModelUnavailableError extends Error {
  readonly code = 'model_unavailable' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/**
 * True when the provider has a usable (non-masked) API key stored. This is
 * the same credential check used by `resolveAiSdkModel` and by the Store
 * Manager model descriptor endpoint, so the picker and the resolver cannot
 * disagree about availability.
 */
export function isProviderCredentialUsable(providerId: string): boolean {
  const credential = getApiKey(providerId);
  return Boolean(credential && credential.api_key && !credential.api_key.includes('•'));
}

/**
 * True when the model is registered and supports tool calling. Store Manager
 * chat requires tools, so non-tool models are never offered or resolved.
 */
export function isModelToolCapable(modelId: string): boolean {
  const profile = getModelProfile(modelId);
  return profile !== null && profile.capabilities.toolCalling !== 'none';
}

function defaultBaseUrlForProvider(provider: string): string {
  return (
    getProviderDefinition(provider)?.defaultBaseUrl ??
    (provider === 'openai'
      ? 'https://api.openai.com/v1'
      : provider === 'deepseek'
        ? 'https://api.deepseek.com'
        : 'http://localhost:11434/v1')
  );
}

function buildModelConfig(provider: string, _model: string): { baseUrl: string; apiKey: string } | null {
  const credential = getApiKey(provider);
  if (!credential || !credential.api_key || credential.api_key.includes('•')) return null;
  return {
    baseUrl: credential.base_url || defaultBaseUrlForProvider(provider),
    apiKey: credential.api_key,
  };
}

function createResolved(
  config: { baseUrl: string; apiKey: string },
  provider: string,
  modelId: string,
  resolutionReason: ModelResolutionReason,
): ResolvedAiSdkModel {
  const providerDef = getProviderDefinition(provider);
  const modelInstance = createOpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  }).chat(modelId);
  return {
    modelInstance,
    provider,
    modelId,
    locality: providerDef?.locality === 'local' ? 'local' : 'cloud',
    resolutionReason,
  };
}

function resolveExplicit(provider: string | undefined, modelName: string): ResolvedAiSdkModel {
  // Check if provider matches an active connection in AI compute
  try {
    const aiConfig = getFullAiRoutingConfig();
    if (provider && aiConfig.connections[provider]) {
      const conn = aiConfig.connections[provider];
      if (conn.enabled) {
        const modelInstance = createOpenAI({
          baseURL: conn.baseUrl,
          apiKey: conn.credential || 'enabled',
        }).chat(modelName);
        return {
          modelInstance,
          provider: conn.id,
          modelId: modelName,
          locality: conn.trustZone === 'cloud' ? 'cloud' : 'local',
          resolutionReason: 'explicit',
        };
      }
    }
  } catch {
    // Fall back to registry
  }

  const profile = getModelProfile(modelName);
  if (!profile) {
    throw new ModelUnavailableError(
      `Model "${modelName}" is not registered in the model registry. ` +
        'Register it in Settings → LLM Providers or choose a listed model.',
    );
  }
  if (provider && provider.trim().toLowerCase() !== profile.provider) {
    throw new ModelUnavailableError(
      `Model "${modelName}" belongs to provider "${profile.provider}", not "${provider}". ` +
        'Select a matching provider/model pair in Settings → LLM Providers.',
    );
  }
  if (!isModelToolCapable(modelName)) {
    throw new ModelUnavailableError(
      `Model "${modelName}" does not support tool calling and cannot be used by the Store Manager. ` +
        'Choose a model with tool-calling support in Settings → LLM Providers.',
    );
  }
  const effectiveProvider = provider ?? profile.provider;
  const providerDef = getProviderDefinition(effectiveProvider);
  if (!providerDef) {
    throw new ModelUnavailableError(`Provider "${effectiveProvider}" is not registered.`);
  }
  const config = buildModelConfig(effectiveProvider, modelName);
  if (!config) {
    const setting = providerDef.requiresCredential
      ? `add an unredacted API key for "${effectiveProvider}" in Settings → LLM Providers`
      : `configure the "${effectiveProvider}" provider in Settings → LLM Providers`;
    throw new ModelUnavailableError(`Model "${modelName}" is not usable: ${setting}.`);
  }
  return createResolved(config, effectiveProvider, modelName, 'explicit');
}

function resolveDefault(): ResolvedAiSdkModel {
  // 1. Direct AI Compute storeManager workload route resolution
  try {
    const aiConfig = getFullAiRoutingConfig();
    const route = aiConfig.workloads.storeManager;
    const target = route.primary === 'inherit' ? aiConfig.defaults.catalogTarget : route.primary;
    if (target && target.connectionId) {
      const conn = aiConfig.connections[target.connectionId];
      if (conn && conn.enabled) {
        const modelInstance = createOpenAI({
          baseURL: conn.baseUrl,
          apiKey: conn.credential || 'enabled',
        }).chat(target.modelId);
        return {
          modelInstance,
          provider: conn.id,
          modelId: target.modelId,
          locality: conn.trustZone === 'cloud' ? 'cloud' : 'local',
          resolutionReason: 'task_config',
        };
      }
    }
  } catch {
    // Fall back to legacy task_configs / api_keys
  }

  // 2. Legacy task-config resolution fallback
  const taskConfig = getLlmConfigForTask('store_manager_assistant', { allowFallback: false });
  let config: { provider: string; model: string; baseUrl: string; apiKey: string } | null = null;
  let resolutionReason: ModelResolutionReason = 'task_config';

  if (taskConfig) {
    const built = buildModelConfig(taskConfig.provider, taskConfig.model);
    if (built) {
      config = { provider: taskConfig.provider, model: taskConfig.model, ...built };
    }
  }

  if (!config) {
    const globalConfig = getLlmConfig();
    if (!globalConfig) {
      throw new ModelUnavailableError(
        'No model is configured for the Store Manager. Configure a provider credential and the ' +
          'store_manager_assistant task route in Settings → LLM Providers.',
      );
    }
    config = { provider: globalConfig.provider, model: globalConfig.model, baseUrl: globalConfig.baseUrl, apiKey: globalConfig.apiKey };
    resolutionReason = 'global_default';
  }

  const profile = getModelProfile(config.model);
  if (!profile || !isModelToolCapable(config.model)) {
    throw new ModelUnavailableError(
      `The configured Store Manager model "${config.model}" is not a registered, tool-calling model. ` +
        'Update the store_manager_assistant task route in Settings → AI Model Routing.',
    );
  }
  if (profile.provider !== config.provider) {
    throw new ModelUnavailableError(
      `The configured Store Manager route pairs model "${config.model}" with provider "${config.provider}", ` +
        `but the registry binds it to "${profile.provider}". Update Settings → AI Model Routing.`,
    );
  }
  const providerDef = getProviderDefinition(config.provider);
  if (!providerDef) {
    throw new ModelUnavailableError(`Provider "${config.provider}" is not registered.`);
  }

  return createResolved(
    { baseUrl: config.baseUrl, apiKey: config.apiKey },
    config.provider,
    config.model,
    resolutionReason,
  );
}

/**
 * Resolve the Store Manager chat model.
 *
 * - `undefined`/empty input: resolve the `store_manager_assistant` task route,
 *   then the existing global configuration (never an arbitrary profile).
 * - Explicit string/object input: must be registered, tool-capable, and
 *   credentialed/usable. Explicit input NEVER falls back.
 *
 * @throws {ModelUnavailableError} When no compatible model can be resolved or
 *   an explicit selection is unusable.
 */
export function resolveAiSdkModel(input?: string | ResolveAiSdkModelOptions): ResolvedAiSdkModel {
  if (typeof input === 'string') {
    return resolveExplicit(undefined, input);
  }
  if (input) {
    if (!input.model) {
      throw new ModelUnavailableError(
        'An explicit model selection requires a model id. Choose a model from the Store Manager picker.',
      );
    }
    return resolveExplicit(input.provider, input.model);
  }
  return resolveDefault();
}

// ---------------------------------------------------------------------------
// Store Manager model descriptor endpoint (server-owned picker source)
// ---------------------------------------------------------------------------

export interface StoreManagerModelDescriptor {
  id: string;
  provider: string;
  providerLabel: string;
  locality: 'local' | 'cloud';
  capabilitySummary: string;
  pricing: {
    inputPerMillion: number | null;
    outputPerMillion: number | null;
    costBasis: CostBasis;
    effectiveAt: string | null;
  };
  isDefault: boolean;
}

export interface StoreManagerModelsResult {
  models: StoreManagerModelDescriptor[];
  defaultModelId: string | null;
  /** Present only when no compatible default exists (fail-closed empty list). */
  setupMessage?: string;
}

export const STORE_MANAGER_SETUP_MESSAGE =
  'No compatible Store Manager model is configured. Add a provider credential and point the ' +
  'store_manager_assistant task route at a registered, tool-calling model in Settings → LLM Providers ' +
  '→ AI Model Routing.';

function toDescriptor(profile: ModelProfile, isDefault: boolean): StoreManagerModelDescriptor {
  const providerDef = getProviderDefinition(profile.provider);
  const locality = providerDef?.locality ?? 'cloud';
  let pricing: StoreManagerModelDescriptor['pricing'];
  if (locality === 'local') {
    pricing = { inputPerMillion: null, outputPerMillion: null, costBasis: 'local_zero', effectiveAt: null };
  } else {
    const rate = getModelPricing(profile.id);
    pricing = rate
      ? {
          inputPerMillion: rate.inputPerMillion,
          outputPerMillion: rate.outputPerMillion,
          costBasis: 'published_rate',
          effectiveAt: rate.effectiveAt,
        }
      : { inputPerMillion: null, outputPerMillion: null, costBasis: 'unknown', effectiveAt: null };
  }
  const caps = profile.capabilities;
  return {
    id: profile.id,
    provider: profile.provider,
    providerLabel: providerDef?.label ?? profile.provider,
    locality,
    capabilitySummary: [
      caps.modalities.join('+'),
      `tool calling: ${caps.toolCalling}`,
      `structured output: ${caps.structuredOutput}`,
    ].join(' · '),
    pricing,
    isDefault,
  };
}

/**
 * Build the server-owned list of usable Store Manager models. Only registered,
 * tool-capable models whose provider definition exists and whose credential is
 * usable are returned. Exactly one profile is marked default — the model
 * resolved from the `store_manager_assistant` task route (or, when no task row
 * exists, the existing global configuration). No compatible default yields an
 * empty list plus a `model_unavailable` setup message; the first arbitrary
 * profile is never selected. Credentials/base URLs are never returned.
 */
export function listUsableStoreManagerModels(): StoreManagerModelsResult {
  let defaultResolution: ResolvedAiSdkModel;
  try {
    defaultResolution = resolveDefault();
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return { models: [], defaultModelId: null, setupMessage: STORE_MANAGER_SETUP_MESSAGE };
    }
    throw err;
  }

  const candidates = listModelProfiles().filter(
    (p) =>
      isModelToolCapable(p.id) &&
      getProviderDefinition(p.provider) !== null &&
      isProviderCredentialUsable(p.provider),
  );
  const models = candidates.map((p) => toDescriptor(p, p.id === defaultResolution.modelId));

  // Fail closed: a resolved default must itself be present in the usable list.
  const defaultInList = models.some((m) => m.id === defaultResolution.modelId);
  if (!defaultInList) {
    return { models: [], defaultModelId: null, setupMessage: STORE_MANAGER_SETUP_MESSAGE };
  }

  return { models, defaultModelId: defaultResolution.modelId };
}
