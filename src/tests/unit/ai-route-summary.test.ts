import { describe, expect, it } from 'vitest';
import { deriveAiRouteSummaryRows } from '../../client/components/common/AiRouteSummary';
import type { AiRoutingConfig, ProviderConnection } from '../../ai/provider-connections';

const connection = (id: string, label: string): ProviderConnection => ({
  id,
  label,
  transport: 'openai-compatible',
  baseUrl: `http://${id}.example.test/v1`,
  trustZone: 'trusted_lan',
  enabled: true,
});

const target = (connectionId: string, modelId: string) => ({ connectionId, modelId });

function config(): AiRoutingConfig {
  return {
    connections: {
      catalog: connection('catalog', 'Catalog Cloud'),
      local: connection('local', 'Local Ollama'),
      vision: connection('vision', 'Vision LAN'),
    },
    defaults: {
      catalogTarget: target('catalog', 'catalog-model'),
      catalogFallback: target('local', 'fallback-model'),
      textDataSharing: 'trusted_lan_allowed',
      imageDataSharing: 'trusted_lan_allowed',
    },
    workloads: {
      discovery: { primary: 'inherit', fallback: 'inherit', terminalBehavior: 'defer' },
      curation: { primary: target('catalog', 'catalog-model'), fallback: null, terminalBehavior: 'heuristic' },
      visionOcr: { primary: target('vision', 'vision-model'), fallback: 'inherit', terminalBehavior: 'fail_closed' },
      profileBuilder: { primary: target('local', 'profile-model'), fallback: null, terminalBehavior: 'fail_closed' },
      storeManager: { primary: 'inherit', fallback: 'inherit', terminalBehavior: 'fail_closed' },
    },
  };
}

describe('AiRouteSummary route derivation', () => {
  it('keeps workloads distinct even when their effective primaries match', () => {
    const rows = deriveAiRouteSummaryRows(config());
    expect(rows.map(row => row.label)).toEqual([
      'Catalog default', 'Discovery', 'Curation', 'Profile Builder', 'Vision / OCR',
    ]);
    expect(rows.find(row => row.label === 'Discovery')?.inheritsPrimary).toBe(true);
    expect(rows.find(row => row.label === 'Curation')?.inheritsPrimary).toBe(false);
    expect(rows.find(row => row.label === 'Discovery')?.route.fallback?.modelId).toBe('fallback-model');
    expect(rows.find(row => row.label === 'Vision / OCR')?.route.fallback?.connectionId).toBe('local');
  });

  it('rejects incomplete configurations instead of allowing a render-time crash', () => {
    expect(() => deriveAiRouteSummaryRows({} as AiRoutingConfig)).toThrow(/incomplete/);
  });

  it('rejects malformed route targets before they can escape the fail-soft boundary', () => {
    const malformed = config();
    malformed.workloads.discovery.primary = null as unknown as 'inherit';
    expect(() => deriveAiRouteSummaryRows(malformed)).toThrow(/incomplete/);
  });
});
