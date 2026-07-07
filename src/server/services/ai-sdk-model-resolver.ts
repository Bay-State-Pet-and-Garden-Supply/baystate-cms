import { createOpenAI } from '@ai-sdk/openai';
import { getLlmConfigForTask } from '../../onboarding/llm-client';
import { getApiKey } from '../../db/repositories/api-key-repo';

/**
 * Resolves the configured LLM provider and model, returning a Vercel AI SDK model instance.
 * Supports a user-selected model override with automatic provider credentials mapping.
 */
export function resolveAiSdkModel(selectedModel?: string) {
  let config: { baseUrl: string; apiKey: string; model: string } | null = null;

  if (selectedModel) {
    const provider =
      selectedModel.startsWith('gpt-') ||
      selectedModel.startsWith('o1-') ||
      selectedModel.startsWith('o3-')
        ? 'openai'
        : selectedModel.startsWith('deepseek-')
        ? 'deepseek'
        : 'ollama';

    const credential = getApiKey(provider);
    if (credential && credential.api_key && !credential.api_key.includes('•')) {
      const defaultUrl =
        provider === 'openai'
          ? 'https://api.openai.com/v1'
          : provider === 'deepseek'
          ? 'https://api.deepseek.com'
          : 'http://localhost:11434/v1';

      config = {
        baseUrl: credential.base_url || defaultUrl,
        apiKey: credential.api_key,
        model: selectedModel,
      };
    }
  }

  // Fallback to task configuration if no valid override is found
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

  // Return the model instance (which is a standard LanguageModelV4) using standard chat completions
  return openaiCompatibleProvider.chat(config.model);
}
