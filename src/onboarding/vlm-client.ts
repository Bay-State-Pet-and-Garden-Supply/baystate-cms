import { getApiKey } from '../db/repositories/api-key-repo';

export interface VlmConfig {
  baseUrl: string;
  model: string;
  enabled: boolean;
}

/**
 * Retrieve the active local vision model configuration from the database.
 * Reads settings from the api_keys table under the service name 'ollama_vlm'.
 */
export function getVlmConfig(): VlmConfig | null {
  const row = getApiKey('ollama_vlm');
  if (!row || row.api_key !== 'enabled') {
    return null;
  }

  // Ensure native base URL (without /v1)
  const rawBaseUrl = row.base_url || 'http://localhost:11434';
  const baseUrl = rawBaseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');

  return {
    baseUrl,
    model: row.model || 'qwen2.5vl:latest',
    enabled: true,
  };
}

/**
 * Invoke the local Ollama vision model using the native /api/chat endpoint.
 */
export async function callVlm(
  prompt: string,
  imageBase64: string,
  configOverride?: VlmConfig
): Promise<string> {
  const config = configOverride || getVlmConfig();
  if (!config || !config.enabled) {
    throw new Error('VLM vision model is not enabled or configured.');
  }

  const url = `${config.baseUrl}/api/chat`;
  console.log(`[VlmClient] Invoking local vision model "${config.model}" at ${url}`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: prompt,
            images: [imageBase64],
          },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err: unknown) {
    const errorName = err instanceof Error ? err.name : '';
    if (errorName === 'AbortError' || errorName === 'TimeoutError') {
      throw new Error('VLM request timed out after 120s', { cause: err });
    }
    throw err;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`VLM request failed: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as {
    message?: { content?: string };
  };

  const content = data.message?.content;
  if (!content) {
    throw new Error('VLM returned an empty response.');
  }

  return content.trim();
}
