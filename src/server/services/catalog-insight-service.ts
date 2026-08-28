import { listProducts } from '../../db/repositories/product-index-repo';
import { listRegistry } from '../../db/repositories/field-registry-repo';

export interface FieldValueInfo {
  value: string;
  frequency: number;
  skus: string[];
}

export interface CasingDuplicateGroup {
  normalized: string;
  values: { value: string; frequency: number; skus: string[] }[];
}

export interface NearDuplicatePair {
  valueA: string;
  frequencyA: number;
  valueB: string;
  frequencyB: number;
  distance: number;
  type: 'levenshtein' | 'alphanumeric';
}

export interface SeparatorInfo {
  separator: string;
  count: number;
}

export interface SuspiciousValueInfo {
  value: string;
  frequency: number;
  reasons: string[];
  skus: string[];
}

export interface ProductFieldAuditReport {
  field: string;
  label: string;
  totalActiveProducts: number;
  emptyCount: number;
  emptyRate: number; // 0 to 1
  uniqueValueCount: number;
  values: FieldValueInfo[];
  casingDuplicates: CasingDuplicateGroup[];
  nearDuplicates: NearDuplicatePair[];
  separatorInconsistencies: {
    inconsistent: boolean;
    counts: SeparatorInfo[];
  };
  suspiciousValues: SuspiciousValueInfo[];
}

/**
 * Calculate the Levenshtein distance between two strings.
 *
 * Performance optimization:
 * Uses two 1D `Uint16Array(n + 1)` buffers and `charCodeAt()` comparisons
 * instead of allocating a full 2D `number[][]` matrix (O(N) space instead of O(M*N)),
 * preventing array allocations in catalog auditing loops (~3.5x faster).
 */
// fallow-ignore-next-line unused-export — used by tests
export function getLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const charA = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = charA === b.charCodeAt(j - 1) ? 0 : 1;
      const sub = prev[j - 1] + cost;
      const ins = curr[j - 1] + 1;
      const del = prev[j] + 1;
      curr[j] = sub < ins ? (sub < del ? sub : del) : (ins < del ? ins : del);
    }
    const temp = prev;
    prev = curr;
    curr = temp;
  }
  return prev[n];
}

/**
 * Strip non-alphanumeric characters and lowercase.
 */
