import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface GoldIdentityBenchmarkRecord {
  id: string;
  version: '1.0';
  provenance: {
    labeledBy: string;
    reviewedBy: string[];
    adjudicated: boolean;
    createdAt: string;
    sourceCollection: string;
  };
  item: {
    itemId: string;
    rawUpc: string;
    expectedNormalizedGtin: string;
    expectedName: string;
    brandHint: string;
    officialDomains: string[];
  };
  candidate: {
    url: string;
    domain: string;
    sourceMethod: 'sitemap_upc' | 'sitemap_token_overlap' | 'distributor_record' | 'search';
  };
  fixture: {
    html: string;
    contentHash: string;
    gtinSourcePaths: Array<{
      type: 'jsonld_product' | 'jsonld_product_group' | 'shopify_variant' | 'microdata' | 'meta_tag' | 'body_text_only' | 'none';
      path: string;
      rawGtin: string | null;
      normalizedGtin: string | null;
      isValidChecksum: boolean;
    }>;
  };
  groundTruth: {
    identityLabel:
      | 'exact_match'
      | 'same_family_different_size'
      | 'same_family_different_flavor'
      | 'same_family_multi_pack'
      | 'category_listing'
      | 'search_page'
      | 'blog_post'
      | 'invalid_gtin_checksum'
      | 'malformed_gtin_length'
      | 'missing_gtin_structured_data'
      | 'contradictory_gtin'
      | 'ambiguous_variant'
      | 'sku_only_match'
      | 'upc_in_body_only'
      | 'off_domain_retailer'
      | 'off_domain_counterfeit';
    stratum:
      | 'exact_valid_gtin_jsonld_single'
      | 'exact_valid_gtin_jsonld_graph'
      | 'exact_valid_gtin_microdata'
      | 'exact_valid_gtin_meta'
      | 'exact_valid_gtin_shopify_product_json'
      | 'exact_variant_shopify_matrix'
      | 'exact_variant_jsonld_product_group'
      | 'same_family_variants'
      | 'listing_search_blog'
      | 'missing_invalid_gtin'
      | 'contradictory_ambiguous_gtin'
      | 'sku_text_only'
      | 'off_domain_false_friends';
    expectedProofClass: 'exact_structured_gtin' | 'exact_variant_gtin' | 'none';
    expectedAuthorityMatch: boolean;
    expectedAutoSelect: boolean;
    difficulty: 'standard' | 'hard_negative' | 'edge_case';
    notes?: string;
  };
}

export function validateGtin(code: string): boolean {
  const digits = code.replace(/[^0-9]/g, '');
  if (digits.length !== 8 && digits.length !== 12 && digits.length !== 13 && digits.length !== 14) {
    return false;
  }
  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  let weight = 3;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  const computed = (10 - (sum % 10)) % 10;
  return computed === check;
}

