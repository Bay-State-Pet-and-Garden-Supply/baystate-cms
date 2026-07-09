/**
 * Profile Runner Client
 *
 * Builds ExtractRequest payloads from an ExtractorProfile + source URL
 * and dispatches them to the extraction worker's POST /profile-runner/extract.
 *
 * Lives in the Bun API server. The extraction worker must be running
 * separately (`bun run worker:dev`) for this to work.
 */

import { trustedExtract } from '../server/extraction-worker-client';
import type { ExtractorProfile } from '../db/repositories/extractor-profile-repo';
import type { ExtractionData } from '../shared/schemas/onboarding';
import type { VariantSelectionStrategy } from '../shared/schemas/extraction-worker';
import { cleanAndDeduplicateImages } from './image-utils';

export interface ProfileRunnerOptions {
  /** The product page URL to extract from. */
  sourceUrl: string;
  /** The extractor profile (CSS selectors) for this domain. */
  profile: ExtractorProfile;
  /** Expected product info from the spreadsheet. */
  expected: {
    name: string;
    brandHint?: string | null;
    price?: string | null;
  };
}

export type ProfileRunnerResult =
  | { ok: true; data: ExtractionData; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

/**
 * Run a trusted profile extraction against the extraction worker.
 *
 * Builds an ExtractRequest from the profile and dispatches it to the
 * worker's POST /profile-runner/extract endpoint. The worker runs the
 * profile's CSS selectors deterministically (never falls back to
 * generic extraction, never calls an LLM).
 *
 * Returns ok:false when the worker is unreachable or returns a
 * response without trusted title evidence, preserving fail-closed
 * semantics per ADR 0009.
 */
export async function runProfileExtraction(
  options: ProfileRunnerOptions,
): Promise<ProfileRunnerResult> {
  const { sourceUrl, profile, expected } = options;

  const request = {
    profileId: profile.id,
    profileVersion: profile.updatedAt
      ? Math.floor(new Date(profile.updatedAt).getTime() / 1000)
      : 0,
    sourceUrl,
    expected: {
      name: expected.name,
      brandHint: expected.brandHint ?? null,
      price: expected.price ?? null,
      spreadsheetHints: {},
    },
    profile: {
      runtime: profile.runtime ?? 'rendered',
      selectors: {
        titleSelector: profile.titleSelector,
        priceSelector: profile.priceSelector,
        descriptionSelector: profile.descriptionSelector,
        brandSelector: profile.brandSelector,
        imagesSelector: profile.imagesSelector,
      },
      titleOptionalSelectors: profile.titleOptionalSelectors ?? [],
      customSelectors: profile.customSelectors ?? {},
      imageRules: {},
      variantSelectionStrategy: profile.variantSelectionStrategy as VariantSelectionStrategy | null ?? null,
    },
  };

  const result = await trustedExtract(request);

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      warnings: [],
    };
  }

  const response = result.data;

  if (!response.ok || !response.extractionData) {
    return {
      ok: false,
      error: 'Extraction worker returned ok:false',
      warnings: response.warnings ?? [],
    };
  }

  const ext = response.extractionData;
  const rawImages = [ext.primaryImage, ...ext.additionalImages].filter(Boolean) as string[];
  const cleanImages = cleanAndDeduplicateImages(rawImages, sourceUrl);
  ext.primaryImage = cleanImages[0] || null;
  ext.additionalImages = cleanImages.slice(1);

  return {
    ok: true,
    data: ext,
    warnings: response.warnings ?? [],
  };
}
