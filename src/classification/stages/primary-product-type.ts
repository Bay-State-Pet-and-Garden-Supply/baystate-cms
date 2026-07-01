import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { randomUUID } from 'node:crypto';
import { getCachedProductTypes } from '../../db/repositories/classification-config-repo';
import { getLlmConfig, callLlm } from '../../onboarding/llm-client';

const now = () => new Date().toISOString();

/**
 * Primary Product Type Proposal Stage
 *
 * Classifies a product into a single Primary Product Type from the store's
 * configured product types. Uses deterministic keyword matching against
 * product names and descriptions first, then falls back to LLM classification
 * if no confident match is found.
 *
 * Dependencies: Evidence from evidence_extraction stage.
 */
export const primaryProductTypeStage: StageDefinition = {
  name: 'primary_product_type_proposal',
  requires: ['evidence_extraction'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const productTypes = getCachedProductTypes(context.workspaceId);
    if (productTypes.length === 0) {
      return { status: 'abstained', reason: 'No product types configured in store/classification/product-types.json.' };
    }

    // Gather all text evidence for matching
    const titleEvidence = input.evidence.filter(e => e.sourceField === 'title' || e.sourceField === 'name');
    const descEvidence = input.evidence.filter(e => e.sourceField === 'description');
    const allText = [
      ...titleEvidence.map(e => String(e.value ?? '')),
      ...descEvidence.map(e => String(e.value ?? '').slice(0, 500)),
    ].join(' ').toLowerCase();

    if (!allText || allText.length < 3) {
      return { status: 'abstained', reason: 'Insufficient text evidence for product type classification.' };
    }

    // ── Deterministic keyword scoring ─────────────────────────────────────
    const scores = productTypes.map(pt => {
      const nameLower = pt.name.toLowerCase();
      const words = nameLower.split(/[-\s]+/).filter(w => w.length > 2);
      const matches = words.filter(w => allText.includes(w));
      return { type: pt, score: matches.length, matchedWords: matches };
    });

    scores.sort((a, b) => b.score - a.score);

    const best = scores[0];
    const hasConfidentMatch = best && best.score >= 2;

    let proposalType: string | null = null;
    let confidence = 0;
    const matchedEvidenceIds = input.evidence.filter(e =>
      e.sourceField === 'title' || e.sourceField === 'name' || e.sourceField === 'description',
    ).map(e => e.id);

    if (hasConfidentMatch) {
      proposalType = best.type.id;
      confidence = Math.min(0.9, best.score / (best.type.name.split(/[-\s]+/).length + 2));
    } else if (scores[0] && scores[0].score >= 1) {
      // Try LLM fallback for moderate matches
      const llmConfig = getLlmConfig();
      if (llmConfig) {
        try {
          const typeNames = productTypes.map(pt => `"${pt.name}" (id: ${pt.id})`).join(', ');
          const prompt = `Classify this product into ONE of these product types: [${typeNames}]. Return ONLY the type ID (the part in parentheses) or "none" if nothing fits.\n\nProduct text: ${allText.slice(0, 1500)}`;
          const response = await callLlm(prompt, 'You are a precise product classification assistant. Return only the type ID or "none".');
          const clean = response.trim().replace(/["']/g, '');
          const match = productTypes.find(pt => pt.id === clean);
          if (match) {
            proposalType = match.id;
            confidence = 0.6;
          }
        } catch (err: any) {
          console.warn(`[ProductTypeStage] LLM classification failed: ${err.message}`);
        }
      }
    }

    if (!proposalType) {
      return { status: 'abstained', reason: 'No confident product type match found from available evidence.' };
    }

    const proposalId = randomUUID();
    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: [{
          id: proposalId,
          runId: context.runId,
          productSku: input.sku,
          proposalType: 'primary_product_type',
          targetId: proposalType,
          proposedValue: {
            productTypeId: proposalType,
            matchedWords: scores.find(s => s.type.id === proposalType)?.matchedWords ?? [],
          },
          confidence,
          evidenceIds: matchedEvidenceIds,
          status: 'pending',
          isBulkAcceptable: confidence >= 0.7,
          isStale: false,
          stalenessReason: null,
          createdAt: now(),
        }],
        abstained: false,
      },
    };
  },
};
