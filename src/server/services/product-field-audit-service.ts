import { listProducts } from '../../db/repositories/product-index-repo';

export interface AuditValue {
  value: string;
  count: number;
  skus: string[];
}

export interface DuplicateGroup {
  normalized: string;
  type: 'case' | 'whitespace' | 'separator';
  values: AuditValue[];
}

export interface SuspiciousGroup {
  value: string;
  count: number;
  reasons: string[];
  skus: string[];
}

export interface ProductFieldAuditResult {
  field: string;
  totalProductsScanned: number;
  missingCount: number;
  uniqueValueCount: number;
  topValues: AuditValue[];
  duplicateGroups: DuplicateGroup[];
  totalDuplicateGroupCount: number;
  suspiciousGroups: SuspiciousGroup[];
  totalSuspiciousGroupCount: number;
  /** True when a transport-safe view omitted samples/groups but counts remain authoritative. */
  transportTruncated?: boolean;
}

export interface NormalizationProposal {
  id: string;
  field: string;
  oldValue: string;
  newValue: string;
  affectedSkus: string[];
  affectedCount: number;
  reason: string;
  confidence: number;
  safeAutoApply: boolean;
}

export interface NormalizationProposalResult {
  field: string;
  proposalCount: number;
  affectedProductCount: number;
  proposals: NormalizationProposal[];
  /** True when transport-safe serialization omitted proposal detail. */
  transportTruncated?: boolean;
}

/**
 * Validate that the field name is a conservative custom product field.
 */
// fallow-ignore-next-line unused-export — used by tests
export function validateFieldName(field: string): void {
  if (!/^ProductField\d+$/.test(field)) {
    throw new Error(`Invalid custom field name: "${field}". Field name must match pattern ^ProductField\\d+$`);
  }
}

/** Maximum serialized result size (bytes) before progressive stripping kicks in. */
const AUDIT_RESULT_BYTE_BUDGET = 28 * 1024;

/**
 * Scan all active products and audit the specified ProductField.
 */
