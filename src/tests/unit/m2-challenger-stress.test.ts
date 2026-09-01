import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  extractStructuredGtinsFromHtml,
  qualifyIdentityProof,
} from '../../onboarding/page-verifier';
import {
  validateGtin,
  canonicalGtinMatch,
} from '../../shared/gtin';
import {
  evaluateStrictGtin,
  runBenchmark,
} from '../../../scripts/benchmark-official-page-identity';
import type { GoldIdentityBenchmarkRecord } from '../../../scripts/generate-gold-benchmark';

describe('Milestone 2 Challenger Empirical Stress Suite', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/onboarding/official-page-identity-gold.jsonl');

  describe('1. Gold Benchmark Invariant & Stratum Stress Test', () => {
    it('executes full benchmark and verifies all G0.2 activation floor criteria', () => {
      const report = runBenchmark(fixturePath);

      // Total counts
      expect(report.meta.totalRecords).toBe(350);
      expect(report.meta.positives).toBe(175);
      expect(report.meta.hardNegatives).toBe(175);

      // Strict GTIN matrix
      expect(report.strictGtin.tp).toBe(175);
      expect(report.strictGtin.fp).toBe(0);
      expect(report.strictGtin.tn).toBe(175);
      expect(report.strictGtin.fn).toBe(0);
      expect(report.strictGtin.precision).toBe(1.0);
      expect(report.strictGtin.recall).toBe(1.0);
      expect(report.strictGtin.specificity).toBe(1.0);
      expect(report.strictGtin.wilsonPrecision.lower).toBeGreaterThanOrEqual(0.95);
      expect(report.strictGtin.wilsonPrecision.lower).toBeCloseTo(0.9785, 3);
      expect(report.strictGtin.wilsonRecall.lower).toBeGreaterThanOrEqual(0.95);

      // Old selector comparison
      expect(report.oldRelaxed.fp).toBe(120);
      expect(report.deltas.falsePositivesEliminated).toBe(120);
      expect(report.deltas.deltaNeedsInputCount).toBe(120);

      // Activation floor
      expect(report.activationFloor.passed).toBe(true);
      expect(report.activationFloor.zeroFalsePositives).toBe(true);
      expect(report.activationFloor.pointPrecisionMet).toBe(true);
      expect(report.activationFloor.wilsonLowerBoundMet).toBe(true);
      expect(report.activationFloor.validGtinRecallMet).toBe(true);
    });

    it('verifies exact counts and FP=0 across all 13 strata', () => {
      const content = fs.readFileSync(fixturePath, 'utf8');
      const records: GoldIdentityBenchmarkRecord[] = content
        .split('\n')
        .filter(l => l.trim().length > 0)
        .map(l => JSON.parse(l));

      const strataMap = new Map<string, GoldIdentityBenchmarkRecord[]>();
      for (const r of records) {
        const s = r.groundTruth.stratum;
        if (!strataMap.has(s)) strataMap.set(s, []);
        strataMap.get(s)!.push(r);
      }

      // Expected strata counts
      const expectedCounts: Record<string, { total: number; expectedAuto: boolean }> = {
        exact_valid_gtin_jsonld_single: { total: 40, expectedAuto: true },
        exact_valid_gtin_jsonld_graph: { total: 30, expectedAuto: true },
        exact_valid_gtin_shopify_product_json: { total: 20, expectedAuto: true },
        exact_valid_gtin_microdata: { total: 15, expectedAuto: true },
        exact_valid_gtin_meta: { total: 15, expectedAuto: true },
        exact_variant_shopify_matrix: { total: 30, expectedAuto: true },
        exact_variant_jsonld_product_group: { total: 25, expectedAuto: true },
        same_family_variants: { total: 40, expectedAuto: false },
        listing_search_blog: { total: 30, expectedAuto: false },
        missing_invalid_gtin: { total: 35, expectedAuto: false },
        contradictory_ambiguous_gtin: { total: 25, expectedAuto: false },
        sku_text_only: { total: 20, expectedAuto: false },
        off_domain_false_friends: { total: 25, expectedAuto: false },
      };

      for (const [stratum, exp] of Object.entries(expectedCounts)) {
        const items = strataMap.get(stratum);
        expect(items).toBeDefined();
        expect(items!.length).toBe(exp.total);

        for (const item of items!) {
          const res = evaluateStrictGtin(item);
          expect(res.autoSelected).toBe(exp.expectedAuto);
          if (exp.expectedAuto) {
            expect(['exact_structured_gtin', 'exact_variant_gtin']).toContain(res.proofClass);
            expect(res.authorityMatch).toBe(true);
          } else {
            // For negative items, must NEVER auto-select
            expect(res.autoSelected).toBe(false);
          }
        }
      }
    });
  });

  describe('2. GS1 Canonical GTIN Validation & Equivalence Stress', () => {
    it('validates 8, 12, 13, and 14-digit GTINs with correct Mod-10 weights', () => {
      // 8-digit
      expect(validateGtin('12345670')).toBe(true);
      expect(validateGtin('12345671')).toBe(false);

      // 12-digit (UPC-A)
      expect(validateGtin('017800010009')).toBe(true);
      expect(validateGtin('017800010000')).toBe(false);
      expect(validateGtin('012000000133')).toBe(true);

      // 13-digit (EAN-13)
      expect(validateGtin('0017800010009')).toBe(true);
      expect(validateGtin('5012345678900')).toBe(true);
      expect(validateGtin('5012345678901')).toBe(false);

      // 14-digit (GTIN-14)
      expect(validateGtin('00017800010009')).toBe(true);
      expect(validateGtin('10012345678902')).toBe(true);
      expect(validateGtin('10012345678908')).toBe(false);

      // Invalid lengths
      expect(validateGtin('1234567')).toBe(false); // 7 digits
      expect(validateGtin('123456789')).toBe(false); // 9 digits
      expect(validateGtin('12345678901')).toBe(false); // 11 digits
      expect(validateGtin('123456789012345')).toBe(false); // 15 digits
      expect(validateGtin('')).toBe(false);
      expect(validateGtin(null)).toBe(false);
      expect(validateGtin(undefined)).toBe(false);
    });

    it('validates canonical equivalence and 0-padding across formats', () => {
      const upc12 = '017800010009';
      const ean13 = '0017800010009';
      const gtin14 = '00017800010009';

      expect(canonicalGtinMatch(upc12, upc12)).toBe(true);
      expect(canonicalGtinMatch(upc12, ean13)).toBe(true);
      expect(canonicalGtinMatch(ean13, upc12)).toBe(true);
      expect(canonicalGtinMatch(upc12, gtin14)).toBe(true);
      expect(canonicalGtinMatch(gtin14, upc12)).toBe(true);
      expect(canonicalGtinMatch(ean13, gtin14)).toBe(true);
      expect(canonicalGtinMatch(gtin14, ean13)).toBe(true);

      // Formatted with dashes/spaces
      expect(canonicalGtinMatch('0-17800-01000-9', upc12)).toBe(true);
      expect(canonicalGtinMatch(' 017800010009 ', ean13)).toBe(true);

      // Different products must NEVER match
      expect(canonicalGtinMatch('017800010009', '017800010016')).toBe(false);
      expect(canonicalGtinMatch('017800010009', '12345670')).toBe(false);
      expect(canonicalGtinMatch(null, upc12)).toBe(false);
    });
  });

  describe('3. Adversarial HTML Parser Stress & Graceful Degradation', () => {
    it('handles malformed, corrupt, or garbage JSON-LD without crashing', () => {
      const malformedHtml = `
        <html>
          <head>
            <script type="application/ld+json">{ broken json </script>
            <script type="application/ld+json">null</script>
            <script type="application/ld+json">[1, 2, "random"]</script>
            <script type="application/ld+json">{"@type": "Product", "gtin12": "017800010009"}</script>
          </head>
        </html>
      `;
      const gtins = extractStructuredGtinsFromHtml(malformedHtml);
      expect(gtins.length).toBe(1);
      expect(gtins[0].gtin).toBe('017800010009');
      expect(gtins[0].isValidChecksum).toBe(true);
      expect(gtins[0].type).toBe('single');
    });

    it('handles numeric GTIN values in JSON-LD and microdata', () => {
      const numericHtml = `
        <script type="application/ld+json">
          {
            "@type": "Product",
            "name": "Test Product",
            "gtin12": 17800010009
          }
        </script>
      `;
      const gtins = extractStructuredGtinsFromHtml(numericHtml);
      expect(gtins.length).toBe(1);
      expect(gtins[0].gtin).toBe('17800010009');
    });

    it('rejects contradictory single-product GTINs even if both have valid GS1 checksums', () => {
      // 017800010009 (valid) and 012000000133 (valid) on the same page
      const contradictoryHtml = `
        <script type="application/ld+json">
          {
            "@type": "Product",
            "name": "Single Item A",
            "gtin12": "017800010009"
          }
        </script>
        <script type="application/ld+json">
          {
            "@type": "Product",
            "name": "Single Item B",
            "gtin12": "012000000133"
          }
        </script>
      `;
      const gtins = extractStructuredGtinsFromHtml(contradictoryHtml);
      expect(gtins.length).toBe(2);

      const signals = {
        isListingOrSearchPage: false,
        isBlogOrCmsPage: false,
        upcInPage: true,
      };

      const proof = qualifyIdentityProof(gtins, '017800010009', signals);
      expect(proof.proofClass).toBe('none');
      expect(proof.decisionReason).toBe('contradictory_gtins_found');
    });

    it('deduplicates identical GTINs across multiple tags without false contradiction', () => {
      const multiTagHtml = `
        <script type="application/ld+json">
          {
            "@type": "Product",
            "name": "Item",
            "gtin12": "017800010009"
          }
        </script>
        <meta property="product:upc" content="017800010009" />
        <span itemprop="gtin12" content="017800010009">017800010009</span>
      `;
      const gtins = extractStructuredGtinsFromHtml(multiTagHtml);
      expect(gtins.length).toBe(4);

      const signals = {
        isListingOrSearchPage: false,
        isBlogOrCmsPage: false,
        upcInPage: true,
      };

      const proof = qualifyIdentityProof(gtins, '017800010009', signals);
      expect(proof.proofClass).toBe('exact_structured_gtin');
      expect(proof.decisionReason).toBe('exact_structured_gtin_verified');
    });

    it('deduplicates 12-digit and 14-digit representations of the same GTIN across tags', () => {
      const padHtml = `
        <script type="application/ld+json">
          {
            "@type": "Product",
            "gtin12": "017800010009"
          }
        </script>
        <meta property="product:upc" content="00017800010009" />
      `;
      const gtins = extractStructuredGtinsFromHtml(padHtml);
      expect(gtins.length).toBe(2);

      const signals = {
        isListingOrSearchPage: false,
        isBlogOrCmsPage: false,
        upcInPage: true,
      };

      const proof = qualifyIdentityProof(gtins, '017800010009', signals);
      expect(proof.proofClass).toBe('exact_structured_gtin');
      expect(proof.decisionReason).toBe('exact_structured_gtin_verified');
    });

    it('rejects listing, search, or blog pages even when they contain matching structured GTINs', () => {
      const listingHtml = `
        <body class="collection-page">
          <script type="application/ld+json">
            {
              "@type": "Product",
              "gtin12": "017800010009"
            }
          </script>
        </body>
      `;
      const gtins = extractStructuredGtinsFromHtml(listingHtml);
      const signals = {
        isListingOrSearchPage: true,
        isBlogOrCmsPage: false,
        upcInPage: true,
      };

      const proof = qualifyIdentityProof(gtins, '017800010009', signals);
      expect(proof.proofClass).toBe('none');
      expect(proof.decisionReason).toBe('listing_or_search_page');
    });

    it('rejects body/review text substring UPCs when structured data is absent', () => {
      const bodyOnlyHtml = `
        <html>
          <body>
            <h1>Great Dog Food</h1>
            <div class="user-review">The barcode on my bag is 017800010009 and my dog loves it!</div>
          </body>
        </html>
      `;
      const gtins = extractStructuredGtinsFromHtml(bodyOnlyHtml);
      expect(gtins.length).toBe(0);

      const signals = {
        isListingOrSearchPage: false,
        isBlogOrCmsPage: false,
        upcInPage: true,
      };

      const proof = qualifyIdentityProof(gtins, '017800010009', signals);
      expect(proof.proofClass).toBe('none');
      expect(proof.decisionReason).toBe('upc_in_body_or_review_text_only');
    });

    it('qualifies variant matrix in Shopify product JSON correctly', () => {
      const shopifyHtml = `
        <script id="ProductJson-12345" type="application/json">
          {
            "id": 12345,
            "title": "Dog Kibble",
            "variants": [
              { "id": 1, "title": "5 lb", "barcode": "017800010009" },
              { "id": 2, "title": "15 lb", "barcode": "017800010016" }
            ]
          }
        </script>
      `;
      const gtins = extractStructuredGtinsFromHtml(shopifyHtml);
      expect(gtins.length).toBe(2);
      expect(gtins[0].type).toBe('variant');
      expect(gtins[1].type).toBe('variant');

      const signals = {
        isListingOrSearchPage: false,
        isBlogOrCmsPage: false,
        upcInPage: true,
      };

      // Query for 5 lb variant
      const proof5 = qualifyIdentityProof(gtins, '017800010009', signals);
      expect(proof5.proofClass).toBe('exact_variant_gtin');
      expect(proof5.decisionReason).toBe('exact_variant_gtin_resolved');

      // Query for 15 lb variant
      const proof15 = qualifyIdentityProof(gtins, '017800010016', signals);
      expect(proof15.proofClass).toBe('exact_variant_gtin');
      expect(proof15.decisionReason).toBe('exact_variant_gtin_resolved');

      // Query for non-existent 30 lb variant
      const proof30 = qualifyIdentityProof(gtins, '017800010023', signals);
      expect(proof30.proofClass).toBe('none');
      expect(proof30.decisionReason).toBe('gtin_mismatch_different_product_or_variant');
    });

    it('handles ambiguous multiple matching variants safely', () => {
      const ambiguousHtml = `
        <script id="ProductJson-12345" type="application/json">
          {
            "id": 12345,
            "title": "Dog Kibble",
            "variants": [
              { "id": 1, "title": "Pack of 1", "barcode": "017800010009" },
              { "id": 2, "title": "Bundle with Toy", "barcode": "017800010009" }
            ]
          }
        </script>
      `;
      const gtins = extractStructuredGtinsFromHtml(ambiguousHtml);
      expect(gtins.length).toBe(2);

      const signals = {
        isListingOrSearchPage: false,
        isBlogOrCmsPage: false,
        upcInPage: true,
      };

      const proof = qualifyIdentityProof(gtins, '017800010009', signals);
      expect(proof.proofClass).toBe('none');
      expect(proof.decisionReason).toBe('ambiguous_multiple_matching_variants');
    });
  });

  describe('4. Operational Kill Switch & Gating Stress', () => {
    it('verifies kill switch behavior for multiple truthy environment representations', () => {
      const truthyValues = ['1', 'true', 'TRUE', 'True'];
      for (const val of truthyValues) {
        process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED = val;
        const isDisabled =
          process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED === '1' ||
          process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED?.toLowerCase() === 'true';
        expect(isDisabled).toBe(true);
      }

      const falsyValues = ['0', 'false', 'FALSE', '', undefined];
      for (const val of falsyValues) {
        if (val === undefined) {
          delete process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED;
        } else {
          process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED = val;
        }
        const isDisabled =
          process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED === '1' ||
          process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED?.toLowerCase() === 'true';
        expect(isDisabled).toBe(false);
      }
      delete process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED;
    });
  });
});
