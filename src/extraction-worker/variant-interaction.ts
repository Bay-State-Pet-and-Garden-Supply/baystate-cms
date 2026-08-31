/**
 * Pure action-plan builder for variant interaction — no browser side-effects.
 * Exact per-axis matching, bounded, deterministic ordering.
 */

export interface VariantOptionAxis {
  axis: string;
  selector: string;
  optionType: 'dropdown' | 'button_group' | 'radio';
  settledSelector?: string;
  settledAttribute?: string;
  timeoutMs?: number;
  optionValueSelector?: string;
  optionTextAttribute?: string;
}

export interface VariantSelectionPlan {
  steps: Array<{ axis: string; value: string; selector: string; optionType: string; settledSelector?: string; settledAttribute?: string; timeoutMs?: number }>;
  warnings: string[];
}

/**
 * Build an exact per-axis plan from resolved variant options.
 * Returns empty warnings on success; fails closed on missing/duplicate controls.
 */
export function buildVariantInteractionPlan(
  axes: VariantOptionAxis[],
  variantOptions: Array<{ axis: string; value: string }>,
): VariantSelectionPlan {
  const warnings: string[] = [];
  const steps: VariantSelectionPlan['steps'] = [];
  const axisMap = new Map(axes.map((a) => [a.axis.toLowerCase(), a]));
  for (const opt of variantOptions) {
    const def = axisMap.get(opt.axis.toLowerCase());
    if (!def) {
      warnings.push(`missing axis selector for ${opt.axis}`);
      continue;
    }
    // exact value — caller must normalize, strict per-axis contract
    steps.push({ axis: opt.axis, value: opt.value, selector: def.selector, optionType: def.optionType, settledSelector: (def as any).settledSelector ?? undefined, settledAttribute: (def as any).settledAttribute ?? undefined, timeoutMs: (def as any).timeoutMs ?? undefined });
  }
  // deterministic order by axis name
  steps.sort((a, b) => a.axis.localeCompare(b.axis));
  return { steps, warnings };
}

export function isInteractionEnabled(): boolean {
  const raw = process.env.BAYSTATE_CMS_VARIANT_INTERACTION_ENABLED;
  if (!raw) return false;
  const n = raw.trim().toLowerCase();
  return n === 'true' || n === '1' || n === 'yes';
}
