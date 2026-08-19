/**
 * Provider-neutral deterministic extraction evidence runner (issue #52).
 *
 * The runner is intentionally narrower than the general PI extraction ladder:
 * it uses the existing HTTP/structured/platform/profile/browser seams, but it
 * never accepts an LLM adapter and never invokes a managed/model fallback. A
 * caller may supply a policy-gateway-bound fetch through LadderOptions. Replay
 * requests use retained page bytes and therefore do not re-research the page.
 */
import { sha256Hex } from '../../shared/stable-id';
import type { FetchedPage } from './platforms';
import { runExtractionLadder, type LadderOptions } from './ladder';
import type { PageExtractionContract, PageExtractionResult } from '../tools/contract';
import {
  ExtractionEvidenceBundleSchema,
  EXTRACTION_EVIDENCE_RUNNER_VERSION,
  type ExtractionEvidenceBundle,
  type ExtractionFailure,
  type ExtractionProfileBinding,
  toExtractionEvidenceBundle,
} from './evidence';

export const MAX_EXTRACTION_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface RetainedExtractionArtifact {
  artifactId: string;
  /** The artifact is supplied by a trusted server-side artifact reader. */
  content: string;
  contentHash?: string;
  url?: string;
  finalUrl?: string;
  artifactType?: 'page_html' | 'browser_snapshot' | 'browser_network_capture';
  retrievedAt?: string;
}

export interface ExtractionArtifactReader {
  load(artifactId: string, signal: AbortSignal): Promise<RetainedExtractionArtifact | null>;
}

export interface DeterministicExtractionRequest {
  url: string;
  expected?: { gtin?: string; name?: string; brandHint?: string | null };
  signal?: AbortSignal;
  timeoutMs?: number;
  profile?: ExtractionProfileBinding | null;
  /** Existing #48 artifact. When present, the runner parses it without fetch. */
  artifact?: RetainedExtractionArtifact | null;
  artifactId?: string | null;
}

export interface DeterministicExtractionRunnerOptions {
  /** Existing ladder/profile/browser infrastructure. */
  ladder?: LadderOptions;
  /** Server-side artifact loader for replay by artifact id. */
  artifactReader?: ExtractionArtifactReader;
  /** Reuse the policy gateway's decision before any transport is invoked. */
  networkGate?: (url: string, signal: AbortSignal) => Promise<{ allowed: boolean; code?: string; detail?: string }>;
  /** Clock injection makes provenance tests deterministic. */
  now?: () => string;
}

export interface DeterministicExtractionRun {
  bundle: ExtractionEvidenceBundle;
  result: PageExtractionResult;
}

const isHttpUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

function safeFailure(
  code: ExtractionFailure['code'],
  stage: ExtractionFailure['stage'],
  message: string,
  retryable = false,
): ExtractionEvidenceBundle {
  const normalizedUrl = isHttpUrl(message) ? message : 'https://invalid.local/';
  return ExtractionEvidenceBundleSchema.parse({
    schemaVersion: 1,
    runnerVersion: EXTRACTION_EVIDENCE_RUNNER_VERSION,
    requestedUrl: normalizedUrl,
    finalUrl: normalizedUrl,
    retrievedAt: new Date().toISOString(),
    contentHash: null,
    artifactRefs: [],
    profile: null,
    extractionPath: [],
    observations: [],
    images: [],
    variant: null,
    identityStatus: 'insufficient_evidence',
    identityReasons: [message.slice(0, 512)],
    failures: [{ code, stage, message: message.slice(0, 512), retryable }],
    deterministicOnly: true,
  });
}

function replayPage(artifact: RetainedExtractionArtifact, requestedUrl: string): FetchedPage {
  const bytes = Buffer.byteLength(artifact.content, 'utf8');
  if (bytes > MAX_EXTRACTION_RESPONSE_BYTES) throw new Error(`Response too large (${bytes} bytes)`);
  const contentHash = sha256Hex(artifact.content);
  if (artifact.contentHash && artifact.contentHash !== contentHash) throw new Error('retained artifact content hash mismatch');
  return {
    html: artifact.content,
    finalUrl: artifact.finalUrl ?? artifact.url ?? requestedUrl,
    status: 200,
    contentHash,
    artifactId: artifact.artifactId,
  };
}

