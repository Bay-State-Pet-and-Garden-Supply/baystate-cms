/**
 * PI-11 ladder wiring: the default ladder options for real runs. The worker
 * snapshot client and extractor profile repo are loaded lazily (createRequire)
 * so this module stays importable in vitest — real runs always execute in the
 * server process where clients and databases are available. No browser/llm/managed
 * provider or profile runner is enabled unless its backend is actually reachable.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/29
 */
import { createRequire } from 'node:module';
import type { LadderOptions } from './ladder';
import type { BrowserSnapshot, BrowserSnapshotFn, BrowserSnapshotRequest } from './browser';
import type { ExtractedFieldEvidence } from '../tools/contract';

const lazyRequire = createRequire(import.meta.url);

/**
 * Round-3 finding 3: the per-run allowed-source-domains are captured in the
 * per-run snapshot closure — there is NO module-level policy state. This
 * factory builds the exact payload a run sends to the worker snapshot
 * endpoint; exported so tests can assert per-run isolation without invoking
 * the worker.
 */
export function snapshotRequestFor(
  request: BrowserSnapshotRequest,
  sourcesAllowlist: string[] | undefined,
): {
  url: string;
  runtime: 'rendered';
  captureScreenshot: false;
  captureNetwork: boolean;
  sourcesAllowlist?: string[];
  interaction: InteractionPayload | null;
} {
  return {
    url: request.url,
    runtime: 'rendered',
    captureScreenshot: false,
    captureNetwork: request.captureNetwork,
    sourcesAllowlist,
    interaction: request.interaction ?? null,
  };
}

interface InteractionPayload {
  type: string;
  selector?: string;
  optionLabel?: string;
  settleMs?: number;
}

/** Worker snapshot client, lazily loaded (null when unavailable). */
function lazySnapshotFn(sourcesAllowlist: string[] | undefined): BrowserSnapshotFn | null {
  try {
    const client = lazyRequire('../../server/extraction-worker-client') as {
      snapshotPage?: (request: ReturnType<typeof snapshotRequestFor>) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
    };
    const snapshotPage = client.snapshotPage;
    if (!snapshotPage) return null;
    return async (request): Promise<BrowserSnapshot> => {
      const result = await snapshotPage(snapshotRequestFor(request, sourcesAllowlist));
      if (!result.ok) throw new Error(result.error);
      const data = result.data as {
        finalUrl: string;
        jsonLd?: Array<Record<string, unknown>>;
        embeddedProductData?: Array<Record<string, unknown>>;
        imageCandidates?: string[];
        networkResponses?: Array<{
          url: string;
          status?: number | null;
          responseContentType?: string | null;
          jsonBody?: unknown;
        }>;
        interaction?: {
          performed?: boolean;
          finalUrl?: string;
          selectedOptions?: string[];
        } | null;
        pageStructureSignals?: string[];
        warnings?: string[];
      };
      return {
        url: request.url,
        finalUrl: data.finalUrl ?? request.url,
        jsonLd: data.jsonLd ?? [],
        embeddedProductData: data.embeddedProductData ?? [],
        imageCandidates: data.imageCandidates ?? [],
        networkResponses: (data.networkResponses ?? []).map((response) => ({
          url: response.url,
          status: response.status ?? null,
          responseContentType: response.responseContentType ?? null,
          jsonBody: response.jsonBody ?? null,
        })),
        interaction: data.interaction
          ? {
              performed: data.interaction.performed ?? false,
              finalUrl: data.interaction.finalUrl ?? request.url,
              selectedOptions: data.interaction.selectedOptions ?? [],
            }
          : null,
        pageStructureSignals: data.pageStructureSignals ?? [],
        warnings: data.warnings ?? [],
      };
    };
  } catch {
    return null;
  }
}

/**
 * Lazy domain profile resolver: connects approved domain extractor profiles from
 * the database to the extraction worker runner. When an approved profile matches
 * the domain of the URL being extracted, trusted CSS selector extraction runs
 * deterministically without LLM fallback.
 */