export function calculateGtinCheckDigit(body: string): number {
  let sum = 0;
  let weight = 3;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

export function makeGtin12(prefix6: string, seq: number): string {
  const body = `${prefix6}${String(seq).padStart(5, '0')}`;
  if (body.length !== 11) throw new Error(`GTIN-12 body length must be 11, got ${body.length}`);
  const check = calculateGtinCheckDigit(body);
  const result = `${body}${check}`;
  if (!validateGtin(result)) throw new Error(`Generated invalid GTIN-12: ${result}`);
  return result;
}

export function makeGtin13(prefix7: string, seq: number): string {
  const body = `${prefix7}${String(seq).padStart(5, '0')}`;
  if (body.length !== 12) throw new Error(`GTIN-13 body length must be 12, got ${body.length}`);
  const check = calculateGtinCheckDigit(body);
  const result = `${body}${check}`;
  if (!validateGtin(result)) throw new Error(`Generated invalid GTIN-13: ${result}`);
  return result;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const BRANDS = [
  { name: 'Purina Pro Plan', domain: 'purina.com', prefix: '017800' },
  { name: 'Blue Buffalo', domain: 'bluebuffalo.com', prefix: '859610' },
  { name: 'Hills Science Diet', domain: 'hillspet.com', prefix: '052742' },
  { name: 'Fromm Family Foods', domain: 'frommfamily.com', prefix: '072705' },
  { name: 'Taste of the Wild', domain: 'tasteofthewildpetfood.com', prefix: '074198' },
  { name: 'Stella & Chewys', domain: 'stellaandchewys.com', prefix: '850000' },
  { name: 'Orijen', domain: 'orijenpetfoods.com', prefix: '064992' },
  { name: 'Acana', domain: 'acana.com', prefix: '064993' },
  { name: 'Wellness Pet Food', domain: 'wellnesspetfood.com', prefix: '076344' },
  { name: 'Nutro Natural Choice', domain: 'nutro.com', prefix: '079105' },
  { name: 'Merrick Pet Care', domain: 'merrickpetcare.com', prefix: '022808' },
  { name: 'Royal Canin', domain: 'royalcanin.com', prefix: '030111' },
  { name: 'Canidae', domain: 'canidae.com', prefix: '099783' },
  { name: 'Victor Super Premium', domain: 'victorpetfood.com', prefix: '854524' },
  { name: 'Earthborn Holistic', domain: 'earthbornholisticpet.com', prefix: '034846' },
  { name: 'NutriSource', domain: 'nutrisourcepetfoods.com', prefix: '073893' },
  { name: 'Solid Gold', domain: 'solidgoldpet.com', prefix: '093766' },
  { name: 'Blue Seal', domain: 'blueseal.com', prefix: '031201' },
  { name: 'Oxbow Animal Health', domain: 'oxbowanimalhealth.com', prefix: '744845' },
  { name: 'Kaytee', domain: 'kaytee.com', prefix: '071859' },
];

const FLAVORS = ['Chicken & Brown Rice Recipe', 'Deboned Salmon & Sweet Potato', 'Lamb & Oatmeal Formula', 'Turkey & Venison Blend', 'Beef & Barley Adult', 'Duck & Pumpkin Entree'];
const SIZES = ['5 lb Bag', '15 lb Bag', '30 lb Bag', '40 lb Bag', '12.5 oz Can', '24-Pack Cans'];

export function generateGoldRecords(): GoldIdentityBenchmarkRecord[] {
  const records: GoldIdentityBenchmarkRecord[] = [];
  let recordId = 1;

  function nextId(): string {
    return `gold-ident-${String(recordId++).padStart(3, '0')}`;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STRATUM 1: JSON-LD, Microdata, Meta, Shopify productJSON Positives (120 pairs)
  // ──────────────────────────────────────────────────────────────────────────

  // 1a. JSON-LD Single Product (40 pairs)
  for (let i = 0; i < 40; i++) {
    const brand = BRANDS[i % BRANDS.length];
    const flavor = FLAVORS[i % FLAVORS.length];
    const size = SIZES[i % SIZES.length];
    const gtin = makeGtin12(brand.prefix, 1000 + i);
    const prodName = `${brand.name} ${flavor} Adult Dry Food, ${size}`;
    const slug = prodName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://www.${brand.domain}/products/${slug}`;
    const gtinKey = i % 3 === 0 ? 'gtin12' : i % 3 === 1 ? 'gtin13' : 'gtin';
    const canonicalGtin = gtinKey === 'gtin13' ? `0${gtin}` : gtin;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${prodName} | ${brand.name}</title>
  <link rel="canonical" href="${url}">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": ${JSON.stringify(prodName)},
    "image": "https://www.${brand.domain}/images/${slug}.jpg",
    "description": "Premium complete and balanced nutrition for adult dogs.",
    "brand": {
      "@type": "Brand",
      "name": ${JSON.stringify(brand.name)}
    },
    "sku": "SKU-${brand.prefix}-${1000 + i}",
    ${JSON.stringify(gtinKey)}: ${JSON.stringify(canonicalGtin)},
    "offers": {
      "@type": "Offer",
      "price": "49.99",
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "url": "${url}"
    }
  }
  </script>
</head>
<body>
  <h1>${prodName}</h1>
  <p class="barcode">UPC: ${gtin}</p>
</body>
</html>`;

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-pos-jsonld-single-${i + 1}`,
        rawUpc: gtin,
        expectedNormalizedGtin: canonicalGtin,
        expectedName: prodName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_upc',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: [{
          type: 'jsonld_product',
          path: gtinKey,
          rawGtin: canonicalGtin,
          normalizedGtin: canonicalGtin,
          isValidChecksum: true,
        }],
      },
      groundTruth: {
        identityLabel: 'exact_match',
        stratum: 'exact_valid_gtin_jsonld_single',
        expectedProofClass: 'exact_structured_gtin',
        expectedAuthorityMatch: true,
        expectedAutoSelect: true,
        difficulty: 'standard',
        notes: `Single Product JSON-LD with valid ${gtinKey}`,
      },
    });
  }

  // 1b. JSON-LD @graph Product (30 pairs)
  for (let i = 0; i < 30; i++) {
    const brand = BRANDS[(i + 5) % BRANDS.length];
    const flavor = FLAVORS[(i + 2) % FLAVORS.length];
    const size = SIZES[(i + 1) % SIZES.length];
    const gtin = makeGtin12(brand.prefix, 2000 + i);
    const prodName = `${brand.name} Grain Free ${flavor}, ${size}`;
    const slug = prodName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://www.${brand.domain}/shop/${slug}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${prodName} - Official Store</title>
  <link rel="canonical" href="${url}">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://www.${brand.domain}/#org",
        "name": ${JSON.stringify(brand.name)},
        "url": "https://www.${brand.domain}"
      },
      {
        "@type": "WebSite",
        "@id": "https://www.${brand.domain}/#website",
        "url": "https://www.${brand.domain}",
        "name": ${JSON.stringify(brand.name)}
      },
      {
        "@type": "Product",
        "@id": "${url}#product",
        "name": ${JSON.stringify(prodName)},
        "brand": { "@id": "https://www.${brand.domain}/#org" },
        "gtin13": "0${gtin}",
        "sku": "ITEM-${2000 + i}"
      }
    ]
  }
  </script>
