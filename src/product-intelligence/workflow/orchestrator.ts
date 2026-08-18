/**
 * Specialist Orchestrator — supervised multi-specialist lifecycle management,
 * routing state machine, retry limits, and terminal state resolution (epic #47, issue #56, ADR 0028).
 *
 * The orchestrator owns ALL sequencing, routing, retries, backtracking, budgets,
 * cancellation propagation, and terminal state transitions across specialists:
 *
 *   ProductSeed (+ optional discoveredGtin & gtinScope)
 *       │
 *       ▼
 *   [Discovery Specialist #49]
 *       │
 *       ├─► (needs_profile / profile_failed?) ──► [Profile Engineer Specialist #51]
 *       │                                                    │
 *       │                                                    ▼ (proposal_only: manual review required)
 *       │                                             Hold: NEEDS_REVIEW
 *       ▼
 *   [Deterministic Extraction Evidence Runner #52]
 *       │
 *       ▼
 *   [Resolver Specialist #53]
 *       │
 *       ▼
 *   [Curator Specialist #54]
 *       │
 *       ▼
 *   [Verifier Specialist #55]
 *       │
 *       ├── 'pass' ───────────────────────► Terminal: COMPLETED
 *       ├── 'retry_curator' (retries < max) ──► Re-run Curator → Verifier
 *       ├── 'retry_resolver' (retries < max) ─► Re-run Resolver → Curator → Verifier
 *       ├── 'retry_discovery' (retries < max) ► Re-run Discovery → Pipeline
 *       └── 'human_review' / retries exhausted ► Terminal: NEEDS_REVIEW
 *
 * INVARIANTS:
 *   - Specialists NEVER invoke each other; ONLY the orchestrator dispatches work.
 *   - All inter-specialist data flows are schema-validated typed artifacts.
 *   - Loops stop deterministically at configured retry/dispatch limits.
 *   - Cancellation via AbortSignal immediately aborts execution and sets CANCELLED.
 *   - Atomic dispatch reservation enforces hard limits before every invocation.
 *   - 14-digit GTINs are strictly case-scoped and never promoted as consumer GTINs.
 *   - Profile Engineer proposals require governance/manual review before activation.
 *   - Domain synthesis leases are released safely on completion or error.
 *   - Every exit path emits a comprehensive, durable workflow state snapshot.
 */

import { z } from 'zod';
import { sha256Hex } from '../../shared/stable-id';

function extractDigits(str: string | null | undefined): string {
  return (str ?? '').replace(/\D/g, '');
}
import type { ProductSeed } from '../product-seed';
import {
  DiscoverySpecialist,
  type DiscoverySpecialistOutput,
  type DiscoveryCandidate,
} from '../specialists/discovery';
import {
  ProfileEngineerSpecialist,
  type ProfileEngineerProposal,
} from '../specialists/profile-engineer';
import {
  ResolverSpecialist,
  type ResolvedFactSet,
} from '../specialists/resolver';
import {
  CuratorSpecialist,
  type CuratedProductDraft,
  type ClassificationContext,
} from '../specialists/curator';
import {
  VerifierSpecialist,
  type VerificationReport,
} from '../specialists/verifier';
import {
  runDeterministicExtraction,
  type DeterministicExtractionRunnerOptions,
} from '../extraction/evidence-runner';
import type {
  ExtractionEvidenceBundle,
  ExtractionProfileBinding,
} from '../extraction/evidence';
import type { SpecialistContext, SpecialistResult } from '../specialists/contracts';
import {
  captureSpecialistCodeCommit,
  type SpecialistArtifactEnvelope,
} from '../specialists/artifacts';

// ── Orchestrator Types & Schemas ─────────────────────────────────────────────

export const OrchestratorTerminalStatusSchema = z.enum([
  'completed',
  'needs_review',
  'abstained',
  'budget_exceeded',
  'cancelled',
  'failed',
]);
export type OrchestratorTerminalStatus = z.infer<typeof OrchestratorTerminalStatusSchema>;

export interface OrchestratorStepEvent {
  step: number;
  specialist: string;
  action: string;
  status: 'started' | 'succeeded' | 'failed' | 'retrying' | 'skipped';
  durationMs: number;
  timestamp: string;
  details?: string;
}

export interface CapabilityLimits {
  maxDiscoveryInvocations: number;
  maxExtractionInvocations: number;
  maxProfileInvocations: number;
  maxResolverInvocations: number;
  maxCuratorInvocations: number;
  maxVerifierInvocations: number;
  maxTotalDispatches: number;
}

