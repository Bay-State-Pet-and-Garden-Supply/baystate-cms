import type { AttributeMappingConfig, ClassificationProposal } from '../shared/types';

/**
 * Serialize an attribute value into a catalog field string using the mapping's
 * serialization config. Supports: direct, separator (for arrays), prefix, suffix.
 */
export function serializeAttributeValue(
  value: unknown,
  serialization: AttributeMappingConfig['serialization'],
): string {
  const { format, separator = ', ', prefix = '', suffix = '' } = serialization;

  let core: string;
  if (Array.isArray(value)) {
    core = value.map(v => String(v)).join(separator);
  } else if (typeof value === 'string') {
    core = value;
  } else if (value !== null && value !== undefined) {
    core = String(value);
  } else {
    core = '';
  }

  return `${prefix}${core}${suffix}`;
}

/**
 * Project the effect of accepted proposals against current product state.
 * Produces three views:
 * - fields: per-catalog-field diff showing current, proposed, overwrite, no-op
 * - pages: existing vs proposed page additions
 * - skipped: proposals that could not be mapped
 */
export function buildAssignmentProjection(
  acceptedProposals: ClassificationProposal[],
  currentCustomFields: Record<string, string>,
  currentPageNames: string[],
  mappings: AttributeMappingConfig[],
): {
  fields: Array<{
    catalogField: string;
    currentValue: string | null;
    proposedValue: string | null;
    isOverwrite: boolean;
    isNoOp: boolean;
  }>;
  pages: {
    existing: string[];
    proposed: string[];
  };
  skipped: Array<{
    proposalId: string;
    targetId: string | null;
    reason: string;
  }>;
} {
  const fields: Array<{
    catalogField: string;
    currentValue: string | null;
    proposedValue: string | null;
    isOverwrite: boolean;
    isNoOp: boolean;
  }> = [];
  const proposedPages: string[] = [];
  const skipped: Array<{
    proposalId: string;
    targetId: string | null;
    reason: string;
  }> = [];
  const seenFields = new Set<string>();

  for (const proposal of acceptedProposals) {
    if (proposal.proposalType === 'field_assignment' && proposal.targetId) {
      const mapping = mappings.find(m => m.attributeId === proposal.targetId);
      if (!mapping) {
        skipped.push({ proposalId: proposal.id, targetId: proposal.targetId, reason: 'No attribute mapping found' });
        continue;
      }
      if (mapping.isStale) {
        skipped.push({ proposalId: proposal.id, targetId: proposal.targetId, reason: 'Attribute mapping is stale' });
        continue;
      }
      if (!mapping.catalogField) {
        skipped.push({ proposalId: proposal.id, targetId: proposal.targetId, reason: 'No catalog field in mapping' });
        continue;
      }

      const currentValue = currentCustomFields[mapping.catalogField] ?? null;
      const proposedValue = serializeAttributeValue(proposal.proposedValue, mapping.serialization);
      const isNoOp = currentValue === proposedValue;
      const isOverwrite = currentValue !== null && !isNoOp;

      if (seenFields.has(mapping.catalogField)) continue;
      seenFields.add(mapping.catalogField);

      fields.push({ catalogField: mapping.catalogField, currentValue, proposedValue, isOverwrite, isNoOp });
    } else if (proposal.proposalType === 'category_page' && proposal.targetId) {
      const pv = proposal.proposedValue as Record<string, unknown> | undefined;
      const pageName = pv?.pageName ? String(pv.pageName) : String(proposal.targetId);
      if (!currentPageNames.includes(pageName) && !proposedPages.includes(pageName)) {
        proposedPages.push(pageName);
      } else {
        skipped.push({ proposalId: proposal.id, targetId: proposal.targetId, reason: 'Page already assigned' });
      }
    }
  }

  return { fields, pages: { existing: currentPageNames, proposed: proposedPages }, skipped };
}