</head>
<body>
  <h1>${prodName}</h1>
</body>
</html>`;

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-pos-jsonld-graph-${i + 1}`,
        rawUpc: gtin,
        expectedNormalizedGtin: `0${gtin}`,
        expectedName: prodName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_upc',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: [{
          type: 'jsonld_product',
          path: '@graph[2].gtin13',
          rawGtin: `0${gtin}`,
          normalizedGtin: `0${gtin}`,
          isValidChecksum: true,
        }],
      },
      groundTruth: {
        identityLabel: 'exact_match',
        stratum: 'exact_valid_gtin_jsonld_graph',
        expectedProofClass: 'exact_structured_gtin',
        expectedAuthorityMatch: true,
        expectedAutoSelect: true,
        difficulty: 'standard',
        notes: 'JSON-LD @graph structure with GTIN13 in Product node',
      },
    });
  }

  // 1c. Shopify Single-Variant productJSON (20 pairs)
  for (let i = 0; i < 20; i++) {
    const brand = BRANDS[(i + 10) % BRANDS.length];
    const flavor = FLAVORS[(i + 4) % FLAVORS.length];
    const size = SIZES[i % SIZES.length];
    const gtin = makeGtin12(brand.prefix, 3000 + i);
    const prodName = `${brand.name} Limited Ingredient ${flavor}, ${size}`;
    const slug = prodName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://${brand.domain}/products/${slug}`;

    const shopifyJson = {
      id: 7000000 + i,
      title: prodName,
      handle: slug,
      vendor: brand.name,
      variants: [
        {
          id: 8000000 + i,
          title: 'Default Title',
          price: 3499,
          sku: `SH-${3000 + i}`,
          barcode: gtin,
          available: true,
        },
      ],
    };

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${prodName}</title>
  <link rel="canonical" href="${url}">
  <script id="ProductJson-product-template" type="application/json">
  ${JSON.stringify(shopifyJson)}
  </script>
</head>
<body>
  <h1>${prodName}</h1>
</body>
</html>`;

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-pos-shopify-single-${i + 1}`,
        rawUpc: gtin,
        expectedNormalizedGtin: gtin,
        expectedName: prodName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_upc',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: [{
          type: 'shopify_variant',
          path: 'variants[0].barcode',
          rawGtin: gtin,
          normalizedGtin: gtin,
          isValidChecksum: true,
        }],
      },
      groundTruth: {
        identityLabel: 'exact_match',
        stratum: 'exact_valid_gtin_shopify_product_json',
        expectedProofClass: 'exact_structured_gtin',
        expectedAuthorityMatch: true,
        expectedAutoSelect: true,
        difficulty: 'standard',
        notes: 'Shopify ProductJson single variant barcode',
      },
    });
  }

  // 1d. Microdata Product (15 pairs)
  for (let i = 0; i < 15; i++) {
    const brand = BRANDS[(i + 3) % BRANDS.length];
    const flavor = FLAVORS[(i + 1) % FLAVORS.length];
    const size = SIZES[(i + 2) % SIZES.length];
    const gtin = makeGtin12(brand.prefix, 4000 + i);
    const prodName = `${brand.name} Healthy Weight ${flavor}, ${size}`;
    const slug = prodName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://www.${brand.domain}/item/${slug}`;

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${prodName} | ${brand.name}</title>
</head>
<body>
  <div itemscope itemtype="https://schema.org/Product">
    <h1 itemprop="name">${prodName}</h1>
    <span itemprop="brand">${brand.name}</span>
    <span itemprop="gtin12">${gtin}</span>
    <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
      <span itemprop="price">$42.99</span>
    </div>
  </div>
</body>
</html>`;

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-pos-microdata-${i + 1}`,
        rawUpc: gtin,
        expectedNormalizedGtin: gtin,
        expectedName: prodName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_upc',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: [{
          type: 'microdata',
          path: 'div[itemscope] > span[itemprop="gtin12"]',
          rawGtin: gtin,
          normalizedGtin: gtin,
          isValidChecksum: true,
        }],
      },
      groundTruth: {
        identityLabel: 'exact_match',
        stratum: 'exact_valid_gtin_microdata',
        expectedProofClass: 'exact_structured_gtin',
        expectedAuthorityMatch: true,
        expectedAutoSelect: true,
        difficulty: 'standard',
        notes: 'HTML5 Microdata itemprop=gtin12',
      },
    });
  }

  // 1e. Meta tags Product (15 pairs)
  for (let i = 0; i < 15; i++) {
    const brand = BRANDS[(i + 7) % BRANDS.length];
    const flavor = FLAVORS[(i + 3) % FLAVORS.length];
    const size = SIZES[(i + 3) % SIZES.length];
    const gtin = makeGtin12(brand.prefix, 5000 + i);
    const prodName = `${brand.name} Sensitive Stomach ${flavor}, ${size}`;
    const slug = prodName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://www.${brand.domain}/p/${slug}`;

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${prodName} | ${brand.name}</title>
  <meta property="og:title" content="${prodName}">
  <meta property="product:upc" content="${gtin}">
  <meta property="og:brand" content="${brand.name}">
</head>
<body>
  <h1>${prodName}</h1>
</body>
</html>`;

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-pos-meta-${i + 1}`,
        rawUpc: gtin,
        expectedNormalizedGtin: gtin,
        expectedName: prodName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_upc',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: [{
          type: 'meta_tag',
          path: 'meta[property="product:upc"]',
          rawGtin: gtin,
          normalizedGtin: gtin,
          isValidChecksum: true,
        }],
      },
      groundTruth: {
        identityLabel: 'exact_match',
        stratum: 'exact_valid_gtin_meta',
        expectedProofClass: 'exact_structured_gtin',
        expectedAuthorityMatch: true,
        expectedAutoSelect: true,
        difficulty: 'standard',
        notes: 'Meta tag product:upc exact match',
      },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STRATUM 2: Multi-Variant Matrices (Shopify & JSON-LD) (55 pairs)
  // ──────────────────────────────────────────────────────────────────────────

  // 2a. Shopify Multi-Variant Matrix (30 pairs)
  for (let i = 0; i < 30; i++) {
    const brand = BRANDS[(i + 2) % BRANDS.length];
    const flavor = FLAVORS[i % FLAVORS.length];
    const targetVariantIdx = i % 3; // 0: 5lb, 1: 15lb, 2: 30lb
    const sizes = ['5 lb', '15 lb', '30 lb'];
    const targetSize = sizes[targetVariantIdx];
    const gtin0 = makeGtin12(brand.prefix, 6000 + i * 3);
    const gtin1 = makeGtin12(brand.prefix, 6000 + i * 3 + 1);
    const gtin2 = makeGtin12(brand.prefix, 6000 + i * 3 + 2);
    const gtins = [gtin0, gtin1, gtin2];
    const targetGtin = gtins[targetVariantIdx];

    const prodBaseName = `${brand.name} High Protein ${flavor} Recipe`;
    const targetItemName = `${prodBaseName}, ${targetSize} Bag`;
    const slug = prodBaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://${brand.domain}/products/${slug}`;

    const shopifyJson = {
      id: 9000000 + i,
      title: prodBaseName,
      handle: slug,
      vendor: brand.name,
      variants: [
        { id: 9100000 + i * 3, title: '5 lb', option1: '5 lb', price: 2199, sku: `VAR-5-${i}`, barcode: gtin0, available: true },
        { id: 9100000 + i * 3 + 1, title: '15 lb', option1: '15 lb', price: 4499, sku: `VAR-15-${i}`, barcode: gtin1, available: true },
        { id: 9100000 + i * 3 + 2, title: '30 lb', option1: '30 lb', price: 7499, sku: `VAR-30-${i}`, barcode: gtin2, available: true },
      ],
    };

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${prodBaseName} | ${brand.name}</title>
  <link rel="canonical" href="${url}">
  <script id="ProductJson-product-template" type="application/json">
  ${JSON.stringify(shopifyJson)}
  </script>
</head>
<body>
  <h1>${prodBaseName}</h1>
</body>
</html>`;

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-pos-shopify-matrix-${i + 1}`,
        rawUpc: targetGtin,
        expectedNormalizedGtin: targetGtin,
        expectedName: targetItemName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_upc',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: [{
          type: 'shopify_variant',
          path: `variants[${targetVariantIdx}].barcode`,
          rawGtin: targetGtin,
          normalizedGtin: targetGtin,
          isValidChecksum: true,
        }],
      },
      groundTruth: {
        identityLabel: 'exact_match',
        stratum: 'exact_variant_shopify_matrix',
        expectedProofClass: 'exact_variant_gtin',
        expectedAuthorityMatch: true,
        expectedAutoSelect: true,
        difficulty: 'standard',
        notes: `Shopify multi-variant matrix resolved target variant ${targetSize}`,
      },
    });
  }

  // 2b. JSON-LD ProductGroup Matrix (25 pairs)
  for (let i = 0; i < 25; i++) {
    const brand = BRANDS[(i + 6) % BRANDS.length];
    const flavor = FLAVORS[(i + 3) % FLAVORS.length];
    const targetVariantIdx = i % 2; // 0: Small Breed, 1: Large Breed
    const options = ['Small Breed', 'Large Breed'];
    const targetOption = options[targetVariantIdx];
    const gtin0 = makeGtin12(brand.prefix, 7000 + i * 2);
    const gtin1 = makeGtin12(brand.prefix, 7000 + i * 2 + 1);
    const gtins = [gtin0, gtin1];
    const targetGtin = gtins[targetVariantIdx];

    const baseName = `${brand.name} Wilderness ${flavor}`;
    const targetItemName = `${baseName} - ${targetOption} 24 lb`;
    const slug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://www.${brand.domain}/products/${slug}`;

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'ProductGroup',
      name: baseName,
      brand: { '@type': 'Brand', name: brand.name },
      hasVariant: [
        {
          '@type': 'Product',
          name: `${baseName} - Small Breed`,
          gtin12: gtin0,
          sku: `GRP-SB-${i}`,
        },
        {
          '@type': 'Product',
          name: `${baseName} - Large Breed`,
          gtin12: gtin1,
          sku: `GRP-LB-${i}`,
        },
      ],
    };

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${baseName} | ${brand.name}</title>
  <script type="application/ld+json">
  ${JSON.stringify(jsonLd)}
  </script>
