/**
 * P2-T6 (packaging-OCR overhaul) — consumer wiring for the `packaging_ocr`
 * classification stage.
 *
 * Covers the SINGLE curation pipeline composition point
 * (`composeCurationPipelineStages`, driven by BOTH the legacy per-item worker
 * path (job-queue.processCuration) AND prepared-cohort member execution via
 * curateItemWithPipeline):
 *
 * - flag OFF (default): exactly today's seven-stage list, no packaging_ocr,
 *   legacy resolveStageOrder byte-identical (flag-off inertness at the
 *   consumer level);
 * - flag ON: packaging_ocr joins FIRST and resolves before
 *   evidence_extraction (its declared dependency);
 * - PI kill-switch dominance: the master flag can never enable the stage
 *   while BAYSTATE_CMS_PI_KILL_SWITCH is set.
 *
 * Pure composition test — no DB needed.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  composeCurationPipelineStages,
} from '../../onboarding/product-curator';
import { resolveStageOrder } from '../../classification/pipeline-runner';
import type { ClassificationStageName } from '../../classification/types';
import {
  getOcrStageFlags,
  overrideOcrStageFlags,
  resetOcrStageFlagsOverride,
} from '../../classification/ocr-stage-flags';

const LEGACY_STAGE_NAMES: ClassificationStageName[] = [
  'evidence_extraction',
  'name_consolidation',
  'primary_product_type_proposal',
  'attribute_applicability',
  'product_attribute_proposals',
  'category_page_proposals',
  'product_draft_projection',
];

/** The pre-existing (flag-OFF) topological execution order produced by
 *  resolveStageOrder over the legacy seven-stage list — captured verbatim so
 *  the flag-OFF assertion proves byte-identical consumer behavior. */
const LEGACY_RESOLVED_ORDER: ClassificationStageName[] = [
  'evidence_extraction',
  'name_consolidation',
  'primary_product_type_proposal',
  'attribute_applicability',
  'category_page_proposals',
  'product_attribute_proposals',
  'product_draft_projection',
];

afterEach(() => {
  resetOcrStageFlagsOverride();
  delete process.env.BAYSTATE_CMS_PI_KILL_SWITCH;
});

describe('curation pipeline stage composition (P2-T6)', () => {
  it('flag OFF (default): composes EXACTLY the legacy seven-stage list with no packaging_ocr', () => {
    // No override → env defaults (master flag false).
    expect(getOcrStageFlags().packagingOcrStageEnabled).toBe(false);

    const stages = composeCurationPipelineStages();
    expect(stages.map(s => s.name)).toEqual(LEGACY_STAGE_NAMES);
    expect(stages.some(s => s.name === 'packaging_ocr')).toBe(false);

    // The executed order is byte-identical to today's legacy resolved order.
    expect(resolveStageOrder(stages)).toEqual(LEGACY_RESOLVED_ORDER);
  });

  it('flag ON: packaging_ocr joins FIRST and resolves before evidence_extraction', () => {
    overrideOcrStageFlags({ packagingOcrStageEnabled: true });

    const stages = composeCurationPipelineStages();
    expect(stages[0].name).toBe('packaging_ocr');
    expect(stages.map(s => s.name)).toEqual(['packaging_ocr', ...LEGACY_STAGE_NAMES]);

    const order = resolveStageOrder(stages);
    expect(order.indexOf('packaging_ocr')).toBeLessThan(order.indexOf('evidence_extraction'));
  });

  it('PI kill-switch dominance: an enabled override cannot add the stage while the kill switch is set', () => {
    overrideOcrStageFlags({ packagingOcrStageEnabled: true });
    process.env.BAYSTATE_CMS_PI_KILL_SWITCH = 'true';
    try {
      expect(getOcrStageFlags().packagingOcrStageEnabled).toBe(false);
      const stages = composeCurationPipelineStages();
      expect(stages.some(s => s.name === 'packaging_ocr')).toBe(false);
      expect(stages.map(s => s.name)).toEqual(LEGACY_STAGE_NAMES);
    } finally {
      delete process.env.BAYSTATE_CMS_PI_KILL_SWITCH;
    }
    // Clearing the env restores normal precedence immediately.
    expect(getOcrStageFlags().packagingOcrStageEnabled).toBe(true);
  });
});
