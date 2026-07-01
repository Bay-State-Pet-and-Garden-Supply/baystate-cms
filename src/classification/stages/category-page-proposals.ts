import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { listPages } from '../../db/repositories/page-repo';
import { randomUUID } from 'node:crypto';

/**
 * Category Page Proposal Stage
 *
 * Proposes which existing store Category Pages the product should be assigned to.
 * Uses direct evidence (product name, description, existing page names) and
 * optionally the accepted Primary Product Type for context.
 *
 * Dependencies: Primary Product Type proposal (optional — can run with direct
 * evidence only), evidence extraction.
 */
export const categoryPageProposalsStage: StageDefinition = {
  name: 'category_page_proposals',
  requires: ['evidence_extraction'],
  evidenceFrom: ['evidence_extraction', 'primary_product_type_proposal'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const pages = listPages();
    if (pages.length === 0) {
      return {
        status: 'abstained',
        reason: 'No store pages available. Sync pages from ShopSite or configure them manually.',
      };
    }

    // Stub: produce a simple proposal. Real implementation would:
    // 1. Match product title/description keywords against page names
    // 2. Use page hierarchy for narrowing
    // 3. Optionally use Product Type as evidence
    // 4. Produce individual category_page proposals

    const pageNames = pages.map(p => p.name);
    const evidenceText = input.evidence
      .filter(e => e.source === 'spreadsheet' || e.source === 'official_product_page')
      .map(e => e.snippet ?? '')
      .join(' ');

    // Very simple keyword overlap matching (placeholder)
    const matches = pageNames.filter(name =>
      evidenceText.toLowerCase().includes(name.toLowerCase()),
    );

    if (matches.length === 0) {
      return {
        status: 'abstained',
        reason: 'No category page matches found from available evidence.',
      };
    }

    const proposals = matches.slice(0, 5).map(name => ({
      id: randomUUID(),
      runId: context.runId,
      productSku: input.sku,
      proposalType: 'category_page' as const,
      targetId: name,
      proposedValue: { pageName: name },
      confidence: 0.5,
      evidenceIds: input.evidence.slice(0, 3).map(e => e.id),
      status: 'pending' as const,
      isBulkAcceptable: true,
      isStale: false,
      stalenessReason: null,
      createdAt: new Date().toISOString(),
    }));

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals,
        abstained: false,
      },
    };
  },
};