</head>
<body>
  <h1>${baseName}</h1>
</body>
</html>`;

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-pos-jsonld-group-${i + 1}`,
        rawUpc: targetGtin,
        expectedNormalizedGtin: targetGtin,
        expectedName: targetItemName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_upc',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: [{
          type: 'jsonld_product_group',
          path: `hasVariant[${targetVariantIdx}].gtin12`,
          rawGtin: targetGtin,
          normalizedGtin: targetGtin,
          isValidChecksum: true,
        }],
      },
      groundTruth: {
        identityLabel: 'exact_match',
        stratum: 'exact_variant_jsonld_product_group',
        expectedProofClass: 'exact_variant_gtin',
        expectedAuthorityMatch: true,
        expectedAutoSelect: true,
        difficulty: 'standard',
        notes: `JSON-LD ProductGroup resolved target variant ${targetOption}`,
      },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STRATUM 3: Same-Family Variants (Hard Negatives) (40 pairs)
  // ──────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < 40; i++) {
    const brand = BRANDS[i % BRANDS.length];
    const subType = i < 20 ? 'size' : i < 35 ? 'flavor' : 'multipack';
    const targetGtin = makeGtin12(brand.prefix, 8000 + i);
    const candidateGtin = makeGtin12(brand.prefix, 8500 + i); // Different GTIN!

    let targetName = '';
    let candidateName = '';
    let identityLabel: GoldIdentityBenchmarkRecord['groundTruth']['identityLabel'] = 'same_family_different_size';

    if (subType === 'size') {
      targetName = `${brand.name} Complete Health Chicken 5 lb Bag`;
      candidateName = `${brand.name} Complete Health Chicken 30 lb Bag`;
      identityLabel = 'same_family_different_size';
    } else if (subType === 'flavor') {
      targetName = `${brand.name} Adult Formula Deboned Salmon 15 lb`;
      candidateName = `${brand.name} Adult Formula Roasted Turkey 15 lb`;
      identityLabel = 'same_family_different_flavor';
    } else {
      targetName = `${brand.name} Classic Pate Chicken 12.5 oz Single Can`;
      candidateName = `${brand.name} Classic Pate Chicken 12.5 oz 24-Can Case`;
      identityLabel = 'same_family_multi_pack';
    }

    const slug = candidateName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://www.${brand.domain}/products/${slug}`;

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${candidateName} | ${brand.name}</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": ${JSON.stringify(candidateName)},
    "brand": { "@type": "Brand", "name": ${JSON.stringify(brand.name)} },
    "gtin12": ${JSON.stringify(candidateGtin)}
  }
  </script>
