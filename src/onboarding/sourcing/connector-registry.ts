import type { DistributorConnector } from './contracts';
import type { SourcingConnectorType } from './contracts';
import { PhillipsConnector, type PhillipsConnectorConfig } from './connectors/phillips';
import { BCIConnector, type BCIConnectorConfig } from './connectors/bci';

/**
 * Connector registry (ADR 0014). Maps a connection's `connectorType` to a
 * connector implementation. Connectors are created per invocation with the
 * connection's NON-secret configuration (base URLs, page caps, timeouts).
 *
 * v1 registers the two Phase 1 REST adapters only; `ftp_catalog`, `csv`, and
 * `legacy_adapter` return null (the engine skips such connections with a
 * stable `connector_not_registered` reason — never a silent fallback).
 */
export interface ConnectorRegistry {
  createConnector(connectorType: SourcingConnectorType, configuration: Record<string, unknown>): DistributorConnector | null;
}

/**
 * Exact distributor-id allowlist for Phase 1 `api` connectors. An unknown
 * distributor id is NEVER silently mapped to a connector (fail closed):
 * the engine skips it as connector_not_registered.
 */
const API_CONNECTOR_BY_DISTRIBUTOR: Readonly<Record<string, 'phillips' | 'bci'>> = {
  phillips: 'phillips',
  endless_aisles: 'phillips',
  bci: 'bci',
  ordercloud: 'bci',
};

export class DefaultConnectorRegistry implements ConnectorRegistry {
  createConnector(connectorType: SourcingConnectorType, configuration: Record<string, unknown>): DistributorConnector | null {
    switch (connectorType) {
      case 'api': {
        const distributorId = typeof configuration.__distributorId === 'string' ? configuration.__distributorId.toLowerCase() : '';
        const kind = API_CONNECTOR_BY_DISTRIBUTOR[distributorId];
        if (!kind) return null;
        if (kind === 'bci') {
          return new BCIConnector(configuration as BCIConnectorConfig);
        }
        return new PhillipsConnector(configuration as PhillipsConnectorConfig);
      }
      case 'ftp_catalog':
      case 'csv':
      case 'legacy_adapter':
        return null;
    }
  }
}

/** Test seam: registry that always returns a fixed connector. */
export class FixedConnectorRegistry implements ConnectorRegistry {
  constructor(private readonly connector: DistributorConnector | null) {}
  createConnector(): DistributorConnector | null {
    return this.connector;
  }
}
