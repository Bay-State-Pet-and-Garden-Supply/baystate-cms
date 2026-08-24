/**
 * Deterministic image-fetch gate (ADR-0030 Phase 1 relocation).
 *
 * The onboarding image-verification pipeline previously fetched through the
 * Product Intelligence PolicyGateway. That gateway couples the deterministic
 * transport protections (protocol/port validation, private/link-local deny
 * with DNS resolution, per-hop redirect re-validation, content-type
 * allowlist, streamed response-size cap) to the PI run-policy runtime
 * (immutable policy snapshots, audit records, data-sharing modes). Only the
 * deterministic half is load-bearing for onboarding imagery verification,
 * so this module replicates EXACTLY that subset with no PI dependency:
 *
 * - http/https only; ports 80/443 only;
 * - localhost and any DNS-resolved private/link-local destination denied;
 * - redirects followed manually with every hop re-validated (max 5);
 * - optional content-type allowlist;
 * - response size capped at the BODY level (chunked/missing-length bodies
 *   are capped too — never trusted via Content-Length).
 *
 * Known accepted residual (inherited from gatewayFetch): validate-then-fetch
 * performs a separate connection, so a DNS-rebinding hostname can answer
 * public during validation and private at connect time. Full closure needs
 * connect-time IP pinning, which Bun's fetch does not expose.
 */
import { lookup } from 'node:dns/promises';
import { isPrivateOrLinkLocal } from '../../shared/ssrf';

export class NetworkGateDeniedError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(`network gate denied: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'NetworkGateDeniedError';
  }
}

/** Structural gate contract consumed by the verification pipeline.
 *  Onboarding callers pass DeterministicNetworkGate; remaining Product
 *  Intelligence callers adapt their PolicyGateway (gatewayFetch has the
 *  same shape), so PI run-policy enforcement is unchanged until Phase 3. */
export interface ImageFetchGate {
  fetch(url: string, init?: RequestInit, options?: GateFetchOptions): Promise<Response>;
}

export interface DeterministicGateOptions {
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  maxRedirects?: number;
}

export interface GateFetchOptions {
  allowedContentTypes?: string[];
  maxResponseBytes?: number;
  signal?: AbortSignal | null;
}

export class DeterministicNetworkGate {
  private readonly resolveHostname: (hostname: string) => Promise<string[]>;
  private readonly fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly maxRedirects: number;

  constructor(options: DeterministicGateOptions = {}) {
    this.resolveHostname = options.resolveHostname ?? (async (hostname) => {
      const records = await lookup(hostname, { all: true });
      return records.map((r) => r.address);
    });
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.maxRedirects = options.maxRedirects ?? 5;
  }

  /** Deterministic destination validation shared by every hop. */
  private async validateDestination(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new NetworkGateDeniedError('invalid_protocol', `unparseable URL: ${url.slice(0, 120)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new NetworkGateDeniedError('invalid_protocol', `protocol ${parsed.protocol} not allowed`);
    }
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (port !== 80 && port !== 443) {
      throw new NetworkGateDeniedError('invalid_port', `port ${port} not allowed`);
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost') {
      throw new NetworkGateDeniedError('private_network_destination', 'localhost is a private destination');
    }

    // DNS resolution + SSRF floor.
    let addresses: string[];
    try {
      addresses = await this.resolveHostname(hostname);
    } catch {
      throw new NetworkGateDeniedError('dns_failed', `DNS resolution failed for ${hostname}`);
    }
    if (addresses.length === 0) {
      throw new NetworkGateDeniedError('no_dns_records', `no DNS records for ${hostname}`);
    }
    const denied = addresses.find((address) => isPrivateOrLinkLocal(address));
    if (denied) {
      throw new NetworkGateDeniedError('private_network_destination', `${hostname} resolves to ${denied} (private/link-local)`);
    }
  }

  /**
   * Policy-equivalent deterministic fetch: validates the destination,
   * follows redirects manually re-validating every hop, and enforces
   * response-size and content-type limits. Denied hops throw
   * NetworkGateDeniedError.
   */
  async fetch(url: string, init: RequestInit = {}, options: GateFetchOptions = {}): Promise<Response> {
    let currentUrl = url;
    let redirects = 0;

    for (;;) {
      await this.validateDestination(currentUrl);

      const response = await this.fetchFn(currentUrl, {
        ...init,
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        redirects += 1;
        if (redirects > this.maxRedirects) {
          throw new NetworkGateDeniedError('redirect_to_denied', `too many redirects (${this.maxRedirects})`);
        }
        currentUrl = new URL(response.headers.get('location')!, currentUrl).toString();
        continue;
      }

      if (options.allowedContentTypes && options.allowedContentTypes.length > 0) {
        const contentType = response.headers.get('content-type') ?? '';
        if (!options.allowedContentTypes.some((allowed) => contentType.startsWith(allowed))) {
          throw new NetworkGateDeniedError('content_type_denied', `${contentType || 'none'} not in allowed types`);
        }
      }

      if (options.maxResponseBytes !== undefined && options.maxResponseBytes !== null) {
        return this.limitResponseStream(response, options.maxResponseBytes);
      }

      return response;
    }
  }

  /** Cap at the body level — chunked/missing-length bodies are capped too. */
  private limitResponseStream(response: Response, limit: number): Response {
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
            new NetworkGateDeniedError('response_too_large', `response exceeds ${limit} bytes (${received} received)`),
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
}
