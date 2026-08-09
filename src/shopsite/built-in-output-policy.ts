/**
 * ShopSite built-in output policy (issue #17 work item J).
 *
 * Central, immutable policy that enumerates every supported ShopSite built-in
 * output field and its omission/default/encoding/cardinality rule. The
 * product denormalizer consumes this policy so built-in DTD behavior is a
 * single versioned, documented contract instead of scattered ad hoc emission
 * rules.
 *
 * DTD-level behavior is ADAPTER-OWNED and NOT workspace-configurable: required
 * ShopSite defaults, XML validity, and round-trip preservation cannot be
 * safely delegated to classification config. Custom `ProductField*` values
 * are NOT built-ins — they continue to use classification mapping /
 * serialization. The draft promoter's construction of Name/Price/new-date
 * ProductField1 is draft INPUT behavior, never XML output policy.
 *
 * Fail-closed invariants:
 * - Unknown built-in policy keys cannot be emitted through a generic
 *   configurable path.
 * - Required defaults/CDATA/omit-empty semantics remain byte-compatible.
 */

export const SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION = 'shopsite-built-in-output-policy-v1';

export type BuiltInFieldEncoding = 'text' | 'cdata';

export type BuiltInOmissionRule = 'always' | 'omit-empty';

export type BuiltInCardinality = 'one' | 'zero-or-one';

export interface BuiltInFieldOutputRule {
  /** DTD element name, e.g. `Name`, `MoreInfoImage3`. */
  element: string;
  /** How the element body is encoded: escaped text or CDATA. */
  encoding: BuiltInFieldEncoding;
  /**
   * `always` = the element is always emitted (possibly with a DTD default);
   * `omit-empty` = the element is omitted when the resolved value is empty.
   */
  omission: BuiltInOmissionRule;
  /** `one` = exactly one element; `zero-or-one` = optional element. */
  cardinality: BuiltInCardinality;
  /** ShopSite DTD default applied when the value is otherwise absent. */
  dtdDefault?: string;
}

/**
 * Immutable v1 policy. Field order matches the denormalizer's emission order
 * (deterministic output bytes).
 */
export const SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1: readonly BuiltInFieldOutputRule[] = [
  { element: 'Name', encoding: 'text', omission: 'always', cardinality: 'one' },
  { element: 'FileName', encoding: 'text', omission: 'always', cardinality: 'one' },
  { element: 'Price', encoding: 'text', omission: 'omit-empty', cardinality: 'zero-or-one' },
  { element: 'SaleAmount', encoding: 'text', omission: 'omit-empty', cardinality: 'zero-or-one' },
  { element: 'ProductDescription', encoding: 'cdata', omission: 'omit-empty', cardinality: 'zero-or-one' },
  { element: 'MinimumQuantity', encoding: 'text', omission: 'always', cardinality: 'one', dtdDefault: '0' },
  { element: 'ProductType', encoding: 'text', omission: 'always', cardinality: 'one', dtdDefault: 'Tangible' },
  { element: 'Weight', encoding: 'text', omission: 'omit-empty', cardinality: 'zero-or-one' },
  { element: 'Graphic', encoding: 'text', omission: 'always', cardinality: 'one', dtdDefault: 'none' },
  { element: 'MoreInformationGraphic', encoding: 'text', omission: 'always', cardinality: 'one', dtdDefault: 'none' },
  { element: 'MoreInformationText', encoding: 'cdata', omission: 'omit-empty', cardinality: 'zero-or-one' },
  { element: 'SearchKeywords', encoding: 'cdata', omission: 'omit-empty', cardinality: 'zero-or-one' },
  // Additional image slots (1–20) — emitted only when populated.
  ...Array.from({ length: 20 }, (_, index) => ({
    element: `MoreInfoImage${index + 1}`,
    encoding: 'text' as const,
    omission: 'omit-empty' as const,
    cardinality: 'zero-or-one' as const,
  })),
];

/** Every element governed by the policy (for membership checks). */
export const BUILT_IN_OUTPUT_POLICY_ELEMENTS: ReadonlySet<string> = new Set(
  SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1.map(rule => rule.element),
);

/** Look up the immutable output rule for a built-in field, or null. */
export function getBuiltInOutputRule(element: string): BuiltInFieldOutputRule | null {
  return SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1.find(rule => rule.element === element) ?? null;
}

/** True when the element is a governed ShopSite built-in output field. */
export function isBuiltInOutputField(element: string): boolean {
  return BUILT_IN_OUTPUT_POLICY_ELEMENTS.has(element);
}

/**
 * Resolve the effective default for an `always`-emitted field with a DTD
 * default. Returns null when the field has no default (caller must supply a
 * value) — an unknown built-in field fails closed (null), never emitting a
 * guessed element through a generic path.
 */
export function builtInDefaultValue(element: string): string | null {
  const rule = getBuiltInOutputRule(element);
  return rule?.dtdDefault ?? null;
}
