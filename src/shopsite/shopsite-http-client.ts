import type { Result } from '@/shared/result';
import { buildCgiScriptUrl, normalizeCgiBaseUrl } from './url-utils';

export interface ShopSiteHttpConfig {
  cgiBaseUrl: string;
  merchantId: string;
  password: string;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
}

/**
 * Generic ShopSite HTTP client for communicating with ShopSite CGI endpoints.
 * Supports Basic auth and CGI URL construction for db_xml, dbupload, dbmake, generate.
 */
export class ShopSiteHttpClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(config: ShopSiteHttpConfig) {
    this.baseUrl = normalizeCgiBaseUrl(config.cgiBaseUrl);
    this.authHeader = 'Basic ' + Buffer.from(`${config.merchantId}:${config.password}`).toString('base64');
  }

  private buildUrl(scriptName: string, params?: Record<string, string>): string {
    return buildCgiScriptUrl(this.baseUrl, scriptName, params);
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: this.authHeader,
      'User-Agent': 'ShopSiteCMS/0.1.0',
      Accept: 'text/xml,application/xml,*/*',
      ...extra,
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const url = this.buildUrl('db_xml.cgi', { clientApp: '1', action: 'list' });
      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        return { success: true, message: 'Connection successful' };
      }

      if (response.status === 401 || response.status === 403) {
        return { success: false, message: 'Authentication failed. Check merchant ID and password.' };
      }

      const text = await response.text().catch(() => '');
      return {
        success: false,
        message: `HTTP ${response.status}: ${text.slice(0, 200) || response.statusText}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Connection error: ${message}`,
      };
    }
  }

  async fetchProductsXml(
    options?: { version?: string; fields?: string[] },
  ): Promise<Result<string>> {
    const params: Record<string, string> = {
      clientApp: '1',
      dbname: 'products',
    };
    if (options?.version) params.version = options.version;
    if (options?.fields && options.fields.length > 0) {
      params.fields = '|' + options.fields.join('|') + '|';
    }

    try {
      const url = this.buildUrl('db_xml.cgi', params);
      const response = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          success: false,
          errors: [`ShopSite download failed (${response.status}): ${text.slice(0, 200)}`],
          error: `HTTP ${response.status}`,
        };
      }

      const xml = await response.text();
      return { success: true, data: xml, errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, errors: [message], error: message };
    }
  }
}
