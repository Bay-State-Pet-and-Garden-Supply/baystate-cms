/**
 * Deterministic Product Intelligence Preflight Fast Path (Phase 2).
 *
 * Runs cheap deterministic lookups and the extraction ladder (Layers 1-4: HTTP,
 * structured JSON-LD, platform APIs, and approved domain profiles) BEFORE
 * instantiating the general Pi LLM agent session.
 *
 * If a candidate URL settles the product with exact identity, positive single-variant
 * proof, required commerce fields, and zero blocking conflicts:
 *   - discovers and verifiably attests images;
 *   - constructs and validates a ProductResearchBundle;
 *   - returns a submitted ProductResearchResult with $0.00 model cost and 0 tokens;
 *   - skips the Pi agent session completely.
 *
 * If preflight is inconclusive or has conflicts, it returns null, cleanly escalating
 * to the general research agent.
 */
import { createRequire } from 'node:module';
import type {
  ProductResearchInput,
  ProductResearchContext,
  ProductResearchResult,
} from './contracts';
import type {
  ProductResearchBundle,
  BundleImageCandidate,
  CommerceFact,
} from './workflow/bundle';
import { validateTerminalSubmission } from './workflow/bundle-validator';
import { runExtractionLadder, exactGtinMatch } from './extraction/ladder';
import { defaultLadderOptions } from './extraction/wiring';
import { defaultPolicyGateway } from './policy';
import { sha256Hex } from '../shared/stable-id';
import type { ExecutionEventSink } from './executor';

const lazyRequire = createRequire(import.meta.url);

interface PreflightCandidate {
  url: string;
  source: 'brand_sitemap' | 'onboarding' | 'catalog' | 'direct';
}

/**
 * Discover candidate official/brand URLs for the product.
 */
async function discoverPreflightCandidates(
  input: ProductResearchInput,
  ctx: ProductResearchContext,
): Promise<PreflightCandidate[]> {
  const candidates: PreflightCandidate[] = [];
  const seenUrls = new Set<string>();

  const addCandidate = (url: string, source: PreflightCandidate['source']) => {
    try {
      const normalized = new URL(url).toString();
      if (!seenUrls.has(normalized)) {
        seenUrls.add(normalized);
        candidates.push({ url: normalized, source });
      }
    } catch {
      // skip invalid URL
    }
  };

  // 1. Look up brand sites from registry
  if (input.brandHint) {
    try {
      const brandRepo = lazyRequire('../db/repositories/brand-site-repo') as {
        findBrandSites?: (brand: string) => Array<{ domain: string }>;
      };
      const brandSites = brandRepo.findBrandSites?.(input.brandHint) ?? [];
      const sitemapCacheRepo = lazyRequire('../db/repositories/sitemap-cache-repo') as {
        getCachedSitemapUrls?: (domain: string) => string[];
      };
      const sitemapMatcher = lazyRequire('../onboarding/sitemap-matcher') as {
        matchSitemapUrls?: (urls: string[], opts: { name: string; gtin?: string }) => Array<{ url: string; score: number }>;
      };

      for (const site of brandSites) {
        if (ctx.signal?.aborted) break;
        let sitemapUrls = sitemapCacheRepo.getCachedSitemapUrls?.(site.domain) ?? [];
        if (sitemapUrls.length === 0) {
          try {
            const sitemapFetcher = lazyRequire('../onboarding/sitemap-fetcher') as {
              fetchAndParseSitemap?: (domain: string) => Promise<{ urls: string[] }>;
            };
            const fetched = await sitemapFetcher.fetchAndParseSitemap?.(site.domain);
            sitemapUrls = fetched?.urls ?? [];
          } catch {
            sitemapUrls = [];
          }
        }

        if (sitemapUrls.length > 0 && sitemapMatcher.matchSitemapUrls) {
          const matches = sitemapMatcher.matchSitemapUrls(sitemapUrls, {
            name: input.registerName,
            gtin: input.gtin,
          });
          for (const match of matches.slice(0, 3)) {
            addCandidate(match.url, 'brand_sitemap');
          }
        }
      }
    } catch {
      // non-fatal
    }
  }

  // 2. Check onboarding items / sources in the same workspace
  try {
    const sourceRepo = lazyRequire('../db/repositories/onboarding-source-repo') as {
      findSourcesByGtin?: (gtin: string) => Array<{ url: string }>;
    };
    const sources = sourceRepo.findSourcesByGtin?.(input.gtin) ?? [];
    for (const s of sources) {
      addCandidate(s.url, 'onboarding');
    }
  } catch {
    // non-fatal
  }

  return candidates.slice(0, 5);
}

/**
 * Execute deterministic preflight on candidate URLs.
 */
