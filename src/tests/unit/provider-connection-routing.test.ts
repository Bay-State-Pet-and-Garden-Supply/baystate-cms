import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb } from '../../db/connection';
import {
  isLoopbackHost,
  isPrivateLanHost,
  isLinkLocalOrMetadataHost,
  validateConnectionTrustZone,
  isTargetPermittedByPolicy,
  toClientProviderConnection,
  type ProviderConnection,
  type AiRoutingConfig,
} from '../../ai/provider-connections';
import {
  AiAvailabilityError,
  AiMisconfigurationError,
  AiPolicyDeniedError,
  executeOpenAiChat,
} from '../../ai/network-transport';
import { dispatchWorkloadChat } from '../../ai/inference-dispatcher';
import {
  upsertProviderConnection,
  getProviderConnection,
  listProviderConnections,
  deleteProviderConnection,
  saveAiRoutingDefaults,
  upsertWorkloadRoute,
  getFullAiRoutingConfig,
} from '../../db/repositories/provider-connection-repo';

describe('Provider Connections & Trust Zone Governance', () => {
  describe('IP & Host Classification', () => {
    it('identifies loopback hosts correctly', () => {
      expect(isLoopbackHost('localhost')).toBe(true);
      expect(isLoopbackHost('127.0.0.1')).toBe(true);
      expect(isLoopbackHost('127.0.0.50')).toBe(true);
      expect(isLoopbackHost('::1')).toBe(true);
      expect(isLoopbackHost('sub.localhost')).toBe(true);
      expect(isLoopbackHost('192.168.1.50')).toBe(false);
      expect(isLoopbackHost('api.openai.com')).toBe(false);
    });

    it('identifies private LAN hosts correctly', () => {
      expect(isPrivateLanHost('192.168.1.100')).toBe(true);
      expect(isPrivateLanHost('10.0.0.5')).toBe(true);
      expect(isPrivateLanHost('172.16.0.1')).toBe(true);
      expect(isPrivateLanHost('172.31.255.255')).toBe(true);
      expect(isPrivateLanHost('desktop.local')).toBe(true);
      expect(isPrivateLanHost('172.32.0.1')).toBe(false);
      expect(isPrivateLanHost('8.8.8.8')).toBe(false);
      expect(isPrivateLanHost('localhost')).toBe(false);
    });

    it('identifies link-local and metadata addresses', () => {
      expect(isLinkLocalOrMetadataHost('169.254.169.254')).toBe(true);
      expect(isLinkLocalOrMetadataHost('169.254.1.1')).toBe(true);
      expect(isLinkLocalOrMetadataHost('100.64.0.1')).toBe(true);
      expect(isLinkLocalOrMetadataHost('0.0.0.0')).toBe(true);
      expect(isLinkLocalOrMetadataHost('192.168.1.50')).toBe(false);
      expect(isLinkLocalOrMetadataHost('api.openai.com')).toBe(false);
    });

    it('enforces trust zone validation for this_device', () => {
      const conn: ProviderConnection = {
        id: 'test-local',
        label: 'Local',
        transport: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        trustZone: 'this_device',
        enabled: true,
      };
      expect(() => validateConnectionTrustZone(conn)).not.toThrow();

      const invalidConn: ProviderConnection = {
        ...conn,
        baseUrl: 'http://192.168.1.50:1234/v1',
      };
      expect(() => validateConnectionTrustZone(invalidConn)).toThrowError(/not a loopback address/);
    });

    it('enforces trust zone validation for trusted_lan', () => {
      const conn: ProviderConnection = {
        id: 'test-lan',
        label: 'LAN Desktop',
        transport: 'openai-compatible',
        baseUrl: 'http://192.168.1.50:1234/v1',
        trustZone: 'trusted_lan',
        enabled: true,
      };
      expect(() => validateConnectionTrustZone(conn)).not.toThrow();

      const invalidConn: ProviderConnection = {
        ...conn,
        baseUrl: 'https://api.openai.com/v1',
      };
      expect(() => validateConnectionTrustZone(invalidConn)).toThrowError(/not a private LAN/);
    });

    it('enforces strict cloud validation (HTTPS required, blocks internal/metadata IPs)', () => {
      const validCloud: ProviderConnection = {
        id: 'valid-cloud',
        label: 'Valid Cloud',
        transport: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        trustZone: 'cloud',
        enabled: true,
      };
      expect(() => validateConnectionTrustZone(validCloud)).not.toThrow();

      // Insecure HTTP to cloud rejected
      const httpCloud: ProviderConnection = {
        ...validCloud,
        baseUrl: 'http://api.openai.com/v1',
      };
      expect(() => validateConnectionTrustZone(httpCloud)).toThrowError(/must use https:/);

      // Cloud pointing to LAN rejected
      const lanCloud: ProviderConnection = {
        ...validCloud,
        baseUrl: 'https://192.168.1.50/v1',
      };
      expect(() => validateConnectionTrustZone(lanCloud)).toThrowError(/cannot point to local\/private\/metadata/);

      // Cloud pointing to AWS metadata IP rejected
      const metadataCloud: ProviderConnection = {
        ...validCloud,
        baseUrl: 'https://169.254.169.254/latest/meta-data',
      };
      expect(() => validateConnectionTrustZone(metadataCloud)).toThrowError(/cannot point to local\/private\/metadata/);
    });

    it('enforces operator host and port pinning (Anti-SSRF)', () => {
      const conn: ProviderConnection = {
        id: 'test-pinned',
        label: 'Pinned Desktop',
        transport: 'openai-compatible',
        baseUrl: 'http://192.168.1.50:1234/v1',
        trustZone: 'trusted_lan',
        approvedHost: '192.168.1.50',
        approvedPort: 1234,
        enabled: true,
      };
      expect(() => validateConnectionTrustZone(conn)).not.toThrow();

      const mismatchedHost: ProviderConnection = {
        ...conn,
        baseUrl: 'http://192.168.1.99:1234/v1',
      };
      expect(() => validateConnectionTrustZone(mismatchedHost)).toThrowError(/does not match approved host/);

      const mismatchedPort: ProviderConnection = {
        ...conn,
        baseUrl: 'http://192.168.1.50:5678/v1',
      };
      expect(() => validateConnectionTrustZone(mismatchedPort)).toThrowError(/does not match approved port/);
    });
  });

  describe('Data Sharing Policy Permissions', () => {
    it('enforces this_device_only', () => {
      expect(isTargetPermittedByPolicy('this_device', 'this_device_only')).toBe(true);
      expect(isTargetPermittedByPolicy('trusted_lan', 'this_device_only')).toBe(false);
      expect(isTargetPermittedByPolicy('cloud', 'this_device_only')).toBe(false);
    });

    it('enforces trusted_lan_allowed', () => {
      expect(isTargetPermittedByPolicy('this_device', 'trusted_lan_allowed')).toBe(true);
      expect(isTargetPermittedByPolicy('trusted_lan', 'trusted_lan_allowed')).toBe(true);
      expect(isTargetPermittedByPolicy('cloud', 'trusted_lan_allowed')).toBe(false);
    });

    it('enforces cloud_allowed', () => {
      expect(isTargetPermittedByPolicy('this_device', 'cloud_allowed')).toBe(true);
      expect(isTargetPermittedByPolicy('trusted_lan', 'cloud_allowed')).toBe(true);
      expect(isTargetPermittedByPolicy('cloud', 'cloud_allowed')).toBe(true);
    });
  });
});