export const DEFAULT_CAPABILITY_LIMITS: CapabilityLimits = {
  maxDiscoveryInvocations: 2,
  maxExtractionInvocations: 12,
  maxProfileInvocations: 4,
  maxResolverInvocations: 4,
  maxCuratorInvocations: 4,
  maxVerifierInvocations: 4,
  maxTotalDispatches: 20,
};

export interface WorkflowStateSnapshot {
  runId: string;
  status: OrchestratorTerminalStatus;
  currentPhase: string;
  retriesCount: number;
  totalDispatches: number;
  invocations: Record<string, number>;
  artifactIds: string[];
  totalDurationMs: number;
  error?: string;
}

export interface SpecialistWorkflowResult {
  runId: string;
  status: OrchestratorTerminalStatus;
  productSeed: ProductSeed;
  discoveryOutput?: DiscoverySpecialistOutput;
  discoveryArtifact?: SpecialistArtifactEnvelope;
  profileOutput?: ProfileEngineerProposal;
  profileArtifact?: SpecialistArtifactEnvelope;
  extractionBundles: ExtractionEvidenceBundle[];
  resolverOutput?: ResolvedFactSet;
  resolverArtifact?: SpecialistArtifactEnvelope;
  curatorOutput?: CuratedProductDraft;
  curatorArtifact?: SpecialistArtifactEnvelope;
  verifierOutput?: VerificationReport;
  verifierArtifact?: SpecialistArtifactEnvelope;
  events: OrchestratorStepEvent[];
  retriesCount: number;
  totalDispatches: number;
  totalDurationMs: number;
  workflowState: WorkflowStateSnapshot;
  error?: string;
}

export interface SpecialistOrchestratorDependencies {
  discovery?: DiscoverySpecialist;
  profileEngineer?: ProfileEngineerSpecialist;
  resolver?: ResolverSpecialist;
  curator?: CuratorSpecialist;
  verifier?: VerifierSpecialist;
  extractionRunnerOptions?: DeterministicExtractionRunnerOptions;
  extractionRunner?: (
    url: string,
    context: SpecialistContext,
    profile?: ExtractionProfileBinding | null,
  ) => Promise<ExtractionEvidenceBundle>;
}

export interface RunWorkflowOptions {
  discoveredGtin?: string | null;
  gtinScope?: 'consumer_unit' | 'case' | 'multipack' | 'inner_pack';
}

export interface SpecialistOrchestratorOptions {
  maxRetries?: number;
  limits?: Partial<CapabilityLimits>;
  extractionConcurrency?: number;
  dependencies?: SpecialistOrchestratorDependencies;
  now?: () => string;
}

// ── Concurrent Map Helper ───────────────────────────────────────────────────

async function boundedMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

// ── Active Domain Leases Map (Cleaned on completion / error) ────────────────

const activeDomainLeases = new Map<string, Promise<SpecialistResult>>();

// ── Orchestrator Implementation ─────────────────────────────────────────────

export class SpecialistOrchestrator {
  private readonly maxRetries: number;
  private readonly limits: CapabilityLimits;
  private readonly extractionConcurrency: number;
  private readonly dependencies: SpecialistOrchestratorDependencies;
  private readonly now: () => string;

