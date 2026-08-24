/**
 * Packaging-OCR evaluation runner (packaging-OCR overhaul P3-T1).
 *
 * Evaluates candidate local vision models against a frozen golden dataset by
 * invoking the REAL OCR core (`runPackagingOcrAttempt`) — same prompt, same
 * parser/coercion, same circuit-breaker and local-slot semantics (`callVlm`
 * keeps its `acquireLocalSlot('ollama')` discipline) — with per-candidate
 * routing injected via `vlmConfigOverride` and the transport injected via
 * `modelFetchFn` (the pinned network seam). In production the fetch points
 * at a locally-running Ollama; the operator pulls models manually. The
 * harness NEVER downloads models and makes no network calls beyond the
 * configured local baseUrl(s); all tests inject mock transports.
 *
 * Execution is strictly sequential: candidates one at a time, items within a
 * candidate one at a time, honoring the global local-slot semaphore inside
 * callVlm.
 *
 * Golden images are staged into a per-run temp directory and loaded through
 * the normal LOCAL-path branch of `loadImageWithReason`, so no golden image
 * is ever fetched over the network during evaluation.
 */

import fsMod from 'node:fs';
import pathMod from 'node:path';
import { runPackagingOcrAttempt } from '../packaging-ocr';
import type { ExtractPackagingOcrParams } from '../packaging-ocr';
import type { NetworkFetch } from '../vlm-client';
import { isLoopbackBaseUrl } from '../../classification/model-policy-gateway';
import {
  decodeInlineImage,
  isInlineImageRef,
  loadGoldenDatasetFromJson,
  type GoldenOcrEntry,
  type LoadedGoldenDataset,
} from './golden-dataset';
import {
  aggregateCandidateReport,
  type OcrComparisonReport,
  type OcrItemOutcome,
} from './metrics';

/** Routing for one evaluated model. */
export interface OcrEvalCandidateConfig {
  /** Local Ollama base URL (loopback). */
  baseUrl: string;
  /** Pulled model tag (e.g. 'qwen3-vl:8b'). */
  model: string;
  /** Stable report key; defaults to `model`. */
  label?: string;
}

export interface OcrEvalRunOptions {
  /**
   * Directory used to resolve relative `imageRef` paths (convention:
   * data/ocr-eval/<dataset-name>/). Required unless every entry is inline.
   */
  datasetDir?: string;
  candidates: OcrEvalCandidateConfig[];
  /** Baseline model id recorded on reports (e.g. DEFAULT_LOCAL_VISION_MODEL). */
  baselineModel?: string;
  /**
   * Which candidate report serves as the delta baseline. Defaults to the
   * candidate whose model matches `baselineModel`, else the first candidate.
   * The baseline report itself carries `vsBaseline.hasBaseline = false`.
   */
  baselineLabel?: string;
  /**
   * Injected VLM transport. REQUIRED (tests always inject mocks; production
   * callers bind a passthrough to their local Ollama base URL).
   */
  fetchFn: NetworkFetch;
}

export interface OcrEvalRunResult {
  datasetName: string;
  datasetDigest: string;
  baselineModel: string;
  reports: OcrComparisonReport[];
  itemOutcomes: Record<string, OcrItemOutcome[]>;
}

/**
 * Resolve an entry's imageRef to bytes WITHOUT any network access.
 * Inline refs decode directly; file refs are read from disk under
 * datasetDir. Returns null when neither is possible — the caller fails
 * closed before any model call.
 */
