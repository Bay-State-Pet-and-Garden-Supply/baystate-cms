/**
 * Live-smoke provider catalog (M6, ADR 0014 Amendment B).
 *
 * The verified TEST identifiers, expected names, and expected brands below
 * are derived from the reviewed fixture manifests under
 * `src/tests/fixtures/sourcing/html-scrapers/<provider>/manifest.json` and
 * `expected.json` (real captures where available; the identifiers were
 * re-verified against the live storefronts during fixture capture on
 * 2026-08-15). They are the ONLY identifiers the live smoke may use without
 * an explicit `--upc` override, and the ONLY expected values it asserts.
 *
 * This module is shared by the CLI (`scripts/sourcing-live-smoke.ts`) and
 * its unit tests; it has no network, DB, env, or logging side effects.
 */

export interface LiveSmokeProvider {
  /** Exact registry provider id (`html_scraper + <providerId>` pair). */
  providerId: string;
  /** Whether this connector requires resolved credentials to run. */
  requiresSecret: boolean;
  /** Verified 8–14 digit test identifier (never a 6-digit item number). */
  defaultIdentifier: string;
  /** Reviewed expected product name (null = no name assertion). */
  expectedName: string | null;
  /** Reviewed expected brand (null = no brand assertion). */
  expectedBrand: string | null;
}

export const LIVE_SMOKE_PROVIDERS: Readonly<Record<string, LiveSmokeProvider>> = {
  bradley: {
    providerId: 'bradley',
    requiresSecret: false,
    // Verified 12-digit UPC captured from the E-Z HANG SCALE PDP
    // (bradleycaldwell.com/e-z-hang-scale-silver-up-to-55-lb-001135).
    defaultIdentifier: '018653299524',
    expectedName: 'E-Z HANG SCALE',
    expectedBrand: 'KERBL',
  },
  central_pet: {
    providerId: 'central_pet',
    requiresSecret: false,
    // Verified 12-digit UPC captured from the KONG Air Dog Squeaker PDP
    // (option PDCM38777520).
    defaultIdentifier: '035585775210',
    expectedName: 'KONG Air Dog Squeaker Tennis Ball Dog Toy',
    expectedBrand: 'KONG',
  },
  orgill: {
    providerId: 'orgill',
    requiresSecret: true,
    defaultIdentifier: '755625321923',
    expectedName: 'Landscapers Select 34609 PCL-P Shovel, 16 ga, Hardwood Handle, 45 in L Handle',
    expectedBrand: 'LANDSCAPERS SELECT',
  },
  pet_food_experts: {
    providerId: 'pet_food_experts',
    requiresSecret: true,
    defaultIdentifier: '33011808',
    expectedName: 'Wellness CORE Grain Free',
    expectedBrand: 'Wellness',
  },
  phillips_storefront: {
    providerId: 'phillips_storefront',
    requiresSecret: true,
    defaultIdentifier: '072705115310',
    expectedName: 'Fromm Gold Large Breed Dog 30 lb',
    expectedBrand: 'FROMM FAMILY FOODS LLC',
  },
};

/**
 * Bradley's historical test SKU `001135` is a SIX-digit BCI item number and
 * cannot satisfy the engine's exact 8–14 digit normalized UPC/GTIN contract.
 * It is retained only as a parser/search-URL regression fixture and is
 * REFUSED as a live-smoke engine identifier (the smoke requires the verified
 * real UPC above or an explicit verified `--upc`).
 */
export const BRADLEY_REFUSED_IDENTIFIER = '001135';
