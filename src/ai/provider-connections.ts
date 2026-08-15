/**
 * Provider Connections & Trust Zones for Baystate AI Infrastructure.
 *
 * Implements the ProviderConnection abstraction, AiTrustZone governance,
 * connection-addressed ModelTarget definitions, and inherited workload routing.
 */

import { getApiKey, listApiKeys } from '../db/repositories/api-key-repo';


export type AiTrustZone = 'this_device' | 'trusted_lan' | 'cloud';
export type AiTransport = 'openai-compatible' | 'ollama-native';
export type DataSharingPolicy = 'this_device_only' | 'trusted_lan_allowed' | 'cloud_allowed';

export interface ProviderConnection {
  id: string;
  label: string;
  transport: AiTransport;
  baseUrl: string;
  credential?: string | null;
  trustZone: AiTrustZone;
  /** Exact operator-approved hostname or IP (anti-SSRF / DNS rebinding guard). */
  approvedHost?: string;
  /** Exact operator-approved port (anti-SSRF guard). */
  approvedPort?: number;
  enabled: boolean;
  /** Fast connect timeout to detect offline machines quickly (default 2000ms). */
  connectTimeoutMs?: number;
  /** Total inference timeout (default 60000ms). */
  inferenceTimeoutMs?: number;
}

export interface ModelTarget {
  connectionId: string;
  modelId: string;
}

export type TerminalBehavior = 'heuristic' | 'defer' | 'fail_closed' | 'unavailable';

export interface WorkloadRoute {
  primary: ModelTarget | 'inherit';
  fallback?: ModelTarget | 'inherit' | null;
  textDataSharing?: DataSharingPolicy;
  imageDataSharing?: DataSharingPolicy;
  terminalBehavior: TerminalBehavior;
}

export interface ResolvedWorkloadRoute {
  primary: ModelTarget;
  fallback: ModelTarget | null;
  textDataSharing: DataSharingPolicy;
  imageDataSharing: DataSharingPolicy;
  terminalBehavior: TerminalBehavior;
}

export interface AiRoutingConfig {
  connections: Record<string, ProviderConnection>;
  defaults: {
    textDataSharing: DataSharingPolicy;
    imageDataSharing: DataSharingPolicy;
    catalogTarget: ModelTarget;
    catalogFallback?: ModelTarget | null;
  };
  workloads: {
    discovery: WorkloadRoute;
    curation: WorkloadRoute;
    visionOcr: WorkloadRoute;
    profileBuilder: WorkloadRoute;
    storeManager: WorkloadRoute;
  };
}

// ─── Trust Zone & IP Validation ───────────────────────────────────────────────

export class TrustZoneValidationError extends Error {
  readonly code: string;
  readonly connectionId?: string;

  constructor(message: string, code: string, connectionId?: string) {
    super(message);
    this.name = 'TrustZoneValidationError';
    this.code = code;
    this.connectionId = connectionId;
  }
}

/**
 * Checks if a hostname is a loopback address (this_device).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
  if (h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return h.split('.').every(part => Number(part) <= 255);
  }
  return false;
}

/**
 * Checks if a hostname is an RFC1918 / RFC4193 private LAN address or .local domain.
 */
export function isPrivateLanHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (isLoopbackHost(h)) return false;

  // .local mDNS hostname
  if (h.endsWith('.local')) return true;

  // IPv4 RFC1918 Private Ranges
  // 10.0.0.0/8
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return h.split('.').every(p => Number(p) <= 255);
  }
  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (/^172\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    return parts.every(p => p <= 255) && parts[1] >= 16 && parts[1] <= 31;
  }
  // 192.168.0.0/16
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return h.split('.').every(p => Number(p) <= 255);
  }

  // IPv6 Unique Local Address (fc00::/7 -> fc00:: or fd00::)
  if (/^\[?(?:fc|fd)[0-9a-f]{2}:/i.test(h)) {
    return true;
  }

  return false;
}

/**
 * Validates that a connection's baseUrl matches its declared trustZone and pinned host/port.
 * Enforces fail-closed invariants against SSRF and misconfiguration.
 */
