/**
 * Provider-agnostic LLM Client for Onboarding Pipeline.
 *
 * Checks database keys and routes completions to DeepSeek, OpenAI,
 * or a local Ollama instance (OpenAI-compatible /v1 endpoint).
 * Falls back to the LCS algorithm if no provider is configured.
 */

import { getApiKey } from '../db/repositories/api-key-repo';
import { extractConsensusName } from './lcs-extractor';

export interface LlmConfig {
  provider: 'deepseek' | 'openai' | 'ollama';
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Retrieve the active LLM provider configuration from the database.
 * Prioritizes DeepSeek, then OpenAI, then Ollama.
 */
export function getLlmConfig(): LlmConfig | null {
  // Try DeepSeek first (recommended cloud)
  const deepseek = getApiKey('deepseek');
  if (deepseek && deepseek.api_key && !deepseek.api_key.includes('•')) {
    return {
      provider: 'deepseek',
      apiKey: deepseek.api_key,
      baseUrl: deepseek.base_url || 'https://api.deepseek.com',
      model: deepseek.model || 'deepseek-v4-flash',
    };
  }

  // Try OpenAI second
  const openai = getApiKey('openai');
  if (openai && openai.api_key && !openai.api_key.includes('•')) {
    return {
      provider: 'openai',
      apiKey: openai.api_key,
      baseUrl: openai.base_url || 'https://api.openai.com/v1',
      model: openai.model || 'gpt-4o-mini',
    };
  }

  // Try Ollama third (local)
  const ollama = getApiKey('ollama');
  if (ollama && ollama.api_key && !ollama.api_key.includes('•')) {
    return {
      provider: 'ollama',
      apiKey: ollama.api_key || 'ollama-default',
      baseUrl: ollama.base_url || 'http://localhost:11434/v1',
      model: ollama.model || 'llama3',
    };
  }

  return null;
}

/**
 * Call completion API of the active LLM provider.
 */
export async function callLlm(
  prompt: string,
  systemPrompt = 'You are a helpful product cataloging assistant.',
): Promise<string> {
  const config = getLlmConfig();
  if (!config) {
    throw new Error('No LLM API keys configured in settings.');
  }

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
}

/**
 * Consolidate a canonical product name from Serper search titles and snippets.
 * Falls back to the LCS algorithm if the LLM is not configured or fails.
 */
export async function consolidateProductName(
  upc: string,
  searchResults: Array<{ title: string; snippet: string }>,
  originalName?: string,
  brandHint?: string | null,
): Promise<string | null> {
  if (searchResults.length === 0 && !originalName) return null;

  try {
    const config = getLlmConfig();
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
3. Strip out internal inventory tags, bulk quantities, or sizing codes that do not form a natural part of the name (e.g. "5CT", "2.64OZ", "10.5OZ", "6PK").
4. Ensure the brand name is present at the start of the canonical name.
5. Return ONLY the final product name string. Do not include quotes, explanatory text, bullet points, or markdown.

Clean Canonical Product Name:`;

    console.log(`[LLMClient] Calling LLM (${config.provider}:${config.model}) for UPC ${upc}`);
    const name = await callLlm(prompt, systemPrompt);

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
