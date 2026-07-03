import type { ClassificationProposal } from '../../shared/schemas/classification';
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { listPages } from '../../db/repositories/page-repo';
import { randomUUID } from 'node:crypto';
import { getLlmConfigForTask, callLlmForTask } from '../../onboarding/llm-client';
import { loadClassificationConfig } from '../config-loader';
import { getExplicitCurationTargets, hasExplicitCurationTargets } from '../curation-targets';

function tokenize(text: string): string[] {
  const stop = new Set(['and', 'the', 'for', 'with', 'from', 'page', 'pages', 'products', 'product', 'shop', 'all']);
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(t => t.trim())
    .filter(t => t.length > 2 && !stop.has(t));
}

function evidenceText(input: StageInput): string {
  return input.evidence
    .filter(e => e.source === 'spreadsheet' || e.source === 'official_product_page')
    .map(e => `${e.snippet ?? ''} ${typeof e.value === 'string' ? e.value : JSON.stringify(e.value ?? '')}`)
    .join(' ');
}

async function llmChoosePages(params: {
  pageNames: string[];
  text: string;
  selectionMode: 'single' | 'multiple';
}): Promise<{ pages: string[]; confidence: number } | null> {
  const llmConfig = getLlmConfigForTask('category_classification', { allowFallback: true });
  if (!llmConfig || params.pageNames.length === 0 || params.text.trim().length < 8) return null;
  const maxPages = params.selectionMode === 'multiple' ? 5 : 1;
  const options = params.pageNames.slice(0, 250);
  const prompt = `Classify this product onto ${params.selectionMode === 'multiple' ? `up to ${maxPages}` : 'one'} existing ShopSite page(s). Choose from the allowed page names only.

Allowed page names:
${JSON.stringify(options)}

Product evidence:
${params.text.slice(0, 3000)}

Return ONLY valid JSON in this shape: {"pages":["exact page name"],"confidence":0.0}. If no page fits, return {"pages":[],"confidence":0}.`;

  try {
    const response = await callLlmForTask(
      'category_classification',
      prompt,
      'You are a strict catalog page classifier. Return only exact allowed page names.',
      { allowFallback: true },
    );
    if (!response) return null;
    const parsed = JSON.parse(response.trim()) as { pages?: unknown[]; confidence?: unknown };
    const pages = (Array.isArray(parsed.pages) ? parsed.pages : [])
      .map(raw => String(raw ?? '').trim())
      .map(raw => options.find(option => option.toLowerCase() === raw.toLowerCase()) ?? null)
      .filter((page): page is string => page != null)
      .filter((page, index, arr) => arr.indexOf(page) === index)
      .slice(0, maxPages);
    if (pages.length === 0) return null;
    return { pages, confidence: Math.max(0.35, Math.min(0.85, Number(parsed.confidence) || 0.55)) };
  } catch (err: any) {
    console.warn(`[CategoryPageStage] LLM page selection failed: ${err.message}`);
    return null;
  }
}

/**
 * Category Page Proposal Stage
 *
 * Proposes which existing store Category Pages the product should be assigned to.
 * The stage only runs when page assignment is enabled in curation targets, unless
 * no explicit target config exists (backward-compatible legacy behavior).
 */
export const categoryPageProposalsStage: StageDefinition = {
  name: 'category_page_proposals',
  requires: ['evidence_extraction'],
  evidenceFrom: ['evidence_extraction', 'primary_product_type_proposal'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const config = loadClassificationConfig(context.workspacePath);
    const explicitTargets = hasExplicitCurationTargets(config) ? getExplicitCurationTargets(config) : [];
    const pageTarget = explicitTargets.find(target => target.kind === 'page') ?? null;
    if (explicitTargets.length > 0 && !pageTarget) {
      return {
        status: 'abstained',
        reason: 'Page assignment is not enabled as a curation target.',
      };
    }
    const selectionMode = (pageTarget?.selectionMode ?? 'multiple') as 'single' | 'multiple';

    const pages = listPages();
    if (pages.length === 0) {
      return {
        status: 'abstained',
        reason: 'No store pages available. Sync pages from ShopSite or configure them manually.',
      };
    }

    const pageNames = pages.map(p => p.name);
    const text = evidenceText(input);
    const evidenceTokens = new Set(tokenize(text));
    const scored = pageNames.map(name => {
      const pageTokens = tokenize(name);
      const hits = pageTokens.filter(token => evidenceTokens.has(token));
      const score = pageTokens.length === 0 ? 0 : hits.length / pageTokens.length;
      return { name, score, hits };
    }).filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    let matches = scored
      .filter(match => match.score >= 0.5 || match.hits.length >= 2)
      .map(match => ({ name: match.name, confidence: Math.min(0.85, 0.45 + match.score * 0.35) }));

    if (matches.length === 0) {
      const llmChoice = await llmChoosePages({ pageNames, text, selectionMode });
      if (llmChoice) {
        matches = llmChoice.pages.map(name => ({ name, confidence: llmChoice.confidence }));
      }
    }

    if (selectionMode === 'single') {
      matches = matches.slice(0, 1);
    } else {
      matches = matches.slice(0, 5);
    }

    if (matches.length === 0) {
      return {
        status: 'abstained',
        reason: 'No category page matches found from available evidence.',
      };
    }

    const evidenceIds = input.evidence.slice(0, 3).map(e => e.id);
    const proposals: ClassificationProposal[] = matches.map(match => ({
      id: randomUUID(),
      runId: context.runId,
      productSku: input.sku,
      proposalType: 'category_page',
      targetId: match.name,
      proposedValue: { pageName: match.name },
      confidence: match.confidence,
      evidenceIds,
      status: 'pending',
      isBulkAcceptable: match.confidence >= 0.7,
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
