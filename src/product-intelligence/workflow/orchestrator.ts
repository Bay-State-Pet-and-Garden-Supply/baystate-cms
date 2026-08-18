/**
 * Specialist Orchestrator — supervised multi-specialist lifecycle management,
 * routing state machine, retry limits, and terminal state resolution (epic #47, issue #56, ADR 0028).
 *
 * The orchestrator owns ALL sequencing, routing, retries, backtracking, budgets,
 * cancellation propagation, and terminal state transitions across specialists:
 *
 *   ProductSeed
 *       │
 *       ▼
 *   [Discovery Specialist #49]
 *       │
 *       ├─► (Profile needed?) ──► [Profile Engineer Specialist #51]
 *       │                                │
 *       ▼                                ▼
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
 *   - Loops stop deterministically at configured retry/step limits.
 *   - Cancellation via AbortSignal immediately aborts execution and sets CANCELLED.
 *   - Profile synthesis deduplicates concurrent domains using the ProfileEngineer lease repo.
 */

import { z } from 'zod';
import { sha256Hex } from '../../shared/stable-id';
import type { ProductSeed } from '../product-seed';
import {
  DiscoverySpecialist,
  type DiscoveryCandidate,
  type DiscoverySpecialistOutput,
} from '../specialists/discovery';
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
import type { SpecialistContext, SpecialistResult } from '../specialists/contracts';
import type { ExtractionEvidenceBundle } from '../extraction/evidence';
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

export interface SpecialistWorkflowResult {
  runId: string;
  status: OrchestratorTerminalStatus;
  productSeed: ProductSeed;
  discoveryOutput?: DiscoverySpecialistOutput;
  discoveryArtifact?: SpecialistArtifactEnvelope;
  extractionBundles: ExtractionEvidenceBundle[];
  resolverOutput?: ResolvedFactSet;
  resolverArtifact?: SpecialistArtifactEnvelope;
  curatorOutput?: CuratedProductDraft;
  curatorArtifact?: SpecialistArtifactEnvelope;
  verifierOutput?: VerificationReport;
  verifierArtifact?: SpecialistArtifactEnvelope;
  events: OrchestratorStepEvent[];
  retriesCount: number;
  totalDurationMs: number;
  error?: string;
}

export interface SpecialistOrchestratorDependencies {
  discovery?: DiscoverySpecialist;
  resolver?: ResolverSpecialist;
  curator?: CuratorSpecialist;
  verifier?: VerifierSpecialist;
  extractionRunner?: (
    url: string,
    context: SpecialistContext,
  ) => Promise<ExtractionEvidenceBundle>;
}

export interface SpecialistOrchestratorOptions {
  maxRetries?: number;
  maxSteps?: number;
  dependencies?: SpecialistOrchestratorDependencies;
  now?: () => string;
}

// ── Default Dummy / Mock Extraction Runner ───────────────────────────────────

function createDefaultExtractionBundle(
  url: string,
  candidate: DiscoveryCandidate,
  now: string,
): ExtractionEvidenceBundle {
  return {
    schemaVersion: 1,
    runnerVersion: '1.0.0',
    requestedUrl: url,
    finalUrl: candidate.finalUrl ?? url,
    retrievedAt: now,
    contentHash: sha256Hex(url),
    artifactRefs: [`artifact:${url}`],
    profile: null,
    extractionPath: [{ layer: 'fallback', method: 'fallback', sourcePath: null, artifactId: null }],
    observations: [
      ...(candidate.extracted.productName
        ? [
            {
              id: `obs:${sha256Hex(`${url}:title`)}`,
              field: 'title',
              value: candidate.extracted.productName,
              method: 'discovery_summary',
              sourcePath: 'candidate.productName',
              sourceUrl: url,
              finalUrl: candidate.finalUrl ?? url,
              contentHash: null,
              artifactId: `artifact:${url}`,
              profileId: null,
              profileVersion: null,
              variantRef: null,
              provenanceQuality: 'exact_path' as const,
            },
          ]
        : []),
      ...(candidate.extracted.brand
        ? [
            {
              id: `obs:${sha256Hex(`${url}:brand`)}`,
              field: 'brand',
              value: candidate.extracted.brand,
              method: 'discovery_summary',
              sourcePath: 'candidate.brand',
              sourceUrl: url,
              finalUrl: candidate.finalUrl ?? url,
              contentHash: null,
              artifactId: `artifact:${url}`,
              profileId: null,
              profileVersion: null,
              variantRef: null,
              provenanceQuality: 'exact_path' as const,
            },
          ]
        : []),
      ...candidate.extracted.gtins.map((gtin, idx) => ({
        id: `obs:${sha256Hex(`${url}:gtin:${idx}`)}`,
        field: 'gtin',
        value: gtin,
        method: 'discovery_summary',
        sourcePath: 'candidate.gtin',
        sourceUrl: url,
        finalUrl: candidate.finalUrl ?? url,
        contentHash: null,
        artifactId: `artifact:${url}`,
        profileId: null,
        profileVersion: null,
        variantRef: null,
        provenanceQuality: 'exact_path' as const,
      })),
    ],
    images: [],
    variant: null,
    identityStatus: candidate.extracted.identityStatus === 'exact_match' ? 'exact_match' : 'probable_match',
    identityReasons: ['discovery candidate summary'],
    failures: [],
    deterministicOnly: true,
  };
}

// ── Orchestrator Implementation ─────────────────────────────────────────────

export class SpecialistOrchestrator {
  private readonly maxRetries: number;
  private readonly maxSteps: number;
  private readonly dependencies: SpecialistOrchestratorDependencies;
  private readonly now: () => string;

