/**
 * ExtractionStagePanel render assertions for distributor-record sources
 * (Amendment A, MD item 9).
 *
 * Pure-component test via `renderToStaticMarkup` (no jsdom, no API mocks),
 * following the sourcing-stage-panel.test.tsx / pr10-drawer-render pattern.
 *
 * Proves: a distributor-record item shows the materialization label and
 * provenance (providers/attempts/generation/hash), hides the URL edit +
 * manual URL input entirely, renders only identity fields (title/brand/
 * weight/SKU/MPN/variant attributes — never copy/images as commerce data),
 * and exposes the guarded "Continue with Official Site Discovery" fallback
 * only when the board supplies the handler. Official-page sources keep the
 * existing URL banner + edit controls.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExtractionStagePanel } from '../../client/components/pipeline-drawer/ExtractionStagePanel';
import { ExtractionDataSchema, type ExtractionData } from '../../shared/schemas/onboarding';
import type { SourcingQualificationView } from '../../client/onboarding-api';

const noop = async () => {};
const setNoop = (_: boolean) => {};
const setUrlNoop = (_: string) => {};

function distributorExtractionData(): ExtractionData {
  return ExtractionDataSchema.parse({
    title: 'Dog Food Chicken 10 lb',
    brand: 'Acme Pet',
    weight: '10 lb',
    distributorSku: 'DIST-SKU-1',
    manufacturerPartNumber: 'MPN-001',
    variantAttributes: { flavor: 'chicken', size: '10 lb' },
    sourceType: 'distributor_record',
    distributorProviderIds: ['phillips', 'bci'],
    distributorEvidenceAttemptIds: ['att-1', 'att-2'],
    distributorRecordProvenance: {
      sourcingGenerationId: 'gen-9',
      evidenceHash: 'a'.repeat(64),
      acceptedEvidenceAttemptIds: ['att-1', 'att-2'],
      providerIds: ['phillips', 'bci'],
      catalogVersions: ['v2026.3'],
    },
    sourceUrl: null,
    confidence: 0,
    description: null,
    bulletPoints: [],
    primaryImage: null,
    additionalImages: [],
    price: null,
  });
}

/**
 * Amendment B (M5b-2): a VERIFIED v2 distributor materialization carrying
 * merchandising-depth fields (description/features/category/dimensions/case/
 * UOM/ingredients) + display-only image candidates with per-field
 * merchandising provenance.
 */
function distributorExtractionDataV2(): ExtractionData {
  return ExtractionDataSchema.parse({
    title: 'Dog Food Chicken 10 lb',
    brand: 'Acme Pet',
    weight: '10 lb',
    description: 'Chicken recipe kibble for adult dogs.',
    bulletPoints: ['Chicken first', 'Grain free'],
    distributorCategory: 'Dog Food',
    dimensions: '18 x 12 x 6 in',
    casePack: '6',
    unitOfMeasure: 'EA',
    ingredients: 'Chicken, brown rice',
    distributorSku: 'DIST-SKU-1',
    manufacturerPartNumber: 'MPN-001',
    variantAttributes: { flavor: 'chicken', size: '10 lb' },
    sourceType: 'distributor_record',
    distributorProviderIds: ['phillips'],
    distributorEvidenceAttemptIds: ['att-1'],
    distributorImageCandidates: [
      { url: 'https://cdn.phillips.example/img/dog-food-1.jpg', sourceAttemptIds: ['att-1'], sourceProviderIds: ['phillips'] },
      { url: 'https://cdn.phillips.example/img/dog-food-2.jpg', sourceAttemptIds: ['att-1'], sourceProviderIds: ['phillips'] },
    ],
    distributorImageApprovals: [],
    distributorRecordProvenance: {
      sourcingGenerationId: 'gen-9',
      evidenceHash: 'a'.repeat(64),
      acceptedEvidenceAttemptIds: ['att-1'],
      providerIds: ['phillips'],
      catalogVersions: ['v2026.3'],
      projectionVersion: 'distributor-record-projection-v2',
      extractionMethod: 'distributor_record_v2',
      merchandisingProvenance: {
        description: [
          { attemptId: 'att-1', providerId: 'phillips', catalogVersion: 'v2026.3', connectionId: 'conn-1', values: ['Chicken recipe kibble for adult dogs.'] },
        ],
        features: [
          { attemptId: 'att-1', providerId: 'phillips', catalogVersion: 'v2026.3', connectionId: 'conn-1', values: ['Chicken first', 'Grain free'] },
        ],
      },
    },
    sourceUrl: null,
    confidence: 0,
    primaryImage: null,
    additionalImages: [],
    price: null,
  });
}

