/**
 * Product Intelligence policy gateway (PI-5).
 *
 * Every external call (model, network) and every budget decision passes
 * through this gateway, which records allow/deny, policy version, target,
 * data classification, fallback status, and reason code. A denied call
 * returns a structured policy outcome and never silently switches providers
 * or destinations.
 *
 * Network controls enforced here:
 * - dataSharingPolicy 'local_only' denies every remote model call;
 * - networkPolicy 'local_only' denies every outbound fetch;
 * - domain allowlists (policy.allowedSourceDomains) restrict destinations;
 * - private-network and link-local destinations are always denied (SSRF);
 * - protocol (http/https) and port (80/443) validation;
 * - redirect revalidation — every hop is re-checked and denied hops block;
 * - response-size (policy.maxResponseBytes) and content-type limits.
 *
 * The container/micro-VM isolation from the issue maps, in this local
 * deployment, to: workers never receive database credentials or workspace
 * write access (no built-in file tools by default), approved-extension-only
 * sessions, and the deterministic enforcement below.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/22
 */
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import type { ProductIntelligencePolicy } from '../contracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyReasonCode =
  | 'local_only_denies_model'
  | 'local_only_denies_network'
  | 'cloud_models_only_denies_network'
  | 'destination_not_allowlisted'
  | 'private_network_destination'
  | 'link_local_destination'
  | 'invalid_protocol'
  | 'invalid_port'
  | 'redirect_to_denied'
  | 'response_too_large'
  | 'content_type_denied'
  | 'model_not_in_route'
  | 'budget_exceeded'
  | 'tool_not_allowed'
  | 'unknown';

export type DataClassification = 'public' | 'product_input' | 'fetched_content' | 'local_evidence';

export interface PolicyCheckContext {
  runId: string;
  policy: ProductIntelligencePolicy;
  stepId?: string | null;
}

export interface PolicyDecision {
  allowed: boolean;
  reasonCode: PolicyReasonCode;
  policyVersion: string;
  detail?: string;
}

export class PolicyDeniedError extends Error {
  constructor(readonly decision: PolicyDecision) {
    super(`Policy denied: ${decision.reasonCode}${decision.detail ? ` (${decision.detail})` : ''}`);
    this.name = 'PolicyDeniedError';
  }
}

// ---------------------------------------------------------------------------
// IP classification (SSRF floor)
// ---------------------------------------------------------------------------

const PRIVATE_IPV4 = [
  { ip: '10.0.0.0', bits: 8 },
  { ip: '172.16.0.0', bits: 12 },
  { ip: '192.168.0.0', bits: 16 },
  { ip: '127.0.0.0', bits: 8 },
  { ip: '169.254.0.0', bits: 16 }, // link-local
  { ip: '0.0.0.0', bits: 8 },
  { ip: '100.64.0.0', bits: 10 }, // CGNAT
] as const;

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv4InRange(ip: string, range: { ip: string; bits: number }): boolean {
  const value = ipv4ToNumber(ip);
  const base = ipv4ToNumber(range.ip);
  if (value === null || base === null) return false;
  const mask = range.bits === 0 ? 0 : (~0 << (32 - range.bits)) >>> 0;
  return (value & mask) === (base & mask);
}

/** Classify a numeric IPv4/IPv6 address as private/link-local or public. */
export function classifyIp(address: string): 'private' | 'link_local' | 'public' | 'unknown' {
  if (address.includes(':')) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::' || lower.startsWith('0:0:0:0:0:0:0:1')) return 'link_local';
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return 'private';
    if (lower.startsWith('::ffff:')) return classifyIp(lower.slice(7));
    return 'public';
  }
  for (const range of PRIVATE_IPV4) {
    if (ipv4InRange(address, range)) {
      return range.ip.startsWith('169.254') || range.ip === '0.0.0.0' ? 'link_local' : 'private';
    }
  }
  return ipv4ToNumber(address) !== null ? 'public' : 'unknown';
}

