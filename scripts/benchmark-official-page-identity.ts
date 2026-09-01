import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GoldIdentityBenchmarkRecord } from './generate-gold-benchmark';

export {
  validateGtinChecksum,
  normalizeGtinDigits,
  canonicalGtinMatch,
} from '../src/shared/gtin';
import {
  extractStructuredGtinsFromHtml,
  qualifyIdentityProof,
  extractVerificationSignals,
} from '../src/onboarding/page-verifier';

export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url.replace(/^(?:https?:\/\/)?(?:www\.)?([^/]+).*$/, '$1').toLowerCase();
  }
}

// ─── Wilson Score Interval ───────────────────────────────────────────────────

export interface WilsonInterval {
  center: number;
  lower: number;
  upper: number;
}

export function computeWilsonScoreInterval(k: number, n: number, z = 1.959964): WilsonInterval {
  if (n === 0) {
    return { center: 1.0, lower: 1.0, upper: 1.0 };
  }
  const z2 = z * z;
  const pCenter = (k + z2 / 2) / (n + z2);
  const varianceTerm = (k * (n - k)) / n + z2 / 4;
  const pMargin = (z * Math.sqrt(varianceTerm)) / (n + z2);
  return {
    center: Math.min(1.0, Math.max(0.0, pCenter)),
    lower: Math.min(1.0, Math.max(0.0, pCenter - pMargin)),
    upper: Math.min(1.0, Math.max(0.0, pCenter + pMargin)),
  };
}

// ─── Evaluators ─────────────────────────────────────────────────────────────

export interface EvaluationResult {
  autoSelected: boolean;
  proofClass: 'exact_structured_gtin' | 'exact_variant_gtin' | 'none';
  authorityMatch: boolean;
  reasons: string[];
}

/**
 * Old Relaxed Evaluator:
 * Replicates the legacy `page-verifier.ts` + `job-queue.ts` logic.
 * Vulnerabilities: accepts `officialDomainResult` at title overlap >= 0.25,
 * accepts naive substring UPC match in HTML body/reviews, accepts weak JSON-LD combos.
 */
export function evaluateOldRelaxed(record: GoldIdentityBenchmarkRecord): EvaluationResult {
  const html = record.fixture.html;
  const candidateDomain = extractDomain(record.candidate.url);
  const officialDomains = record.item.officialDomains.map(d => d.replace(/^www\./, '').toLowerCase());
  const domainOfficial = officialDomains.includes(candidateDomain);

  // Check page type signals
  const isListingOrSearchPage = /category-listing|collection-page|search-results-page|\/collections\/|\/search\?/i.test(html) || /<body[^>]*class=["'][^"']*(?:collection|search)[^"']*["']/i.test(html);
  const isBlogOrCmsPage = /blog-post-article|\/blogs\//i.test(html);

  // Token overlap calculation
  const targetTokens = record.item.expectedName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const lowerHtml = html.toLowerCase();
  let tokenHits = 0;
  for (const t of targetTokens) {
    if (lowerHtml.includes(t)) tokenHits++;
  }
  const titleOverlap = targetTokens.length > 0 ? tokenHits / targetTokens.length : 0;

  // UPC substring match
  const upcDigits = record.item.rawUpc.replace(/\D+/g, '');
  const upcInPage = upcDigits.length >= 8 && html.includes(upcDigits);

  // SKU presence
  const skuInPage = /"sku"\s*:\s*"[^"]+"/i.test(html) || /SKU-/i.test(html);
  const hasJsonLdProduct = /"@type"\s*:\s*"Product"/i.test(html);

  // Old job-queue relaxed rule:
  // if domainOfficial && !listing && !blog && (titleOverlap >= 0.25 || skuInPage) -> auto-selects!
  if (domainOfficial && !isListingOrSearchPage && !isBlogOrCmsPage && (titleOverlap >= 0.25 || skuInPage)) {
    return {
      autoSelected: true,
      proofClass: upcInPage ? 'exact_structured_gtin' : 'none',
      authorityMatch: domainOfficial,
      reasons: ['relaxed_official_domain_match', `title_overlap_${(titleOverlap * 100).toFixed(0)}%`],
    };
  }

  // Old page-verifier strong proof rule:
  if (upcInPage && domainOfficial) {
    return {
      autoSelected: true,
      proofClass: 'exact_structured_gtin',
      authorityMatch: domainOfficial,
      reasons: ['upc_substring_in_page'],
    };
  }

  if (hasJsonLdProduct && titleOverlap >= 0.4 && domainOfficial) {
    return {
      autoSelected: true,
      proofClass: 'none',
      authorityMatch: domainOfficial,
      reasons: ['jsonld_product_and_title_overlap'],
    };
  }

  return {
    autoSelected: false,
    proofClass: 'none',
    authorityMatch: domainOfficial,
    reasons: ['no_relaxed_signals'],
  };
}

