import { boundedFetchJson, SourcingHttpError } from './bounded-fetch';

/**
 * Bounded OAuth2 client-credentials client (BCI / OrderCloud reference,
 * ported from the BayState repo with the CMS security model):
 * - token cached in memory ONLY (never persisted), reused until near expiry;
 * - injectable fetch transport (tests never touch the network);
 * - all errors normalized to stable non-secret codes; the client secret and
 *   raw token responses never appear in error messages or logs.
 */

export interface OAuthClientConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Origin allowlist check target (the token server origin). */
  configuredOrigin: string;
  fetchImpl?: typeof fetch;
  /** Buffer before expiry where a refresh is forced (ms). */
  refreshBufferMs?: number;
}

interface OAuthToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
}

export class OAuthClient {
  private cachedToken: OAuthToken | null = null;
  private readonly config: OAuthClientConfig;

  constructor(config: OAuthClientConfig) {
    this.config = config;
  }

  /** In-memory token cache; null on failure. Throws OAuthError on token fetch failure. */
  async getBearerToken(signal?: AbortSignal, deadlineAt?: string): Promise<string | null> {
    const bufferMs = this.config.refreshBufferMs ?? 60_000;
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + bufferMs) {
      return `${this.cachedToken.tokenType} ${this.cachedToken.accessToken}`;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    let data: unknown;
    try {
      data = await boundedFetchJson(this.config.tokenUrl, this.config.configuredOrigin, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }, { signal, deadlineAt, fetchImpl: this.config.fetchImpl });
    } catch (e) {
      // Redacted: never echo the token response body or the secret.
      if (e instanceof SourcingHttpError) {
        throw new OAuthError(`oauth token request failed: ${e.code}`);
      }
      throw new OAuthError('oauth token request failed: unexpected');
    }

    const parsed = data as { access_token?: unknown; token_type?: unknown; expires_in?: unknown };
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new OAuthError('oauth token response missing access_token');
    }

    const tokenType = typeof parsed.token_type === 'string' && parsed.token_type.length > 0 ? parsed.token_type : 'Bearer';
    const expiresIn = typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 3600;

    this.cachedToken = {
      accessToken: parsed.access_token,
      tokenType,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return `${tokenType} ${parsed.access_token}`;
  }

  /** Test seam: drop the cached token (forced refresh). */
  clearCache(): void {
    this.cachedToken = null;
  }
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}
