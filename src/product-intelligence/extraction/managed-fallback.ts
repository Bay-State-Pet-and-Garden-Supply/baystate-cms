/**
 * PI-11 layer 7 (issue #29): provider-neutral managed browser / unlocking
 * fallback interface. The extraction contract is never coupled to a vendor:
 * benchmark first, select the smallest justified set, pin versions, enable
 * per workspace/domain, and route calls through the policy gateway. The
 * interface and registry here are the seam — no real providers ship (no
 * credentials), and none is adopted until it has benchmark evidence.
 *
 * Pure module: zod only (vitest-runnable).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/29
 */
import { z } from 'zod';
import { sha256Hex } from '../../shared/stable-id';

const ManagedFallbackProviderConfigSchema = z.object({
  name: z.string().min(1).max(64),
  /** Pinned provider version — upgrades are explicit. */
  pinnedVersion: z.string().min(1).max(32),
  /** Domains this provider may serve (empty = none). */
  allowedDomains: z.array(z.string()).default(() => []),
  /** Optional API base URL override (env-configured tokens only). */
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
  /** Benchmark evidence this provider was selected with. */
  selectedByBenchmark: z.boolean().default(false),
});
export type ManagedFallbackProviderConfig = z.infer<typeof ManagedFallbackProviderConfigSchema>;

const ManagedFallbackConfigSchema = z.object({
  providers: z.array(ManagedFallbackProviderConfigSchema).default(() => []),
});
export type ManagedFallbackConfig = z.infer<typeof ManagedFallbackConfigSchema>;
/** Input shape: schema defaults (enabled/selectedByBenchmark/allowedDomains) apply. */
export type ManagedFallbackConfigInput = z.input<typeof ManagedFallbackConfigSchema>;

/**
 * No provider is adopted until it is benchmarked, versioned, domain-scoped,
 * and routed through the policy gateway (PI-9 benchmark + PI-5 gateway).
 */
const DEFAULT_MANAGED_FALLBACK_CONFIG: ManagedFallbackConfig = { providers: [] };

export interface ManagedPage {
  finalUrl: string;
  html: string;
  contentHash: string;
  statusCode: number | null;
  fetchedAt: string;
}

export interface ManagedFetchRequest {
  url: string;
  signal: AbortSignal;
  timeoutMs: number;
  /**
   * P0-1: policy-gateway-bound fetch for provider HTTP calls. The registry
   * attaches it at dispatch (defaults to the global fetch for non-PI callers
   * and tests); real providers must use it so provider traffic rides the
   * enforced network capability.
   */
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface ManagedBrowserProvider {
  readonly name: string;
  readonly version: string;
  /** The provider may only serve this exact URL (domain allowlist checked by the registry). */
  fetchPage(request: ManagedFetchRequest): Promise<ManagedPage>;
}

/**
 * Registry of registered managed-browser providers plus the per-workspace
 * configuration that decides which provider may serve which domain. The
 * domain allowlist is safety-first: a config entry with an empty
 * allowedDomains list never matches.
 */
export class ManagedFallbackRegistry {
  private registered = new Map<string, ManagedBrowserProvider>();
  private config: ManagedFallbackConfig;
  private readonly fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  constructor(
    config: ManagedFallbackConfigInput = DEFAULT_MANAGED_FALLBACK_CONFIG,
    providers: ManagedBrowserProvider[] = [],
    fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  ) {
    this.config = ManagedFallbackConfigSchema.parse(config);
    for (const provider of providers) this.register(provider);
    this.fetchFn = fetchFn;
  }

  configure(config: ManagedFallbackConfigInput): void {
    this.config = ManagedFallbackConfigSchema.parse(config);
  }

  getConfig(): ManagedFallbackConfig {
    return this.config;
  }

  register(provider: ManagedBrowserProvider): void {
    this.registered.set(provider.name, provider);
  }

  /**
   * Find the enabled provider for a URL's hostname. A config entry only
   * matches when its allowedDomains contains the hostname — an entry with an
   * empty allowedDomains list is NOT enabled (safety-first default).
   */
  providerFor(url: string): ManagedBrowserProvider | null {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return null;
    }
    for (const entry of this.config.providers) {
      if (!entry.enabled) continue;
      if (entry.allowedDomains.length === 0) continue;
      if (!entry.allowedDomains.includes(hostname)) continue;
      const provider = this.registered.get(entry.name);
      // Pinned versions are enforced: a registered provider whose version
      // differs from the config's pinnedVersion is NOT served (review
      // PI-11-m9) — upgrades are explicit config changes.
      if (provider && provider.version === entry.pinnedVersion) return provider;
    }
    return null;
  }

  async fetch(url: string, signal: AbortSignal, timeoutMs: number): Promise<ManagedPage> {
    const provider = this.providerFor(url);
    if (!provider) throw new Error(`No managed fallback provider enabled for ${url}`);
    return provider.fetchPage({ url, signal, timeoutMs, fetchFn: this.fetchFn });
  }
}

/** Deterministic benchmark/test provider (no external calls). */
export class StubManagedProvider implements ManagedBrowserProvider {
  readonly name = 'stub_managed';
  readonly version = '0.1.0';
  private pages: Map<string, string>;

  constructor(pages: Map<string, string>) {
    this.pages = pages;
  }

  async fetchPage(request: ManagedFetchRequest): Promise<ManagedPage> {
    const html = this.pages.get(request.url) ?? '';
    return {
      finalUrl: request.url,
      html,
      contentHash: sha256Hex(html),
      statusCode: this.pages.has(request.url) ? 200 : 404,
      fetchedAt: new Date().toISOString(),
    };
  }
}