/**
 * Strict GTIN Evaluator:
 * Implements the P1-A strict official-page identity gate.
 * Invariants:
 * 1. Authority Gate: Domain MUST be in item's official domains.
 * 2. GTIN must be extracted from structured data (JSON-LD Product, ProductGroup, Microdata, Meta, Shopify productJSON).
 * 3. GTIN must satisfy GS1 checksum validation.
 * 4. GTIN must canonically match target item's GTIN.
 * 5. Page must not be listing/search/blog.
 * 6. No contradictory structured GTINs.
 * 7. Substring UPCs in body/review text are ignored.
 */
export function evaluateStrictGtin(record: GoldIdentityBenchmarkRecord): EvaluationResult {
  const html = record.fixture.html;
  const candidateDomain = extractDomain(record.candidate.url);
  const officialDomains = record.item.officialDomains.map(d => d.replace(/^www\./, '').toLowerCase());
  const authorityMatch = officialDomains.includes(candidateDomain);

  // If authority fails, cannot auto-select (routes to review / needs_input)
  if (!authorityMatch) {
    return {
      autoSelected: false,
      proofClass: 'none',
      authorityMatch: false,
      reasons: ['authority_gate_failed'],
    };
  }

  const signals = extractVerificationSignals(html, record.candidate.url, {
    upc: record.item.rawUpc,
    expectedName: record.item.expectedName,
    brandHint: record.item.brandHint,
    officialDomains: record.item.officialDomains,
  });

  const extractedGtins = extractStructuredGtinsFromHtml(html);
  const { proofClass, decisionReason } = qualifyIdentityProof(extractedGtins, record.item.rawUpc, signals);

  const autoSelected = proofClass === 'exact_structured_gtin' || proofClass === 'exact_variant_gtin';

  return {
    autoSelected,
    proofClass,
    authorityMatch: true,
    reasons: [decisionReason],
  };
}

// ─── Confusion Matrix & Metrics ──────────────────────────────────────────────

export interface ConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  total: number;
  precision: number;
  recall: number;
  specificity: number;
  wilsonPrecision: WilsonInterval;
  wilsonRecall: WilsonInterval;
}

export function computeConfusionMatrix(records: GoldIdentityBenchmarkRecord[], evaluator: (r: GoldIdentityBenchmarkRecord) => EvaluationResult): ConfusionMatrix {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  for (const record of records) {
    const res = evaluator(record);
    const expected = record.groundTruth.expectedAutoSelect;
    const actual = res.autoSelected;

    if (expected && actual) {
      tp++;
    } else if (!expected && actual) {
      fp++;
    } else if (!expected && !actual) {
      tn++;
    } else {
      fn++;
    }
  }

  const total = records.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1.0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1.0;
  const specificity = tn + fp > 0 ? tn / (tn + fp) : 1.0;
  const wilsonPrecision = computeWilsonScoreInterval(tp, tp + fp);
  const wilsonRecall = computeWilsonScoreInterval(tp, tp + fn);

  return {
    tp,
    fp,
    tn,
    fn,
    total,
    precision,
    recall,
    specificity,
    wilsonPrecision,
    wilsonRecall,
  };
}

