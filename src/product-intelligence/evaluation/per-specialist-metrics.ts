/**
 * Per-specialist versioned metrics (e03s01 Task 1).
 * Emits quality/provenance/cost/latency/human-correction deltas per specialist
 * version, reusing frozen dataset content-addressed SHA via fixture dataset.
 * Pure module, <200 lines.
 * story: e03s01
 */
import { createHash } from 'node:crypto';
import { buildPiGoldenProducts, PI_GOLDEN_DATASET_VERSION } from './fixture-dataset';
import { aggregatePiComparisons, type PiComparison } from './metrics';

export interface SpecialistVersionMetrics {
  specialist: string;
  version: string;
  datasetVersion: string;
  datasetSha: string;
  sampleSize: number;
  rates: Record<string, number | null>;
  deltas: {
    quality: number | null;
    provenance: number | null;
    cost: number | null;
    latency: number | null;
    humanCorrection: number | null;
  };
}

export function datasetSha(): string {
  const products = buildPiGoldenProducts();
  // Hash the FULL frozen dataset contents (input + gold labels), not just GTIN/name,
  // so any change to the frozen dataset changes the reported content hash.
  const canonical = JSON.stringify(
    products
      .map((p) => ({ input: p.input, gold: p.gold }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function avgRate(comparisons: PiComparison[], key: keyof PiComparison['identity'] | string): number | null {
  const values = comparisons.map((c) => {
    if (key === 'quality') return c.fields.recall;
    if (key === 'provenance') return c.evidenceCoverage.coverage;
    return null;
  });
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

export function computePerSpecialistVersionedMetrics(
  specialist: string,
  version: string,
  comparisons: PiComparison[],
): SpecialistVersionMetrics {
  if (specialist.length === 0) throw new Error('specialist required');
  if (version.length === 0) throw new Error('version required');
  if (comparisons.length === 0) {
    return {
      specialist,
      version,
      datasetVersion: PI_GOLDEN_DATASET_VERSION,
      datasetSha: datasetSha(),
      sampleSize: 0,
      rates: {},
      deltas: { quality: null, provenance: null, cost: null, latency: null, humanCorrection: null },
    };
  }
  const agg = aggregatePiComparisons(comparisons);
  const avgQuality = avgRate(comparisons, 'quality');
  const avgProvenance = avgRate(comparisons, 'provenance');
  const avgCost = agg.ops.totalCostUsd ?? 0;
  const avgLatency = agg.ops.avgDurationMs ?? 0;
  const humanCorrection = comparisons.filter((c) => c.conflicts.falseConflict).length / comparisons.length;
  return {
    specialist,
    version,
    datasetVersion: PI_GOLDEN_DATASET_VERSION,
    datasetSha: datasetSha(),
    sampleSize: comparisons.length,
    rates: agg.rates,
    deltas: {
      quality: avgQuality,
      provenance: avgProvenance,
      cost: avgCost,
      latency: avgLatency,
      humanCorrection,
    },
  };
}

export function compareSpecialistDeltas(
  current: SpecialistVersionMetrics,
  baseline: SpecialistVersionMetrics,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of ['quality', 'provenance', 'cost', 'latency', 'humanCorrection'] as const) {
    const a = current.deltas[k];
    const b = baseline.deltas[k];
    out[k] = a != null && b != null ? a - b : null;
  }
  return out;
}
