import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isLoopbackHost,
  isPrivateLanHost,
  validateConnectionTrustZone,
  isTargetPermittedByPolicy,
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
import { probeConnectionHealth } from '../../ai/connection-health-monitor';

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
        fallback: null,
        imageDataSharing: 'trusted_lan_allowed',
        terminalBehavior: 'heuristic',
      },
      profileBuilder: {
        primary: { connectionId: 'desktop-lm', modelId: 'qwen3.8:27b' },
        fallback: { connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' },
        terminalBehavior: 'fail_closed',
      },
      storeManager: {
        primary: { connectionId: 'desktop-lm', modelId: 'muse-glimmer' },
        fallback: { connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' },
        terminalBehavior: 'unavailable',
      },
    },
  };

  it('successfully executes primary target when online', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      clone: () => ({}),
      json: async () => ({
        choices: [{ message: { content: 'Primary Response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    } as any) as unknown as typeof fetch;

    const result = await dispatchWorkloadChat(
      'discovery',
      [{ role: 'user', content: 'test prompt' }],
      { routingConfig: mockConfig },
    );

    expect(result.content).toBe('Primary Response');
    expect(result.wasFallback).toBe(false);
    expect(result.executedTarget.connectionId).toBe('desktop-lm');
  });

  it('fails over immediately when desktop connection is refused (offline PC)', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('192.168.1.50')) {
        throw new Error('fetch failed: ECONNREFUSED');
      }
      return {
        ok: true,
        status: 200,
        clone: () => ({}),
        json: async () => ({
          choices: [{ message: { content: 'Cloud Fallback Response' } }],
        }),
      } as any;
    }) as unknown as typeof fetch;

    const result = await dispatchWorkloadChat(
      'discovery',
      [{ role: 'user', content: 'test prompt' }],
      { routingConfig: mockConfig },
    );

    expect(result.content).toBe('Cloud Fallback Response');
    expect(result.wasFallback).toBe(true);
    expect(result.executedTarget.connectionId).toBe('openai-cloud');
  });

  it('fails closed and NEVER falls back on Policy Denial', async () => {
    const strictPolicyConfig: AiRoutingConfig = {
      ...mockConfig,
      defaults: {
        ...mockConfig.defaults,
        textDataSharing: 'this_device_only', // Disallows trusted_lan and cloud
      },
    };

    await expect(
      dispatchWorkloadChat(
        'discovery',
        [{ role: 'user', content: 'test prompt' }],
        { routingConfig: strictPolicyConfig },
      ),
    ).rejects.toThrowError(AiPolicyDeniedError);
  });

  it('falls over and warns when model is missing (HTTP 404 misconfiguration)', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('192.168.1.50')) {
        return {
          ok: false,
          status: 404,
          clone: () => ({}),
          text: async () => 'Model qwen3.8:27b not loaded',
        } as any;
      }
      return {
        ok: true,
        status: 200,
        clone: () => ({}),
        json: async () => ({
          choices: [{ message: { content: 'Cloud Fallback Response' } }],
        }),
      } as any;
    }) as unknown as typeof fetch;

    const result = await dispatchWorkloadChat(
      'discovery',
      [{ role: 'user', content: 'test prompt' }],
      { routingConfig: mockConfig },
    );

    expect(result.wasFallback).toBe(true);
    expect(result.warning).toContain('misconfigured');
    expect(result.content).toBe('Cloud Fallback Response');
  });

  it('blocks image dispatch to cloud when image sharing is trusted_lan_allowed', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('192.168.1.50')) {
        throw new Error('ECONNREFUSED');
      }
      return {
        ok: true,
        status: 200,
        clone: () => ({}),
        json: async () => ({ choices: [{ message: { content: 'Cloud Image' } }] }),
      } as any;
    }) as unknown as typeof fetch;

    const visionConfigWithFallback: AiRoutingConfig = {
      ...mockConfig,
      workloads: {
        ...mockConfig.workloads,
        visionOcr: {
          primary: { connectionId: 'desktop-lm', modelId: 'gemma-4-26b-a4b-qat' },
          fallback: { connectionId: 'openai-cloud', modelId: 'gpt-4o' },
          imageDataSharing: 'trusted_lan_allowed', // Cloud is NOT allowed for images
          terminalBehavior: 'heuristic',
        },
      },
    };

    await expect(
      dispatchWorkloadChat(
        'visionOcr',
        [{ role: 'user', content: 'ocr prompt' }],
        { requiresImage: true, routingConfig: visionConfigWithFallback },
      ),
    ).rejects.toThrowError(AiPolicyDeniedError);
  });
});
