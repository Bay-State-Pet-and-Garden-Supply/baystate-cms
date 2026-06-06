import type { Result } from '../shared/result';

export interface PublishOptions {
  htmlpages?: boolean;
  custompages?: boolean;
  index?: boolean;
  regen?: boolean;
  sitemap?: boolean;
}

/**
 * Call generate.cgi to publish/regenerate the store after import.
 * Default publish options enabled: htmlpages, index.
 * These are default documented flags; sitemap is version-variable.
 */
export async function publishStore(
  generateUrl: string,
  authHeader: string,
  options?: PublishOptions,
  cookieHeader?: string,
): Promise<Result<string>> {
  const params = new URLSearchParams({ clientApp: '1' });

  const merged: PublishOptions = {
    htmlpages: options?.htmlpages ?? true,
    index: options?.index ?? true,
    custompages: options?.custompages,
    regen: options?.regen,
    sitemap: options?.sitemap,
  };

  if (merged.htmlpages) params.append('htmlpages', '1');
  if (merged.custompages) params.append('custompages', '1');
  if (merged.index) params.append('index', '1');
  if (merged.regen) params.append('regen', '1');
  if (merged.sitemap) params.append('sitemap', '1');

  const url = `${generateUrl}?${params.toString()}`;
  const headers: Record<string, string> = {
    Authorization: authHeader,
    'User-Agent': 'ShopSiteCMS/0.1.0',
    Accept: 'text/xml,application/xml,*/*',
  };
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(attempt === 1 ? 60_000 : 90_000),
      });

      const responseText = await response.text();

      if (response.ok) {
        return { success: true, data: responseText, errors: [] };
      }

      const isTimeout =
        response.status === 524 ||
        /error code 524|a timeout occurred/i.test(responseText);

      if (isTimeout && attempt < 2) {
        continue;
      }

      return {
        success: false,
        error: attempt > 1
          ? `ShopSite publish failed after retry (${response.status})`
          : `ShopSite publish failed (${response.status})`,
        errors: [responseText.slice(0, 500)],
      };
    }

    return { success: false, error: 'ShopSite publish failed after retry', errors: ['ShopSite publish failed after retry'] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message, errors: [message] };
  }
}
