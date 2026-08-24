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
import { classifyIp, isPrivateOrLinkLocal } from '../../shared/ssrf';

export { classifyIp, isPrivateOrLinkLocal }; // re-export until Phase 3 deletion

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
  | 'data_sharing_denies_search'
  | 'zone_transition'
  | 'unknown';

export type DataClassification = 'public' | 'product_input' | 'fetched_content' | 'search_query' | 'local_evidence' | 'model_input';

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

// IP classification (SSRF floor) relocated to src/shared/ssrf.ts (ADR-0030 PR 1.1).

/**
 * True only for EXPLICIT loopback literals (localhost / 127.0.0.0/8 / ::1 /
 * IPv4-mapped forms). Never DNS-resolves arbitrary hostnames — resolving a
 * hostile hostname for a "loopback test" would itself be an SSRF probe.
 */
function isExplicitLoopbackEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    if (hostname === 'localhost' || hostname === '::1' || hostname === '127.0.0.1') return true;
    if (/^127(\.\d{1,3}){3}$/.test(hostname)) return true;
    if (hostname.startsWith('::ffff:127.')) return true;
    if (hostname.startsWith('0:0:0:0:0:0:ffff:127')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Conservative port allowlist for LOCAL model endpoints (round-5). Loopback
 * models get an explicit loopback-model destination policy — loopback
 * literals only, http(s), and this port set (Ollama defaults 11434/11435
 * plus 80/443 for local proxies). Redirects from a local endpoint must
 * remain loopback AND within this port set.
 */
const LOCAL_MODEL_PORTS = new Set([80, 443, 11434, 11435]);

/** Model-call response cap (VLM/OCR), enforced on the body stream. */
export const MAX_MODEL_RESPONSE_BYTES = 20 * 1024 * 1024;

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
      // The import itself can reject in environments without bun:sqlite
      // (vitest) — the try must wrap it so audit failures never become
      // unhandled rejections and never break the run.
      try {
      const { getDb } = await import('../../db/connection');
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
    // P0-1: third-party search queries transmit product input (GTIN/name) to
    // an external search engine. Under local_only or cloud_models_only
    // data-sharing policies that transmission is DENIED — never merely
    // logged — so agent search tools return policy_denied without a query.
    if (dataClassification === 'search_query' && (policy.dataSharingPolicy === 'local_only' || policy.dataSharingPolicy === 'cloud_models_only')) {
      decision.allowed = false;
      decision.reasonCode = 'data_sharing_denies_search';
      decision.detail = 'third-party search queries denied under the run\'s data-sharing policy';
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
   *
   * Round-4 P1-4 (documented residual): this is a validate-then-fetch
   * sequence — the destination's DNS is resolved and validated here, then
   * fetchFn() makes a SEPARATE connection with its own DNS resolution. A
   * rebinding hostname can therefore answer public during validation and
   * private at connection time. Full closure requires connect-time IP
   * enforcement / DNS pinning / an outbound proxy (Bun's fetch does not
   * expose a pinned-IP transport). Accepted residual for the single-operator
   * local deployment; the extraction worker closes the equivalent window for
   * http destinations by pinning to the validated address literal.
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
        // Enforce the size limit at the body level by wrapping the stream
        // (shared with the model transport — chunked/missing-length bodies
        // are capped too, never trusted via Content-Length).
        return this.limitResponseStream(response, options.maxResponseBytes, ctx, 'response');
      }

      return response;
    }
  }

  /**
   * P0-1: build a fetch-like function bound to this gateway for a run
   * context. Every call performs policy destination validation, per-hop
   * redirect re-validation, size/type limits, and audit attribution. Used by
   * the extraction ladder, managed providers, and OCR paths so no PI-initiated
   * transport bypasses the network capability.
   */
  buildPiNetworkFetch(
    ctx: PolicyCheckContext,
    options: { dataClassification?: DataClassification } = {},
  ): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    const dataClassification = options.dataClassification ?? 'fetched_content';
    return (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return this.gatewayFetch(ctx, url, init, { dataClassification });
    };
  }

  // -------------------------------------------------------------------------
  // Model endpoints (VLM/OCR)
  // -------------------------------------------------------------------------

  /**
   * VLM/model-endpoint policy gate (round 4). LOCAL model endpoints
   * (explicit localhost/loopback literals — never DNS-resolution probes)
   * share nothing externally and are allowed under any data-sharing policy;
   * REMOTE endpoints carry product input to a third party and must pass
   * model-call authority: local_only denies; otherwise the provider/model
   * must match the policy modelRoute. Every call is audited as a model
   * decision (target_type 'model').
   */
  async checkModelEndpoint(
    ctx: PolicyCheckContext,
    call: { provider: string; model: string; endpointUrl: string; dataClassification?: DataClassification },
  ): Promise<PolicyDecision> {
    const { policy } = ctx;
    const classification = call.dataClassification ?? 'model_input';
    if (isExplicitLoopbackEndpoint(call.endpointUrl)) {
      const decision: PolicyDecision = {
        allowed: true,
        reasonCode: 'unknown',
        policyVersion: policy.configId,
        detail: `local model endpoint ${call.endpointUrl} (${call.provider}/${call.model})`,
      };
      this.record(ctx, decision, 'model', `${call.provider}/${call.model}@local`, classification, 'none');
      return decision;
    }
    if (policy.dataSharingPolicy === 'local_only') {
      const decision: PolicyDecision = {
        allowed: false,
        reasonCode: 'local_only_denies_model',
        policyVersion: policy.configId,
        detail: `remote model endpoint ${call.endpointUrl} denied under local_only data-sharing policy`,
      };
      this.record(ctx, decision, 'model', `${call.provider}/${call.model}`, classification, 'fallback_denied');
      return decision;
    }
    if (!policy.modelRoute || policy.modelRoute.provider !== call.provider || policy.modelRoute.model !== call.model) {
      const decision: PolicyDecision = {
        allowed: false,
        reasonCode: 'model_not_in_route',
        policyVersion: policy.configId,
        detail: `${call.provider}/${call.model} is not the policy model route; fallbacks are never selected silently`,
      };
      this.record(ctx, decision, 'model', `${call.provider}/${call.model}`, classification, 'fallback_denied');
      return decision;
    }
    const decision: PolicyDecision = {
      allowed: true,
      reasonCode: 'unknown',
      policyVersion: policy.configId,
      detail: `remote model endpoint ${call.endpointUrl} (${call.provider}/${call.model})`,
    };
    this.record(ctx, decision, 'model', `${call.provider}/${call.model}`, classification, 'none');
    return decision;
  }

  /**
   * Round-5: destination/SSRF authority for model transports. Every model
   * hop composes TWO independent authorities: checkModelEndpoint (model +
   * data-sharing authorization) AND this destination check. LOCAL endpoints
   * get an explicit loopback-model policy — loopback literals only, http(s),
   * and the LOCAL_MODEL_PORTS allowlist (Ollama defaults + 80/443); remote
   * endpoints reuse the public-destination validator (protocol, port,
   * allowlist, DNS, private/link-local deny) WITHOUT the page-fetch-specific
   * cloud_models_only network denial — model authorization belongs to
   * checkModelEndpoint alone.
   */
  async checkModelDestination(
    ctx: PolicyCheckContext,
    url: string,
    isLocalModel: boolean,
  ): Promise<{ allowed: boolean; reasonCode: PolicyReasonCode; detail: string }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reasonCode: 'invalid_protocol', detail: `unparseable model endpoint: ${url.slice(0, 120)}` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reasonCode: 'invalid_protocol', detail: `model endpoint protocol ${parsed.protocol} not allowed` };
    }
    if (isLocalModel) {
      if (!isExplicitLoopbackEndpoint(url)) {
        return {
          allowed: false,
          reasonCode: 'private_network_destination',
          detail: `local model endpoint must be an explicit loopback literal: ${url.slice(0, 120)}`,
        };
      }
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
      if (!LOCAL_MODEL_PORTS.has(port)) {
        return {
          allowed: false,
          reasonCode: 'invalid_port',
          detail: `local model port ${port} not allowed (allowlist: ${[...LOCAL_MODEL_PORTS].sort((a, b) => a - b).join(', ')})`,
        };
      }
      return { allowed: true, reasonCode: 'unknown', detail: '' };
    }
    // Remote model: reuse the public-destination validator. This applies the
    // protocol/port/domain-allowlist/DNS/private-IP floor to the model hop
    // without the cloud_models_only page-fetch denial (that is a page-fetch
    // rule; model authorization stays with checkModelEndpoint).
    const destination = await this.validateDestination(url, ctx.policy, 'model_input');
    if (!destination.allowed) {
      return { allowed: false, reasonCode: destination.reasonCode, detail: `model endpoint ${destination.detail}` };
    }
    return { allowed: true, reasonCode: 'unknown', detail: '' };
  }

  /**
   * Stream-bounded response body: enforces the size cap on the body stream
   * (never trusting Content-Length — chunked or missing-length bodies are
   * capped too) and errors the stream with PolicyDeniedError past the limit.
   * Shared by gatewayFetch and the model transport.
   */
  private limitResponseStream(response: Response, limit: number, ctx: PolicyCheckContext, what: string): Response {
    const reader = response.body?.getReader();
    if (!reader) return response;
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
          controller.error(
            new PolicyDeniedError({
              allowed: false,
              reasonCode: 'response_too_large',
              policyVersion: ctx.policy.configId,
              detail: `${what} exceeds ${limit} bytes (${received} received)`,
            }),
          );
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

  /**
   * Model-call transport (VLM/OCR): gates EVERY hop through TWO independent
   * authorities — checkModelEndpoint (model + data-sharing: loopback allowed
   * under any policy, remote must match the modelRoute) AND
   * checkModelDestination (SSRF/destination floor: loopback-model policy for
   * local endpoints, public-destination validation for remote). Redirects are
   * followed manually and BOTH authorities re-fire on every hop. The response
   * size cap is enforced on the body stream (never via Content-Length).
   *
   * Round-6 zone rule: the transport's TRUST ZONE is classified ONCE from the
   * configured initial endpoint (call.endpointUrl) and is immutable for the
   * whole request — a local-model transport must stay explicit-loopback on
   * every redirect, and a remote-model transport must stay public/remote on
   * every redirect. Redirects that cross the local/remote boundary are denied
   * with reasonCode 'zone_transition' (a route-authorized remote VLM cannot
   * 302 into 127.0.0.1:11434, and a local Ollama cannot hop out to a public
   * URL).
   */
  buildModelFetch(
    ctx: PolicyCheckContext,
    call: { provider: string; model: string; endpointUrl: string },
  ): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    const classification: DataClassification = 'model_input';
    // Round-6: classify the trust zone once from the CONFIGURED endpoint and
    // never recompute it from a redirect target.
    const initialZone: 'local' | 'remote' = isExplicitLoopbackEndpoint(call.endpointUrl) ? 'local' : 'remote';
    const isLocalModel = initialZone === 'local';
    return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      let currentUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      let redirects = 0;
      for (;;) {
        // Round-6: zone integrity is checked BEFORE model authorization — a
        // zone-crossed target is never even authorized as a model endpoint.
        const hopZone: 'local' | 'remote' = isExplicitLoopbackEndpoint(currentUrl) ? 'local' : 'remote';
        if (hopZone !== initialZone) {
          throw new PolicyDeniedError({
            allowed: false,
            reasonCode: 'zone_transition',
            policyVersion: ctx.policy.configId,
            detail: `model transport is ${initialZone}-zone (from configured endpoint ${call.endpointUrl}) but the request landed on ${currentUrl} — ${initialZone} never becomes ${hopZone}`,
          });
        }

        const modelDecision = await this.checkModelEndpoint(ctx, {
          provider: call.provider,
          model: call.model,
          endpointUrl: currentUrl,
          dataClassification: classification,
        });
        if (!modelDecision.allowed) throw new PolicyDeniedError(modelDecision);

        const destination = await this.checkModelDestination(ctx, currentUrl, isLocalModel);
        if (!destination.allowed) {
          throw new PolicyDeniedError({
            allowed: false,
            reasonCode: destination.reasonCode,
            policyVersion: ctx.policy.configId,
            detail: destination.detail,
          });
        }

        const response = await this.fetchFn(currentUrl, { ...init, redirect: 'manual', signal: init.signal });
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
          redirects += 1;
          if (redirects > 5) {
            throw new PolicyDeniedError({
              allowed: false,
              reasonCode: 'redirect_to_denied',
              policyVersion: ctx.policy.configId,
              detail: 'too many redirects (5) for model endpoint',
            });
          }
          currentUrl = new URL(response.headers.get('location')!, currentUrl).toString();
          continue;
        }
        // Round-5: the 20MB cap is enforced on the body stream — a
        // chunked/missing-length body cannot exceed the limit.
        return this.limitResponseStream(response, MAX_MODEL_RESPONSE_BYTES, ctx, 'model response');
      }
    };
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