export function lazyProfileResolver(sourcesAllowlist?: string[]): LadderOptions['profiles'] {
  return [
    {
      name: 'onboarding_domain_profiles',
      matches(url: string): boolean {
        try {
          const parsed = new URL(url);
          const domain = parsed.hostname.toLowerCase().replace(/^www\./, '').trim();
          if (!domain) return false;
          if (sourcesAllowlist && sourcesAllowlist.length > 0 && !sourcesAllowlist.includes(domain)) {
            return false;
          }
          const conn = lazyRequire('../../db/connection') as { isDbInitialized?: () => boolean };
          if (!conn.isDbInitialized?.()) return false;
          const repo = lazyRequire('../../db/repositories/extractor-profile-repo') as {
            findProfileByDomain?: (d: string) => { id: string } | null;
          };
          return !!repo.findProfileByDomain?.(domain);
        } catch {
          return false;
        }
      },
      async extract(
        url: string,
        signal: AbortSignal,
        _timeoutMs: number,
        expected?: { gtin?: string; name?: string; brandHint?: string | null },
      ): Promise<{
        fields: ExtractedFieldEvidence[];
        images: Array<{ url: string; sourcePath?: string }>;
        profile?: { id: string; version: string | number; runtime?: 'static' | 'rendered' };
      } | null> {
        if (signal.aborted) return null;
        try {
          const parsed = new URL(url);
          const domain = parsed.hostname.toLowerCase().replace(/^www\./, '').trim();
          if (!domain) return null;

          const repo = lazyRequire('../../db/repositories/extractor-profile-repo') as {
            findProfileByDomain?: (d: string) => import('../../db/repositories/extractor-profile-repo').ExtractorProfile | null;
          };
          const profile = repo.findProfileByDomain?.(domain);
          if (!profile) return null;

          const runner = lazyRequire('../../onboarding/profile-runner-client') as {
            runProfileExtraction?: (opts: {
              sourceUrl: string;
              profile: typeof profile;
              expected: { name: string; brandHint?: string | null; price?: string | null };
            }) => Promise<{ ok: boolean; data?: import('../../shared/schemas/onboarding').ExtractionData; error?: string }>;
          };
          if (!runner.runProfileExtraction) return null;

          const res = await runner.runProfileExtraction({
            sourceUrl: url,
            profile,
            expected: {
              name: expected?.name ?? '',
              brandHint: expected?.brandHint ?? null,
            },
          });

          if (!res.ok || !res.data) return null;
          const data = res.data;
          const fields: ExtractedFieldEvidence[] = [];

          if (data.title) {
            fields.push({
              field: 'product_name',
              value: data.title,
              method: 'profile_selector',
              sourcePath: `profile:${profile.id}:title`,
            });
          }
          if (data.description) {
            fields.push({
              field: 'description',
              value: data.description,
              method: 'profile_selector',
              sourcePath: `profile:${profile.id}:description`,
            });
          }
          if (data.brand) {
            fields.push({
              field: 'brand',
              value: data.brand,
              method: 'profile_selector',
              sourcePath: `profile:${profile.id}:brand`,
            });
          }
          if (data.price) {
            fields.push({
              field: 'price',
              value: data.price,
              method: 'profile_selector',
              sourcePath: `profile:${profile.id}:price`,
            });
          }
          const sizeVal = data.packageSize || data.weight;
          if (sizeVal) {
            fields.push({
              field: 'size',
              value: typeof sizeVal === 'string' ? sizeVal : JSON.stringify(sizeVal),
              method: 'profile_selector',
              sourcePath: `profile:${profile.id}:size`,
            });
          }
          if (data.ingredients) {
            fields.push({
              field: 'ingredients',
              value: typeof data.ingredients === 'string' ? data.ingredients : JSON.stringify(data.ingredients),
              method: 'profile_selector',
              sourcePath: `profile:${profile.id}:ingredients`,
            });
          }
          if (data.guaranteedAnalysis) {
            fields.push({
              field: 'guaranteed_analysis',
              value: typeof data.guaranteedAnalysis === 'string' ? data.guaranteedAnalysis : JSON.stringify(data.guaranteedAnalysis),
              method: 'profile_selector',
              sourcePath: `profile:${profile.id}:guaranteed_analysis`,
            });
          }
          if (Array.isArray(data.variants) && data.variants.length > 0) {
            const firstSku = data.variants[0]?.sku;
            if (firstSku) {
              fields.push({
                field: 'sku',
                value: firstSku,
                method: 'profile_selector',
                sourcePath: `profile:${profile.id}:variants[0].sku`,
              });
            }
          }

          const rawImages = [data.primaryImage, ...(data.additionalImages ?? [])].filter(
            (img): img is string => typeof img === 'string' && img.length > 0,
          );
          const images = rawImages.map((imgUrl, index) => ({
            url: imgUrl,
            sourcePath: `profile:${profile.id}:${index === 0 ? 'primaryImage' : 'additionalImages'}`,
          }));

          return {
            fields,
            images,
            profile: {
              id: profile.id,
              version: profile.updatedAt ? Math.floor(new Date(profile.updatedAt).getTime() / 1000) : 0,
              runtime: profile.runtime,
            },
          };
        } catch {
          return null;
        }
      },
    },
  ];
}

/** Default ladder options for the server: domain profiles and browser layer wired. */
export function defaultLadderOptions(sourcesAllowlist?: string[]): LadderOptions {
  const snapshot = lazySnapshotFn(sourcesAllowlist);
  const profiles = lazyProfileResolver(sourcesAllowlist);
  const options: LadderOptions = {};
  if (snapshot) options.browser = { snapshot };
  if (profiles && profiles.length > 0) options.profiles = profiles;
  return options;
}