export function getProductFieldAudit(field: string, limit: number = 100): ProductFieldAuditResult {
  validateFieldName(field);

  const { products } = listProducts();
  const activeProducts = products.filter(p => p.status === 'active');
  const totalProductsScanned = activeProducts.length;

  const valueMap = new Map<string, { count: number; skus: string[] }>();
  let missingCount = 0;

  for (const p of activeProducts) {
    const val = p.customFields?.[field];
    if (val === undefined || val === null || String(val).trim() === '') {
      missingCount++;
    } else {
      const valStr = String(val);
      const existing = valueMap.get(valStr) || { count: 0, skus: [] };
      existing.count++;
      if (existing.skus.length < 5) {
        existing.skus.push(p.sku);
      }
      valueMap.set(valStr, existing);
    }
  }

  const uniqueValues: AuditValue[] = Array.from(valueMap.entries()).map(([value, info]) => ({
    value,
    count: info.count,
    skus: info.skus,
  }));

  // Sort by count descending
  uniqueValues.sort((a, b) => b.count - a.count);
  const topValues = uniqueValues.slice(0, limit);

  // Group duplicate values
  const duplicateGroups: DuplicateGroup[] = [];

  // 1. Whitespace duplicates
  // Group by trimmed value (case-sensitive) to find whitespace differences
  const whitespaceMap = new Map<string, AuditValue[]>();
  for (const v of uniqueValues) {
    const trimmed = v.value.trim();
    const group = whitespaceMap.get(trimmed) || [];
    group.push(v);
    whitespaceMap.set(trimmed, group);
  }
  for (const [trimmed, group] of whitespaceMap.entries()) {
    if (group.length > 1) {
      duplicateGroups.push({
        normalized: trimmed.toLowerCase(),
        type: 'whitespace',
        values: group,
      });
    }
  }

  // 2. Casing duplicates
  // Group by trimmed value case-insensitively
  const casingMap = new Map<string, AuditValue[]>();
  for (const v of uniqueValues) {
    const norm = v.value.trim().toLowerCase();
    const group = casingMap.get(norm) || [];
    group.push(v);
    casingMap.set(norm, group);
  }
  for (const [norm, group] of casingMap.entries()) {
    const trimmedMap = new Map<string, AuditValue>();
    for (const v of group) {
      const trimmed = v.value.trim();
      const existing = trimmedMap.get(trimmed);
      if (!existing || v.count > existing.count) {
        trimmedMap.set(trimmed, v);
      }
    }
    const reps = Array.from(trimmedMap.values());
    if (reps.length > 1) {
      duplicateGroups.push({
        normalized: norm,
        type: 'case',
        values: reps,
      });
    }
  }

  // 3. Separator grouping
  // Separator normalization: replaces typical separators with a space, trims, and lowercases
  const separatorNormalizedGroups = new Map<string, AuditValue[]>();
  for (const v of uniqueValues) {
    const norm = v.value
      .toLowerCase()
      .replace(/[\s\->/|;:]+/g, ' ')
      .trim();
    const group = separatorNormalizedGroups.get(norm) || [];
    group.push(v);
    separatorNormalizedGroups.set(norm, group);
  }

  for (const [norm, group] of separatorNormalizedGroups.entries()) {
    if (group.length > 1) {
      // E.g. ["Dog - Food", "Dog/Food", "Dog Food"]
      // Check if they are already covered by casing/whitespace duplicates
      const caseTrimmedValues = new Set(group.map(g => g.value.trim().toLowerCase()));
      if (caseTrimmedValues.size > 1) {
        // There are actual structural differences beyond case/whitespace, so it's a separator duplicate
        duplicateGroups.push({
          normalized: norm,
          type: 'separator',
          values: group,
        });
      }
    }
  }

  // Detect suspicious values
  const allSuspiciousGroups: SuspiciousGroup[] = [];
  for (const v of uniqueValues) {
    const reasons: string[] = [];
    const val = v.value;

    // Whitespace
    if (val !== val.trim()) {
      reasons.push('Leading or trailing whitespace');
    }
    if (val.includes('  ')) {
      reasons.push('Multiple consecutive internal spaces');
    }

    // Trailing punctuation
    if (/[.,;|]$/.test(val.trim())) {
      reasons.push('Trailing punctuation symbol');
    }

    // HTML elements / entities
    if (/&[a-z0-9#]+;/i.test(val) || /[<>]/.test(val)) {
      reasons.push('Contains HTML entities or markup');
    }

    // Irregular casing
    const trimmed = val.trim();
    if (trimmed.length > 2 && /^[a-z]+[A-Z]+/.test(trimmed) && !/^[A-Z]/.test(trimmed)) {
      reasons.push('Irregular casing pattern');
    }

    // Singleton check
    if (v.count === 1 && totalProductsScanned > 10) {
      reasons.push('Singleton value (frequency is 1)');
    }

    if (reasons.length > 0) {
      allSuspiciousGroups.push({
        value: val,
        count: v.count,
        reasons,
        skus: v.skus,
      });
    }
  }

  // Cap duplicate groups: sort by total affected products descending, then truncate
  const totalDuplicateGroupCount = duplicateGroups.length;
  duplicateGroups.sort((a, b) => {
    const aTotal = a.values.reduce((sum, v) => sum + v.count, 0);
    const bTotal = b.values.reduce((sum, v) => sum + v.count, 0);
    return bTotal - aTotal;
  });
  const cappedDuplicateGroups = duplicateGroups.slice(0, limit);

  // Cap suspicious groups: sort by count descending, then truncate
  const totalSuspiciousGroupCount = allSuspiciousGroups.length;
  allSuspiciousGroups.sort((a, b) => b.count - a.count);
  const cappedSuspiciousGroups = allSuspiciousGroups.slice(0, limit);

  return {
    field,
    totalProductsScanned,
    missingCount,
    uniqueValueCount: uniqueValues.length,
    topValues,
    duplicateGroups: cappedDuplicateGroups,
    totalDuplicateGroupCount,
    suspiciousGroups: cappedSuspiciousGroups,
    totalSuspiciousGroupCount,
  };
}

/**
 * Progressively strip payload until result fits within the byte budget.
 * Stripping order: suspicious SKUs → duplicate SKUs → suspicious groups → top values.
 */
export function boundProductFieldAuditForTransport(result: ProductFieldAuditResult): ProductFieldAuditResult {
  const bounded = JSON.parse(JSON.stringify(result)) as ProductFieldAuditResult;
  bounded.transportTruncated = false;
  applyByteBudget(bounded);
  return bounded;
}

function applyByteBudget(result: ProductFieldAuditResult): ProductFieldAuditResult {
  const measure = () => Buffer.byteLength(JSON.stringify(result), 'utf8');
  const markTruncated = () => { result.transportTruncated = true; };

  // Pass 1: strip SKUs from suspicious groups
  if (measure() > AUDIT_RESULT_BYTE_BUDGET) {
    markTruncated();
    for (const g of result.suspiciousGroups) {
      g.skus = g.skus.slice(0, 1);
    }
  }

  // Pass 2: strip SKUs from duplicate group values
  if (measure() > AUDIT_RESULT_BYTE_BUDGET) {
    markTruncated();
    for (const g of result.duplicateGroups) {
      for (const v of g.values) {
        v.skus = v.skus.slice(0, 1);
      }
    }
  }

  // Pass 3: halve suspicious groups
  if (measure() > AUDIT_RESULT_BYTE_BUDGET) {
    markTruncated();
    result.suspiciousGroups = result.suspiciousGroups.slice(0, Math.max(10, result.suspiciousGroups.length >> 1));
  }

  // Pass 4: halve top values
  if (measure() > AUDIT_RESULT_BYTE_BUDGET) {
    markTruncated();
    result.topValues = result.topValues.slice(0, Math.max(10, result.topValues.length >> 1));
  }

  // Pass 5: clear suspicious groups entirely
  if (measure() > AUDIT_RESULT_BYTE_BUDGET) {
    markTruncated();
    result.suspiciousGroups = [];
  }
  if (measure() > AUDIT_RESULT_BYTE_BUDGET) {
    markTruncated();
    result.duplicateGroups = [];
    result.topValues = [];
  }

  return result;
}

/**
 * Generate proposals based on the selected normalization strategy.
 */
export function proposeProductFieldNormalization(
  field: string,
  strategy: 'case_only' | 'trim_whitespace' | 'separator_cleanup' | 'safe_duplicates' = 'safe_duplicates',
  limit: number = 100
): NormalizationProposalResult {
  const audit = getProductFieldAudit(field, limit);
  const proposals: NormalizationProposal[] = [];
  const affectedSkuSet = new Set<string>();

  if (strategy === 'case_only' || strategy === 'safe_duplicates') {
    // Find 'case' type duplicate groups
    const caseGroups = audit.duplicateGroups.filter(g => g.type === 'case');
    for (const group of caseGroups) {
      // Choose the canonical value: the one with the highest count
      const sorted = [...group.values].sort((a, b) => b.count - a.count);
      const canonical = sorted[0];

      // Propose changing all other variants in the group to the canonical variant
      for (let i = 1; i < sorted.length; i++) {
        const item = sorted[i];
        const affectedSkus = item.skus;
        proposals.push({
          id: `prop-case-${field}-${Buffer.from(item.value).toString('hex')}`,
          field,
          oldValue: item.value,
          newValue: canonical.value,
          affectedSkus,
          affectedCount: item.count,
          reason: `casing normalization to "${canonical.value}"`,
          confidence: 0.95,
          safeAutoApply: true,
        });
        affectedSkus.forEach(sku => affectedSkuSet.add(sku));
      }
    }
  }

  if (strategy === 'trim_whitespace' || strategy === 'safe_duplicates') {
    // Find values with leading or trailing whitespace
    const whitespaceValues = audit.suspiciousGroups.filter(g =>
      g.reasons.includes('Leading or trailing whitespace')
    );

    for (const item of whitespaceValues) {
      const trimmed = item.value.trim();
      // Only propose if trimmed value is non-empty and different
      if (trimmed !== '' && trimmed !== item.value) {
        proposals.push({
          id: `prop-trim-${field}-${Buffer.from(item.value).toString('hex')}`,
          field,
          oldValue: item.value,
          newValue: trimmed,
          affectedSkus: item.skus,
          affectedCount: item.count,
          reason: 'trim leading/trailing whitespace',
          confidence: 0.99,
          safeAutoApply: true,
        });
        item.skus.forEach(sku => affectedSkuSet.add(sku));
      }
    }
  }

  if (strategy === 'separator_cleanup') {
    // Find separator duplicate groups
    const separatorGroups = audit.duplicateGroups.filter(g => g.type === 'separator');
    for (const group of separatorGroups) {
      // Pick canonical: the one with the highest count
      const sorted = [...group.values].sort((a, b) => b.count - a.count);
      const canonical = sorted[0];

      for (let i = 1; i < sorted.length; i++) {
        const item = sorted[i];
        const affectedSkus = item.skus;
        proposals.push({
          id: `prop-sep-${field}-${Buffer.from(item.value).toString('hex')}`,
          field,
          oldValue: item.value,
          newValue: canonical.value,
          affectedSkus,
          affectedCount: item.count,
          reason: `separator cleanup matching canonical value "${canonical.value}"`,
          confidence: 0.8,
          safeAutoApply: false, // Separator cleanup requires confirmation
        });
        affectedSkus.forEach(sku => affectedSkuSet.add(sku));
      }
    }
  }

  const affectedProductCount = proposals.reduce((acc, p) => acc + p.affectedCount, 0);

  return {
    field,
    proposalCount: proposals.length,
    affectedProductCount,
    proposals,
  };
}

/** Bound only the transport view; normalization proposals use the full audit internally. */
export function boundNormalizationProposalResultForTransport(result: NormalizationProposalResult): NormalizationProposalResult {
  const bounded = JSON.parse(JSON.stringify(result)) as NormalizationProposalResult;
  let truncated = false;
  for (const proposal of bounded.proposals) {
    if (proposal.affectedSkus.length > 5) {
      proposal.affectedSkus = proposal.affectedSkus.slice(0, 5);
      truncated = true;
    }
  }
  while (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > AUDIT_RESULT_BYTE_BUDGET && bounded.proposals.length > 1) {
    bounded.proposals = bounded.proposals.slice(0, Math.ceil(bounded.proposals.length / 2));
    truncated = true;
  }
  // A single proposal can itself contain arbitrarily large product values.
  // Drop only its detail as the final hard fallback; aggregate counts remain
  // authoritative and the explicit flag tells callers the detail is partial.
  if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > AUDIT_RESULT_BYTE_BUDGET) {
    bounded.proposals = [];
    truncated = true;
  }
  if (truncated) bounded.transportTruncated = true;
  return bounded;
}