  public constructor(options: SpecialistOrchestratorOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.limits = { ...DEFAULT_CAPABILITY_LIMITS, ...options.limits };
    this.extractionConcurrency = Math.max(1, Math.min(8, options.extractionConcurrency ?? 3));
    this.dependencies = options.dependencies ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async runWorkflow(
    productSeed: ProductSeed,
    classificationContext: ClassificationContext,
    context: SpecialistContext,
    workflowOptions: RunWorkflowOptions = {},
  ): Promise<SpecialistWorkflowResult> {
    const startedAt = Date.now();
    const events: OrchestratorStepEvent[] = [];
    let eventSeq = 0;
    let totalDispatches = 0;
    let retriesCount = 0;

    const invocations = {
      discovery: 0,
      extraction: 0,
      profile: 0,
      resolver: 0,
      curator: 0,
      verifier: 0,
    };

    let discoveryArtifact: SpecialistArtifactEnvelope | undefined;
    let profileArtifact: SpecialistArtifactEnvelope | undefined;
    let resolverArtifact: SpecialistArtifactEnvelope | undefined;
    let curatorArtifact: SpecialistArtifactEnvelope | undefined;
    let verifierArtifact: SpecialistArtifactEnvelope | undefined;

    const makeSnapshot = (
      status: OrchestratorTerminalStatus,
      currentPhase: string,
      error?: string,
    ): WorkflowStateSnapshot => {
      const artifactIds: string[] = [];
      if (discoveryArtifact) artifactIds.push(`${discoveryArtifact.artifactType}:${discoveryArtifact.contentHash}`);
      if (profileArtifact) artifactIds.push(`${profileArtifact.artifactType}:${profileArtifact.contentHash}`);
      if (resolverArtifact) artifactIds.push(`${resolverArtifact.artifactType}:${resolverArtifact.contentHash}`);
      if (curatorArtifact) artifactIds.push(`${curatorArtifact.artifactType}:${curatorArtifact.contentHash}`);
      if (verifierArtifact) artifactIds.push(`${verifierArtifact.artifactType}:${verifierArtifact.contentHash}`);

      return {
        runId: context.runId,
        status,
        currentPhase,
        retriesCount,
        totalDispatches,
        invocations: { ...invocations },
        artifactIds,
        totalDurationMs: Date.now() - startedAt,
        error,
      };
    };

    const recordEvent = (
      specialist: string,
      action: string,
      status: OrchestratorStepEvent['status'],
      durationMs: number,
      details?: string,
    ): void => {
      eventSeq += 1;
      events.push({
        step: eventSeq,
        specialist,
        action,
        status,
        durationMs,
        timestamp: this.now(),
        details,
      });
    };

    const reserveDispatch = (count = 1): boolean => {
      if (totalDispatches + count > this.limits.maxTotalDispatches) {
        return false;
      }
      totalDispatches += count;
      return true;
    };

    const reserveExtractionDispatch = (): boolean => {
      if (invocations.extraction >= this.limits.maxExtractionInvocations) {
        return false;
      }
      if (!reserveDispatch(1)) {
        return false;
      }
      invocations.extraction += 1;
      return true;
    };

    const isAborted = (): boolean => Boolean(context.signal?.aborted);

    if (isAborted()) {
      recordEvent('orchestrator', 'init', 'failed', 0, 'Workflow cancelled before start');
      return {
        runId: context.runId,
        status: 'cancelled',
        productSeed,
        extractionBundles: [],
        events,
        retriesCount: 0,
        totalDispatches: 0,
        totalDurationMs: Date.now() - startedAt,
        workflowState: makeSnapshot('cancelled', 'init', 'Execution cancelled before start'),
        error: 'Execution cancelled',
      };
    }

    const discovery = this.dependencies.discovery ?? new DiscoverySpecialist({}, { codeCommit: captureSpecialistCodeCommit() });
    const profileEngineer = this.dependencies.profileEngineer ?? new ProfileEngineerSpecialist({}, { codeCommit: captureSpecialistCodeCommit() });
    const resolver = this.dependencies.resolver ?? new ResolverSpecialist({ now: this.now });
    const curator = this.dependencies.curator ?? new CuratorSpecialist({ now: this.now });
    const verifier = this.dependencies.verifier ?? new VerifierSpecialist({ now: this.now });

    let discoveryOutput: DiscoverySpecialistOutput | undefined;
    let profileOutput: ProfileEngineerProposal | undefined;
    let extractionBundles: ExtractionEvidenceBundle[] = [];
    let resolverOutput: ResolvedFactSet | undefined;
    let curatorOutput: CuratedProductDraft | undefined;
    let verifierOutput: VerificationReport | undefined;

    let targetPhase: 'discovery' | 'extraction' | 'resolver' | 'curator' | 'verifier' = 'discovery';

    while (totalDispatches < this.limits.maxTotalDispatches) {
      if (isAborted()) {
        recordEvent('orchestrator', 'cancellation_check', 'failed', 0, 'Workflow cancelled by caller');
        return {
          runId: context.runId,
          status: 'cancelled',
          productSeed,
          discoveryOutput,
          discoveryArtifact,
          profileOutput,
          profileArtifact,
          extractionBundles,
          resolverOutput,
          resolverArtifact,
          curatorOutput,
          curatorArtifact,
          verifierOutput,
          verifierArtifact,
          events,
          retriesCount,
          totalDispatches,
          totalDurationMs: Date.now() - startedAt,
          workflowState: makeSnapshot('cancelled', targetPhase, 'Workflow cancelled by caller'),
          error: 'Execution cancelled',
        };
      }

      // Check wall-clock deadline
      if (context.deadlineAt && Date.now() > context.deadlineAt) {
        recordEvent('orchestrator', 'deadline_check', 'failed', 0, 'Execution deadline exceeded');
        return {
          runId: context.runId,
          status: 'budget_exceeded',
          productSeed,
          discoveryOutput,
          discoveryArtifact,
          profileOutput,
          profileArtifact,
          extractionBundles,
          resolverOutput,
          resolverArtifact,
          curatorOutput,
          curatorArtifact,
          verifierOutput,
          verifierArtifact,
          events,
          retriesCount,
          totalDispatches,
          totalDurationMs: Date.now() - startedAt,
          workflowState: makeSnapshot('budget_exceeded', 'deadline_check', 'Execution deadline exceeded'),
          error: 'Execution deadline exceeded',
        };
      }

      switch (targetPhase) {
        case 'discovery': {
          if (invocations.discovery >= this.limits.maxDiscoveryInvocations || !reserveDispatch(1)) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Discovery invocation or total dispatch limit exceeded');
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              extractionBundles: [],
              workflowState: makeSnapshot('budget_exceeded', 'discovery', 'Discovery invocation or dispatch limit reached'),
              error: 'Discovery invocation or dispatch limit reached',
            };
          }

          invocations.discovery += 1;
          const stepStart = Date.now();
          recordEvent('discovery', 'discover_candidates', 'started', 0);

          // Only pass initial discovered GTIN if consumer-scoped (8/12/13 digits) or explicitly case-scoped
          const initialDiscoveredGtin = (() => {
            const raw = workflowOptions.discoveredGtin;
            if (!raw) return null;
            const d = extractDigits(raw);
            if (d.length === 14 && workflowOptions.gtinScope !== 'case') {
              return null;
            }
            return raw;
          })();

          const discResult: SpecialistResult = await discovery.execute(
            {
              schemaVersion: 1,
              productSeed,
              discoveredGtin: initialDiscoveredGtin,
              batchContext: null,
              sourceCandidates: [],
            },
            context,
          );

          const discDuration = Date.now() - stepStart;
          if (discResult.outcome !== 'succeeded' || !discResult.output) {
            if (discResult.outcome === 'abstained') {
              recordEvent('discovery', 'discover_candidates', 'succeeded', discDuration, 'Discovery abstained (no candidates)');
              return {
                runId: context.runId,
                status: 'abstained',
                productSeed,
                extractionBundles,
                events,
                retriesCount,
                totalDispatches,
                totalDurationMs: Date.now() - startedAt,
                workflowState: makeSnapshot('abstained', 'discovery'),
              };
            }
            recordEvent('discovery', 'discover_candidates', 'failed', discDuration, discResult.failure?.message);
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('failed', 'discovery', discResult.failure?.message),
              error: discResult.failure?.message ?? 'Discovery failed',
            };
          }

          const envelope = discResult.output as SpecialistArtifactEnvelope;
          discoveryArtifact = envelope;
          discoveryOutput = envelope.payload as DiscoverySpecialistOutput;

          if (discoveryOutput.candidates.length === 0) {
            recordEvent('discovery', 'discover_candidates', 'succeeded', discDuration, 'Discovery abstained (no candidates)');
            return {
              runId: context.runId,
              status: 'abstained',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('abstained', 'discovery'),
            };
          }

          recordEvent(
            'discovery',
            'discover_candidates',
            'succeeded',
            discDuration,
            `Found ${discoveryOutput.candidates.length} candidates`,
          );
          targetPhase = 'extraction';
          break;
        }

        case 'extraction': {
          const stepStart = Date.now();
          recordEvent('extraction_runner', 'extract_evidence', 'started', 0);

          const candidates = discoveryOutput?.candidates ?? [];
          const candidateUrls = candidates
            .slice(0, 3)
            .map((c) => c.finalUrl ?? c.source.url);

          // Promote GTIN strictly from verified PDP candidate with trusted identifier provenance
          const trustedCandidateGtin = (() => {
            const trusted = candidates.find(
              (c) => (c.pageKind === 'exact_pdp' || c.pageKind === 'probable_pdp') &&
                c.extracted.identifiers.some((i) => i.kind === 'gtin' && Boolean(i.sourceArtifactId) && i.evidenceIds.length > 0),
            )?.extracted.identifiers.find((i) => i.kind === 'gtin')?.value ?? null;
            if (!trusted) return null;
            const d = extractDigits(trusted);
            // 14-digit GTINs are strictly case identifiers; never promote as consumer GTIN unless explicit scope
            if (d.length === 14 && workflowOptions.gtinScope !== 'case') {
              return null;
            }
            return trusted;
          })();

          const genuineDiscoveredGtin = workflowOptions.discoveredGtin ?? discoveryOutput?.discoveredGtin ?? trustedCandidateGtin ?? null;

          let requiresProfileHold = false;

          // Bounded parallel extraction
          extractionBundles = await boundedMap(
            candidateUrls,
            this.extractionConcurrency,
            async (url) => {
              if (!reserveExtractionDispatch()) {
                return {
                  schemaVersion: 1 as const,
                  runnerVersion: '1.0.0',
                  requestedUrl: url,
                  finalUrl: url,
                  retrievedAt: this.now(),
                  contentHash: sha256Hex(url),
                  artifactRefs: [],
                  profile: null,
                  extractionPath: [],
                  observations: [],
                  images: [],
                  variant: null,
                  identityStatus: 'insufficient_evidence' as const,
                  identityReasons: ['Extraction invocation or dispatch limit reached'],
                  failures: [{ code: 'extraction_failed' as const, stage: 'retrieval' as const, message: 'Dispatch limit reached', retryable: false }],
                  deterministicOnly: true,
                };
              }

              const domain = (() => {
                try { return new URL(url).hostname; } catch { return 'unknown'; }
              })();

              // Run extraction
              let bundle: ExtractionEvidenceBundle;
              if (this.dependencies.extractionRunner) {
                bundle = await this.dependencies.extractionRunner(url, context, null);
              } else {
                const { bundle: detBundle } = await runDeterministicExtraction(
                  {
                    url,
                    expected: {
                      gtin: genuineDiscoveredGtin ?? undefined,
                      name: productSeed.name,
                    },
                    signal: context.signal,
                  },
                  this.dependencies.extractionRunnerOptions ?? { now: this.now },
                );
                bundle = detBundle;
              }

              // Check if profile is needed or failed
              const needsProfile = bundle.failures.some((f) => f.code === 'profile_failed' || f.code === 'profile_missing');
              if (needsProfile && invocations.profile < this.limits.maxProfileInvocations) {
                // Find independent candidate URLs on this domain for profile synthesis
                const domainCandidates = candidates.filter((c: DiscoveryCandidate) => {
                  try {
                    const cUrl = c.finalUrl ?? c.source.url;
                    return new URL(cUrl).hostname === domain;
                  } catch {
                    return false;
                  }
                });

                // Profile Engineer strictly requires 2 independent sample pages
                if (domainCandidates.length >= 2) {
                  let leasePromise = activeDomainLeases.get(domain);
                  if (!leasePromise) {
                    if (reserveDispatch(1)) {
                      invocations.profile += 1;
                      recordEvent('profile_engineer', 'synthesize_profile', 'started', 0, `Synthesizing profile proposal for domain: ${domain}`);

                      const sample1 = domainCandidates[0];
                      const sample2 = domainCandidates[1];
                      const sample1Url = sample1.finalUrl ?? sample1.source.url;
                      const sample2Url = sample2.finalUrl ?? sample2.source.url;

                      // Map observed fields to Profile Engineer schema conventions
                      const sample1Obs: Record<string, string> = {};
                      if (sample1.extracted.brand) sample1Obs.brand = sample1.extracted.brand;
                      if (sample1.extracted.productName) sample1Obs.product_name = sample1.extracted.productName;
                      if (sample1.extracted.size) sample1Obs.size = sample1.extracted.size;
                      if (sample1.extracted.sku) sample1Obs.sku = sample1.extracted.sku;
                      if (sample1.extracted.gtins.length > 0) sample1Obs.gtin = sample1.extracted.gtins[0];

                      const sample2Obs: Record<string, string> = {};
                      if (sample2.extracted.brand) sample2Obs.brand = sample2.extracted.brand;
                      if (sample2.extracted.productName) sample2Obs.product_name = sample2.extracted.productName;
                      if (sample2.extracted.size) sample2Obs.size = sample2.extracted.size;
                      if (sample2.extracted.sku) sample2Obs.sku = sample2.extracted.sku;
                      if (sample2.extracted.gtins.length > 0) sample2Obs.gtin = sample2.extracted.gtins[0];

                      // Map selector hints (e.g. titleSelector)
                      const sample1Hints: Record<string, string> = {
                        titleSelector: 'h1.product-title, h1[itemprop="name"], h1',
                      };
                      const sample2Hints: Record<string, string> = {
                        titleSelector: 'h1.product-title, h1[itemprop="name"], h1',
                      };

                      // Use retained page artifact references
                      const sample1Artifacts = sample1.extracted.identifiers
                        .map((i) => i.sourceArtifactId)
                        .filter((id) => Boolean(id));
                      const sample2Artifacts = sample2.extracted.identifiers
                        .map((i) => i.sourceArtifactId)
                        .filter((id) => Boolean(id));

                      const hasSample1Gtin = sample1.extracted.gtins.length > 0;
                      const hasSample2Gtin = sample2.extracted.gtins.length > 0;

                      leasePromise = profileEngineer.execute(
                        {
                          schemaVersion: 1,
                          domain,
                          activeProfile: null,
                          samples: [
                            {
                              url: sample1Url,
                              artifactRefs: sample1Artifacts.length > 0 ? sample1Artifacts : [sha256Hex(sample1Url)],
                              expectedName: productSeed.name,
                              expectedGtin: genuineDiscoveredGtin ?? undefined,
                              signals: {
                                jsonLd: hasSample1Gtin,
                                shopify: sample1.signals.some((s) => s.value.toLowerCase().includes('shopify')),
                                woocommerce: sample1.signals.some((s) => s.value.toLowerCase().includes('woocommerce')),
                                embeddedState: false,
                                selectorOnly: false,
                                changedMarkup: false,
                                wrongVariant: sample1.pageKind === 'wrong_variant',
                              },
                              selectorHints: sample1Hints,
                              observedFields: sample1Obs,
                            },
                            {
                              url: sample2Url,
                              artifactRefs: sample2Artifacts.length > 0 ? sample2Artifacts : [sha256Hex(sample2Url)],
                              expectedName: productSeed.name,
                              expectedGtin: genuineDiscoveredGtin ?? undefined,
                              signals: {
                                jsonLd: hasSample2Gtin,
                                shopify: sample2.signals.some((s) => s.value.toLowerCase().includes('shopify')),
                                woocommerce: sample2.signals.some((s) => s.value.toLowerCase().includes('woocommerce')),
                                embeddedState: false,
                                selectorOnly: false,
                                changedMarkup: false,
                                wrongVariant: sample2.pageKind === 'wrong_variant',
                              },
                              selectorHints: sample2Hints,
                              observedFields: sample2Obs,
                            },
                          ],
                          requiredFields: ['titleSelector'],
                        },
                        context,
                      ).finally(() => {
                        // Release lease on completion or error to prevent stale leases
                        activeDomainLeases.delete(domain);
                      });
                      activeDomainLeases.set(domain, leasePromise);
                    }
                  }

                  if (leasePromise) {
                    const profResult = await leasePromise;
                    if (profResult.outcome === 'succeeded' && profResult.output) {
                      const profEnv = profResult.output as SpecialistArtifactEnvelope;
                      profileArtifact = profEnv;
                      profileOutput = profEnv.payload as ProfileEngineerProposal;

                      // Per ADR 0023/ADR 0028: Profile proposals are proposal_only with manual_review_required.
                      recordEvent(
                        'profile_engineer',
                        'synthesize_profile',
                        'succeeded',
                        0,
                        `Proposed profile for ${domain}; held for manual review/activation`,
                      );
                      requiresProfileHold = true;
                    }
                  }
                }
              }

              return bundle;
            },
          );

          const extractDuration = Date.now() - stepStart;
          recordEvent(
            'extraction_runner',
            'extract_evidence',
            'succeeded',
            extractDuration,
            `Collected ${extractionBundles.length} extraction bundle(s)`,
          );

          if (requiresProfileHold) {
            recordEvent(
              'orchestrator',
              'profile_review_hold',
              'succeeded',
              0,
              'Holding workflow for manual review and activation of proposed profile in Profile Builder',
            );
            return {
              runId: context.runId,
              status: 'needs_review',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              profileOutput,
              profileArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('needs_review', 'extraction_profile_hold'),
            };
          }

          targetPhase = 'resolver';
          break;
        }

        case 'resolver': {
          if (invocations.resolver >= this.limits.maxResolverInvocations || !reserveDispatch(1)) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Resolver invocation or total dispatch limit exceeded');
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('budget_exceeded', 'resolver', 'Resolver invocation or dispatch limit reached'),
              error: 'Resolver invocation or dispatch limit reached',
            };
          }