export function isPrivateOrLinkLocal(address: string): boolean {
  const kind = classifyIp(address);
  return kind === 'private' || kind === 'link_local';
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export interface PolicyGatewayOptions {
  /** DNS resolver injection for tests. */
  resolveHostname?: (hostname: string) => Promise<string[]>;
  /** Fetch injection for tests (redirect/size/type scenarios). */
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Clock injection for tests. */
  now?: () => Date;
}

export class PolicyGateway {
  private readonly sequences = new Map<string, number>();
  private readonly resolveHostname: (hostname: string) => Promise<string[]>;
  private readonly fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly now: () => Date;

  constructor(options: PolicyGatewayOptions = {}) {
    this.resolveHostname = options.resolveHostname ?? (async (hostname) => {
      const records = await lookup(hostname, { all: true });
      return records.map((r) => r.address);
    });
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
  }

  /** Per-run decision sequence (idempotent audit rows). */
  private nextSequence(runId: string): number {
    const next = (this.sequences.get(runId) ?? 0) + 1;
    this.sequences.set(runId, next);
    return next;
  }

  record(ctx: PolicyCheckContext, decision: PolicyDecision, targetType: 'model' | 'network' | 'budget' | 'tool', target: string, dataClassification?: DataClassification, fallbackStatus: 'none' | 'fallback_denied' | 'fallback_used' = 'none'): void {
    // The DB import is lazy so the gateway stays importable in environments
    // without bun:sqlite (vitest); audit failures never break the run.
    void (async () => {
      const { getDb } = await import('../../db/connection');
      try {
      getDb().run(
        `INSERT OR IGNORE INTO product_intelligence_policy_decisions
         (id, run_id, sequence, decision, policy_version, target_type, target,
          data_classification, fallback_status, reason_code, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          ctx.runId,
          this.nextSequence(ctx.runId),
          decision.allowed ? 'allow' : 'deny',
          decision.policyVersion,
          targetType,
          target.slice(0, 512),
          dataClassification ?? null,
          fallbackStatus,
          decision.reasonCode,
          decision.detail ? JSON.stringify({ detail: decision.detail }) : null,
          this.now().toISOString(),
        ],
      );
      } catch {
        // Auditing must never break the run.
      }
    })();
  }

  // -------------------------------------------------------------------------
  // Model calls
  // -------------------------------------------------------------------------

  checkModelCall(
    ctx: PolicyCheckContext,
    call: { provider: string; model: string; dataClassification: DataClassification },
  ): PolicyDecision {
    const { policy } = ctx;
    const decision: PolicyDecision = { allowed: true, reasonCode: 'unknown', policyVersion: policy.configId };

    if (policy.dataSharingPolicy === 'local_only') {
      decision.allowed = false;
      decision.reasonCode = 'local_only_denies_model';
      decision.detail = `${call.provider}/${call.model} denied under local_only data-sharing policy`;
    } else if (!policy.modelRoute || policy.modelRoute.provider !== call.provider || policy.modelRoute.model !== call.model) {
      decision.allowed = false;
      decision.reasonCode = 'model_not_in_route';
      decision.detail = `${call.provider}/${call.model} is not the policy model route; fallbacks are never selected silently`;
    }

    this.record(ctx, decision, 'model', `${call.provider}/${call.model}`, call.dataClassification, decision.allowed ? 'none' : 'fallback_denied');
    return decision;
  }

  // -------------------------------------------------------------------------
  // Network calls
  // -------------------------------------------------------------------------

  /**
   * Validate a destination URL against the policy. `followRedirects` is used
   * for redirect revalidation (each hop is checked independently).
   */
  async checkNetworkRequest(ctx: PolicyCheckContext, url: string, dataClassification: DataClassification = 'fetched_content', followRedirects = false): Promise<PolicyDecision> {
    const { policy } = ctx;
    const decision: PolicyDecision = { allowed: true, reasonCode: 'unknown', policyVersion: policy.configId };

    if (policy.networkPolicy === 'local_only') {
      decision.allowed = false;
      decision.reasonCode = 'local_only_denies_network';
      decision.detail = 'outbound fetches denied under local_only network policy';
      this.record(ctx, decision, 'network', url, dataClassification);
      return decision;
    }
    if (policy.dataSharingPolicy === 'cloud_models_only' && !followRedirects) {
      // cloud_models_only permits model calls only; page fetches are denied.
      decision.allowed = false;
      decision.reasonCode = 'cloud_models_only_denies_network';
      decision.detail = 'network fetches denied under cloud_models_only data-sharing policy';
      this.record(ctx, decision, 'network', url, dataClassification);
      return decision;
    }

    const destination = await this.validateDestination(url, policy, dataClassification);
    if (!destination.allowed) {
      decision.allowed = false;
      decision.reasonCode = destination.reasonCode;
      decision.detail = destination.detail;
      this.record(ctx, decision, 'network', url, dataClassification);
      return decision;
    }

    this.record(ctx, decision, 'network', url, dataClassification);
    return decision;
  }

  private async validateDestination(
    url: string,
    policy: ProductIntelligencePolicy,
    _dataClassification: DataClassification,
  ): Promise<{ allowed: boolean; reasonCode: PolicyReasonCode; detail: string }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reasonCode: 'invalid_protocol', detail: `unparseable URL: ${url.slice(0, 120)}` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reasonCode: 'invalid_protocol', detail: `protocol ${parsed.protocol} not allowed` };
    }
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (port !== 80 && port !== 443) {
      return { allowed: false, reasonCode: 'invalid_port', detail: `port ${port} not allowed` };
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost') {
      return { allowed: false, reasonCode: 'private_network_destination', detail: 'localhost is a private destination' };
    }

    // Domain allowlist (suffix match on hostname).
    if (policy.allowedSourceDomains.length > 0) {
      const allowlisted = policy.allowedSourceDomains.some((domain) => {
        const normalized = domain.toLowerCase().replace(/^www\./, '');
        return hostname === normalized || hostname.endsWith(`.${normalized}`);
      });
      if (!allowlisted) {
        return { allowed: false, reasonCode: 'destination_not_allowlisted', detail: `${hostname} is not in the policy allowlist` };
      }
    }

    // DNS resolution + SSRF floor.
    try {
      const addresses = await this.resolveHostname(hostname);
      if (addresses.length === 0) {
        return { allowed: false, reasonCode: 'unknown', detail: `no DNS records for ${hostname}` };
      }
      const denied = addresses.find((address) => isPrivateOrLinkLocal(address));
      if (denied) {
        return {
          allowed: false,
          reasonCode: 'private_network_destination',
          detail: `${hostname} resolves to ${denied} (private/link-local)`,
        };
      }
    } catch {
      return { allowed: false, reasonCode: 'unknown', detail: `DNS resolution failed for ${hostname}` };
    }
    return { allowed: true, reasonCode: 'unknown', detail: '' };
  }

  /**
   * Policy-enforcing fetch: validates the destination, follows redirects
   * manually re-validating every hop, and enforces response-size and
   * content-type limits. Denied hops throw PolicyDeniedError.
   */
  async gatewayFetch(
    ctx: PolicyCheckContext,
    url: string,
    init: RequestInit = {},
    options: { dataClassification?: DataClassification; allowedContentTypes?: string[]; maxRedirects?: number; maxResponseBytes?: number } = {},
  ): Promise<Response> {
    const dataClassification = options.dataClassification ?? 'fetched_content';
    const maxRedirects = options.maxRedirects ?? 5;
    let currentUrl = url;
    let redirects = 0;

    for (;;) {
      const decision = await this.checkNetworkRequest(ctx, currentUrl, dataClassification, redirects > 0);
      if (!decision.allowed) throw new PolicyDeniedError(decision);

      const response = await this.fetchFn(currentUrl, {
        ...init,
        redirect: 'manual',
        signal: init.signal,
      });

      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        redirects += 1;
        if (redirects > maxRedirects) {
          throw new PolicyDeniedError({ allowed: false, reasonCode: 'redirect_to_denied', policyVersion: ctx.policy.configId, detail: `too many redirects (${maxRedirects})` });
        }
        currentUrl = new URL(response.headers.get('location')!, currentUrl).toString();
        continue;
      }

      if (options.allowedContentTypes && options.allowedContentTypes.length > 0) {
        const contentType = response.headers.get('content-type') ?? '';
        if (!options.allowedContentTypes.some((allowed) => contentType.startsWith(allowed))) {
          throw new PolicyDeniedError({ allowed: false, reasonCode: 'content_type_denied', policyVersion: ctx.policy.configId, detail: `${contentType || 'none'} not in allowed types` });
        }
      }

      if (options.maxResponseBytes !== undefined && options.maxResponseBytes !== null) {
        // Enforce the size limit at the body level by wrapping the stream.
        const limit = options.maxResponseBytes;
        const reader = response.body?.getReader();
        if (reader) {
          let received = 0;
          const limited = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { value, done } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              received += value.byteLength;
              if (received > limit) {
                controller.error(new PolicyDeniedError({ allowed: false, reasonCode: 'response_too_large', policyVersion: ctx.policy.configId, detail: `${received} bytes exceeds ${limit}` }));
                return;
              }
              controller.enqueue(value);
            },
            cancel() {
              void reader.cancel().catch(() => undefined);
            },
          });
          return new Response(limited, { status: response.status, headers: response.headers });
        }
      }

      return response;
    }
  }

  // -------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------

  checkToolBudget(ctx: PolicyCheckContext, used: number, max: number): PolicyDecision {
    const decision: PolicyDecision = { allowed: used < max, reasonCode: 'budget_exceeded', policyVersion: ctx.policy.configId };
    if (decision.allowed) decision.reasonCode = 'unknown';
    this.record(ctx, decision, 'tool', `tool_calls ${used}/${max}`, 'local_evidence');
    return decision;
  }

  checkModelBudget(ctx: PolicyCheckContext, costUsd: number, maxUsd: number | null | undefined): PolicyDecision {
    if (maxUsd === null || maxUsd === undefined) {
      return { allowed: true, reasonCode: 'unknown', policyVersion: ctx.policy.configId };
    }
    const decision: PolicyDecision = {
      allowed: costUsd <= maxUsd,
      reasonCode: 'budget_exceeded',
      policyVersion: ctx.policy.configId,
      detail: `model cost $${costUsd.toFixed(4)} exceeds $${maxUsd}`,
    };
    if (decision.allowed) decision.reasonCode = 'unknown';
    this.record(ctx, decision, 'budget', `model_cost $${costUsd.toFixed(4)}`, 'local_evidence');
    return decision;
  }
}

export const defaultPolicyGateway = new PolicyGateway();
