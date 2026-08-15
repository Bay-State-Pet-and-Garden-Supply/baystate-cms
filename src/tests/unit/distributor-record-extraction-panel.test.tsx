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