          invocations.resolver += 1;
          const stepStart = Date.now();
          recordEvent('resolver', 'reconcile_facts', 'started', 0);

          const trustedCandidateGtin = (() => {
            const trusted = discoveryOutput?.candidates.find(
              (c) => (c.pageKind === 'exact_pdp' || c.pageKind === 'probable_pdp') &&
                c.extracted.identifiers.some((i) => i.kind === 'gtin' && Boolean(i.sourceArtifactId) && i.evidenceIds.length > 0),
            )?.extracted.identifiers.find((i) => i.kind === 'gtin')?.value ?? null;
            if (!trusted) return null;
            const d = extractDigits(trusted);
            if (d.length === 14 && workflowOptions.gtinScope !== 'case') {
              return null;
            }
            return trusted;
          })();

          const genuineDiscoveredGtin = workflowOptions.discoveredGtin ?? discoveryOutput?.discoveredGtin ?? trustedCandidateGtin ?? null;
          const effectiveGtinScope = workflowOptions.gtinScope ?? (genuineDiscoveredGtin && extractDigits(genuineDiscoveredGtin).length === 14 ? 'case' : 'consumer_unit');

          const resResult: SpecialistResult = await resolver.execute(
            {
              schemaVersion: '1.0.0',
              productSeed,
              expectedIdentity: {
                gtin: genuineDiscoveredGtin,
                gtinScope: effectiveGtinScope,
              },
              discoveryCandidates: discoveryOutput?.candidates ?? [],
              extractionBundles,
            },
            context,
          );

