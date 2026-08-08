import { CheerioCrawler, PlaywrightCrawler, ProxyConfiguration, Configuration } from 'crawlee';
import { firefox } from 'playwright';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import type * as cheerio from 'cheerio';
import type { ScrapedProductEvidence, SiteCrawlConfig } from './corpus-schema.js';
import { computeEntityId, validateUrl } from './url-policy.js';
import { isChewyUrl, parseChewyProductHtml, extractChewyCatalogLinks } from './sites/chewy.js';
import { isTractorSupplyUrl, parseTractorSupplyProductHtml, extractTractorSupplyCatalogLinks } from './sites/tractor-supply.js';
import { isBurpeeUrl, parseBurpeeProductHtml, extractBurpeeCatalogLinks } from './sites/burpee.js';
import { isAceHardwareUrl, parseAceHardwareProductHtml, extractAceHardwareCatalogLinks } from './sites/ace-hardware.js';

export class TrainingCorpusCrawler {
  private config: SiteCrawlConfig;
  private scrapedItems: ScrapedProductEvidence[] = [];

  constructor(config: SiteCrawlConfig) {
    this.config = config;
  }

  /**
   * Helper to create Crawlee ProxyConfiguration if environment variables are present.
   */
  private createProxyConfiguration(): ProxyConfiguration | undefined {
    const rawEnv = process.env.BAYSTATE_CMS_PROXY_URLS || process.env.PROXY_URL;
    if (!rawEnv) return undefined;

    const proxyUrls = rawEnv.split(',').map((s) => s.trim()).filter(Boolean);
    if (proxyUrls.length === 0) return undefined;

    return new ProxyConfiguration({ proxyUrls });
  }

  /**
   * Dispatches HTML parsing to the appropriate domain-specific parser.
   */
  private parsePage(url: string, $: cheerio.CheerioAPI): { item: ScrapedProductEvidence | null; links: string[] } {
    if (isChewyUrl(url)) {
      return {
        item: parseChewyProductHtml(url, $),
        links: extractChewyCatalogLinks($, url),
      };
    }
    if (isTractorSupplyUrl(url)) {
      return {
        item: parseTractorSupplyProductHtml(url, $),
        links: extractTractorSupplyCatalogLinks($, url),
      };
    }
    if (isBurpeeUrl(url)) {
      return {
        item: parseBurpeeProductHtml(url, $),
        links: extractBurpeeCatalogLinks($, url),
      };
    }
    if (isAceHardwareUrl(url)) {
      return {
        item: parseAceHardwareProductHtml(url, $),
        links: extractAceHardwareCatalogLinks($, url),
      };
    }

    // Generic fallback parser
    const title = $('h1').first().text().trim();
    if (!title) return { item: null, links: [] };

    const breadcrumbs: string[] = [];
    $('nav li, .breadcrumb li').each((_i, el) => {
      const text = $(el).text().trim();
      if (text) breadcrumbs.push(text);
    });

    const links: string[] = [];
    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (href) {
        try {
          links.push(new URL(href, url).href);
        } catch {
          // ignore
        }
      }
    });

    const item: ScrapedProductEvidence = {
      id: computeEntityId(url).slice(0, 16),
      entityId: computeEntityId(url),
      retailer: new URL(url).hostname,
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
      title,
      rawBreadcrumb: breadcrumbs,
      specifications: {},
      images: [],
      acquisitionMode: 'http_fetch',
      parserVersion: '2.0',
      validationState: 'unvalidated',
      qualityFlags: [],
      pageKind: 'unknown',
    };

    return { item, links };
  }

  /**
   * Executes the crawl using CheerioCrawler (default fast mode) or PlaywrightCrawler with Camoufox anti-detect Firefox.
   */
  async run(): Promise<ScrapedProductEvidence[]> {
    const items: ScrapedProductEvidence[] = [];
    const maxItems = this.config.maxItems || 100;
    const domain = this.config.domain;
    const proxyConfiguration = this.createProxyConfiguration();

    const crawlerConfig = new Configuration({
      persistStorage: false,
      purgeOnStart: true,
    });

    const self = this; // eslint-disable-line @typescript-eslint/no-this-alias -- captured for crawler requestHandler closures

    if (this.config.useBrowser) {
      let camoufoxOpts: Record<string, unknown> = {};
      try {
        camoufoxOpts = await camoufoxLaunchOptions({ headless: true });
      } catch {
        // Fallback if Camoufox binary is missing
      }

      const crawler = new PlaywrightCrawler(
        {
          maxConcurrency: this.config.maxConcurrency || 2,
          maxRequestsPerCrawl: maxItems * 3,
          proxyConfiguration,
          launchContext: {
            launcher: firefox,
            launchOptions: {
              ...camoufoxOpts,
              headless: true,
            },
          },
          async requestHandler({ page, request }) {
            if (items.length >= maxItems) {
              await crawler.teardown();
              return;
            }

            // Human-like delay and scrolling to bypass JS anti-bot checks
            await page.waitForTimeout(1000 + Math.floor(Math.random() * 1000));
            await page.evaluate(() => window.scrollTo(0, 400));

            const html = await page.content();
            const cheerioModule = await import('cheerio');
            const $ = cheerioModule.load(html);

            const { item, links } = self.parsePage(request.url, $);
            if (item && items.length < maxItems) {
              items.push(item);
            }

            if (items.length >= maxItems) {
              await crawler.teardown();
              return;
            }

            const safeLinks = self.filterSafeLinks(links, domain);
            if (safeLinks.length > 0) {
              await crawler.addRequests(safeLinks.map((url: string) => ({ url })));
            }
          },
        },
        crawlerConfig
      );

      await crawler.run(this.config.startUrls);
    } else {
      const crawler = new CheerioCrawler(
        {
          maxConcurrency: this.config.maxConcurrency || 2,
          maxRequestsPerCrawl: maxItems * 3,
          proxyConfiguration,
          requestHandlerTimeoutSecs: 30,
          maxRequestRetries: 2,
          additionalMimeTypes: ['text/html', 'application/xhtml+xml'],
          preNavigationHooks: [
            async (_c, gotOptions) => {
              gotOptions.http2 = false;
              gotOptions.headers = {
                ...gotOptions.headers,
                'User-Agent':
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
              };
            },
          ],
          async requestHandler({ request, $, enqueueLinks: _enqueueLinks }) {
            if (items.length >= maxItems) {
              await crawler.teardown();
              return;
            }

            const { item, links } = self.parsePage(request.url, $ as unknown as cheerio.CheerioAPI);
            if (item && items.length < maxItems) {
              items.push(item);
            }

            if (items.length >= maxItems) {
              await crawler.teardown();
              return;
            }

            const safeLinks = self.filterSafeLinks(links, domain);
            if (safeLinks.length > 0) {
              await crawler.addRequests(safeLinks.map((url: string) => ({ url })));
            }
          },
        },
        crawlerConfig
      );

      await crawler.run(this.config.startUrls.filter((u) => validateUrl(u).ok));
    }

    this.scrapedItems = items;
    return items;
  }

  /**
   * Applies the URL policy to discovered links: only same-domain, valid
   * http(s) URLs are enqueued.
   */
  private filterSafeLinks(links: string[], domain: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const link of links) {
      const validated = validateUrl(link);
      if (!validated.ok || !validated.canonicalUrl) continue;
      if (!validated.canonicalUrl.includes(domain)) continue;
      if (seen.has(validated.canonicalUrl)) continue;
      seen.add(validated.canonicalUrl);
      result.push(validated.canonicalUrl);
    }
    return result;
  }
}
