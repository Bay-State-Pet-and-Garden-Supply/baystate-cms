/**
 * PI-9 built-in golden dataset (issue #26).
 *
 * A representative, versioned fixture set covering every difficulty class
 * named in the issue. Consumed by the evaluation runner (Slice B) and by
 * tests. Pure module.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/26
 */
import { z } from 'zod';
import { PiGoldLabelsSchema, type PiGoldLabels, type PiProductInput } from './gold';

export interface FixtureProduct {
  input: PiProductInput;
  gold: PiGoldLabels;
}

export const PI_GOLDEN_DATASET_NAME = 'pi-golden-v1';
export const PI_GOLDEN_DATASET_VERSION = 'v1';

function product(
  gtin: string,
  registerName: string,
  gold: z.input<typeof PiGoldLabelsSchema>,
  input: Partial<PiProductInput> = {},
): FixtureProduct {
  return {
    input: {
      gtin,
      registerName,
      brandHint: gold.identity.exactProduct ? registerName.split(' ')[0] : null,
      expectedPageUrl: `https://fixture.example.com/p/${gtin}`,
      ...input,
    },
    gold: PiGoldLabelsSchema.parse(gold),
  };
}

const exactBase = {
  exactProduct: true,
  exactVariant: true,
  parentProductOnly: false,
  wrongVariant: false,
  requiredAbstention: false,
};

/**
 * Build the versioned representative set: 16 products, one per difficulty tag.
 */
