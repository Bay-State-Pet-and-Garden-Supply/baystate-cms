/**
 * Versioned weak-label rules bound to the ACTIVE canonical configuration.
 *
 * Every target ID (Product Type, attribute) is resolved against the activated
 * v2 configuration bundle — never against a static taxonomy registry. A rule
 * that matches a target ID which is not present in the active config abstains.
 * Rules never label from absence, never guess Pages, and never emit a
 * Product Type → ProductField24/25 mapping.
 */

export interface WeakLabelProductType {
  id: string;
  name: string;
}

export interface WeakLabelAttribute {
  id: string;
  name: string;
  valueMode?: string;
}

export interface WeakLabelConfig {
  productTypes: WeakLabelProductType[];
  attributes: WeakLabelAttribute[];
  /** Attribute ID to use for species evidence (from the active config). */
  speciesAttributeId?: string;
  /** Attribute ID to use for food-form evidence. */
  foodFormAttributeId?: string;
  /** Attribute ID to use for life-stage evidence. */
  lifeStageAttributeId?: string;
}

export interface WeakProductTypeMatch {
  id: string;
  name: string;
  confidence: number;
}

export interface WeakAttributeValues {
  species?: string[];
  lifeStage?: string[];
  foodForm?: string[];
}

const RULE_VERSION = '2.0';

interface ProductTypeRule {
  /** Pattern pairs; a match on any pair yields the target. */
  patterns: RegExp[];
  targetId: string;
  confidence: number;
}

const PRODUCT_TYPE_RULES: ProductTypeRule[] = [
  { patterns: [/\bdry\b.*\bdog food\b/i, /\bdog food\b.*\bdry\b/i, /\bkibble\b.*\bdog\b/i, /\bdog\b.*\bkibble\b/i], targetId: 'dog-food-dry', confidence: 0.8 },
  { patterns: [/\bwet\b.*\bdog food\b/i, /\bdog food\b.*\bwet\b/i, /\bcanned dog food\b/i, /\bdog\b.*\bpate\b/i], targetId: 'dog-food-wet', confidence: 0.8 },
  { patterns: [/\bdog treat\b/i, /\bdog chew\b/i, /\brawhide\b/i, /\bdental chew\b/i, /\bdog\b.*\btreats?\b/i, /\btreats?\b.*\bdog\b/i], targetId: 'dog-treats', confidence: 0.8 },
  { patterns: [/\bdry\b.*\bcat food\b/i, /\bcat food\b.*\bdry\b/i, /\bkibble\b.*\bcat\b/i, /\bcat\b.*\bkibble\b/i], targetId: 'cat-food-dry', confidence: 0.8 },
  { patterns: [/\bwet\b.*\bcat food\b/i, /\bcat food\b.*\bwet\b/i, /\bcanned cat food\b/i, /\bpate\b/i], targetId: 'cat-food-wet', confidence: 0.8 },
  { patterns: [/\bcat treat\b/i, /\bsqueezable cat\b/i, /\bcat\b.*\btreats?\b/i, /\btreats?\b.*\bcat\b/i], targetId: 'cat-treats', confidence: 0.8 },
  { patterns: [/\bcat litter\b/i, /\bclumping litter\b/i, /\blitter\b/i], targetId: 'cat-litter', confidence: 0.8 },
  { patterns: [/\bdog toy\b/i, /\bchew toy\b/i, /\bsqueak\b/i, /\bdog\b.*\btoy\b/i], targetId: 'dog-toys', confidence: 0.7 },
  { patterns: [/\bcat toy\b/i, /\bcatnip\b/i, /\bcat\b.*\btoy\b/i, /\bteaser\b/i], targetId: 'cat-toys', confidence: 0.7 },
  { patterns: [/\bgrooming\b/i, /\bdeshedding\b/i, /\bslicker brush\b/i, /\bde-matting\b/i, /\bnail clipper\b/i], targetId: 'grooming', confidence: 0.7 },
  { patterns: [/\bwaste bag\b/i, /\bpoop bag\b/i, /\blitter scoop\b/i], targetId: 'dog-waste-bags', confidence: 0.75 },
  { patterns: [/\bsupplement\b/i, /\bvitamin\b/i, /\bprobiotic\b/i, /\bjoint\b/i, /\bomega-?3\b/i], targetId: 'supplements', confidence: 0.7 },
  { patterns: [/\bcollar\b/i, /\bleash\b/i, /\bharness\b/i], targetId: 'collars-leashes', confidence: 0.75 },
  { patterns: [/\bflea\b/i, /\btick\b/i, /\bpreventative\b/i, /\bparasite\b/i], targetId: 'flea-tick-treatment', confidence: 0.75 },
  { patterns: [/\bbird seed\b/i, /\bsuet\b/i, /\bnectar\b/i, /\bwild bird\b/i], targetId: 'bird-food', confidence: 0.75 },
  { patterns: [/\bfertilizer\b/i, /\blawn food\b/i, /\bplant food\b/i], targetId: 'lawn-fertilizer', confidence: 0.75 },
  { patterns: [/\bgrass seed\b/i, /\bturfgrass\b/i, /\bseed blend\b/i], targetId: 'grass-seed', confidence: 0.75 },
  { patterns: [/\bweed killer\b/i, /\bherbicide\b/i, /\bweed control\b/i, /\bweed beater\b/i], targetId: 'weed-control', confidence: 0.75 },
  { patterns: [/\binsect control\b/i, /\binsecticide\b/i, /\bpest control\b/i, /\bbug killer\b/i, /\binsect repellent\b/i, /\binsect killer\b/i], targetId: 'insect-control', confidence: 0.75 },
  { patterns: [/\bpotting soil\b/i, /\bplanting mix\b/i, /\bcompost\b/i, /\bpotting mix\b/i], targetId: 'potting-soil', confidence: 0.75 },
  { patterns: [/\bpruner\b/i, /\btrowel\b/i, /\brake\b/i, /\bshovel\b/i, /\bhand tool\b/i, /\bweeder\b/i], targetId: 'hand-tools', confidence: 0.7 },
];