/**
 * Run deterministic extraction and convert the result into a versioned bundle.
 * Expected failures are represented in the bundle, not thrown, so callers can
 * route blocked pages, missing fields, and wrong variants without string
 * parsing. Unexpected programming errors are also converted fail-closed.
 */
export async function runDeterministicExtraction(
  request: DeterministicExtractionRequest,
  options: DeterministicExtractionRunnerOptions = {},
): Promise<DeterministicExtractionRun> {
  const signal = request.signal ?? new AbortController().signal;
  const now = options.now ?? (() => new Date().toISOString());
  const requestedUrl = request.url;
  if (!isHttpUrl(requestedUrl)) {
    const bundle = safeFailure('invalid_url', 'request', 'extraction URL must use http(s)', false);
    return { bundle: { ...bundle, requestedUrl: 'https://invalid.local/', finalUrl: 'https://invalid.local/' }, result: emptyResult(requestedUrl, 'invalid URL') };
  }
  if (signal.aborted) {
    const bundle = safeFailure('cancelled', 'request', 'extraction cancelled', false);
    return { bundle: { ...bundle, requestedUrl, finalUrl: requestedUrl, retrievedAt: now() }, result: emptyResult(requestedUrl, 'cancelled') };
  }
  let artifact = request.artifact ?? null;
  if (!artifact && request.artifactId && options.artifactReader) {
    try { artifact = await options.artifactReader.load(request.artifactId, signal); } catch { artifact = null; }
  }
  if (request.artifactId && !artifact) {
    const bundle = safeFailure('artifact_unavailable', 'replay', `retained artifact unavailable: ${request.artifactId}`, false);
    return { bundle: { ...bundle, requestedUrl, finalUrl: requestedUrl, retrievedAt: now(), artifactRefs: [request.artifactId] }, result: emptyResult(requestedUrl, 'artifact unavailable') };
  }

  if (!artifact && options.networkGate) {
    try {
      const decision = await options.networkGate(requestedUrl, signal);
      if (!decision.allowed) {
        const message = `network denied${decision.code ? `: ${decision.code}` : ''}${decision.detail ? ` (${decision.detail})` : ''}`;
        const bundle = safeFailure('policy_denied', 'policy', message, false);
        return { bundle: { ...bundle, requestedUrl, finalUrl: requestedUrl, retrievedAt: now() }, result: emptyResult(requestedUrl, message) };
      }
    } catch {
      const bundle = safeFailure('policy_denied', 'policy', 'network policy check failed', false);
      return { bundle: { ...bundle, requestedUrl, finalUrl: requestedUrl, retrievedAt: now() }, result: emptyResult(requestedUrl, 'network policy check failed') };
    }
  }

  try {
    // Never pass model or managed fallback capabilities through this runner.
    // Replay is a strict retained-bytes interpreter: no policy check, profile,
    // browser, interaction, platform, managed, or model transport survives.
    const replay = !!artifact;
    const ladder: LadderOptions = replay ? {
      fetchPage: async () => replayPage(artifact!, requestedUrl),
      fetchShopify: async () => { throw new Error('platform artifact not retained'); },
      profiles: [],
      browser: null,
      interaction: null,
      managedFallback: null,
      llm: null,
    } : {
      ...(options.ladder ?? {}),
      llm: null,
      managedFallback: null,
      networkGate: options.networkGate ?? options.ladder?.networkGate,
    };
    const { result, layersUsed, profile: selectedProfile } = await runExtractionLadder(
      requestedUrl,
      request.expected ?? {},
      signal,
      Math.max(1, Math.min(request.timeoutMs ?? 30_000, 3_600_000)),
      ladder,
    );
    let bundle = toExtractionEvidenceBundle(result, {
      // Only the profile path selected and executed by the ladder may attach
      // profile provenance. Request metadata is never authoritative.
      profile: selectedProfile ?? null,
      artifactId: artifact?.artifactId ?? request.artifactId ?? result.artifactRef,
      retrievedAt: artifact?.retrievedAt ?? now(),
    });
    if (layersUsed.includes('profile_failed')) {
      bundle = {
        ...bundle,
        failures: [...bundle.failures, {
          code: 'profile_failed',
          stage: 'profile_selector',
          message: 'approved profile selector extraction failed',
          retryable: true,
        }],
      };
    }
    if (layersUsed.includes('profile_miss')) {
      bundle = {
        ...bundle,
        failures: [...bundle.failures, {
          code: 'profile_missing',
          stage: 'profile_selector',
          message: 'no approved profile available for domain',
          retryable: true,
        }],
      };
    }
    return { bundle: ExtractionEvidenceBundleSchema.parse(bundle), result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    const code: ExtractionFailure['code'] = /too large|size/i.test(message)
      ? 'response_too_large'
      : /403|401|429|blocked|cloudflare|captcha|just a moment/i.test(lower)
        ? 'blocked'
        : /artifact/i.test(lower)
          ? 'artifact_unavailable'
          : 'extraction_failed';
    const stage: ExtractionFailure['stage'] = code === 'blocked' || code === 'response_too_large' ? 'retrieval' : artifact ? 'replay' : 'retrieval';
    const bundle = safeFailure(code, stage, message, code === 'blocked');
    return { bundle: { ...bundle, requestedUrl, finalUrl: requestedUrl, retrievedAt: now(), profile: null, artifactRefs: artifact ? [artifact.artifactId] : [] }, result: emptyResult(requestedUrl, message) };
  }
}

/** Replay convenience API: requires retained bytes and never invokes transport. */
export async function replayDeterministicExtraction(
  artifact: RetainedExtractionArtifact,
  request: Omit<DeterministicExtractionRequest, 'artifact' | 'artifactId'>,
  options: Omit<DeterministicExtractionRunnerOptions, 'artifactReader'> = {},
): Promise<DeterministicExtractionRun> {
  if (!artifact || typeof artifact.content !== 'string' || !artifact.artifactId) {
    const url = request.url;
    const bundle = safeFailure('artifact_unavailable', 'replay', 'retained artifact bytes unavailable', false);
    return { bundle: { ...bundle, requestedUrl: url, finalUrl: url, retrievedAt: (options.now ?? (() => new Date().toISOString()))() }, result: emptyResult(url, 'artifact unavailable') };
  }
  // Deliberately discard all caller transports/capabilities. The artifact is
  // the only input replay may interpret.
  return runDeterministicExtraction({ ...request, artifact }, { now: options.now });
}

function emptyResult(url: string, reason: string): PageExtractionResult {
  return {
    requestedUrl: url,
    finalUrl: url,
    fetchModes: [],
    contentHash: null,
    artifactRef: null,
    fields: [],
    gtins: [],
    sku: null,
    brand: null,
    productName: null,
    variant: null,
    size: null,
    packCount: null,
    images: [],
    conflicts: [{ field: '_runner', summary: reason.slice(0, 300) }],
    identityStatus: 'insufficient_evidence',
    identityReasons: [reason.slice(0, 300)],
    deterministicOnly: true,
  };
}

export class DeterministicExtractionRunner {
  constructor(private readonly options: DeterministicExtractionRunnerOptions = {}) {}
  run(request: DeterministicExtractionRequest): Promise<DeterministicExtractionRun> {
    return runDeterministicExtraction(request, this.options);
  }
}

/** Provider-neutral production contract backed by the evidence runner. */
export function createDeterministicExtractionContract(options: DeterministicExtractionRunnerOptions = {}): PageExtractionContract {
  return {
    name: 'deterministic_extraction_evidence',
    version: EXTRACTION_EVIDENCE_RUNNER_VERSION,
    async extract(request) {
      const run = await runExtractionEvidence({
        url: request.url,
        expected: request.expected,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
      }, options);
      return run.result;
    },
  };
}

/** Naming alias used by provider-neutral extraction callers. */
export const runExtractionEvidence = runDeterministicExtraction;