</head>
<body>
  <h1>${candidateName}</h1>
  <p>Also available in other sizes/flavors!</p>
</body>
</html>`;

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-neg-same-family-${i + 1}`,
        rawUpc: targetGtin,
        expectedNormalizedGtin: targetGtin,
        expectedName: targetName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_token_overlap',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: [{
          type: 'jsonld_product',
          path: 'gtin12',
          rawGtin: candidateGtin,
          normalizedGtin: candidateGtin,
          isValidChecksum: true,
        }],
      },
      groundTruth: {
        identityLabel,
        stratum: 'same_family_variants',
        expectedProofClass: 'none',
        expectedAuthorityMatch: true,
        expectedAutoSelect: false,
        difficulty: 'hard_negative',
        notes: `Candidate page is same family but different variant (${subType}) with different GTIN`,
      },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STRATUM 4: Listing / Search / Blog Pages (Hard Negatives) (30 pairs)
  // ──────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < 30; i++) {
    const brand = BRANDS[(i + 4) % BRANDS.length];
    const pageType = i < 10 ? 'category' : i < 20 ? 'search' : 'blog';
    const targetGtin = makeGtin12(brand.prefix, 9000 + i);
    const prodName = `${brand.name} Premium Puppy Kibble 15 lb`;

    let url = '';
    let html = '';
    let identityLabel: GoldIdentityBenchmarkRecord['groundTruth']['identityLabel'] = 'category_listing';

    if (pageType === 'category') {
      url = `https://www.${brand.domain}/collections/puppy-food`;
      identityLabel = 'category_listing';
      html = `<!DOCTYPE html>
<html>
<head>
  <title>Puppy Food Collection | ${brand.name}</title>
</head>
<body class="collection-page category-listing">
  <h1>Puppy Food Collection</h1>
  <div class="product-grid">
    <div class="card"><a href="/p/1">${prodName}</a></div>
    <div class="card"><a href="/p/2">${brand.name} Large Breed Puppy</a></div>
  </div>
</body>
</html>`;
    } else if (pageType === 'search') {
      url = `https://www.${brand.domain}/search?q=puppy+kibble`;
      identityLabel = 'search_page';
      html = `<!DOCTYPE html>
<html>
<head>
  <title>Search Results for "puppy kibble" | ${brand.name}</title>
</head>
<body class="search-results-page">
  <h1>Search Results</h1>
  <p>Found 12 matching products for ${prodName}</p>
</body>
</html>`;
    } else {
      url = `https://www.${brand.domain}/blogs/nutrition/choosing-the-best-puppy-food`;
      identityLabel = 'blog_post';
      html = `<!DOCTYPE html>
<html>
<head>
  <title>Choosing the Best Puppy Food | ${brand.name} Blog</title>
</head>
<body class="blog-post-article">
  <h1>Choosing the Best Puppy Food</h1>
  <p>When looking at ${prodName}, pet parents appreciate the wholesome grains...</p>
</body>
</html>`;
    }

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-neg-listing-blog-${i + 1}`,
        rawUpc: targetGtin,
        expectedNormalizedGtin: targetGtin,
        expectedName: prodName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_token_overlap',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: [{
          type: 'none',
          path: '',
          rawGtin: null,
          normalizedGtin: null,
          isValidChecksum: false,
        }],
      },
      groundTruth: {
        identityLabel,
        stratum: 'listing_search_blog',
        expectedProofClass: 'none',
        expectedAuthorityMatch: true,
        expectedAutoSelect: false,
        difficulty: 'hard_negative',
        notes: `Page is a ${pageType} page without single structured product GTIN`,
      },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STRATUM 5: Missing / Invalid / Malformed GTIN (Hard Negatives) (35 pairs)
  // ──────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < 35; i++) {
    const brand = BRANDS[(i + 8) % BRANDS.length];
    const subType = i < 15 ? 'bad_checksum' : i < 20 ? 'bad_length' : 'missing_gtin';
    const targetGtin = makeGtin12(brand.prefix, 10000 + i);
    const prodName = `${brand.name} Senior Digestive Care Diet 25 lb`;
    const slug = prodName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://www.${brand.domain}/products/${slug}`;

    let candidateGtin = '';
    let identityLabel: GoldIdentityBenchmarkRecord['groundTruth']['identityLabel'] = 'missing_gtin_structured_data';
    let gtinField = '';

    if (subType === 'bad_checksum') {
      const validCheck = Number(targetGtin.slice(-1));
      const corruptCheck = (validCheck + 5) % 10;
      candidateGtin = `${targetGtin.slice(0, -1)}${corruptCheck}`; // Corrupted check digit!
      identityLabel = 'invalid_gtin_checksum';
      gtinField = `"gtin12": "${candidateGtin}",`;
    } else if (subType === 'bad_length') {
      candidateGtin = '123456'; // 6 digits only
      identityLabel = 'malformed_gtin_length';
      gtinField = `"gtin": "${candidateGtin}",`;
    } else {
      candidateGtin = '';
      identityLabel = 'missing_gtin_structured_data';
      gtinField = ''; // No GTIN in JSON-LD at all
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${prodName} | ${brand.name}</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": ${JSON.stringify(prodName)},
    "brand": { "@type": "Brand", "name": ${JSON.stringify(brand.name)} },
    ${gtinField}
    "sku": "SENIOR-${10000 + i}"
  }
  </script>