const SPECIES_RULES: Array<{ id: string; patterns: RegExp[] }> = [
  { id: 'dog', patterns: [/\bdogs?\b/i, /\bcanine\b/i, /\bpupp(y|ies)\b/i, /\bpup\b/i] },
  { id: 'cat', patterns: [/\bcats?\b/i, /\bfeline\b/i, /\bkitten\b/i, /\bkitty\b/i] },
  { id: 'bird', patterns: [/\bbirds?\b/i, /\bavian\b/i, /\bparrot\b/i, /\bfinch\b/i, /\bcanary\b/i] },
  { id: 'fish', patterns: [/\bfish(es)?\b/i, /\baquatic\b/i, /\bguppy\b/i, /\bbetta\b/i] },
  { id: 'small_animal', patterns: [/\bhamster\b/i, /\bguinea pig\b/i, /\bgerbil\b/i, /\brabbit\b/i, /\bchinchilla\b/i] },
];

const LIFE_STAGE_RULES: Array<{ id: string; patterns: RegExp[] }> = [
  { id: 'puppy', patterns: [/\bpuppy\b/i] },
  { id: 'kitten', patterns: [/\bkitten\b/i] },
  { id: 'adult', patterns: [/\badult\b/i] },
  { id: 'senior', patterns: [/\bsenior\b/i, /\bmature\b/i] },
];

const FOOD_FORM_RULES: Array<{ id: string; patterns: RegExp[] }> = [
  { id: 'dry', patterns: [/\bdry\b/i, /\bkibble\b/i, /\bcrunches?\b/i] },
  { id: 'wet', patterns: [/\bwet\b/i, /\bcanned\b/i, /\bpate\b/i, /\bgravy\b/i, /\bslices?\b.*\bgravy\b/i] },
  { id: 'treat', patterns: [/\btreats?\b/i, /\bchews?\b/i, /\bbiscuits?\b/i, /\bdental\b/i] },
  { id: 'freeze_dried', patterns: [/\bfreeze-?dried\b/i, /\braw\b/i] },
];