describe('Inference Dispatcher & Availability Failover', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const mockConfig: AiRoutingConfig = {
    connections: {
      'desktop-lm': {
        id: 'desktop-lm',
        label: 'Desktop LM Studio',
        transport: 'openai-compatible',
        baseUrl: 'http://192.168.1.50:1234/v1',
        trustZone: 'trusted_lan',
        approvedHost: '192.168.1.50',
        approvedPort: 1234,
        enabled: true,
        connectTimeoutMs: 100,
        inferenceTimeoutMs: 500,
      },
      'openai-cloud': {
        id: 'openai-cloud',
        label: 'OpenAI Cloud',
        transport: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        credential: 'sk-mock-key',
        trustZone: 'cloud',
        approvedHost: 'api.openai.com',
        approvedPort: 443,
        enabled: true,
        connectTimeoutMs: 100,
        inferenceTimeoutMs: 500,
      },
    },
    defaults: {
      textDataSharing: 'cloud_allowed',
      imageDataSharing: 'trusted_lan_allowed',
      catalogTarget: { connectionId: 'desktop-lm', modelId: 'qwen3.8:27b' },
      catalogFallback: { connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' },
    },
    workloads: {
      discovery: {
        primary: 'inherit',
        fallback: 'inherit',
        terminalBehavior: 'heuristic',
      },
      curation: {
        primary: 'inherit',
        fallback: 'inherit',
        terminalBehavior: 'defer',
      },
      visionOcr: {
        primary: { connectionId: 'desktop-lm', modelId: 'gemma-4-26b-a4b-qat' },
        fallback: { connectionId: 'openai-cloud', modelId: 'gpt-4o' },
        imageDataSharing: 'trusted_lan_allowed',
        terminalBehavior: 'heuristic',
      },
      profileBuilder: {
        primary: 'inherit',
        fallback: 'inherit',
        terminalBehavior: 'fail_closed',
      },
      storeManager: {
        primary: { connectionId: 'desktop-lm', modelId: 'muse-glimmer' },
        fallback: 'inherit',
        terminalBehavior: 'unavailable',
      },
    },
  };

  it('rejects HTTP 3xx redirects to prevent SSRF and trust zone bypass', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 307,
      statusText: 'Temporary Redirect',
    } as any);

    const conn = mockConfig.connections['desktop-lm'];
    await expect(
      executeOpenAiChat(conn, 'qwen3.8:27b', [{ role: 'user', content: 'test prompt' }]),
    ).rejects.toThrowError(/AI endpoints forbid redirects/);
  });

  it('successfully executes primary target when online', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Consolidated Title Output' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    } as any);

    const result = await dispatchWorkloadChat(
      'curation',
      [{ role: 'user', content: 'test prompt' }],
      { routingConfig: mockConfig },
    );

    expect(result.content).toBe('Consolidated Title Output');
    expect(result.executedTarget).toEqual({ connectionId: 'desktop-lm', modelId: 'qwen3.8:27b' });
    expect(result.wasFallback).toBe(false);
  });

  it('fails over immediately when desktop connection is refused (offline PC)', async () => {
    let callCount = 0;
    (globalThis as any).fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes('192.168.1.50')) {
        const err = new Error('fetch failed: Connection refused');
        (err as any).cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      // Cloud Fallback Succeeds
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Fallback Cloud Result' } }],
        }),
      };
    });

    const result = await dispatchWorkloadChat(
      'discovery',
      [{ role: 'user', content: 'find brand' }],
      { routingConfig: mockConfig },
    );

    expect(callCount).toBe(2);
    expect(result.content).toBe('Fallback Cloud Result');
    expect(result.executedTarget).toEqual({ connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' });
    expect(result.wasFallback).toBe(true);
  });

  it('fails closed and NEVER falls back on Policy Denial', async () => {
    const policyRestrictedConfig: AiRoutingConfig = {
      ...mockConfig,
      defaults: {
        ...mockConfig.defaults,
        textDataSharing: 'this_device_only', // Disallows LAN and Cloud!
      },
    };

    await expect(
      dispatchWorkloadChat(
        'curation',
        [{ role: 'user', content: 'test' }],
        { routingConfig: policyRestrictedConfig },
      ),
    ).rejects.toThrowError(AiPolicyDeniedError);
  });

  it('falls over and warns when model is missing (HTTP 404 misconfiguration)', async () => {
    let callCount = 0;
    (globalThis as any).fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes('192.168.1.50')) {
        return {
          ok: false,
          status: 404,
          text: async () => 'Model qwen3.8:27b not loaded',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Fallback from cloud' } }],
        }),
      };
    });

    const result = await dispatchWorkloadChat(
      'curation',
      [{ role: 'user', content: 'test' }],
      { routingConfig: mockConfig },
    );

    expect(result.wasFallback).toBe(true);
    expect(result.warning?.toLowerCase()).toContain('misconfigured');
    expect(result.executedTarget).toEqual({ connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' });
  });

  it('blocks image dispatch to cloud when image sharing is trusted_lan_allowed', async () => {
    // Desktop offline -> Fallback is openai-cloud
    // But visionOcr requires image, and image policy is trusted_lan_allowed -> Cloud fallback denied!
    (globalThis as any).fetch = vi.fn().mockImplementation(async () => {
      throw new Error('Connection refused');
    });

    await expect(
      dispatchWorkloadChat(
        'visionOcr',
        [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,123' } }] }],
        { requiresImage: true, routingConfig: mockConfig },
      ),
    ).rejects.toThrowError(AiPolicyDeniedError);
  });
});

