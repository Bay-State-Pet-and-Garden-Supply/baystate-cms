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
        htmlRef?: string | null;
        networkRef?: string | null;
        artifactId?: string | null;
        contentHash?: string | null;
        jsonLd?: Array<Record<string, unknown>>;
        embeddedProductData?: Array<Record<string, unknown>>;
        imageCandidates?: string[];
        networkResponses?: Array<{
          url: string;
          status?: number | null;
          responseContentType?: string | null;
          jsonBody?: unknown;
          artifactId?: string | null;
          contentHash?: string | null;
          sourcePath?: string;
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
        artifactId: data.artifactId ?? data.htmlRef ?? null,
        contentHash: data.contentHash ?? null,
        jsonLd: data.jsonLd ?? [],
        embeddedProductData: data.embeddedProductData ?? [],
        imageCandidates: data.imageCandidates ?? [],
        networkResponses: (data.networkResponses ?? []).map((response) => ({
          url: response.url,
          status: response.status ?? null,
          responseContentType: response.responseContentType ?? null,
          jsonBody: response.jsonBody ?? null,
          artifactId: response.artifactId ?? null,
          contentHash: response.contentHash ?? null,
          sourcePath: response.sourcePath,
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
        images: Array<{ url: string; sourcePath?: string; sourceArtifactId?: string | null; sourceContentHash?: string | null; variantRef?: string }>;
        profile?: { id: string; version: string | number; runtime?: 'static' | 'rendered'; artifactId?: string | null; contentHash?: string | null };
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
            }) => Promise<{ ok: boolean; data?: import('../../shared/schemas/onboarding').ExtractionData; fieldProvenance?: Record<string, string>; fieldProvenanceDetails?: Record<string, { method: string; sourcePath: string }>; error?: string; sourceContentHash?: string | null; sourceArtifactId?: string | null }>;
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
          // A profile result without retained source metadata cannot support
          // durable selector evidence. Never relabel fallback values as a
          // profile selector merely because an approved profile was matched.
          const sourceContentHash = res.sourceContentHash ?? null;
          const sourceArtifactId = res.sourceArtifactId ?? null;
          if (!sourceContentHash && !sourceArtifactId) return null;
          const data = res.data;
          const provenance = res.fieldProvenance ?? data.fieldProvenance ?? {};
          const provenanceDetails = res.fieldProvenanceDetails ?? {};
          const fields: ExtractedFieldEvidence[] = [];
          const source = { sourceArtifactId, sourceContentHash };
          const provenanceFor = (field: string, selectorPath: string): { method: string; sourcePath: string } => {
            const detail = provenanceDetails[field];
            if (detail && (detail.method === 'profile_selector' || detail.method === 'profile-selector')) {
              return { method: 'profile_selector', sourcePath: detail.sourcePath };
            }
            if (detail) return { method: detail.method, sourcePath: detail.sourcePath };
            const declared = String(provenance[field] ?? '').trim().toLowerCase();
            if (declared === 'profile-selector' || declared === 'profile_selector') {
              return { method: 'profile_selector', sourcePath: selectorPath };
            }
            if (declared.startsWith('json-ld') || declared === 'json_ld') return { method: 'json_ld', sourcePath: `json-ld:${field}` };
            if (declared.startsWith('meta')) return { method: 'meta', sourcePath: `meta:${field}` };
            if (declared.startsWith('microdata')) return { method: 'microdata', sourcePath: `microdata:${field}` };
            if (declared === 'spreadsheet-import' || declared === 'expected') return { method: 'expected_value', sourcePath: `expected:${field}` };
            // Unknown provenance is retained as an explicit method, never
            // upgraded to profile_selector. The field path remains stable and
            // source-bound to the worker's retained response.
            return { method: declared || 'profile_fallback', sourcePath: declared || `fallback:${field}` };
          };
          const addField = (field: string, value: unknown, selectorPath: string): void => {
            if (value === null || value === undefined || String(value).trim() === '') return;
            const method = provenanceFor(field, selectorPath);
            fields.push({ field, value: typeof value === 'string' ? value : JSON.stringify(value), ...method, ...source });
          };

          addField('product_name', data.title, `profile:${profile.id}:title`);
          addField('description', data.description, `profile:${profile.id}:description`);
          addField('brand', data.brand, `profile:${profile.id}:brand`);
          addField('price', data.price, `profile:${profile.id}:price`);
          addField('size', data.packageSize || data.weight, `profile:${profile.id}:size`);
          addField('ingredients', data.ingredients, `profile:${profile.id}:ingredients`);
          addField('guaranteed_analysis', data.guaranteedAnalysis, `profile:${profile.id}:guaranteed_analysis`);

          // Profile worker variants are already linked to the selected page
          // bytes. Preserve each variant reference for SKU/GTIN and product
          // fields instead of flattening all values to variants[0].
          const variants = (data as typeof data & { variants?: Array<Record<string, unknown>> }).variants;
          if (Array.isArray(variants)) {
            variants.forEach((variant, index) => {
              const variantRef = variant.id === null || variant.id === undefined ? null : String(variant.id);
              const variantSource = { ...source, variantRef };
              const variantPath = `profile:${profile.id}:variants[${index}]`;
              const addVariant = (field: string, value: unknown, key: string): void => {
                if (value === null || value === undefined || String(value).trim() === '') return;
                const method = provenanceFor(field, `${variantPath}.${key}`);
                fields.push({ field, value: typeof value === 'string' ? value : JSON.stringify(value), ...method, ...variantSource });
              };
              addVariant('variant_name', variant.title ?? variant.name, 'title');
              addVariant('sku', variant.sku, 'sku');
              addVariant('gtin', variant.gtin ?? variant.barcode ?? variant.upc, 'gtin');
              addVariant('product_name', variant.productName ?? variant.product_name, 'productName');
            });
          }

          const rawImages = [data.primaryImage, ...(data.additionalImages ?? [])].filter(
            (img): img is string => typeof img === 'string' && img.length > 0,
          );
          const images = rawImages.map((imgUrl, index) => {
            const field = index === 0 ? 'primaryImage' : 'additionalImages';
            const imageProvenance = provenanceFor(field, `profile:${profile.id}:${index === 0 ? 'primaryImage' : 'additionalImages'}`);
            return {
              url: imgUrl,
              sourcePath: imageProvenance.sourcePath,
              ...source,
            };
          });

          return {
            fields,
            images,
            profile: {
              id: profile.id,
              version: profile.updatedAt ? Math.floor(new Date(profile.updatedAt).getTime() / 1000) : 0,
              runtime: profile.runtime,
              artifactId: res.sourceArtifactId ?? null,
              contentHash: res.sourceContentHash ?? null,
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