export function validateConnectionTrustZone(conn: ProviderConnection): void {
  if (!conn.baseUrl) {
    throw new TrustZoneValidationError('Base URL is missing', 'base_url_missing', conn.id);
  }

  let parsed: URL;
  try {
    parsed = new URL(conn.baseUrl);
  } catch {
    throw new TrustZoneValidationError(`Invalid Base URL: ${conn.baseUrl}`, 'invalid_url', conn.id);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TrustZoneValidationError(
      `Unsupported protocol "${parsed.protocol}"; only http: and https: are allowed.`,
      'unsupported_protocol',
      conn.id,
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);

  // Validate Host & Port against Operator Pinning (Anti-SSRF)
  if (conn.approvedHost) {
    const approvedHost = conn.approvedHost.trim().toLowerCase();
    if (hostname !== approvedHost) {
      throw new TrustZoneValidationError(
        `Connection host "${hostname}" does not match approved host "${approvedHost}".`,
        'unapproved_host',
        conn.id,
      );
    }
  }

  if (conn.approvedPort !== undefined && conn.approvedPort !== null) {
    if (port !== conn.approvedPort) {
      throw new TrustZoneValidationError(
        `Connection port "${port}" does not match approved port "${conn.approvedPort}".`,
        'unapproved_port',
        conn.id,
      );
    }
  }

  switch (conn.trustZone) {
    case 'this_device': {
      if (!isLoopbackHost(hostname)) {
        throw new TrustZoneValidationError(
          `Connection declared "this_device" but host "${hostname}" is not a loopback address.`,
          'trust_zone_mismatch_this_device',
          conn.id,
        );
      }
      break;
    }
    case 'trusted_lan': {
      if (isLoopbackHost(hostname)) {
        // Loopback is allowed on trusted_lan if operator configured it
        break;
      }
      if (!isPrivateLanHost(hostname)) {
        throw new TrustZoneValidationError(
          `Connection declared "trusted_lan" but host "${hostname}" is not a private LAN IP/mDNS address.`,
          'trust_zone_mismatch_trusted_lan',
          conn.id,
        );
      }
      break;
    }
    case 'cloud': {
      if (isLoopbackHost(hostname)) {
        throw new TrustZoneValidationError(
          `Connection declared "cloud" cannot point to loopback address "${hostname}".`,
          'trust_zone_mismatch_cloud',
          conn.id,
        );
      }
      break;
    }
    default:
      throw new TrustZoneValidationError(
        `Unknown trust zone "${conn.trustZone}".`,
        'unknown_trust_zone',
        conn.id,
      );
  }
}

/**
 * Checks if a given destination trust zone is permitted by the data sharing policy.
 */
export function isTargetPermittedByPolicy(
  targetZone: AiTrustZone,
  policy: DataSharingPolicy,
): boolean {
  if (policy === 'this_device_only') {
    return targetZone === 'this_device';
  }
  if (policy === 'trusted_lan_allowed') {
    return targetZone === 'this_device' || targetZone === 'trusted_lan';
  }
  if (policy === 'cloud_allowed') {
    return true;
  }
  return false;
}

// ─── Default Connections & Fallbacks ──────────────────────────────────────────

export const DEFAULT_BUILTIN_CONNECTIONS: Record<string, ProviderConnection> = {
  'local-ollama': {
    id: 'local-ollama',
    label: 'Ollama (Local Mac)',
    transport: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    credential: null,
    trustZone: 'this_device',
    approvedHost: 'localhost',
    approvedPort: 11434,
    enabled: true,
    connectTimeoutMs: 2000,
    inferenceTimeoutMs: 60000,
  },
  'openai-cloud': {
    id: 'openai-cloud',
    label: 'OpenAI (Cloud)',
    transport: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    credential: null,
    trustZone: 'cloud',
    approvedHost: 'api.openai.com',
    approvedPort: 443,
    enabled: true,
    connectTimeoutMs: 5000,
    inferenceTimeoutMs: 60000,
  },
  'deepseek-cloud': {
    id: 'deepseek-cloud',
    label: 'DeepSeek (Cloud)',
    transport: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    credential: null,
    trustZone: 'cloud',
    approvedHost: 'api.deepseek.com',
    approvedPort: 443,
    enabled: true,
    connectTimeoutMs: 5000,
    inferenceTimeoutMs: 60000,
  },
};

// ─── Legacy Resolver & Adapter ────────────────────────────────────────────────

/**
 * Adapter that reads existing `api_keys` and `llm_task_configs` database state
 * and maps it into standard `ProviderConnection` and `AiRoutingConfig` structures.
 * Provides 100% backward compatibility.
 */
export function buildEffectiveRoutingConfig(): AiRoutingConfig {
  const connections: Record<string, ProviderConnection> = { ...DEFAULT_BUILTIN_CONNECTIONS };

  // Load configured api_keys
  try {
    const keyRows = listApiKeys();
    for (const row of keyRows) {
      const s = row.service.toLowerCase();
      if (s === 'ollama') {
        const rawUrl = row.base_url || 'http://localhost:11434/v1';
        const url = rawUrl.endsWith('/v1') ? rawUrl : `${rawUrl.replace(/\/+$/, '')}/v1`;
        let host = 'localhost';
        let port = 11434;
        try {
          const p = new URL(url);
          host = p.hostname;
          port = p.port ? parseInt(p.port, 10) : 80;
        } catch { /* use default */ }
        const trustZone: AiTrustZone = isLoopbackHost(host) ? 'this_device' : (isPrivateLanHost(host) ? 'trusted_lan' : 'cloud');
        connections['local-ollama'] = {
          id: 'local-ollama',
          label: 'Ollama',
          transport: 'openai-compatible',
          baseUrl: url,
          credential: row.api_key && row.api_key !== 'enabled' ? row.api_key : null,
          trustZone,
          approvedHost: host,
          approvedPort: port,
          enabled: true,
          connectTimeoutMs: 2000,
          inferenceTimeoutMs: 60000,
        };
      } else if (s === 'openai') {
        connections['openai-cloud'] = {
          id: 'openai-cloud',
          label: 'OpenAI (Cloud)',
          transport: 'openai-compatible',
          baseUrl: row.base_url || 'https://api.openai.com/v1',
          credential: row.api_key,
          trustZone: 'cloud',
          approvedHost: 'api.openai.com',
          approvedPort: 443,
          enabled: true,
          connectTimeoutMs: 5000,
          inferenceTimeoutMs: 60000,
        };
      } else if (s === 'deepseek') {
        connections['deepseek-cloud'] = {
          id: 'deepseek-cloud',
          label: 'DeepSeek (Cloud)',
          transport: 'openai-compatible',
          baseUrl: row.base_url || 'https://api.deepseek.com',
          credential: row.api_key,
          trustZone: 'cloud',
          approvedHost: 'api.deepseek.com',
          approvedPort: 443,
          enabled: true,
          connectTimeoutMs: 5000,
          inferenceTimeoutMs: 60000,
        };
      } else if (s === 'desktop_lmstudio' || s === 'lmstudio' || s === 'desktop-lmstudio') {
        const rawUrl = row.base_url || 'http://192.168.1.50:1234/v1';
        let host = '192.168.1.50';
        let port = 1234;
        try {
          const p = new URL(rawUrl);
          host = p.hostname;
          port = p.port ? parseInt(p.port, 10) : 1234;
        } catch { /* use default */ }
        connections['desktop-lmstudio'] = {
          id: 'desktop-lmstudio',
          label: 'Desktop LM Studio',
          transport: 'openai-compatible',
          baseUrl: rawUrl,
          credential: row.api_key && row.api_key !== 'enabled' ? row.api_key : null,
          trustZone: 'trusted_lan',
          approvedHost: host,
          approvedPort: port,
          enabled: true,
          connectTimeoutMs: 2000,
          inferenceTimeoutMs: 60000,
        };
      }
    }
  } catch {
    // Database may be unavailable during isolated unit testing; fall back to defaults
  }

  // Determine default catalog target
  const defaultCatalogTarget: ModelTarget = connections['desktop-lmstudio']
    ? { connectionId: 'desktop-lmstudio', modelId: 'qwen3.8:27b' }
    : (connections['deepseek-cloud']?.credential
      ? { connectionId: 'deepseek-cloud', modelId: 'deepseek-v4-flash' }
      : { connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' });

  const defaultCatalogFallback: ModelTarget | null = connections['openai-cloud']?.credential
    ? { connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' }
    : null;

  return {
    connections,
    defaults: {
      textDataSharing: 'cloud_allowed',
      imageDataSharing: 'trusted_lan_allowed',
      catalogTarget: defaultCatalogTarget,
      catalogFallback: defaultCatalogFallback,
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
        primary: connections['desktop-lmstudio']
          ? { connectionId: 'desktop-lmstudio', modelId: 'gemma-4-26b-a4b-qat' }
          : { connectionId: 'local-ollama', modelId: 'qwen2.5vl:latest' },
        fallback: null,
        imageDataSharing: 'trusted_lan_allowed',
        terminalBehavior: 'heuristic',
      },
      profileBuilder: {
        primary: connections['desktop-lmstudio']
          ? { connectionId: 'desktop-lmstudio', modelId: 'qwen3.8:27b' }
          : (connections['deepseek-cloud']?.credential
            ? { connectionId: 'deepseek-cloud', modelId: 'deepseek-v4-flash' }
            : { connectionId: 'openai-cloud', modelId: 'gpt-4o-mini' }),
        fallback: defaultCatalogFallback,
        terminalBehavior: 'fail_closed',
      },
      storeManager: {
        primary: connections['desktop-lmstudio']
          ? { connectionId: 'desktop-lmstudio', modelId: 'muse-glimmer' }
          : defaultCatalogTarget,
        fallback: defaultCatalogFallback,
        terminalBehavior: 'unavailable',
      },
    },
  };
}

/**
 * Resolves an effective workload route, inheriting from defaults where specified.
 */
export function resolveWorkloadRoute(
  workload: keyof AiRoutingConfig['workloads'],
  config: AiRoutingConfig = buildEffectiveRoutingConfig(),
): ResolvedWorkloadRoute {
  const route = config.workloads[workload];
  const primary = route.primary === 'inherit' ? config.defaults.catalogTarget : route.primary;
  const fallback = route.fallback === 'inherit'
    ? (config.defaults.catalogFallback ?? null)
    : (route.fallback ?? null);

  return {
    primary,
    fallback,
    textDataSharing: route.textDataSharing ?? config.defaults.textDataSharing,
    imageDataSharing: route.imageDataSharing ?? config.defaults.imageDataSharing,
    terminalBehavior: route.terminalBehavior,
  };
}