function buildText(record: { title?: string; description?: string; specifications?: Record<string, string> }): string {
  const specsText = record.specifications
    ? Object.entries(record.specifications).map(([k, v]) => `${k} ${v}`).join(' ')
    : '';
  return `${record.title || ''} ${record.description || ''} ${specsText}`;
}

/**
 * Weak-label rules resolved against the active canonical configuration.
 * Thread-safe and stateless; construct once per rebuild and reuse.
 */
export class WeakLabelRules {
  readonly version = RULE_VERSION;
  private productTypeIds: Set<string>;
  private attributeIds: Set<string>;

  constructor(readonly config: WeakLabelConfig) {
    this.productTypeIds = new Set(config.productTypes.map((pt) => pt.id));
    this.attributeIds = new Set(config.attributes.map((attr) => attr.id));
  }

  hasProductType(id: string): boolean {
    return this.productTypeIds.has(id);
  }

  hasAttribute(id: string): boolean {
    return this.attributeIds.has(id);
  }

  /**
   * Resolves a Product Type target from joint title/description/spec evidence.
   * Returns null (abstention) when no rule matches or the matched target is
   * not present in the active config.
   */
  resolveProductType(record: { title: string; description?: string; specifications?: Record<string, string> }): WeakProductTypeMatch | null {
    const text = buildText(record);
    for (const rule of PRODUCT_TYPE_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(text))) {
        const target = this.config.productTypes.find((pt) => pt.id === rule.targetId);
        if (!target) return null; // target not in active config → abstain
        return { id: target.id, name: target.name, confidence: rule.confidence };
      }
    }
    return null;
  }

  /**
   * Resolves species/life-stage/food-form attribute evidence against the
   * active config's attribute IDs. Joint species+form rules never label from
   * absence: only positive matches produce values.
   */
  resolveAttributes(record: { title: string; description?: string; specifications?: Record<string, string> }): WeakAttributeValues {
    const text = buildText(record);
    const result: WeakAttributeValues = {};

    if (this.speciesAttributeId()) {
      const species = SPECIES_RULES.filter((rule) => rule.patterns.some((p) => p.test(text))).map((rule) => rule.id);
      if (species.length > 0) result.species = species.sort();
    }
    if (this.lifeStageAttributeId()) {
      const lifeStage = LIFE_STAGE_RULES.filter((rule) => rule.patterns.some((p) => p.test(text))).map((rule) => rule.id);
      if (lifeStage.length > 0) result.lifeStage = lifeStage.sort();
    }
    if (this.foodFormAttributeId()) {
      const foodForm = FOOD_FORM_RULES.filter((rule) => rule.patterns.some((p) => p.test(text))).map((rule) => rule.id);
      if (foodForm.length > 0) result.foodForm = foodForm.sort();
    }
    return result;
  }

  private speciesAttributeId(): string | undefined {
    const id = this.config.speciesAttributeId;
    return id && this.attributeIds.has(id) ? id : undefined;
  }

  private lifeStageAttributeId(): string | undefined {
    const id = this.config.lifeStageAttributeId;
    return id && this.attributeIds.has(id) ? id : undefined;
  }

  private foodFormAttributeId(): string | undefined {
    const id = this.config.foodFormAttributeId;
    return id && this.attributeIds.has(id) ? id : undefined;
  }
}

/**
 * Builds a WeakLabelConfig from an active v2 configuration bundle shape
 * (productTypes/attributes entries). Attributes are matched by the IDs used in
 * the live catalog (`species`, `life-stage`, `food-form`).
 */
export function buildWeakLabelConfigFromBundle(bundle: {
  productTypes?: Array<{ id: string; name: string }>;
  attributes?: Array<{ id: string; name: string; valueMode?: string }>;
}): WeakLabelConfig {
  return {
    productTypes: (bundle.productTypes || []).map((pt) => ({ id: pt.id, name: pt.name })),
    attributes: (bundle.attributes || []).map((attr) => ({ id: attr.id, name: attr.name, valueMode: attr.valueMode })),
    speciesAttributeId: 'species',
    foodFormAttributeId: 'food-form',
    lifeStageAttributeId: 'life-stage',
  };
}