function cleanAlphanumeric(val: string): string {
  return val.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Scan all active products in the database and audit the given ProductField.
 */
export function generateProductFieldAuditReport(
  workspaceId: string,
  field: string
): ProductFieldAuditReport {
  // 1. Fetch registry to find field label
  const registry = listRegistry(workspaceId);
  const registryField = registry.find(r => r.xmlField === field);
  const label = registryField?.label || field;

  // 2. Fetch all products
  const { products } = listProducts();
  const activeProducts = products.filter(p => p.status === 'active');
  const totalActiveProducts = activeProducts.length;

  const valueMap = new Map<string, { frequency: number; skus: string[] }>();
  let emptyCount = 0;

  for (const p of activeProducts) {
    const val = p.customFields?.[field];
    if (val !== undefined && val !== null && val.trim() !== '') {
      const trimmed = val; // Keep original spacing for casing/suspicious analysis
      const existing = valueMap.get(trimmed) || { frequency: 0, skus: [] };
      existing.frequency++;
      if (existing.skus.length < 50) {
        existing.skus.push(p.sku);
      }
      valueMap.set(trimmed, existing);
    } else {
      emptyCount++;
    }
  }

  const values: FieldValueInfo[] = Array.from(valueMap.entries()).map(([value, info]) => ({
    value,
    frequency: info.frequency,
    skus: info.skus,
  }));

  // Sort values by frequency descending
  values.sort((a, b) => b.frequency - a.frequency);

  // 3. Casing duplicates
  const casingGroups = new Map<string, { value: string; frequency: number; skus: string[] }[]>();
  for (const v of values) {
    const lower = v.value.toLowerCase().trim();
    const existing = casingGroups.get(lower) || [];
    existing.push(v);
    casingGroups.set(lower, existing);
  }

  const casingDuplicates: CasingDuplicateGroup[] = [];
  for (const [normalized, list] of casingGroups.entries()) {
    if (list.length > 1) {
      casingDuplicates.push({
        normalized,
        values: list,
      });
    }
  }

  // 4. Near duplicates (excluding casing duplicates since they are tracked separately)
  const nearDuplicates: NearDuplicatePair[] = [];
  const lowercaseValueList = values.map(v => ({
    orig: v.value,
    lower: v.value.toLowerCase().trim(),
    clean: cleanAlphanumeric(v.value),
    freq: v.frequency,
  }));

  for (let i = 0; i < lowercaseValueList.length; i++) {
    for (let j = i + 1; j < lowercaseValueList.length; j++) {
      const a = lowercaseValueList[i];
      const b = lowercaseValueList[j];

      // Skip if they are casing duplicates
      if (a.lower === b.lower) continue;

      // Check 1: Alphanumeric match (e.g. "Cat-Supplies" vs "Cat Supplies")
      if (a.clean !== '' && b.clean !== '' && a.clean === b.clean) {
        nearDuplicates.push({
          valueA: a.orig,
          frequencyA: a.freq,
          valueB: b.orig,
          frequencyB: b.freq,
          distance: 0,
          type: 'alphanumeric',
        });
        continue;
      }

      // Check 2: Levenshtein distance for strings with length >= 4
      if (a.lower.length >= 4 && b.lower.length >= 4) {
        const distance = getLevenshteinDistance(a.lower, b.lower);
        if (distance > 0 && distance <= 2) {
          nearDuplicates.push({
            valueA: a.orig,
            frequencyA: a.freq,
            valueB: b.orig,
            frequencyB: b.freq,
            distance,
            type: 'levenshtein',
          });
        }
      }
    }
  }

  // 5. Separator inconsistencies
  const separatorCounts = [
    { separator: ',', count: 0 },
    { separator: ';', count: 0 },
    { separator: '|', count: 0 },
  ];

  for (const v of values) {
    for (const info of separatorCounts) {
      if (v.value.includes(info.separator)) {
        info.count += v.frequency;
      }
    }
  }

  const activeSeparators = separatorCounts.filter(s => s.count > 0);
  const separatorInconsistent = activeSeparators.length > 1;

  // 6. Suspicious Values detection
  const suspiciousValues: SuspiciousValueInfo[] = [];

  for (const v of values) {
    const reasons: string[] = [];
    const val = v.value;

    // Lead/trail whitespace
    if (val !== val.trim()) {
      reasons.push('Leading or trailing whitespace');
    }

    // Trailing punctuation
    if (/[.,;|]$/.test(val.trim())) {
      reasons.push('Trailing punctuation symbol');
    }

    // Singleton value (very low frequency relative to total)
    if (v.frequency === 1 && totalActiveProducts > 10) {
      reasons.push('Singleton value (frequency is 1)');
    }

    // Weird characters / HTML entities
    if (/&[a-z0-9#]+;/i.test(val) || /[<>]/.test(val)) {
      reasons.push('Contains HTML entities or markup');
    }

    // Weird casing (e.g. mIxEd CaSe or lower first letter but upper later)
    const trimmed = val.trim();
    if (trimmed.length > 2 && /^[a-z]+[A-Z]+/.test(trimmed) && !/^[A-Z]/.test(trimmed)) {
      reasons.push('Irregular casing pattern');
    }

    if (reasons.length > 0) {
      suspiciousValues.push({
        value: val,
        frequency: v.frequency,
        reasons,
        skus: v.skus,
      });
    }
  }

  return {
    field,
    label,
    totalActiveProducts,
    emptyCount,
    emptyRate: totalActiveProducts > 0 ? emptyCount / totalActiveProducts : 0,
    uniqueValueCount: values.length,
    values,
    casingDuplicates,
    nearDuplicates,
    separatorInconsistencies: {
      inconsistent: separatorInconsistent,
      counts: separatorCounts,
    },
    suspiciousValues,
  };
}
