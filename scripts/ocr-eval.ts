#!/usr/bin/env bun
/**
 * Packaging-OCR golden-set evaluation CLI (packaging-OCR overhaul P3-T1/T3).
 *
 * Thin wrapper: all logic lives in `src/onboarding/ocr-eval/*` so the
 * vitest/bun suites exercise the same code. Manual rollout action per
 * docs/runbooks/packaging-ocr-model-rollout.md — never runs in tests/CI and
 * makes NO network calls beyond the candidate baseUrls you pass (models
 * must already be pulled locally; this script never downloads anything).
 *
 * Usage:
 *   bun run scripts/ocr-eval.ts \
 *     --dataset src/onboarding/ocr-eval/datasets/packaging-ocr-golden-v1.json \
 *     --data-dir data/ocr-eval/packaging-ocr-golden-v1 \
 *     --candidate qwen2.5vl:latest@http://localhost:11434 \
 *     --candidate qwen3-vl:8b@http://localhost:11434 \
 *     [--baseline-model qwen2.5vl:latest]
 *
 * Reports are written to stdout as JSON (see the runbook for the shape).
 */
import {
  loadGoldenDatasetFromJson,
} from '../src/onboarding/ocr-eval/golden-dataset.ts';
import { evaluateCandidatesAgainstGolden } from '../src/onboarding/ocr-eval/runner.ts';
import { evaluateRolloutGate } from '../src/onboarding/ocr-eval/metrics.ts';
import { DEFAULT_LOCAL_VISION_MODEL } from '../src/shared/vision-model-defaults.ts';

export function main(argv: string[]): void {
  const args = argv.slice();
  let datasetPath: string | null = null;
  let dataDir: string | undefined;
  let baselineModel = DEFAULT_LOCAL_VISION_MODEL;
  const candidates: Array<{ model: string; baseUrl: string }> = [];

  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case '--dataset':
        datasetPath = args.shift() ?? null;
        break;
      case '--data-dir':
        dataDir = args.shift();
        break;
      case '--baseline-model':
        baselineModel = args.shift() ?? baselineModel;
        break;
      case '--candidate': {
        // Format: model@baseUrl (e.g. qwen3-vl:8b@http://localhost:11434)
        const spec = args.shift() ?? '';
        const at = spec.lastIndexOf('@');
        if (at <= 0 || at === spec.length - 1) {
          console.error(`Invalid --candidate "${spec}" (expected model@baseUrl).`);
          process.exit(2);
        }
        candidates.push({ model: spec.slice(0, at), baseUrl: spec.slice(at + 1) });
        break;
      }
      default:
        console.error(`Unknown argument "${flag}".`);
        process.exit(2);
    }
  }

  if (!datasetPath || candidates.length === 0) {
    console.error('--dataset and at least one --candidate are required.');
    process.exit(2);
  }

  // Post-review fixup 5: duplicate candidate models resolve to duplicate
  // labels and would silently collide in the runner — reject up front.
  if (new Set(candidates.map(c => c.model)).size !== candidates.length) {
    console.error('Duplicate --candidate models are not allowed; each candidate needs a unique model.');
    process.exit(2);
  }

  // Ensure the baseline itself is evaluated so deltas exist.
  if (!candidates.some(c => c.model === baselineModel)) {
    const first = candidates[0]!;
    if (!candidates.some(c => c.baseUrl === first.baseUrl && c.model === baselineModel)) {
      candidates.unshift({ model: baselineModel, baseUrl: first.baseUrl });
    }
  }

  const raw = Bun.file(datasetPath);
  raw.text().then(async text => {
    loadGoldenDatasetFromJson(text); // validate + digest before running
    const result = await evaluateCandidatesAgainstGolden(text, {
      datasetDir: dataDir,
      candidates,
      baselineModel,
      fetchFn: fetch, // direct transport to the configured local baseUrls only
    });
    const withGates = result.reports.map(r => ({
      ...r,
      rolloutGate: evaluateRolloutGate(r),
    }));
    console.log(JSON.stringify({ ...result, reports: withGates }, null, 2));
  }).catch(err => {
    console.error(`[ocr-eval] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

if (import.meta.main === true) {
  main(process.argv.slice(2));
}