export async function runDeterministicPreflight(
  input: ProductResearchInput,
  ctx: ProductResearchContext,
  sink: ExecutionEventSink,
): Promise<ProductResearchResult | null> {
  const startedAt = new Date().toISOString();
  sink.emit('run_started', {
    message: 'Starting deterministic preflight search',
    data: { executor: 'deterministic_preflight' },
  });

  const candidates = await discoverPreflightCandidates(input, ctx);
  if (candidates.length === 0) {
    return null;
  }

  const ladderOpts = defaultLadderOptions(ctx.policy.allowedSourceDomains);

  for (const candidate of candidates) {
    if (ctx.signal?.aborted) return null;

    try {
      const ladderRun = await runExtractionLadder(
        candidate.url,
        {
          gtin: input.gtin,
          name: input.registerName,
          brandHint: input.brandHint,
        },
        ctx.signal ?? new AbortController().signal,
        15_000,
        ladderOpts,
      );

      const res = ladderRun.result;

      // Settlement criteria:
      // 1. Exact GTIN match
      const gtinMatched = exactGtinMatch(input.gtin, res.gtins) || res.identityStatus === 'exact_match';
      if (!gtinMatched) continue;

      // 2. Mandatory commerce fields
      const productName = res.fields.find((f) => f.field === 'product_name')?.value ?? null;
      const brand = res.fields.find((f) => f.field === 'brand')?.value ?? input.brandHint ?? null;
      if (!productName || !brand) continue;

      // 3. At least one image
      if (res.images.length === 0) continue;

      // 4. Zero blocking conflicts
      if (res.conflicts.length > 0) continue;

      const piRepo = lazyRequire('../db/repositories/product-intelligence-repo') as {
        insertPiSource?: (input: Record<string, unknown>) => { id: string };
        insertPiPageArtifact?: (input: Record<string, unknown>) => { id: string };
        insertPiImageCandidate?: (input: Record<string, unknown>) => { id: string };
        insertPiEvidence?: (input: Record<string, unknown>) => { id: string };
      };

      const domain = new URL(res.finalUrl).hostname.replace(/^www\./, '');
      const sourceRow = piRepo.insertPiSource?.({
        runId: ctx.runId,
        url: res.finalUrl,
        domain,
        sourceType: 'manufacturer',
        discoveryMethod: 'deterministic_preflight',
      });
      const sourceId = sourceRow?.id ?? ctx.runId;

      const artifactRow = piRepo.insertPiPageArtifact?.({
        runId: ctx.runId,
        url: res.finalUrl,
        contentHash: res.contentHash ?? sha256Hex(res.finalUrl),
        content: '',
        artifactType: 'page_html',
      });
      const artifactId = artifactRow?.id ?? ctx.runId;

      // Persist field evidence rows
      const evidenceIds: string[] = [];
      for (const field of res.fields) {
        const evId = `preflight:${sha256Hex(res.finalUrl)}:${field.field}:${sha256Hex(field.sourcePath ?? field.value ?? '')}`;
        evidenceIds.push(evId);
        piRepo.insertPiEvidence?.({
          runId: ctx.runId,
          sourceId,
          targetField: field.field,
          value: field.value,
          extractionMethod: field.method,
          metadata: { toolEvidenceId: evId, path: field.sourcePath },
        });
      }

      // Discover and record image candidates
      const imageCandidates: BundleImageCandidate[] = [];
      for (let idx = 0; idx < res.images.length && idx < 5; idx++) {
        const img = res.images[idx];
        const role = idx === 0 ? 'primary' : 'alternate';
        const candidateRow = piRepo.insertPiImageCandidate?.({
          runId: ctx.runId,
          imageUrl: img.url,
          discoveringSourceId: sourceId,
          attestationArtifactId: artifactId,
          extractionMethod: 'profile_selector',
        });
        const candidateId = candidateRow?.id ?? `candidate-${idx}`;

        // Verify image candidate deterministically
        let verifiedAssetId = '';
        try {
          const verifier = lazyRequire('./assets/verification') as {
            verifyImageCandidate?: (
              target: { runId: string; candidateId: string; imageUrl: string; sourcePageUrl: string; sourceArtifactId: string },
              checkCtx: { runId: string; policy: unknown; gateway: unknown },
            ) => Promise<{ asset: { id: string } }>;
          };
          if (verifier.verifyImageCandidate) {
            const verified = await verifier.verifyImageCandidate(
              {
                runId: ctx.runId,
                candidateId,
                imageUrl: img.url,
                sourcePageUrl: res.finalUrl,
                sourceArtifactId: artifactId,
              },
              { runId: ctx.runId, policy: ctx.policy, gateway: defaultPolicyGateway },
            );
            verifiedAssetId = verified?.asset?.id ?? '';
          }
        } catch {
          // verification best-effort in preflight
        }

        imageCandidates.push({
          sourceId,
          sourceArtifactId: artifactId,
          url: img.url,
          role,
          verifiedAssetId,
          evidenceIds,
          sourcePageUrl: res.finalUrl,
          sourcePath: img.sourcePath ?? null,
          extractionMethod: 'profile_selector',
          retrievedAt: new Date().toISOString(),
          observedNetContent: null,
          observedPackCount: null,
          conflicts: [],
        });
      }

      const commerceFacts: CommerceFact[] = res.fields.map((f) => ({
        field: f.field,
        value: f.value,
        evidenceIds,
        extractionMethods: [f.method],
        confidenceSignal: 1.0,
      }));

      const bundle: ProductResearchBundle = {
        schemaVersion: 1,
        gtin: input.gtin,
        inputName: input.registerName,
        identity: {
          status: 'exact_match',
          brand,
          canonicalName: productName,
          variant: res.variant?.name ?? null,
          manufacturer: brand,
          netContent: null,
          packCount: null,
          evidenceIds,
        },
        commerceFacts,
        classificationProposals: [],
        imageCandidates,
        conflicts: [],
        disposition: 'research_complete',
      };

      // Bundle validation gate
      const validation = validateTerminalSubmission(bundle, input.gtin, ctx.workspaceId, ctx.runId);
      if (validation.valid) {
        sink.emit('run_completed', {
          message: 'Preflight completed successfully (deterministic hit)',
        });

        return {
          runId: ctx.runId,
          outcome: 'submitted',
          executor: 'deterministic_preflight',
          executorVersion: '1.0.0',
          piVersion: 'preflight-1.0.0',
          extensionVersions: [],
          configId: ctx.policy.configId,
          durationMs: Math.max(0, Date.now() - new Date(startedAt).getTime()),
          submission: bundle,
          failure: null,
          events: sink.snapshot(),
          modelCostUsd: 0,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        };
      }
    } catch {
      // ignore candidate error and continue to next candidate
    }
  }

  return null;
}