describe('Database Repository Integration & Redaction', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('persists connections, redacts credentials for client, and preserves secrets on edit', () => {
    const testConn: ProviderConnection = {
      id: 'test-secure-conn',
      label: 'Secure Cloud Provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      credential: 'sk-secret-key-12345',
      trustZone: 'cloud',
      approvedHost: 'api.openai.com',
      approvedPort: 443,
      enabled: true,
    };

    upsertProviderConnection(testConn);

    // Database row contains raw secret
    const saved = getProviderConnection('test-secure-conn');
    expect(saved?.credential).toBe('sk-secret-key-12345');

    // Client view is redacted
    const clientView = toClientProviderConnection(saved!);
    expect((clientView as any).credential).toBeUndefined();
    expect(clientView.hasCredential).toBe(true);

    // Re-saving with masked credential '[REDACTED]' preserves the stored secret!
    upsertProviderConnection({
      ...testConn,
      label: 'Updated Label',
      credential: '[REDACTED]',
    });

    const reloaded = getProviderConnection('test-secure-conn');
    expect(reloaded?.label).toBe('Updated Label');
    expect(reloaded?.credential).toBe('sk-secret-key-12345');
  });

  it('persists defaults and workload routes with safe deletion repair', () => {
    saveAiRoutingDefaults({
      catalogTarget: { connectionId: 'desktop-lmstudio', modelId: 'qwen3.8:27b' },
      catalogFallback: { connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' },
      textDataSharing: 'cloud_allowed',
      imageDataSharing: 'trusted_lan_allowed',
    });

    upsertWorkloadRoute('storeManager', {
      primary: { connectionId: 'desktop-lmstudio', modelId: 'muse-glimmer' },
      fallback: 'inherit',
      terminalBehavior: 'unavailable',
    });

    const full = getFullAiRoutingConfig();
    expect(full.defaults.catalogTarget.modelId).toBe('qwen3.8:27b');
    expect(full.workloads.storeManager.primary).toEqual({
      connectionId: 'desktop-lmstudio',
      modelId: 'muse-glimmer',
    });

    // Delete connection and verify routes are safely repaired rather than crashing
    deleteProviderConnection('desktop-lmstudio');
    const repaired = getFullAiRoutingConfig();
    expect(repaired.connections['desktop-lmstudio']).toBeUndefined();
    expect(repaired.workloads.storeManager.primary).toBe('inherit');
  });
});