function officialExtractionData(): ExtractionData {
  return ExtractionDataSchema.parse({
    title: 'Official Title',
    brand: 'Acme Pet',
    description: 'Official description copy.',
    sourceType: 'official_page',
    sourceUrl: 'https://acmepet.example/products/dog-food',
    confidence: 0.8,
  });
}

function renderPanel(overrides: {
  extractionData?: ExtractionData | null;
  sourceUrl?: string | null;
  sourceType?: 'official_page' | 'distributor_record';
  qualificationView?: SourcingQualificationView | null;
  stageStatus?: string;
  onContinueWithOfficialDiscovery?: (() => Promise<void>) | undefined;
} = {}) {
  return renderToStaticMarkup(
    <ExtractionStagePanel
      extractionData={overrides.extractionData ?? null}
      sourceUrl={overrides.sourceUrl ?? null}
      showEditUrl={false}
      setShowEditUrl={setNoop}
      manualUrlInput=""
      setManualUrlInput={setUrlNoop}
      onSetManualUrl={noop}
      sourceType={overrides.sourceType ?? 'official_page'}
      qualificationView={overrides.qualificationView ?? null}
      stageStatus={overrides.stageStatus}
      onContinueWithOfficialDiscovery={overrides.onContinueWithOfficialDiscovery}
    />,
  );
}