          const resDuration = Date.now() - stepStart;
          if (resResult.outcome !== 'succeeded' || !resResult.output) {
            recordEvent('resolver', 'reconcile_facts', 'failed', resDuration, resResult.failure?.message);
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('failed', 'resolver', resResult.failure?.message),
              error: resResult.failure?.message ?? 'Resolver failed',
            };
          }

          const envelope = resResult.output as SpecialistArtifactEnvelope;
          resolverArtifact = envelope;
          resolverOutput = envelope.payload as ResolvedFactSet;

          recordEvent(
            'resolver',
            'reconcile_facts',
            'succeeded',
            resDuration,
            `Resolved identity: ${resolverOutput.identity.status}, facts: ${resolverOutput.fieldCompleteness.resolved}/${resolverOutput.fieldCompleteness.total}`,
          );
          targetPhase = 'curator';
          break;
        }

        case 'curator': {
          if (invocations.curator >= this.limits.maxCuratorInvocations || !reserveDispatch(1)) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Curator invocation or total dispatch limit exceeded');
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('budget_exceeded', 'curator', 'Curator invocation or dispatch limit reached'),
              error: 'Curator invocation or dispatch limit reached',
            };
          }

          invocations.curator += 1;
          const stepStart = Date.now();
          recordEvent('curator', 'synthesize_draft', 'started', 0);

          if (!resolverOutput) {
            recordEvent('curator', 'synthesize_draft', 'failed', 0, 'Missing resolved facts');
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('failed', 'curator', 'Missing resolved facts'),
              error: 'Missing resolved facts',
            };
          }

          const curResult: SpecialistResult = await curator.execute(
            {
              schemaVersion: '1.0.0',
              productSeed,
              resolvedFacts: resolverOutput,
              classificationContext,
            },
            context,
          );

          const curDuration = Date.now() - stepStart;
          if (curResult.outcome !== 'succeeded' || !curResult.output) {
            recordEvent('curator', 'synthesize_draft', 'failed', curDuration, curResult.failure?.message);
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('failed', 'curator', curResult.failure?.message),
              error: curResult.failure?.message ?? 'Curator failed',
            };
          }

          const envelope = curResult.output as SpecialistArtifactEnvelope;
          curatorArtifact = envelope;
          curatorOutput = envelope.payload as CuratedProductDraft;

          recordEvent(
            'curator',
            'synthesize_draft',
            'succeeded',
            curDuration,
            `Draft title: '${curatorOutput.catalogTitle}'`,
          );
          targetPhase = 'verifier';
          break;
        }

        case 'verifier': {
          if (invocations.verifier >= this.limits.maxVerifierInvocations || !reserveDispatch(1)) {
            recordEvent('orchestrator', 'budget_check', 'failed', 0, 'Verifier invocation or total dispatch limit exceeded');
            return {
              runId: context.runId,
              status: 'budget_exceeded',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('budget_exceeded', 'verifier', 'Verifier invocation or dispatch limit reached'),
              error: 'Verifier invocation or dispatch limit reached',
            };
          }

          invocations.verifier += 1;
          const stepStart = Date.now();
          recordEvent('verifier', 'verify_quality', 'started', 0);

          if (!resolverOutput || !curatorOutput) {
            recordEvent('verifier', 'verify_quality', 'failed', 0, 'Missing facts or draft for verification');
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('failed', 'verifier', 'Missing facts or draft'),
              error: 'Missing facts or draft',
            };
          }

          const verResult: SpecialistResult = await verifier.execute(
            {
              schemaVersion: '1.0.0',
              productSeed,
              resolvedFacts: resolverOutput,
              curatedDraft: curatorOutput,
              classificationContext,
            },
            context,
          );

          const verDuration = Date.now() - stepStart;
          if (verResult.outcome !== 'succeeded' || !verResult.output) {
            recordEvent('verifier', 'verify_quality', 'failed', verDuration, verResult.failure?.message);
            return {
              runId: context.runId,
              status: 'failed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('failed', 'verifier', verResult.failure?.message),
              error: verResult.failure?.message ?? 'Verifier failed',
            };
          }

          const envelope = verResult.output as SpecialistArtifactEnvelope;
          verifierArtifact = envelope;
          verifierOutput = envelope.payload as VerificationReport;

          recordEvent(
            'verifier',
            'verify_quality',
            'succeeded',
            verDuration,
            `Verdict: ${verifierOutput.verdict}, Score: ${verifierOutput.score}`,
          );

          // Evaluate verdict
          if (verifierOutput.verdict === 'pass') {
            recordEvent('orchestrator', 'terminal_eval', 'succeeded', 0, 'Workflow completed successfully');
            return {
              runId: context.runId,
              status: 'completed',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              profileOutput,
              profileArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              verifierOutput,
              verifierArtifact,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('completed', 'completed'),
            };
          }

          if (retriesCount >= this.maxRetries) {
            recordEvent(
              'orchestrator',
              'retry_limit_reached',
              'succeeded',
              0,
              `Max retries (${this.maxRetries}) reached; holding for human review`,
            );
            return {
              runId: context.runId,
              status: 'needs_review',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              profileOutput,
              profileArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              verifierOutput,
              verifierArtifact,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('needs_review', 'review_hold_retries_exhausted'),
            };
          }

          // Execute structured retry routing
          retriesCount += 1;
          const retry = verifierOutput.retryRequest;

          if (retry?.targetSpecialist === 'curator') {
            recordEvent('orchestrator', 'route_retry', 'retrying', 0, `Retrying curator: ${retry.reason}`);
            targetPhase = 'curator';
          } else if (retry?.targetSpecialist === 'resolver') {
            recordEvent('orchestrator', 'route_retry', 'retrying', 0, `Retrying resolver: ${retry.reason}`);
            targetPhase = 'resolver';
          } else if (retry?.targetSpecialist === 'discovery') {
            recordEvent('orchestrator', 'route_retry', 'retrying', 0, `Retrying discovery: ${retry.reason}`);
            targetPhase = 'discovery';
          } else {
            // Unhandled or human_review verdict
            recordEvent('orchestrator', 'human_review_hold', 'succeeded', 0, 'Holding for human review');
            return {
              runId: context.runId,
              status: 'needs_review',
              productSeed,
              discoveryOutput,
              discoveryArtifact,
              profileOutput,
              profileArtifact,
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              verifierOutput,
              verifierArtifact,
              events,
              retriesCount,
              totalDispatches,
              totalDurationMs: Date.now() - startedAt,
              workflowState: makeSnapshot('needs_review', 'human_review_verdict'),
            };
          }
          break;
        }
      }
    }

    recordEvent('orchestrator', 'dispatch_limit_reached', 'failed', 0, `Exceeded max total dispatches (${this.limits.maxTotalDispatches})`);
    return {
      runId: context.runId,
      status: 'budget_exceeded',
      productSeed,
      discoveryOutput,
      discoveryArtifact,
      profileOutput,
      profileArtifact,
      extractionBundles,
      resolverOutput,
      resolverArtifact,
      curatorOutput,
      curatorArtifact,
      verifierOutput,
      verifierArtifact,
      events,
      retriesCount,
      totalDispatches,
      totalDurationMs: Date.now() - startedAt,
      workflowState: makeSnapshot('budget_exceeded', 'dispatch_limit_reached', 'Exceeded max total dispatches'),
      error: 'Exceeded max total dispatches',
    };
  }
}
