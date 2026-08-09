import { createOpenAI } from '@ai-sdk/openai';
import { getLlmConfigForTask } from '../../onboarding/llm-client';
import { getApiKey } from '../../db/repositories/api-key-repo';
import { getProviderDefinition } from '../../ai/provider-registry';
import { getModelProfile } from '../../ai/model-registry';

export interface ResolveAiSdkModelOptions {
  provider?: string;
  model?: string;
}

/**
 * Resolves the configured LLM provider and model, returning a Vercel AI SDK model instance.
 * Supports explicit `{ provider, model }` options, a user-selected model string, or task config fallback.
 */
export function resolveAiSdkModel(input?: string | ResolveAiSdkModelOptions) {
  let providerName: string | undefined;
  let modelName: string | undefined;

  if (typeof input === 'string') {
    modelName = input;
    const profile = getModelProfile(input);
    if (profile) {
      providerName = profile.provider;
    }
  } else if (input) {
    providerName = input.provider;
    modelName = input.model;
    if (!providerName && modelName) {
      const profile = getModelProfile(modelName);
      if (profile) providerName = profile.provider;
    }
  }

  let config: { baseUrl: string; apiKey: string; model: string } | null = null;

  if (providerName && modelName) {
    const providerDef = getProviderDefinition(providerName);
    const credential = getApiKey(providerName);
    if (credential && credential.api_key && !credential.api_key.includes('•')) {
      const defaultUrl = providerDef?.defaultBaseUrl ?? (
        providerName === 'openai'
          ? 'https://api.openai.com/v1'
          : providerName === 'deepseek'
          ? 'https://api.deepseek.com'
          : 'http://localhost:11434/v1'
      );

      config = {
        baseUrl: credential.base_url || defaultUrl,
        apiKey: credential.api_key,
        model: modelName,
      };
    }
  }

  // Fallback to task configuration if no valid explicit model config resolved
  if (!config) {
    const taskConfig = getLlmConfigForTask('store_manager_assistant', { allowFallback: true });
    if (!taskConfig) {
      throw new Error(
        'No usable model provider is configured. Please configure your LLM settings (DeepSeek, OpenAI, or Ollama) in Settings → LLM Providers.'
      );
    }
    config = {
      baseUrl: taskConfig.baseUrl,
      apiKey: taskConfig.apiKey,
      model: taskConfig.model,
    };
  }

  // Create an OpenAI-compatible provider instance
  const openaiCompatibleProvider = createOpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });

  // Return the model instance (standard LanguageModelV4)
  return openaiCompatibleProvider.chat(config.model);
}