// ─── CLI Benchmark Execution ─────────────────────────────────────────────────

export interface StratumMetric {
  stratum: string;
  count: number;
  expectedPositives: number;
  expectedNegatives: number;
  strictTp: number;
  strictFp: number;
  strictTn: number;
  strictFn: number;
  oldFp: number;
}

export interface BenchmarkReport {
  meta: {
    timestamp: string;
    fixturePath: string;
    totalRecords: number;
    positives: number;
    hardNegatives: number;
  };
  oldRelaxed: ConfusionMatrix;
  strictGtin: ConfusionMatrix;
  strata: StratumMetric[];
  deltas: {
    falsePositivesEliminated: number;
    deltaNeedsInputCount: number;
    deltaNeedsInputRate: number;
  };
  activationFloor: {
    passed: boolean;
    zeroFalsePositives: boolean;
    pointPrecisionMet: boolean;
    wilsonLowerBoundMet: boolean;
    validGtinRecallMet: boolean;
  };
}

export function runBenchmark(fixturePath: string, jsonOutputPath?: string, _verbose = false): BenchmarkReport {
  const content = fs.readFileSync(fixturePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const records: GoldIdentityBenchmarkRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    const parsed: GoldIdentityBenchmarkRecord = JSON.parse(lines[i]);
    // Verify SHA256 content hash
    const computedHash = createHash('sha256').update(parsed.fixture.html, 'utf8').digest('hex');
    if (computedHash !== parsed.fixture.contentHash) {
      throw new Error(`Content hash mismatch at record ${parsed.id}: expected ${parsed.fixture.contentHash}, computed ${computedHash}`);
    }
    records.push(parsed);
  }

  const oldMatrix = computeConfusionMatrix(records, evaluateOldRelaxed);
  const strictMatrix = computeConfusionMatrix(records, evaluateStrictGtin);

  // Stratum metrics
  const strataMap = new Map<string, StratumMetric>();
  for (const record of records) {
    const s = record.groundTruth.stratum;
    if (!strataMap.has(s)) {
      strataMap.set(s, {
        stratum: s,
        count: 0,
        expectedPositives: 0,
        expectedNegatives: 0,
        strictTp: 0,
        strictFp: 0,
        strictTn: 0,
        strictFn: 0,
        oldFp: 0,
      });
    }
    const sm = strataMap.get(s)!;
    sm.count++;
    if (record.groundTruth.expectedAutoSelect) {
      sm.expectedPositives++;
    } else {
      sm.expectedNegatives++;
    }

    const strictRes = evaluateStrictGtin(record);
    const oldRes = evaluateOldRelaxed(record);

    if (record.groundTruth.expectedAutoSelect && strictRes.autoSelected) sm.strictTp++;
    else if (!record.groundTruth.expectedAutoSelect && strictRes.autoSelected) sm.strictFp++;
    else if (!record.groundTruth.expectedAutoSelect && !strictRes.autoSelected) sm.strictTn++;
    else sm.strictFn++;

    if (!record.groundTruth.expectedAutoSelect && oldRes.autoSelected) {
      sm.oldFp++;
    }
  }

  const strata = Array.from(strataMap.values());
  const positives = records.filter(r => r.groundTruth.expectedAutoSelect).length;
  const hardNegatives = records.filter(r => !r.groundTruth.expectedAutoSelect).length;

  const oldNeedsInput = records.filter(r => !evaluateOldRelaxed(r).autoSelected).length;
  const strictNeedsInput = records.filter(r => !evaluateStrictGtin(r).autoSelected).length;
  const deltaNeedsInputCount = strictNeedsInput - oldNeedsInput;
  const deltaNeedsInputRate = deltaNeedsInputCount / records.length;
  const falsePositivesEliminated = oldMatrix.fp - strictMatrix.fp;

  const zeroFp = strictMatrix.fp === 0;
  const pointPrecisionMet = strictMatrix.precision === 1.0;
  const wilsonLowerMet = strictMatrix.wilsonPrecision.lower >= 0.95;
  const validRecallMet = strictMatrix.recall >= 0.99;
  const passed = zeroFp && pointPrecisionMet && wilsonLowerMet && validRecallMet;

  const report: BenchmarkReport = {
    meta: {
      timestamp: new Date().toISOString(),
      fixturePath,
      totalRecords: records.length,
      positives,
      hardNegatives,
    },
    oldRelaxed: oldMatrix,
    strictGtin: strictMatrix,
    strata,
    deltas: {
      falsePositivesEliminated,
      deltaNeedsInputCount,
      deltaNeedsInputRate,
    },
    activationFloor: {
      passed,
      zeroFalsePositives: zeroFp,
      pointPrecisionMet,
      wilsonLowerBoundMet: wilsonLowerMet,
      validGtinRecallMet: validRecallMet,
    },
  };

  // Console formatting
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('         OFFICIAL-PAGE IDENTITY GOLD BENCHMARK RESULTS (G0.2)                  ');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`Total Labeled Pairs: ${records.length} (${positives} Positives, ${hardNegatives} Hard Negatives)\n`);

  console.log('┌─────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ 1. COMPARATIVE CONFUSION MATRIX & ACCURACY SUMMARY                          │');
  console.log('├──────────────────────────────┬──────────────────────┬───────────────────────┤');
  console.log('│ Metric                       │ Old Relaxed Selector │ Strict GTIN Gate      │');
  console.log('├──────────────────────────────┼──────────────────────┼───────────────────────┤');
  console.log(`│ True Positives (TP)          │ ${String(oldMatrix.tp).padEnd(20)} │ ${String(strictMatrix.tp).padEnd(21)} │`);
  console.log(`│ False Positives (FP) [DEFECT]│ ${String(oldMatrix.fp).padEnd(20)} │ ${String(strictMatrix.fp).padEnd(21)} │`);
  console.log(`│ True Negatives (TN)          │ ${String(oldMatrix.tn).padEnd(20)} │ ${String(strictMatrix.tn).padEnd(21)} │`);
  console.log(`│ False Negatives (FN)         │ ${String(oldMatrix.fn).padEnd(20)} │ ${String(strictMatrix.fn).padEnd(21)} │`);
  console.log('├──────────────────────────────┼──────────────────────┼───────────────────────┤');
  console.log(`│ Point Precision              │ ${(oldMatrix.precision * 100).toFixed(2)}%${' '.repeat(14)} │ ${(strictMatrix.precision * 100).toFixed(2)}%${' '.repeat(15)} │`);
  console.log(`│ Wilson 95% Precision CI      │ [${(oldMatrix.wilsonPrecision.lower * 100).toFixed(1)}%, ${(oldMatrix.wilsonPrecision.upper * 100).toFixed(1)}%]${' '.repeat(6)} │ [${(strictMatrix.wilsonPrecision.lower * 100).toFixed(1)}%, ${(strictMatrix.wilsonPrecision.upper * 100).toFixed(1)}%]${' '.repeat(7)} │`);
  console.log(`│ Point Recall                 │ ${(oldMatrix.recall * 100).toFixed(2)}%${' '.repeat(14)} │ ${(strictMatrix.recall * 100).toFixed(2)}%${' '.repeat(15)} │`);
  console.log(`│ Specificity (Neg TN Rate)    │ ${(oldMatrix.specificity * 100).toFixed(2)}%${' '.repeat(14)} │ ${(strictMatrix.specificity * 100).toFixed(2)}%${' '.repeat(15)} │`);
  console.log('└──────────────────────────────┴──────────────────────┴───────────────────────┘\n');

  console.log('┌─────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ 2. STRATUM BREAKDOWN (STRICT GTIN EVALUATOR)                                │');
  console.log('├──────────────────────────────────────┬──────┬──────┬──────┬──────┬──────────┤');
  console.log('│ Stratum                              │ Total│ Strict│ Strict│ Old  │ FP Elim. │');
  console.log('│                                      │ Pairs│  TP   │  FP   │  FP  │          │');
  console.log('├──────────────────────────────────────┼──────┼──────┼──────┼──────┼──────────┤');
  for (const s of strata) {
    const sName = s.stratum.length > 36 ? s.stratum.slice(0, 33) + '...' : s.stratum.padEnd(36);
    console.log(`│ ${sName} │ ${String(s.count).padStart(4)} │ ${String(s.strictTp).padStart(4)} │ ${String(s.strictFp).padStart(4)} │ ${String(s.oldFp).padStart(4)} │ ${String(s.oldFp - s.strictFp).padStart(8)} │`);
  }
  console.log('└──────────────────────────────────────┴──────┴──────┴──────┴──────┴──────────┘\n');

  console.log('┌─────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ 3. GATE 0 ACTIVATION FLOOR VERIFICATION                                     │');
  console.log('├────────────────────────────────────────┬───────────┬──────────────┬─────────┤');
  console.log('│ Invariant                              │ Required  │ Measured     │ Status  │');
  console.log('├────────────────────────────────────────┼───────────┼──────────────┼─────────┤');
  console.log(`│ Zero False Positives (FP == 0)         │ 0         │ ${strictMatrix.fp}${' '.repeat(12 - String(strictMatrix.fp).length)} │ ${zeroFp ? 'PASS \u2713' : 'FAIL \u2717'}   │`);
  console.log(`│ Point Precision == 1.0 (100.0%)        │ 100.0%    │ ${(strictMatrix.precision * 100).toFixed(1)}%${' '.repeat(8)} │ ${pointPrecisionMet ? 'PASS \u2713' : 'FAIL \u2717'}   │`);
  console.log(`│ Wilson 95% Precision Lower Bound       │ >= 95.0%  │ ${(strictMatrix.wilsonPrecision.lower * 100).toFixed(2)}%${' '.repeat(7)} │ ${wilsonLowerMet ? 'PASS \u2713' : 'FAIL \u2717'}   │`);
  console.log(`│ Valid GTIN Recall                      │ >= 99.0%  │ ${(strictMatrix.recall * 100).toFixed(2)}%${' '.repeat(7)} │ ${validRecallMet ? 'PASS \u2713' : 'FAIL \u2717'}   │`);
  console.log('└────────────────────────────────────────┴───────────┴──────────────┴─────────┘\n');

  console.log(`Summary: False Positives Eliminated = ${falsePositivesEliminated} | Delta Needs Input = +${deltaNeedsInputCount} (+${(deltaNeedsInputRate * 100).toFixed(1)}%)\n`);

  if (jsonOutputPath) {
    fs.mkdirSync(path.dirname(jsonOutputPath), { recursive: true });
    fs.writeFileSync(jsonOutputPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`Baseline report written to ${jsonOutputPath}\n`);
  }

  return report;
}

// ─── CLI Entrypoint ──────────────────────────────────────────────────────────

if (import.meta.main || process.argv[1]?.endsWith('benchmark-official-page-identity.ts')) {
  const args = process.argv.slice(2);
  let fixturePath = path.join(__dirname, '../src/tests/fixtures/onboarding/official-page-identity-gold.jsonl');
  let jsonPath: string | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fixture' && args[i + 1]) {
      fixturePath = path.resolve(args[++i]);
    } else if (args[i] === '--json' && args[i + 1]) {
      jsonPath = path.resolve(args[++i]);
    } else if (args[i] === '--verbose') {
      verbose = true;
    }
  }

  try {
    const report = runBenchmark(fixturePath, jsonPath, verbose);
    if (!report.activationFloor.passed) {
      console.error('ACTIVATION FLOOR FAILED');
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('Benchmark execution error:', err);
    process.exit(1);
  }
}
