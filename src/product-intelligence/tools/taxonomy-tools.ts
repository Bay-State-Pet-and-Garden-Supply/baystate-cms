/**
 * Taxonomy research tools (PI-3).
 *
 * list_product_type_candidates, list_attribute_options,
 * list_category_page_candidates, validate_taxonomy_selection. These tools
 * never invent identifiers — they read the CMS-controlled configuration and
 * validate proposals against it. Proposals must reference existing stable
 * ids or abstain.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/20
 */
import { Type } from 'typebox';
import {
  getCachedAttributes,
  getCachedProductTypes,
} from '../../db/repositories/classification-config-repo';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import type { PiToolAdapter, PiToolContext, PiToolResult } from './contract';
import { evidenceId, noResult, okResult } from './contract';
import { boundedString } from './registry';

const listProductTypeCandidates: PiToolAdapter = {
  name: 'list_product_type_candidates',
  version: '1.0.0',
  description:
    'List the internal Product Types the CMS controls (stable ids + labels + descriptions). Never invent a Product Type — only these ids may be proposed.',
  parameters: Type.Object({ query: Type.Optional(boundedString(128, 'Optional label filter')) }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const types = getCachedProductTypes(ctx.workspaceId);
    if (types.length === 0) return noResult('No Product Types are configured for this workspace');
    const query = params.query ? String(params.query).toLowerCase() : null;
    const filtered = query
      ? types.filter((t) => (t.name ?? '').toLowerCase().includes(query) || String(t.id).toLowerCase().includes(query))
      : types;
    if (filtered.length === 0) return noResult(`No Product Types match "${query}"`);
    return okResult(
      { count: filtered.length, productTypes: filtered.map((t) => ({ id: t.id, name: t.name, description: t.description ?? null })) },
      [{ id: evidenceId('list_product_type_candidates', ctx.workspaceId), kind: 'taxonomy_evidence', method: 'classification_config' }],
    );
  },
};

const listAttributeOptions: PiToolAdapter = {
  name: 'list_attribute_options',
  version: '1.0.0',
  description:
    'List the Product Attributes the CMS controls (stable field names, allowed values, data types). Never invent an attribute or an allowed value — only these may be proposed.',
  parameters: Type.Object({ query: Type.Optional(boundedString(128, 'Optional attribute name filter')) }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const attributes = getCachedAttributes(ctx.workspaceId);
    if (attributes.length === 0) return noResult('No Product Attributes are configured for this workspace');
    const query = params.query ? String(params.query).toLowerCase() : null;
    const filtered = query ? attributes.filter((a) => (a.name ?? '').toLowerCase().includes(query)) : attributes;
    if (filtered.length === 0) return noResult(`No attributes match "${query}"`);
    return okResult(
      {
        count: filtered.length,
        attributes: filtered.map((a) => ({
          id: a.id,
          name: a.name,
          valueMode: a.valueMode,
          allowedValues: a.allowedValues ?? [],
        })),
      },
      [{ id: evidenceId('list_attribute_options', ctx.workspaceId), kind: 'taxonomy_evidence', method: 'classification_config' }],
    );
  },
};

const listCategoryPageCandidates: PiToolAdapter = {
  name: 'list_category_page_candidates',
  version: '1.0.0',
  description:
    'List verified Category Page candidates (stable page ids + names + paths). Never invent a Category Page — only these ids may be proposed.',
  parameters: Type.Object({ query: Type.Optional(boundedString(128, 'Optional name filter')) }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const pages = listVerifiedPageOptions(ctx.workspaceId);
    if (pages.length === 0) return noResult('No verified Category Pages exist for this workspace');
    const query = params.query ? String(params.query).toLowerCase() : null;
    const filtered = query ? pages.filter((p) => (p.name ?? '').toLowerCase().includes(query)) : pages;
    if (filtered.length === 0) return noResult(`No Category Pages match "${query}"`);
    return okResult(
      {
        count: filtered.length,
        pages: filtered.map((p) => ({ id: p.id, name: p.name, identityStatus: p.identityStatus ?? null })),
      },
      [{ id: evidenceId('list_category_page_candidates', ctx.workspaceId), kind: 'taxonomy_evidence', method: 'page_identity_registry' }],
    );
  },
};

const validateTaxonomySelection: PiToolAdapter = {
  name: 'validate_taxonomy_selection',
  version: '1.0.0',
  description:
    'Validate a proposed taxonomy selection against the CMS-controlled configuration. Returns which ids exist and which are invalid, and whether the selection is fully valid. Invalid selections must be corrected before submission.',
  parameters: Type.Object({
    productTypeId: Type.Optional(boundedString(128, 'Proposed Product Type id')),
    categoryPageId: Type.Optional(boundedString(128, 'Proposed Category Page id')),
    attributeValues: Type.Optional(
      Type.Array(
        Type.Object({
          name: boundedString(128, 'Attribute name'),
          value: boundedString(256, 'Attribute value'),
        }),
        { maxItems: 20 },
      ),
    ),
  }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const issues: string[] = [];
    const productTypes = getCachedProductTypes(ctx.workspaceId);
    const attributes = getCachedAttributes(ctx.workspaceId);
    const pages = listVerifiedPageOptions(ctx.workspaceId);

    const productTypeId = params.productTypeId ? String(params.productTypeId) : null;
    const categoryPageId = params.categoryPageId ? String(params.categoryPageId) : null;
    const attributeValues = params.attributeValues ? (params.attributeValues as Array<{ name: string; value: string }>) : [];

    const productTypeValid = productTypeId === null || productTypes.some((t) => String(t.id) === productTypeId);
    if (productTypeId !== null && !productTypeValid) issues.push(`productTypeId "${productTypeId}" is not a configured Product Type`);
    const pageValid = categoryPageId === null || pages.some((p) => p.id === categoryPageId);
    if (categoryPageId !== null && !pageValid) issues.push(`categoryPageId "${categoryPageId}" is not a verified Category Page`);

    const attributeMap = new Map(attributes.map((a) => [a.name, a]));
    for (const attr of attributeValues) {
      const config = attributeMap.get(attr.name);
      if (!config) {
        issues.push(`attribute "${attr.name}" is not configured`);
        continue;
      }
      const allowed = config.allowedValues ?? [];
      if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(attr.value)) {
        issues.push(`attribute "${attr.name}" does not allow value "${attr.value}"`);
      }
    }

    const valid = issues.length === 0;
    return okResult(
      { valid, issues, productTypeValid, categoryPageValid: pageValid, attributeCount: attributeValues.length },
      [{ id: evidenceId('validate_taxonomy_selection', `${productTypeId ?? ''}:${categoryPageId ?? ''}`), kind: 'taxonomy_evidence', method: 'classification_config_validation' }],
    );
  },
};

export const taxonomyTools: PiToolAdapter[] = [
  listProductTypeCandidates,
  listAttributeOptions,
  listCategoryPageCandidates,
  validateTaxonomySelection,
];