</head>
<body>
  <h1>${prodName}</h1>
</body>
</html>`;

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-neg-invalid-gtin-${i + 1}`,
        rawUpc: targetGtin,
        expectedNormalizedGtin: targetGtin,
        expectedName: prodName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_token_overlap',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: candidateGtin ? [{
          type: 'jsonld_product',
          path: subType === 'bad_checksum' ? 'gtin12' : 'gtin',
          rawGtin: candidateGtin,
          normalizedGtin: candidateGtin,
          isValidChecksum: false,
        }] : [],
      },
      groundTruth: {
        identityLabel,
        stratum: 'missing_invalid_gtin',
        expectedProofClass: 'none',
        expectedAuthorityMatch: true,
        expectedAutoSelect: false,
        difficulty: 'hard_negative',
        notes: `Product page has ${subType}`,
      },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STRATUM 6: Contradictory & Ambiguous GTINs (Hard Negatives) (25 pairs)
  // ──────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < 25; i++) {
    const brand = BRANDS[(i + 11) % BRANDS.length];
    const subType = i < 10 ? 'contradictory' : 'ambiguous';
    const targetGtin = makeGtin12(brand.prefix, 11000 + i);
    const conflictingGtin = makeGtin12(brand.prefix, 11500 + i);
    const prodName = `${brand.name} Probiotic Indoor Blend 10 lb`;
    const slug = prodName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://www.${brand.domain}/products/${slug}`;

    let html = '';
    let identityLabel: GoldIdentityBenchmarkRecord['groundTruth']['identityLabel'] = 'contradictory_gtin';

    if (subType === 'contradictory') {
      identityLabel = 'contradictory_gtin';
      html = `<!DOCTYPE html>
<html>
<head>
  <title>${prodName}</title>
  <meta property="product:upc" content="${targetGtin}">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": ${JSON.stringify(prodName)},
    "gtin12": ${JSON.stringify(conflictingGtin)}
  }
  </script>
</head>
<body>
  <h1>${prodName}</h1>
</body>
</html>`;
    } else {
      identityLabel = 'ambiguous_variant';
      // Shopify matrix where multiple variants share no barcodes or empty barcode strings
      const shopifyJson = {
        id: 12000000 + i,
        title: prodName,
        variants: [
          { id: 12100000 + i * 2, title: 'Small', barcode: '', sku: `AMB-1-${i}` },
          { id: 12100000 + i * 2 + 1, title: 'Large', barcode: '', sku: `AMB-2-${i}` },
        ],
      };
      html = `<!DOCTYPE html>
<html>
<head>
  <title>${prodName}</title>
  <script id="ProductJson-product-template" type="application/json">
  ${JSON.stringify(shopifyJson)}
  </script>
</head>
<body>
  <h1>${prodName}</h1>
</body>
</html>`;
    }

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-neg-contradictory-${i + 1}`,
        rawUpc: targetGtin,
        expectedNormalizedGtin: targetGtin,
        expectedName: prodName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_token_overlap',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: subType === 'contradictory' ? [
          { type: 'meta_tag', path: 'meta[property="product:upc"]', rawGtin: targetGtin, normalizedGtin: targetGtin, isValidChecksum: true },
          { type: 'jsonld_product', path: 'gtin12', rawGtin: conflictingGtin, normalizedGtin: conflictingGtin, isValidChecksum: true },
        ] : [],
      },
      groundTruth: {
        identityLabel,
        stratum: 'contradictory_ambiguous_gtin',
        expectedProofClass: 'none',
        expectedAuthorityMatch: true,
        expectedAutoSelect: false,
        difficulty: 'hard_negative',
        notes: `Product page contains ${subType} GTIN data`,
      },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STRATUM 7: SKU-Only & UPC in Body Only (Hard Negatives) (20 pairs)
  // ──────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < 20; i++) {
    const brand = BRANDS[(i + 13) % BRANDS.length];
    const subType = i < 10 ? 'sku_only' : 'body_review_only';
    const targetGtin = makeGtin12(brand.prefix, 12000 + i);
    const prodName = `${brand.name} Pure Ocean Whitefish Cat Diet 6 lb`;
    const slug = prodName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://www.${brand.domain}/shop/${slug}`;

    let html = '';
    let identityLabel: GoldIdentityBenchmarkRecord['groundTruth']['identityLabel'] = 'sku_only_match';

    if (subType === 'sku_only') {
      identityLabel = 'sku_only_match';
      html = `<!DOCTYPE html>
<html>
<head>
  <title>${prodName} | ${brand.name}</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": ${JSON.stringify(prodName)},
    "sku": "SKU-WHITEFISH-${12000 + i}"
  }
  </script>
</head>
<body>
  <h1>${prodName}</h1>
  <p>Manufacturer SKU: SKU-WHITEFISH-${12000 + i}</p>
</body>
</html>`;
    } else {
      identityLabel = 'upc_in_body_only';
      html = `<!DOCTYPE html>
<html>
<head>
  <title>${prodName} | ${brand.name}</title>
</head>
<body>
  <h1>${prodName}</h1>
  <div class="customer-reviews">
    <h3>Customer Reviews</h3>
    <p>User123: I bought this item to replace barcode ${targetGtin} and it works great!</p>
  </div>
  <footer>
    <p class="disclaimer">Random numeric token 987654321012</p>
  </footer>
</body>
</html>`;
    }

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-neg-sku-body-${i + 1}`,
        rawUpc: targetGtin,
        expectedNormalizedGtin: targetGtin,
        expectedName: prodName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain: brand.domain,
        sourceMethod: 'sitemap_token_overlap',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: subType === 'body_review_only' ? [
          { type: 'body_text_only', path: 'body > .customer-reviews > p', rawGtin: targetGtin, normalizedGtin: targetGtin, isValidChecksum: true },
        ] : [],
      },
      groundTruth: {
        identityLabel,
        stratum: 'sku_text_only',
        expectedProofClass: 'none',
        expectedAuthorityMatch: true,
        expectedAutoSelect: false,
        difficulty: 'hard_negative',
        notes: `Product page contains ${subType} without structured product GTIN`,
      },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STRATUM 8: Off-Domain Retailer & False Friends (Hard Negatives) (25 pairs)
  // ──────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < 25; i++) {
    const brand = BRANDS[(i + 15) % BRANDS.length];
    const subType = i < 15 ? 'retailer' : 'counterfeit';
    const targetGtin = makeGtin12(brand.prefix, 13000 + i);
    const prodName = `${brand.name} Senior Holistic Blend 28 lb`;

    let domain = '';
    let url = '';
    let identityLabel: GoldIdentityBenchmarkRecord['groundTruth']['identityLabel'] = 'off_domain_retailer';

    if (subType === 'retailer') {
      domain = i % 2 === 0 ? 'chewy.com' : 'amazon.com';
      url = `https://www.${domain}/dp/${1000000 + i}`;
      identityLabel = 'off_domain_retailer';
    } else {
      domain = `discount-${brand.domain.replace('.com', '')}-outlet.xyz`;
      url = `https://${domain}/cheap/${1000000 + i}`;
      identityLabel = 'off_domain_counterfeit';
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${prodName} at ${domain}</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": ${JSON.stringify(prodName)},
    "brand": { "@type": "Brand", "name": ${JSON.stringify(brand.name)} },
    "gtin12": ${JSON.stringify(targetGtin)}
  }
  </script>