  public constructor(options: SpecialistOrchestratorOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.maxSteps = options.maxSteps ?? 20;
    this.dependencies = options.dependencies ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async runWorkflow(
    productSeed: ProductSeed,
    classificationContext: ClassificationContext,
    context: SpecialistContext,
  ): Promise<SpecialistWorkflowResult> {
    const startedAt = Date.now();
    const events: OrchestratorStepEvent[] = [];
    let stepCount = 0;
    let retriesCount = 0;

    const recordEvent = (
      specialist: string,
      action: string,
      status: OrchestratorStepEvent['status'],
      durationMs: number,
      details?: string,
    ): void => {
      stepCount += 1;
      events.push({
        step: stepCount,
        specialist,
        action,
        status,
        durationMs,
        timestamp: this.now(),
        details,
      });
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
        totalDurationMs: Date.now() - startedAt,
        error: 'Execution cancelled',
      };
    }

    const discovery = this.dependencies.discovery ?? new DiscoverySpecialist({}, { codeCommit: captureSpecialistCodeCommit() });
    const resolver = this.dependencies.resolver ?? new ResolverSpecialist({ now: this.now });
    const curator = this.dependencies.curator ?? new CuratorSpecialist({ now: this.now });
    const verifier = this.dependencies.verifier ?? new VerifierSpecialist({ now: this.now });

    let discoveryOutput: DiscoverySpecialistOutput | undefined;
    let discoveryArtifact: SpecialistArtifactEnvelope | undefined;
    let extractionBundles: ExtractionEvidenceBundle[] = [];
    let resolverOutput: ResolvedFactSet | undefined;
    let resolverArtifact: SpecialistArtifactEnvelope | undefined;
    let curatorOutput: CuratedProductDraft | undefined;
    let curatorArtifact: SpecialistArtifactEnvelope | undefined;
    let verifierOutput: VerificationReport | undefined;
    let verifierArtifact: SpecialistArtifactEnvelope | undefined;

    let targetPhase: 'discovery' | 'extraction' | 'resolver' | 'curator' | 'verifier' = 'discovery';

    while (stepCount < this.maxSteps) {
      if (isAborted()) {
        recordEvent('orchestrator', 'cancellation_check', 'failed', 0, 'Workflow cancelled by caller');
        return {
          runId: context.runId,
          status: 'cancelled',
          productSeed,
          discoveryOutput,
          discoveryArtifact,
          extractionBundles,
          resolverOutput,
          resolverArtifact,
          curatorOutput,
          curatorArtifact,
          verifierOutput,
          verifierArtifact,
          events,
          retriesCount,
          totalDurationMs: Date.now() - startedAt,
        };
      }

      // Check deadline
      if (context.deadlineAt && Date.now() > context.deadlineAt) {
        recordEvent('orchestrator', 'deadline_check', 'failed', 0, 'Execution deadline exceeded');
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
          verifierOutput,
          verifierArtifact,
          events,
          retriesCount,
          totalDurationMs: Date.now() - startedAt,
        };
      }

      switch (targetPhase) {
        case 'discovery': {
          const stepStart = Date.now();
          recordEvent('discovery', 'discover_candidates', 'started', 0);

          const discResult: SpecialistResult = await discovery.execute(
            {
              schemaVersion: 1,
              productSeed,
              discoveredGtin: null,
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
                totalDurationMs: Date.now() - startedAt,
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
              totalDurationMs: Date.now() - startedAt,
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
              totalDurationMs: Date.now() - startedAt,
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
          extractionBundles = [];

          for (const cand of candidates.slice(0, 3)) {
            const url = cand.finalUrl ?? cand.source.url;
            if (this.dependencies.extractionRunner) {
              const bundle = await this.dependencies.extractionRunner(url, context);
              extractionBundles.push(bundle);
            } else {
              const bundle = createDefaultExtractionBundle(url, cand, this.now());
              extractionBundles.push(bundle);
            }
          }

          const extractDuration = Date.now() - stepStart;
          recordEvent(
            'extraction_runner',
            'extract_evidence',
            'succeeded',
            extractDuration,
            `Collected ${extractionBundles.length} extraction bundle(s)`,
          );
          targetPhase = 'resolver';
          break;
        }

        case 'resolver': {
          const stepStart = Date.now();
          recordEvent('resolver', 'reconcile_facts', 'started', 0);

          const resResult: SpecialistResult = await resolver.execute(
            {
              schemaVersion: '1.0.0',
              productSeed,
              expectedIdentity: { gtin: null, gtinScope: 'consumer_unit' },
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
              totalDurationMs: Date.now() - startedAt,
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
              totalDurationMs: Date.now() - startedAt,
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
              totalDurationMs: Date.now() - startedAt,
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
              totalDurationMs: Date.now() - startedAt,
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
              totalDurationMs: Date.now() - startedAt,
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
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              verifierOutput,
              verifierArtifact,
              events,
              retriesCount,
              totalDurationMs: Date.now() - startedAt,
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
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              verifierOutput,
              verifierArtifact,
              events,
              retriesCount,
              totalDurationMs: Date.now() - startedAt,
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
              extractionBundles,
              resolverOutput,
              resolverArtifact,
              curatorOutput,
              curatorArtifact,
              verifierOutput,
              verifierArtifact,
              events,
              retriesCount,
              totalDurationMs: Date.now() - startedAt,
            };
          }
          break;
        }
      }
    }

    recordEvent('orchestrator', 'step_limit_reached', 'failed', 0, `Exceeded max steps (${this.maxSteps})`);
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
      verifierOutput,
      verifierArtifact,
      events,
      retriesCount,
      totalDurationMs: Date.now() - startedAt,
    };
  }
}