function resolveEntryImageBytes(entry: GoldenOcrEntry, datasetDir?: string): Buffer | null {
  if (isInlineImageRef(entry)) {
    return decodeInlineImage(entry);
  }
  if (!datasetDir) return null;
  const root = pathMod.resolve(datasetDir);
  const resolved = pathMod.resolve(root, entry.imageRef);
  // Refuse refs that escape the dataset directory.
  if (!resolved.startsWith(root + pathMod.sep)) return null;
  try {
    if (!fsMod.existsSync(resolved)) return null;
    const buf = fsMod.readFileSync(resolved);
    // Mirror loadImageWithReason's minimum-size rule so golden entries that
    // would be rejected as "too small" fail loudly at load time, not mid-run.
    if (buf.length < 1024) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Evaluate all candidates sequentially against the frozen dataset.
 *
 * Accepts either a pre-loaded dataset object or raw JSON text (which is
 * validated + digested here so CLI callers can pipe a file straight in).
 */
export async function evaluateCandidatesAgainstGolden(
  rawDatasetJson: string | LoadedGoldenDataset,
  options: OcrEvalRunOptions,
): Promise<OcrEvalRunResult> {
  const dataset = typeof rawDatasetJson === 'string'
    ? loadGoldenDatasetFromJson(rawDatasetJson)
    : rawDatasetJson;

  if (options.candidates.length === 0) {
    throw new Error('OCR eval requires at least one candidate.');
  }

  // Post-review fixup 5: duplicate candidate labels (label ?? model) would
  // silently collide — the later candidate's itemOutcomes overwrite the
  // earlier one's under the same key. Reject BEFORE any model call.
  const seenLabels = new Set<string>();
  for (const candidate of options.candidates) {
    const label = candidate.label ?? candidate.model;
    if (seenLabels.has(label)) {
      throw new Error(
        `OCR eval candidates must resolve to unique labels; "${label}" appears more than once. Set an explicit distinct 'label' per candidate.`,
      );
    }
    seenLabels.add(label);
  }

  // Post-review security fixup (eval loopback-only): every candidate baseUrl
  // must resolve to THIS machine BEFORE any golden image is staged or any
  // transport call is made. The harness contract is strictly local-only.
  for (const candidate of options.candidates) {
    if (!isLoopbackBaseUrl(candidate.baseUrl)) {
      throw new Error(
        `OCR eval candidate "${candidate.label ?? candidate.model}" has a non-loopback baseUrl (${candidate.baseUrl}); the evaluation harness may only target loopback endpoints.`,
      );
    }
  }

  const resolvedBaselineModel = options.baselineModel ?? 'unknown-baseline';

  // Resolve every golden image up front (fail closed before any model call).
  const osMod = await import('node:os');
  const bytesByEntry = new Map<string, Buffer>();
  for (const entry of dataset.entries) {
    const buf = resolveEntryImageBytes(entry, options.datasetDir);
    if (!buf) {
      throw new Error(
        `Cannot resolve image for golden entry "${entry.id}" (missing datasetDir, unreadable file, or undersized/invalid inline payload).`,
      );
    }
    bytesByEntry.set(entry.id, buf);
  }

  // Stage golden bytes into one temp directory; each entry becomes NNNN.bin
  // (index-based names keep ids from becoming path fragments).
  const tempDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'ocr-eval-'));
  const stagedPathByEntry = new Map<string, string>();
  try {
    dataset.entries.forEach((entry, idx) => {
      const fileName = `${String(idx).padStart(4, '0')}.bin`;
      fsMod.writeFileSync(pathMod.join(tempDir, fileName), bytesByEntry.get(entry.id)!);
      stagedPathByEntry.set(entry.id, fileName);
    });

    const entryExpected = dataset.entries.map(e => ({ id: e.id, expected: e.expected }));
    const itemOutcomes: Record<string, OcrItemOutcome[]> = {};

    for (const candidate of options.candidates) {
      const label = candidate.label ?? candidate.model;
      const outcomes: OcrItemOutcome[] = [];
      for (const entry of dataset.entries) {
        const attemptParams: ExtractPackagingOcrParams = {
          // Not remote → the local-file loader resolves imageLocalPath below.
          imageUrl: `golden://${entry.id}`,
          imageLocalPath: stagedPathByEntry.get(entry.id),
          workspacePath: tempDir,
          sku: `ocr-eval:${entry.id}`,
          modelFetchFn: options.fetchFn,
          vlmConfigOverride: { baseUrl: candidate.baseUrl, model: candidate.model, enabled: true },
        };
        const startedAt = Date.now();
        const result = await runPackagingOcrAttempt(attemptParams);
        const latencyMs = Date.now() - startedAt;
        outcomes.push(
          result.ok
            ? { entryId: entry.id, ok: true, latencyMs, data: result.data }
            : { entryId: entry.id, ok: false, latencyMs, reasonCode: result.reasonCode },
        );
      }
      itemOutcomes[label] = outcomes;
    }

    // Aggregate reports; attach baseline deltas for every non-baseline report.
    const baselineLabel =
      options.baselineLabel
      ?? options.candidates.find(c => c.model === resolvedBaselineModel)?.label
      ?? options.candidates[0].label
      ?? options.candidates[0].model;
    const baselineOutcomes = itemOutcomes[baselineLabel] ?? null;
    const baselineReport = baselineOutcomes
      ? aggregateCandidateReport(baselineLabel, baselineOutcomes, {
          baselineModel: resolvedBaselineModel,
          datasetEntries: entryExpected,
        })
      : null;
    const reports: OcrComparisonReport[] = [];
    for (const candidate of options.candidates) {
      const label = candidate.label ?? candidate.model;
      reports.push(
        aggregateCandidateReport(label, itemOutcomes[label], {
          baselineModel: resolvedBaselineModel,
          baselineReport: label === baselineLabel ? undefined : baselineReport ?? undefined,
          datasetEntries: entryExpected,
        }),
      );
    }

    return {
      datasetName: dataset.name,
      datasetDigest: dataset.digest,
      baselineModel: resolvedBaselineModel,
      reports,
      itemOutcomes,
    };
  } finally {
    try {
      fsMod.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
