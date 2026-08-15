import { getApiKey } from '../db/repositories/api-key-repo';
import { acquireLocalSlot, releaseLocalSlot } from '../ai/local-runtime-coordinator';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';

/** Minimal structural fetch signature — lets callers inject the PI
 *  policy-gateway bound fetch (P0-1). */
export type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface VlmConfig {
  baseUrl: string;
  model: string;
  enabled: boolean;
  transport?: 'openai-compatible' | 'ollama-native';
  credential?: string;
}

/**
 * Retrieve the active vision model configuration from the database.
 * Prefers the connection-addressed visionOcr workload route, falling back to legacy settings.
 */
export function getVlmConfig(): VlmConfig | null {
  const row = getApiKey('ollama_vlm');
  if (row) {
    if (row.api_key !== 'enabled') {
      return null;
    }
    const rawBaseUrl = row.base_url || 'http://localhost:11434';
    const baseUrl = rawBaseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    return {
      baseUrl,
      model: row.model || 'qwen2.5vl:latest',
      enabled: true,
      transport: 'ollama-native',
    };
  }

  try {
    const config = getFullAiRoutingConfig();
    const route = config.workloads.visionOcr;
    if (route && route.primary !== 'inherit') {
      const conn = config.connections[route.primary.connectionId];
      if (conn && conn.enabled && conn.id !== 'desktop-lmstudio') {
        return {
          baseUrl: conn.baseUrl,
          model: route.primary.modelId || 'gemma-4-26b-a4b-qat',
          enabled: true,
          transport: conn.transport,
          credential: conn.credential ?? undefined,
        };
      }
    }
  } catch {
    // Fall back
  }

  return null;
}

/**
 * Invoke the vision model (Ollama native or OpenAI-compatible LM Studio endpoint).
 */
export async function callVlm(
  prompt: string,
  imageBase64: string,
  configOverride?: VlmConfig,
  fetchFn: NetworkFetch = fetch,
): Promise<string> {
  const config = configOverride || getVlmConfig();
  if (!config || !config.enabled) {
    throw new Error('VLM vision model is not enabled or configured.');
  }

  const isOpenAi = config.transport === 'openai-compatible' || config.baseUrl.includes('/v1');
  const cleanBase = config.baseUrl.replace(/\/+$/, '');
  const url = isOpenAi ? `${cleanBase}/chat/completions` : `${cleanBase}/api/chat`;

  console.log(`[VlmClient] Invoking vision model "${config.model}" via ${isOpenAi ? 'OpenAI-compatible' : 'Ollama-native'} at ${url}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (config.credential) {
    headers.Authorization = `Bearer ${config.credential}`;
  }

  const dataUri = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;

  const body = isOpenAi
    ? JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
        stream: false,
      })
    : JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: prompt,
            images: [imageBase64.replace(/^data:image\/[a-z]+;base64,/, '')],
          },
        ],
        stream: false,
      });

  await acquireLocalSlot('ollama');
  try {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers,
        body,
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

    const data = (await response.json()) as any;
    const content = isOpenAi
      ? data?.choices?.[0]?.message?.content
      : data?.message?.content;

    if (!content) {
      throw new Error('VLM returned an empty response.');
    }

    return content.trim();
  } finally {
    releaseLocalSlot('ollama');
  }
}
