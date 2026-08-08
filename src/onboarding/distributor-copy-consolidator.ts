/**
 * Multi-provider distributor copy consolidator.
 *
 * Collects all third_party_page title/brand/description signals from accepted
 * distributor evidence attempts and consolidates them into a single curated
 * description. Uses the configured LLM when available; falls back to the
 * highest-confidence non-empty description deterministically.
 *
 * Provider disagreement is surfaced as soft warnings rather than silently
 * resolving or discarding differences.
 */

import { getLlmConfigForTask, callLlmForTask } from './llm-client';
import type { EvidenceAttempt } from '../shared/schemas/distributor-evidence';
import { ProductIdentityEvidenceSchema } from '../shared/schemas/distributor-evidence';

export interface DistributorTitleSignal {
  title: string;
  providerId: string;
  attemptId: string;
  confidence: number;
}

export interface ConsolidationResult {
  /** The consolidated/final curated description. */
  curatedDescription: string | null;
  /** The immutable attempt IDs whose copy contributed. */
  sourceAttemptIds: string[];
  /** Non-blocking differences surfaced for Review. */
  warnings: string[];
}

/**
 * Collect all distributor title signals from accepted attempts.
 * Titles are ordered by confidence descending, then provider ID.
 */
export function collectDistributorTitles(
  attempts: EvidenceAttempt[],
): DistributorTitleSignal[] {
  const signals: DistributorTitleSignal[] = [];

  for (const attempt of attempts) {
    if (attempt.outcome !== 'found' || !attempt.identityJson) continue;

    try {
      const raw = JSON.parse(attempt.identityJson);
      const result = ProductIdentityEvidenceSchema.safeParse(raw);
      if (result.success && result.data.name) {
        signals.push({
          title: result.data.name,
          providerId: attempt.providerId,
          attemptId: attempt.id,
          confidence: attempt.confidence,
        });
      }
    } catch {
      // Skip malformed identities
    }
  }

  // Sort by confidence descending, then provider ID for determinism
  signals.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.providerId.localeCompare(b.providerId);
  });

  return signals;
}

/**
 * Consolidate all distributor provider descriptions into a single curated copy.
 *
 * Rules:
 * - Provider text is delimited and untrusted — never invent claims
 * - LLM is used when configured for product_curation; otherwise fallback
 * - Fallback: highest-confidence non-empty description wins
 * - Soft differences (e.g. "premium" vs "gourmet") become warnings
 */
export async function consolidateDistributorCopy(
  attempts: EvidenceAttempt[],
  itemName: string,
  brandHint: string | null,
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
): Promise<ConsolidationResult> {
  const foundAttempts = attempts.filter(a => a.outcome === 'found');
  if (foundAttempts.length === 0) {
    return { curatedDescription: null, sourceAttemptIds: [], warnings: [] };
  }

  const sourceAttemptIds = foundAttempts.map(a => a.id);
  const warnings: string[] = [];

  // Parse all descriptions
  interface DescriptionEntry {
    text: string;
    providerId: string;
    attemptId: string;
    confidence: number;
  }

  const descriptions: DescriptionEntry[] = [];
  const titles: DescriptionEntry[] = [];

  for (const attempt of foundAttempts) {
    if (!attempt.identityJson) continue;
    try {
      const raw = JSON.parse(attempt.identityJson);
      const result = ProductIdentityEvidenceSchema.safeParse(raw);
      if (result.success) {
        const data = result.data;
        if (data.description) {
          descriptions.push({
            text: data.description,
            providerId: attempt.providerId,
            attemptId: attempt.id,
            confidence: attempt.confidence,
          });
        }
        if (data.name) {
          titles.push({
            text: data.name,
            providerId: attempt.providerId,
            attemptId: attempt.id,
            confidence: attempt.confidence,
          });
        }
      }
    } catch {
      // Skip malformed
    }
  }

  // Sort descriptions by confidence descending
  descriptions.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.providerId.localeCompare(b.providerId);
  });

  // Check for disagreements between providers
  if (descriptions.length >= 2) {
    const firstDesc = descriptions[0].text.toLowerCase().trim();
    for (let i = 1; i < descriptions.length; i++) {
      const otherDesc = descriptions[i].text.toLowerCase().trim();
      // Simple length-based divergence check
      const shortLen = Math.min(firstDesc.length, otherDesc.length);
      if (shortLen > 20) {
        // Check if descriptions differ significantly
        const commonWords = firstDesc.split(' ').filter(w =>
          otherDesc.includes(w) && w.length > 3,
        ).length;
        const totalUnique = new Set([...firstDesc.split(' '), ...otherDesc.split(' ')]).size;
        if (totalUnique > 0 && commonWords / totalUnique < 0.3) {
          warnings.push(`Significant description difference between ${descriptions[0].providerId} and ${descriptions[i].providerId}`);
        }
      }
    }
  }

  // Try LLM consolidation
  const llmConfig = getLlmConfigForTask('product_curation', {
    allowFallback: true,
    modelPolicy,
    protectedOperation: 'distributor_copy_consolidation',
  });
  if (llmConfig && descriptions.length > 0) {
    const prompt = buildConsolidationPrompt(descriptions, itemName, brandHint);
    try {
      const consolidated = await callLlmForTask(
        'product_curation',
        prompt,
        'You are a product copy editor. Synthesize only the facts provided — never invent claims, specifications, or usage details.',
        {
          allowFallback: true,
          modelPolicy,
          protectedOperation: 'distributor_copy_consolidation',
        },
      );
      if (consolidated && consolidated.length > 10 && consolidated.length < 5000) {
        return {
          curatedDescription: consolidated,
          sourceAttemptIds,
          warnings,
        };
      }
    } catch (err: any) {
      console.warn(`[DistributorCopyConsolidator] LLM consolidation failed: ${err.message}`);
    }
  }

  // Fallback: highest-confidence non-empty description
  const best = descriptions[0] ?? null;
  return {
    curatedDescription: best ? best.text : null,
    sourceAttemptIds,
    warnings,
  };
}

function buildConsolidationPrompt(
  descriptions: Array<{ text: string; providerId: string; confidence: number }>,
  itemName: string,
  brandHint: string | null,
): string {
  const parts: string[] = [
    `Product: ${itemName}`,
    brandHint ? `Brand: ${brandHint}` : '',
    '',
    'Below are product descriptions from distributor sources. Synthesize a single accurate, natural description using only the facts provided.',
    'IMPORTANT: Do not invent any claims, specifications, or usage details that are not present in at least one source.',
    'IMPORTANT: Do not include pricing, distributor names, or inventory status.',
    'IMPORTANT: If sources disagree, use the most specific and recent information.',
    '',
  ];

  for (let i = 0; i < descriptions.length; i++) {
    parts.push(`--- Source ${i + 1}: ${descriptions[i].providerId} (confidence: ${descriptions[i].confidence}) ---`);
    parts.push(descriptions[i].text);
    parts.push('');
  }

  parts.push('--- Consolidated Description ---');
  return parts.join('\n');
}