</head>
<body>
  <h1>${prodName}</h1>
  <p>Sold by ${domain}</p>
</body>
</html>`;

    records.push({
      id: nextId(),
      version: '1.0',
      provenance: {
        labeledBy: 'curator-adjudication-panel',
        reviewedBy: ['reviewer-alpha', 'reviewer-beta'],
        adjudicated: true,
        createdAt: '2026-09-01T00:00:00Z',
        sourceCollection: 'baystate-catalog-sample',
      },
      item: {
        itemId: `item-neg-offdomain-${i + 1}`,
        rawUpc: targetGtin,
        expectedNormalizedGtin: targetGtin,
        expectedName: prodName,
        brandHint: brand.name,
        officialDomains: [brand.domain, `www.${brand.domain}`],
      },
      candidate: {
        url,
        domain,
        sourceMethod: 'search',
      },
      fixture: {
        html,
        contentHash: sha256(html),
        gtinSourcePaths: [{
          type: 'jsonld_product',
          path: 'gtin12',
          rawGtin: targetGtin,
          normalizedGtin: targetGtin,
          isValidChecksum: true,
        }],
      },
      groundTruth: {
        identityLabel,
        stratum: 'off_domain_false_friends',
        expectedProofClass: 'none',
        expectedAuthorityMatch: false,
        expectedAutoSelect: false,
        difficulty: 'hard_negative',
        notes: `Page has structured GTIN but is off-domain (${domain}), failing brand authority gate`,
      },
    });
  }

  return records;
}

// Generate and write out if run directly
const records = generateGoldRecords();
const targetPath = path.join(__dirname, '../src/tests/fixtures/onboarding/official-page-identity-gold.jsonl');
fs.mkdirSync(path.dirname(targetPath), { recursive: true });
const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
fs.writeFileSync(targetPath, content, 'utf8');
console.log(`Generated ${records.length} gold benchmark records to ${targetPath}`);
