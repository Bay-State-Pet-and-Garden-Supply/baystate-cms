/**
 * PI-11 ladder wiring: the default ladder options for real runs. The worker
 * snapshot client is loaded lazily (createRequire) so this module stays
 * importable in vitest — real runs always execute in the server process where
 * the client is available. No browser/llm/managed provider is enabled unless
 * its backend is actually reachable.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/29
 */
import { createRequire } from 'node:module';
import type { LadderOptions } from './ladder';
import type { BrowserSnapshot, BrowserSnapshotFn, BrowserSnapshotRequest } from './browser';

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

/** Default ladder options for the server: browser layer wired to the worker. */
export function defaultLadderOptions(sourcesAllowlist?: string[]): LadderOptions {
  const snapshot = lazySnapshotFn(sourcesAllowlist);
  return snapshot ? { browser: { snapshot } } : {};
}