describe('ExtractionStagePanel — distributor-record source (MD)', () => {
  it('labels the materialization source and shows provenance for distributor items', () => {
    const html = renderPanel({
      extractionData: distributorExtractionData(),
      sourceType: 'distributor_record',
    });
    expect(html).toContain('Distributor Record');
    expect(html).toContain('Materialized from a qualified distributor record (no product page).');
    expect(html).toContain('Providers:');
    expect(html).toContain('phillips, bci');
    expect(html).toContain('gen-9');
    expect(html).toContain('att-1, att-2');
    expect(html).toContain('a'.repeat(64));
    expect(html).toContain('v2026.3');
  });

  it('never shows the URL edit control or manual URL input for distributor items', () => {
    const html = renderPanel({
      extractionData: distributorExtractionData(),
      sourceType: 'distributor_record',
    });
    expect(html).not.toContain('✏ Edit');
    expect(html).not.toContain('Paste product page URL manually');
    expect(html).not.toContain('Set');
  });

  it('renders only identity fields and never copy/images as commerce data', () => {
    const html = renderPanel({
      extractionData: distributorExtractionData(),
      sourceType: 'distributor_record',
    });
    expect(html).toContain('Distributor Record Data (identity-only)');
    expect(html).toContain('Dog Food Chicken 10 lb');
    expect(html).toContain('Acme Pet');
    expect(html).toContain('DIST-SKU-1');
    expect(html).toContain('MPN-001');
    expect(html).toContain('flavor');
    expect(html).toContain('chicken');
    // No distributor copy/description/price/images are rendered as data.
    expect(html).not.toContain('Official description copy.');
    expect(html).not.toContain('primaryImage');
  });

  it('shows additional distributor SKUs from other accepted providers as reference values', () => {
    const data = ExtractionDataSchema.parse({
      ...distributorExtractionData(),
      distributorReferenceValues: {
        distributorSku: ['DIST-SKU-1', 'SKU-BCI', 'SKU-UNFI'],
        name: ['Dog Food Chicken 10 lb', 'DOG FOOD CHICKEN 10LB'],
      },
    });
    const html = renderPanel({ extractionData: data, sourceType: 'distributor_record' });
    expect(html).toContain('DIST-SKU-1');
    expect(html).toContain('SKU-BCI · SKU-UNFI');
  });

  it('never renders distributor copy even when a tampered payload carries description/customFields', () => {
    // A malformed or tampered distributor payload must not display copy:
    // the panel renders identity fields only for distributor sources.
    const tampered = ExtractionDataSchema.parse({
      ...distributorExtractionData(),
      description: 'Tampered marketing copy from an untrusted payload',
      bulletPoints: ['Bullet A', 'Bullet B'],
      customFields: { price: '9.99', inStock: 'true', 'Raw Note': 'should not render' },
    });
    const html = renderPanel({
      extractionData: tampered,
      sourceType: 'distributor_record',
    });
    expect(html).not.toContain('Tampered marketing copy');
    expect(html).not.toContain('Bullet A');
    expect(html).not.toContain('price');
    expect(html).not.toContain('inStock');
    expect(html).not.toContain('Raw Note');
    // Identity fields still render.
    expect(html).toContain('Dog Food Chicken 10 lb');
  });

  it('shows the guarded fallback button only when the board supplies the handler', () => {
    const withFallback = renderPanel({
      extractionData: distributorExtractionData(),
      sourceType: 'distributor_record',
      onContinueWithOfficialDiscovery: noop,
    });
    expect(withFallback).toContain('Continue with Official Site Discovery');

    const withoutFallback = renderPanel({
      extractionData: distributorExtractionData(),
      sourceType: 'distributor_record',
    });
    expect(withoutFallback).not.toContain('Continue with Official Site Discovery');
  });

  it('renders sourcing provenance from the qualification view when the payload is not yet materialized', () => {
    // Extraction pending/failed: the item has a current generation with
    // qualified evidence, but no extraction payload yet. Provenance must be
    // visible from the server-derived qualification view (MD round-3 defect 3).
    const qualificationView: SourcingQualificationView = {
      qualified: true,
      reasonCodes: [],
      acceptedEvidenceAttemptIds: ['att-1', 'att-2'],
      providerIds: ['phillips', 'bci'],
      evidenceHash: 'b'.repeat(64),
      sourcingGenerationId: 'gen-9',
    };
    const html = renderPanel({
      extractionData: null,
      sourceType: 'distributor_record',
      qualificationView,
    });
    expect(html).toContain('Distributor Record');
    expect(html).toContain('Distributor qualification (providers / attempts / hash)');
    expect(html).toContain('phillips, bci');
    expect(html).toContain('att-1, att-2');
    expect(html).toContain('b'.repeat(64));
    // Generation renders from the view even without a materialized payload.
    expect(html).toContain('gen-9');
    // The null-payload state must NOT claim the record was materialized.
    expect(html).not.toContain('Materialized from a qualified distributor record');
    expect(html).toContain('Distributor evidence is qualified; record materialization is pending.');
    // No URL edit control, and the fallback remains available.
    expect(html).not.toContain('Paste product page URL manually');
  });

  it('labels a failed distributor materialization accurately (no Materialized claim)', () => {
    const qualificationView: SourcingQualificationView = {
      qualified: true,
      reasonCodes: [],
      acceptedEvidenceAttemptIds: ['att-1'],
      providerIds: ['phillips'],
      evidenceHash: 'c'.repeat(64),
      sourcingGenerationId: 'gen-9',
    };
    const html = renderPanel({
      extractionData: null,
      sourceType: 'distributor_record',
      qualificationView,
      stageStatus: 'failed',
    });
    expect(html).toContain('Materialization failed');
    expect(html).toContain('Review the provenance below and use the guarded fallback');
    expect(html).not.toContain('Materialized from a qualified distributor record');
    expect(html).toContain('gen-9');
  });

  it('renders merchandising-depth data for a VERIFIED v2 distributor materialization (M5b-2)', () => {
    const html = renderPanel({
      extractionData: distributorExtractionDataV2(),
      sourceType: 'distributor_record',
    });
    expect(html).toContain('Distributor Record Data (merchandising-depth)');
    // Explicit merchandising fields render as data.
    expect(html).toContain('Chicken recipe kibble for adult dogs.');
    expect(html).toContain('Chicken first');
    expect(html).toContain('Grain free');
    expect(html).toContain('Dog Food');
    expect(html).toContain('18 x 12 x 6 in');
    expect(html).toContain('EA');
    expect(html).toContain('Chicken, brown rice');
    // Per-field merchandising provenance renders.
    expect(html).toContain('Merchandising provenance');
    expect(html).toContain('phillips');
    // Identity fields still render.
    expect(html).toContain('Dog Food Chicken 10 lb');
    expect(html).toContain('DIST-SKU-1');
    // Price / commerce image fields NEVER render even when v2.
    expect(html).not.toContain('>9.99<');
    expect(html).not.toContain('primaryImage');
  });

  it('renders image candidate URLs as DISPLAY-ONLY text, never as <img> or commerce images (M5b-2)', () => {
    const html = renderPanel({
      extractionData: distributorExtractionDataV2(),
      sourceType: 'distributor_record',
    });
    expect(html).toContain('Image candidates');
    expect(html).toContain('DISPLAY ONLY, not approved for catalog use');
    expect(html).toContain('https://cdn.phillips.example/img/dog-food-1.jpg');
    expect(html).toContain('https://cdn.phillips.example/img/dog-food-2.jpg');
    // The URL is rendered as TEXT — no <img> element may fetch it.
    expect(html).not.toContain('<img');
    // The candidate list is not commerce media (no primary/additional image).
    expect(html).not.toContain('primaryImage');
    expect(html).not.toContain('additionalImages');
  });

  it('keeps identity-only rendering for v1 / unverified distributor rows (no extractionMethod)', () => {
    const html = renderPanel({
      extractionData: distributorExtractionData(),
      sourceType: 'distributor_record',
    });
    expect(html).toContain('Distributor Record Data (identity-only)');
    // A v1/unverified payload carrying description copy still never renders.
    const withCopy = ExtractionDataSchema.parse({
      ...distributorExtractionData(),
      description: 'Unverified copy',
      bulletPoints: ['Bullet X'],
      distributorCategory: 'Canine Cuisine',
      distributorImageCandidates: [{ url: 'https://cdn.example/img/x.jpg', sourceAttemptIds: ['att-1'], sourceProviderIds: ['phillips'] }],
    });
    const html2 = renderPanel({ extractionData: withCopy, sourceType: 'distributor_record' });
    expect(html2).not.toContain('Unverified copy');
    expect(html2).not.toContain('Bullet X');
    expect(html2).not.toContain('Canine Cuisine');
    expect(html2).not.toContain('Image candidates');
  });

  it('keeps the official-page source UI unchanged (URL banner + edit control)', () => {
    const html = renderPanel({
      extractionData: officialExtractionData(),
      sourceUrl: 'https://acmepet.example/products/dog-food',
      sourceType: 'official_page',
    });
    expect(html).toContain('🔗 Source URL');
    expect(html).toContain('https://acmepet.example/products/dog-food');
    expect(html).toContain('✏ Edit');
    expect(html).toContain('Raw Scraped Spec Data');
    expect(html).toContain('Official description copy.');
    expect(html).not.toContain('Continue with Official Site Discovery');
  });
});
