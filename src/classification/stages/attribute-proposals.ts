import type { ClassificationProposal, ProductAttributeConfig } from '../../shared/schemas/classification';
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { randomUUID } from 'node:crypto';
import {
  getCachedAttributes,
  getCachedAttributeMappings,
  getCachedAttributeProfiles,
} from '../../db/repositories/classification-config-repo';
import { getLlmConfigForTask, callLlmForTask } from '../../onboarding/llm-client';
import { loadClassificationConfig } from '../config-loader';
import {
  findCurationTargetForAttribute,
  getExplicitCurationTargets,
  hasExplicitCurationTargets,
  resolveAttributeAllowedValues,
} from '../curation-targets';

const now = () => new Date().toISOString();

function normalizeOption(value: unknown, options: string[]): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return options.find(option => option.toLowerCase() === raw.toLowerCase()) ?? null;
}

function evidenceText(input: StageInput): string {
  return input.evidence.map(e => {
    if (!e.value) return '';
    if (typeof e.value === 'string') return e.value;
    return JSON.stringify(e.value);
  }).join(' ').toLowerCase();
}

async function llmChooseValues(params: {
  attribute: ProductAttributeConfig;
  options: string[];
  selectionMode: 'single' | 'multiple';
  text: string;
}): Promise<{ values: string[]; confidence: number } | null> {
  if (params.options.length === 0 || params.text.length < 8) return null;
  const llmConfig = getLlmConfigForTask('category_classification', { allowFallback: true });
  if (!llmConfig) return null;

  const optionList = params.options.slice(0, 150);
  const maxValues = params.selectionMode === 'multiple' ? Math.min(10, optionList.length) : 1;
  const prompt = `Choose ${params.selectionMode === 'multiple' ? `up to ${maxValues}` : 'one'} value(s) for the product field "${params.attribute.name}" from the allowed options only.

Allowed options:
${JSON.stringify(optionList)}

Product evidence:
${params.text.slice(0, 3000)}

Return ONLY valid JSON in this shape: {"values":["exact allowed option"],"confidence":0.0}. If none fit, return {"values":[],"confidence":0}. Do not invent options.`;

  try {
    const response = await callLlmForTask(
      'category_classification',
      prompt,
      'You are a strict catalog classifier. You only return exact values from the allowed options.',
      { allowFallback: true },
    );
    if (!response) return null;
    const parsed = JSON.parse(response.trim()) as { values?: unknown[]; value?: unknown; confidence?: unknown };
    const rawValues = Array.isArray(parsed.values) ? parsed.values : parsed.value != null ? [parsed.value] : [];
    const values = rawValues
      .map(value => normalizeOption(value, optionList))
      .filter((value): value is string => value != null)
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .slice(0, maxValues);
    if (values.length === 0) return null;
    const confidence = Math.max(0.35, Math.min(0.85, Number(parsed.confidence) || 0.55));
    return { values, confidence };
  } catch (err: any) {
    console.warn(`[AttributeProposalStage] LLM option selection failed for ${params.attribute.id}: ${err.message}`);
    return null;
  }
}

export const productAttributeProposalsStage: StageDefinition = {
  name: 'product_attribute_proposals',
  requires: ['attribute_applicability'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const config = loadClassificationConfig(context.workspacePath);
    const explicitTargets = hasExplicitCurationTargets(config) ? getExplicitCurationTargets(config) : [];
    const productFieldTargets = explicitTargets.filter(target => target.kind === 'product_field');
    if (explicitTargets.length > 0 && productFieldTargets.length === 0) {
      return { status: 'abstained', reason: 'No product-field curation targets are enabled.' };
    }

    const allAttributes = getCachedAttributes(context.workspaceId);
    if (allAttributes.length === 0) return { status: 'abstained', reason: 'No attributes configured.' };

    const mappings = getCachedAttributeMappings(context.workspaceId);
    const acceptedType = input.acceptedProposals.find(p => p.proposalType === 'primary_product_type' && p.status === 'accepted');
    let applicableIds: string[] = [];
    if (acceptedType?.targetId) {
      const profiles = getCachedAttributeProfiles(context.workspaceId);
      const profile = profiles.find(p => p.productTypeId === acceptedType.targetId);
      if (profile) applicableIds = profile.attributes.map(a => a.attributeId);
    }
    if (applicableIds.length === 0) applicableIds = allAttributes.map(a => a.id);

    if (productFieldTargets.length > 0) {
      const targetAttributeIds = new Set(
        productFieldTargets.flatMap(target => {
          const ids: string[] = [];
          if (target.attributeId) ids.push(target.attributeId);
          if (target.catalogField) {
            const mapping = mappings.find(m => m.catalogField === target.catalogField);
            if (mapping) ids.push(mapping.attributeId);
          }
          return ids;
        }),
      );
      applicableIds = applicableIds.filter(id => targetAttributeIds.has(id));
    }

    const joinedText = evidenceText(input);

    const cardinalityMap: Record<string, 'single' | 'multiple'> = {};
    if (acceptedType?.targetId) {
      const profiles = getCachedAttributeProfiles(context.workspaceId);
      const profile = profiles.find(p => p.productTypeId === acceptedType.targetId);
      if (profile) {
        for (const pa of profile.attributes) cardinalityMap[pa.attributeId] = pa.cardinality;
      }
    }

    const proposals: ClassificationProposal[] = [];
    const evidenceIds = input.evidence.map(e => e.id);

    for (const attr of allAttributes) {
      if (!applicableIds.includes(attr.id)) continue;

      const target = findCurationTargetForAttribute(config, attr.id, mappings);
      const selectionMode = (target?.selectionMode ?? cardinalityMap[attr.id] ?? 'single') as 'single' | 'multiple';
      const options = resolveAttributeAllowedValues(config, attr, target);
      const found: string[] = [];

      for (const v of options) {
        if (joinedText.includes(v.toLowerCase())) found.push(v);
      }
      for (const a of attr.valueAliases) {
        if (joinedText.includes(a.alias.toLowerCase())) {
          const mapped = normalizeOption(a.mapsTo, options) ?? a.mapsTo;
          if (!found.includes(mapped)) found.push(mapped);
        }
      }

      let values = found.slice(0, selectionMode === 'multiple' ? 10 : 1);
      let confidence = found.length >= 2 ? 0.75 : found.length === 1 ? 0.6 : 0;

      if (values.length === 0) {
        const llmChoice = await llmChooseValues({ attribute: attr, options, selectionMode, text: joinedText });
        if (llmChoice) {
          values = llmChoice.values;
          confidence = llmChoice.confidence;
        }
      }

      if (values.length > 0) {
        proposals.push({
          id: randomUUID(),
          runId: context.runId,
          productSku: input.sku,
          proposalType: 'field_assignment',
          targetId: attr.id,
          proposedValue: selectionMode === 'multiple' ? values : values[0],
          confidence,
          evidenceIds,
          status: 'pending',
          isBulkAcceptable: confidence >= 0.7,
          isStale: false,
          stalenessReason: null,
          createdAt: now(),
        });
      }
    }
    if (proposals.length === 0) return { status: 'abstained', reason: 'No attribute value matches found.' };
    return { status: 'succeeded', output: { evidence: [], proposals, abstained: false } };
  },
};
