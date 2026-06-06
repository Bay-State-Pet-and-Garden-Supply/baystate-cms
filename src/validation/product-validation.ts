import type { Product } from '../shared/types';
import type { ValidationResultRow } from '../db/repositories/validation-repo';
import { addValidationResult, hasBlockers } from '../db/repositories/validation-repo';
import { hasOpenDriftForSku } from '../db/repositories/drift-repo';

export interface ValidationContext {
  workspaceId: string;
  scopeType: 'product' | 'change_set';
  scopeId: string;
  allSkus: string[];
}

export interface ValidationOptions {
  /** Check for unresolved drift placeholders */
  checkDrift?: boolean;
  /** Check malformed registry */
  checkRegistry?: boolean;
  /** Check XML generation viability */
  checkXmlGeneration?: boolean;
}

/**
 * Run all validation rules for a single product draft.
 * Returns the list of validation results.
 */
export function validateProduct(
  product: Product,
  context: ValidationContext,
  options?: ValidationOptions,
): ValidationResultRow[] {
  const results: ValidationResultRow[] = [];
  const scopeType = context.scopeType;
  const scopeId = context.scopeId;

  // Clear previous results for this product within the scope
  // (caller should clear per scope)

  // 1. Missing SKU (blocker)
  if (!product.sku || product.sku.trim() === '') {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: 'blocker',
      code: 'MISSING_SKU',
      message: 'Product SKU is required and cannot be empty.',
      fieldPath: 'sku',
    }));
  }

  // 2. Duplicate SKU (blocker)
  if (product.sku && context.allSkus.filter(s => s === product.sku).length > 1) {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: 'blocker',
      code: 'DUPLICATE_SKU',
      message: `SKU "${product.sku}" appears more than once in this change set.`,
      fieldPath: 'sku',
    }));
  }

  // 3. Changed synced SKU (blocker)
  // If a product already has been pushed/synced, SKU must not change
  if (product.shopsite.lastSyncedAt && product.metadata.createdAt !== product.metadata.updatedAt) {
    // We detect SKU change by checking if there's a base product with different SKU
    // Handled at change-set level during approval via baseJson comparison
  }

  // 4. Invalid price (blocker)
  if (product.core.price != null && product.core.price !== '') {
    const priceNum = parseFloat(product.core.price);
    if (isNaN(priceNum) || priceNum < 0) {
      results.push(addValidationResult({
        scopeType, scopeId,
        severity: 'blocker',
        code: 'INVALID_PRICE',
        message: `Price "${product.core.price}" is not a valid non-negative number.`,
        fieldPath: 'core.price',
      }));
    }
  }
  if (product.core.salePrice != null && product.core.salePrice !== '') {
    const saleNum = parseFloat(product.core.salePrice);
    if (isNaN(saleNum) || saleNum < 0) {
      results.push(addValidationResult({
        scopeType, scopeId,
        severity: 'blocker',
        code: 'INVALID_SALE_PRICE',
        message: `Sale price "${product.core.salePrice}" is not a valid non-negative number.`,
        fieldPath: 'core.salePrice',
      }));
    }
  }

  // 5. Missing name (blocker)
  if (!product.core.name || product.core.name.trim() === '') {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: 'blocker',
      code: 'MISSING_NAME',
      message: 'Product name is required.',
      fieldPath: 'core.name',
    }));
  }

  // 6. Unresolved drift (blocker if checkDrift)
  if (options?.checkDrift && product.sku) {
    try {
      if (hasOpenDriftForSku(context.workspaceId, product.sku)) {
        results.push(addValidationResult({
          scopeType, scopeId,
          severity: 'blocker',
          code: 'UNRESOLVED_DRIFT',
          message: `Product "${product.sku}" has unresolved remote drift. Resolve drift before pushing.`,
          fieldPath: 'sku',
        }));
      }
    } catch {
      // Drift table may not exist or workspace not initialized yet
    }
  }

  // 7. Malformed registry placeholder (blocker if checkRegistry)
  if (options?.checkRegistry) {
    // Placeholder: will validate custom field mapping against registry
  }

  // 8. XML generation failure placeholder (blocker if checkXmlGeneration)
  if (options?.checkXmlGeneration) {
    // Placeholder: will attempt XML generation and catch errors
  }

  // Warnings:

  // 9. Missing/broken media reference (warning)
  if (product.core.media.primary && !product.core.media.primary.startsWith('http') && !product.core.media.primary.startsWith('/') && !product.core.media.primary.includes('.')) {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: 'warning',
      code: 'SUSPICIOUS_MEDIA_REF',
      message: `Primary media "${product.core.media.primary}" does not look like a valid URL or path.`,
      fieldPath: 'core.media.primary',
    }));
  }

  // 10. Unknown preserved fields (warning)
  const unknownCount = Object.keys(product.shopsite.preserved.unknownElements).length;
  if (unknownCount > 0) {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: 'warning',
      code: 'UNKNOWN_PRESERVED_FIELDS',
      message: `Product has ${unknownCount} unknown preserved field(s) that will be round-tripped but may need review.`,
      fieldPath: 'shopsite.preserved.unknownElements',
    }));
  }

  // 11. Advanced blocks preserved (info/warning)
  if (product.shopsite.preserved.advancedBlocks && Object.keys(product.shopsite.preserved.advancedBlocks).length > 0) {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: 'warning',
      code: 'ADVANCED_BLOCKS_PRESERVED',
      message: 'Product contains advanced blocks (e.g., subproducts, options) that are preserved but not editable in v1.',
      fieldPath: 'shopsite.preserved.advancedBlocks',
    }));
  }

  return results;
}

/**
 * Check if a scope has blockers.
 */
export function scopeHasBlockers(scopeType: string, scopeId: string): boolean {
  return hasBlockers(scopeType, scopeId);
}