export function buildPiGoldenProducts(): FixtureProduct[] {
  return [
    product('085000079585', 'STELLA CHKN BROTH 16OZ', {
      identity: { ...exactBase },
      expectedSource: { domain: 'chewy.com', kind: 'retailer' },
      expectedTitle: 'Stella & Chewy Chicken Broth 16 oz',
      requiredFacts: [
        { field: 'size', value: '16 oz' },
        { field: 'flavor', value: 'chicken' },
      ],
      expectedEvidence: [
        { field: 'size', sourcePath: 'json_ld.product.size', extractionMethod: 'json_ld' },
        { field: 'flavor', sourcePath: 'json_ld.product.name', extractionMethod: 'json_ld' },
      ],
      difficultyTags: ['upc_normalization'] as const,
    }),
    product('736211046798', 'ACANA PRAIRIE POULTRY DOG FOOD 25LB', {
      identity: { ...exactBase },
      expectedSource: { domain: 'acana.com', kind: 'official' },
      expectedTitle: 'ACANA Prairie Poultry Dog Food 25 lb',
      requiredFacts: [
        { field: 'size', value: '25 lb' },
        { field: 'formula', value: 'prairie poultry' },
      ],
      expectedEvidence: [
        { field: 'size', sourcePath: 'json_ld.product.offers.priceSpecification', extractionMethod: 'json_ld' },
        { field: 'formula', sourcePath: 'json_ld.product.name', extractionMethod: 'json_ld' },
      ],
      difficultyTags: ['json_ld_static'] as const,
    }),
    product('831080003188', 'ZESTY PAWS CHICKEN BITES 6OZ', {
      identity: { ...exactBase },
      expectedSource: { domain: 'zesty paws.com', kind: 'official' },
      expectedTitle: 'Zesty Paws Chicken Bites 6 oz',
      requiredFacts: [
        { field: 'size', value: '6 oz' },
        { field: 'count', value: '90' },
      ],
      expectedEvidence: [
        { field: 'size', sourcePath: 'shopify.variants[0].title', extractionMethod: 'platform_api' },
        { field: 'count', sourcePath: 'shopify.variants[0].sku', extractionMethod: 'platform_api' },
      ],
      difficultyTags: ['shopify_variant'] as const,
    }),
    product('810019560391', 'BARKWORTHY BACON TREATS 4OZ', {
      identity: { ...exactBase },
      expectedSource: { domain: 'barkworthy.com', kind: 'official' },
      expectedTitle: 'Barkworthy Bacon Treats 4 oz',
      requiredFacts: [
        { field: 'size', value: '4 oz' },
        { field: 'flavor', value: 'bacon' },
      ],
      expectedEvidence: [
        { field: 'size', sourcePath: 'woocommerce.variations[0].attributes', extractionMethod: 'platform_api' },
        { field: 'flavor', sourcePath: 'woocommerce.product.title', extractionMethod: 'platform_api' },
      ],
      difficultyTags: ['woocommerce_variant'] as const,
    }),
    product('075311101203', 'GREENIES TEENIE 36CT', {
      identity: { ...exactBase },
      expectedSource: { domain: 'greenies.com', kind: 'official' },
      expectedTitle: 'Greenies Teenie Dental Dog Treats 36 ct',
      requiredFacts: [
        { field: 'size', value: 'teenie' },
        { field: 'count', value: '36' },
      ],
      expectedEvidence: [
        { field: 'size', sourcePath: 'network_response.variants[2].title', extractionMethod: 'network_response' },
        { field: 'count', sourcePath: 'network_response.variants[2].sku', extractionMethod: 'network_response' },
      ],
      difficultyTags: ['multi_variant'] as const,
    }),
    product('786560647750', 'BENEBONE WISHBONE MEDIUM', {
      identity: {
        exactProduct: false,
        exactVariant: false,
        parentProductOnly: true,
        wrongVariant: false,
        requiredAbstention: false,
      },
      expectedSource: { domain: 'benebone.com', kind: 'official' },
      expectedTitle: null,
      requiredFacts: [{ field: 'size', value: 'medium' }],
      expectedEvidence: [{ field: 'size', sourcePath: 'page_context.variant_selector', extractionMethod: 'profile_selector' }],
      difficultyTags: ['product_family'] as const,
    }),
    product('841002206534', 'FROMM GOLD ADULT 30LB', {
      identity: { ...exactBase },
      expectedSource: { domain: 'frommfamily.com', kind: 'official' },
      expectedTitle: 'Fromm Gold Adult Dog Food 30 lb',
      requiredFacts: [
        { field: 'size', value: '30 lb' },
        { field: 'formula', value: 'gold adult' },
      ],
      expectedEvidence: [
        { field: 'size', sourcePath: 'xhr_response.graphql.product.variant', extractionMethod: 'network_response' },
        { field: 'formula', sourcePath: 'xhr_response.graphql.product.name', extractionMethod: 'network_response' },
      ],
      difficultyTags: ['xhr_only'] as const,
    }),
    product('040000512693', 'TRIXIE TREAT BALL SMALL', {
      identity: { ...exactBase },
      expectedSource: { domain: 'trixiepets.com', kind: 'official' },
      expectedTitle: 'Trixie Treat Ball Small',
      requiredFacts: [{ field: 'size', value: 'small' }],
      expectedEvidence: [{ field: 'size', sourcePath: 'interaction.variant_selected', extractionMethod: 'manual' }],
      difficultyTags: ['interaction_required'] as const,
    }),
    product('085000079592', 'STELLA CHEWYS PUMPKIN RECIPE 12OZ', {
      identity: { ...exactBase },
      expectedSource: { domain: 'chewy.com', kind: 'retailer' },
      expectedTitle: 'Stella & Chewy Pumpkin Recipe 12 oz',
      requiredFacts: [
        { field: 'size', value: '12 oz' },
        { field: 'flavor', value: 'pumpkin' },
      ],
      expectedEvidence: [
        { field: 'size', sourcePath: 'json_ld.product.size', extractionMethod: 'json_ld' },
        { field: 'flavor', sourcePath: 'json_ld.product.name', extractionMethod: 'json_ld' },
      ],
      expectedImage: { identityMatch: 'unknown', rightsStatus: 'restricted' },
      difficultyTags: ['packaging_redesign'] as const,
    }),
    product('070628048161', 'BLUE BUFFALO WILDERNESS 24LB WRONG', {
      identity: {
        exactProduct: false,
        exactVariant: false,
        parentProductOnly: false,
        wrongVariant: true,
        requiredAbstention: false,
      },
      expectedSource: { domain: 'chewy.com', kind: 'retailer' },
      expectedTitle: null,
      requiredFacts: [{ field: 'size', value: '24 lb' }],
      expectedEvidence: [{ field: 'size', sourcePath: 'retailer.page.size', extractionMethod: 'profile_selector' }],
      misleadingSources: [{ domain: 'chewy.com', reason: 'retailer page shows the wrong package size' }],
      difficultyTags: ['wrong_size_retailer'] as const,
    }),
    product('032369001234', 'DISCONTINUED OLD FORMULA 8OZ', {
      identity: {
        exactProduct: false,
        exactVariant: false,
        parentProductOnly: false,
        wrongVariant: false,
        requiredAbstention: true,
      },
      expectedSource: null,
      expectedTitle: null,
      requiredFacts: [],
      expectedEvidence: [],
      difficultyTags: ['discontinued'] as const,
    }),
    product('054321098765', 'GENERIC PET SNACK 5OZ', {
      identity: {
        exactProduct: false,
        exactVariant: false,
        parentProductOnly: false,
        wrongVariant: false,
        requiredAbstention: true,
      },
      expectedSource: null,
      expectedTitle: null,
      requiredFacts: [],
      expectedEvidence: [],
      difficultyTags: ['ambiguous_brand'] as const,
    }),
    product('011110222333', 'NORTHWEST NATURALS SALMON 5LB', {
      identity: { ...exactBase },
      expectedSource: { domain: 'northwestnaturals.net', kind: 'official' },
      expectedTitle: 'Northwest Naturals Salmon Formula 5 lb',
      requiredFacts: [{ field: 'size', value: '5 lb' }],
      expectedEvidence: [{ field: 'size', sourcePath: 'network_response.supplier_api.product', extractionMethod: 'media_api' }],
      misleadingSources: [{ domain: 'northwestnaturals.net', reason: 'official page is blocked; found via supplier media API' }],
      difficultyTags: ['blocked_official'] as const,
    }),
    product('033322211100', 'PRECISE NATURALS CHICKEN 6LB', {
      identity: { ...exactBase },
      expectedSource: { domain: 'precisenaturals.com', kind: 'official' },
      expectedTitle: 'Precise Naturals Chicken & Brown Rice 6 lb',
      requiredFacts: [{ field: 'size', value: '6 lb' }],
      expectedEvidence: [{ field: 'size', sourcePath: 'json_ld.product.size', extractionMethod: 'json_ld' }],
      misleadingSources: [{ domain: 'distributorfeed.example.com', reason: 'distributor data conflicts on pack count' }],
      difficultyTags: ['distributor_conflict'] as const,
    }),
    product('024654321098', 'HAPPY PAWS WILD ALASKA 12OZ', {
      identity: { ...exactBase },
      expectedSource: { domain: 'happypaws.example.com', kind: 'supplier' },
      expectedTitle: 'Happy Paws Wild Alaska Salmon 12 oz',
      requiredFacts: [{ field: 'size', value: '12 oz' }],
      expectedEvidence: [{ field: 'size', sourcePath: 'media_api.asset.listing', extractionMethod: 'media_api' }],
      expectedImage: { identityMatch: 'exact', rightsStatus: 'unknown' },
      difficultyTags: ['image_rights_uncertainty'] as const,
    }),
    product('098765432101', 'MYSTERY BRAND GRAVY 3OZ', {
      identity: {
        exactProduct: false,
        exactVariant: false,
        parentProductOnly: false,
        wrongVariant: false,
        requiredAbstention: true,
      },
      expectedSource: null,
      expectedTitle: null,
      requiredFacts: [],
      expectedEvidence: [],
      difficultyTags: ['abstention_correct'] as const,
    }),
  ];
}
