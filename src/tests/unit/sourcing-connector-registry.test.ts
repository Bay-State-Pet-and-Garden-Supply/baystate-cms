import { describe, test, expect } from 'vitest';
import {
  DefaultConnectorRegistry,
  FixedConnectorRegistry,
} from '../../onboarding/sourcing/connector-registry';
import { PhillipsConnector } from '../../onboarding/sourcing/connectors/phillips';
import { BCIConnector } from '../../onboarding/sourcing/connectors/bci';
import { BradleyConnector } from '../../onboarding/sourcing/connectors/bradley';
import { CentralPetConnector } from '../../onboarding/sourcing/connectors/central-pet';
import { OrgillConnector } from '../../onboarding/sourcing/connectors/orgill';
import { PetFoodExpertsConnector } from '../../onboarding/sourcing/connectors/pet-food-experts';
import { PhillipsStorefrontConnector } from '../../onboarding/sourcing/connectors/phillips-storefront';

/**
 * Exact (connectorType, distributorId) pair dispatch for the sourcing
 * connector registry (ADR 0014 + Amendment B). Unknown pairs, unregistered
 * types, and `legacy_adapter` NEVER fall back — they return null and the
 * engine records a durable `connector_not_registered` outcome.
 */
describe('DefaultConnectorRegistry — exact pair dispatch (ADR 0014 + Amendment B)', () => {
  const registry = new DefaultConnectorRegistry();

  test('api + phillips resolves to the Phillips REST connector', () => {
    const connector = registry.createConnector('api', 'phillips', {});
    expect(connector).toBeInstanceOf(PhillipsConnector);
  });

  test('api + endless_aisles alias resolves to Phillips (declared compatibility alias only)', () => {
    const connector = registry.createConnector('api', 'endless_aisles', {});
    expect(connector).toBeInstanceOf(PhillipsConnector);
  });

  test('api + bci resolves to the BCI OrderCloud REST connector', () => {
    const connector = registry.createConnector('api', 'bci', {});
    expect(connector).toBeInstanceOf(BCIConnector);
  });

  test('api + ordercloud alias resolves to BCI (declared compatibility alias only)', () => {
    const connector = registry.createConnector('api', 'ordercloud', {});
    expect(connector).toBeInstanceOf(BCIConnector);
  });

  test('distributor id matching is case/whitespace-insensitive', () => {
    expect(registry.createConnector('api', '  PHILLIPS ', {})).toBeInstanceOf(PhillipsConnector);
    expect(registry.createConnector('api', 'Bci', {})).toBeInstanceOf(BCIConnector);
  });

  test('unknown api distributor id fails closed (null, never a silent fallback)', () => {
    expect(registry.createConnector('api', 'unfi', {})).toBeNull();
    expect(registry.createConnector('api', 'orgill', {})).toBeNull();
    expect(registry.createConnector('api', '', {})).toBeNull();
  });

  test('no api/scraper collision: an api pair never produces an html_scraper connector and vice versa', () => {
    // All five Distributor Scraper pairs are registered (M3 tier-1 public,
    // M4a/M4b tier-2 authenticated).
    expect(registry.createConnector('html_scraper', 'bradley', {})).toBeInstanceOf(BradleyConnector);
    expect(registry.createConnector('html_scraper', 'central_pet', {})).toBeInstanceOf(CentralPetConnector);
    expect(registry.createConnector('html_scraper', 'orgill', {})).toBeInstanceOf(OrgillConnector);
    expect(registry.createConnector('html_scraper', 'pet_food_experts', {})).toBeInstanceOf(PetFoodExpertsConnector);
    expect(registry.createConnector('html_scraper', 'phillips_storefront', {})).toBeInstanceOf(PhillipsStorefrontConnector);
    // Unknown scraper ids fail closed (never a silent fallback).
    expect(registry.createConnector('html_scraper', 'phillips', {})).toBeNull();
    // phillips exists as an api REST connector; the scraper flavor must not
    // leak through the api path either.
    expect(registry.createConnector('api', 'phillips', {})).toBeInstanceOf(PhillipsConnector);
  });

  test('ftp_catalog, csv, and legacy_adapter never register a connector', () => {
    for (const type of ['ftp_catalog', 'csv', 'legacy_adapter'] as const) {
      expect(registry.createConnector(type, 'phillips', {})).toBeNull();
      expect(registry.createConnector(type, 'bradley', {})).toBeNull();
    }
  });

  test('configuration is passed through unchanged; no hidden distributor key is injected', () => {
    const config = { pageSize: 25, baseUrl: 'https://fixture.example/v1' };
    const connector = registry.createConnector('api', 'phillips', config);
    expect(connector).toBeInstanceOf(PhillipsConnector);
    // The registry must not mutate the caller's object (engine no longer
    // injects __distributorId into the configuration it passes).
    expect(config).toEqual({ pageSize: 25, baseUrl: 'https://fixture.example/v1' });
    expect(Object.keys(config)).not.toContain('__distributorId');
  });
});

describe('FixedConnectorRegistry — deterministic test seam', () => {
  test('returns the fixed connector regardless of pair arguments', () => {
    const fixed = new PhillipsConnector();
    const registry = new FixedConnectorRegistry(fixed);
    expect(registry.createConnector('api', 'anything', {})).toBe(fixed);
    expect(registry.createConnector('html_scraper', 'anything', {})).toBe(fixed);
  });

  test('returns null when configured with null (simulates zero enabled connectors)', () => {
    const registry = new FixedConnectorRegistry(null);
    expect(registry.createConnector('api', 'phillips', {})).toBeNull();
  });
});
