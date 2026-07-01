import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { randomUUID } from 'node:crypto';
import { getCachedAttributes, getCachedAttributeProfiles } from '../../db/repositories/classification-config-repo';

const now = () => new Date().toISOString();

export const productAttributeProposalsStage: StageDefinition = {
  name: 'product_attribute_proposals',
  requires: ['attribute_applicability'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const allAttributes = getCachedAttributes(context.workspaceId);
    if (allAttributes.length === 0) return { status: 'abstained', reason: 'No attributes configured.' };

    const acceptedType = input.acceptedProposals.find(p => p.proposalType === 'primary_product_type' && p.status === 'accepted');
    let applicableIds: string[] = [];
    if (acceptedType?.targetId) {
      const profiles = getCachedAttributeProfiles(context.workspaceId);
      const profile = profiles.find(p => p.productTypeId === acceptedType.targetId);
      if (profile) applicableIds = profile.attributes.map(a => a.attributeId);
    }
    if (applicableIds.length === 0) applicableIds = allAttributes.map(a => a.id);

    const joinedText = input.evidence.map(e => {
      if (!e.value) return '';
      if (typeof e.value === 'string') return e.value;
      return JSON.stringify(e.value);
    }).join(' ').toLowerCase();

    const cardinalityMap: Record<string, string> = {};
    if (acceptedType?.targetId) {
      const profiles = getCachedAttributeProfiles(context.workspaceId);
      const profile = profiles.find(p => p.productTypeId === acceptedType.targetId);
      if (profile) for (const pa of profile.attributes) cardinalityMap[pa.attributeId] = pa.cardinality;
    }

    const proposals: any[] = [];
    const evidenceIds = input.evidence.map(e => e.id);

    for (const attr of allAttributes) {
      if (!applicableIds.includes(attr.id)) continue;
      const found: string[] = [];
      for (const v of attr.allowedValues) { if (joinedText.includes(v.toLowerCase())) found.push(v); }
      for (const a of attr.valueAliases) { if (joinedText.includes(a.alias.toLowerCase())) { if (!found.includes(a.mapsTo)) found.push(a.mapsTo); } }
      if (found.length > 0) {
        const cardinality = cardinalityMap[attr.id] ?? 'single';
        proposals.push({
          id: randomUUID(), runId: context.runId, productSku: input.sku,
          proposalType: 'field_assignment' as const, targetId: attr.id,
          proposedValue: cardinality === 'multiple' ? found.slice(0, 10) : found[0],
          confidence: found.length >= 2 ? 0.7 : 0.5, evidenceIds,
          status: 'pending' as const, isBulkAcceptable: true, isStale: false,
          stalenessReason: null, createdAt: now(),
        });
      }
    }
    if (proposals.length === 0) return { status: 'abstained', reason: 'No attribute value matches found.' };
    return { status: 'succeeded', output: { evidence: [], proposals: [...proposals], abstained: false } };
  },
};
