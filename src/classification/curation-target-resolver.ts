/**
 * Curation target option resolver.
 *
 * Resolves enabled curation targets to their concrete option lists.
 * Each target kind (product_type, product_field, page) uses a different
 * option source — product types from config, fields from attributes + live
 * store values, pages from the live store page index.
 *
 * This is the config-driven entry point: enabled curation targets define
 * WHAT needs proposals; the resolver provides the RAW MATERIALS (options)
 * that matchers and rankers then score against evidence.
 */
import {
  type ClassificationConfig,
  type CurationTargetConfig,
  type ProductAttributeConfig,
} from '../shared/schemas/classification';
import {
  getExplicitCurationTargets,
  resolveAttributeAllowedValues,
} from './curation-targets';
import { getCachedProductTypes } from '../db/repositories/classification-config-repo';
import { listPages } from '../db/repositories/page-repo';

export interface ResolvedTargetOption {
  value: string;
  label: string;
}

export interface ResolvedTarget {
  config: CurationTargetConfig;
  /** Resolved option list for this target */
  options: ResolvedTargetOption[];
  /** The attribute config, if this is a product_field target */
  attribute?: ProductAttributeConfig;
}

export interface ResolvedTargets {
  /** Product type targets */
  productTypes: ResolvedTarget[];
  /** Product field / attribute targets */
  productFields: ResolvedTarget[];
  /** Category page targets */
  pages: ResolvedTarget[];
  /** Whether any targets are enabled */
  hasAny: boolean;
}

/**
 * Resolve all enabled curation targets to their concrete options.
 *
 * @param config - The full classification config
 * @param workspaceId - Current workspace ID for cached reads
 * @returns Resolved targets grouped by kind, with options populated
 */
export function resolveEnabledTargets(
  config: ClassificationConfig,
  workspaceId: string,
): ResolvedTargets {
  // Start with explicitly enabled targets
  const enabled = getExplicitCurationTargets(config);

  // Include mandatory targets regardless of enabled flag
  const allTargets = [...enabled];
  for (const target of config.curationTargets ?? []) {
    if ((target as any).mandatory === true && !allTargets.find(e => e.id === target.id)) {
      allTargets.push(target);
    }
  }

  const productTypes: ResolvedTarget[] = [];
  const productFields: ResolvedTarget[] = [];
  const pages: ResolvedTarget[] = [];

  for (const target of allTargets) {
    switch (target.kind) {
      case 'product_type': {
        const cached = getCachedProductTypes(workspaceId);
        // Prefer cache, fall back to config file for test/reset scenarios
        const options: ResolvedTargetOption[] = (cached.length > 0 ? cached : config.productTypes).map(pt => ({
          value: pt.id,
          label: pt.name,
        }));
        productTypes.push({ config: target, options });
        break;
      }

      case 'product_field': {
        const attribute = config.attributes.find(a => a.id === target.attributeId);
        if (!attribute) {
          // Target references a missing attribute — skip silently
          continue;
        }
        const allowedValues = resolveAttributeAllowedValues(config, attribute, target);
        const options: ResolvedTargetOption[] = allowedValues.map(v => ({
          value: v,
          label: v,
        }));
        productFields.push({ config: target, options, attribute });
        break;
      }

      case 'page': {
        const storePages = listPages();
        const options: ResolvedTargetOption[] = storePages.map(p => ({
          value: p.id,
          label: p.name,
        }));
        pages.push({ config: target, options });
        break;
      }
    }
  }

  return {
    productTypes,
    productFields,
    pages,
    hasAny: productTypes.length > 0 || productFields.length > 0 || pages.length > 0,
  };
}
