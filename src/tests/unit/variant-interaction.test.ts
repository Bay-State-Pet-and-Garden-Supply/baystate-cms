// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { buildVariantInteractionPlan } from '../../extraction-worker/variant-interaction';
import { resetVariantFlagsOverride, overrideVariantFlags, getEffectiveVariantInteractionEnabled } from '../../onboarding/variant-flags';

describe('variant-interaction', () => {
  afterEach(() => resetVariantFlagsOverride());
  it('builds exact per-axis plan in deterministic axis order', () => {
    const axes = [
      { axis: 'Flavor', selector: '[data-axis="flavor"]', optionType: 'button_group' as const },
      { axis: 'Size', selector: '[data-axis="size"]', optionType: 'dropdown' as const },
    ];
    const opts = [{ axis: 'Size', value: 'Small' }, { axis: 'Flavor', value: 'Beef' }];
    const plan = buildVariantInteractionPlan(axes, opts);
    expect(plan.warnings).toEqual([]);
    // deterministic order by axis name: Flavor then Size
    expect(plan.steps.map(s=>s.axis)).toEqual(['Flavor', 'Size']);
  });
  it('fails closed on missing axis selector', () => {
    const axes = [{ axis: 'Size', selector: '#size', optionType: 'dropdown' as const }];
    const opts = [{ axis: 'Size', value: 'Small' }, { axis: 'Flavor', value: 'Beef' }];
    const plan = buildVariantInteractionPlan(axes, opts);
    expect(plan.warnings.join(' ')).toMatch(/missing axis selector for Flavor/);
    expect(plan.steps.length).toBe(1);
  });
  it('no substring confusion — plan preserves exact value Small vs Small Breed', () => {
    const axes = [{ axis: 'Size', selector: '#size', optionType: 'dropdown' as const }];
    const opts = [{ axis: 'Size', value: 'Small' }];
    const plan = buildVariantInteractionPlan(axes, opts);
    expect(plan.steps[0].value).toBe('Small');
    expect(plan.steps[0].value).not.toBe('Small Breed');
  });
  it('exact per-axis: Small does not resolve Small Breed, and vice versa', () => {
    const axes = [
      { axis: 'BreedSize', selector: '#breed', optionType: 'button_group' as const },
      { axis: 'Size', selector: '#size', optionType: 'dropdown' as const },
    ];
    const optsSmall = [{ axis: 'Size', value: 'Small' }];
    const planSmall = buildVariantInteractionPlan(axes, optsSmall);
    expect(planSmall.steps[0].value).toBe('Small');
    // ensure plan does not auto-expand Small to Small Breed
    expect(planSmall.steps[0].value.length).toBe(5);
    const optsBreed = [{ axis: 'BreedSize', value: 'Small Breed' }];
    const planBreed = buildVariantInteractionPlan(axes, optsBreed);
    expect(planBreed.steps[0].value).toBe('Small Breed');
    expect(planBreed.steps[0].axis).toBe('BreedSize');
  });
  it('strict schema axes enforce exact axis mapping — unknown axis fails closed', () => {
    const axes = [{ axis: 'Color', selector: '#color', optionType: 'radio' as const }];
    const opts = [{ axis: 'Size', value: 'Small' }];
    const plan = buildVariantInteractionPlan(axes, opts);
    expect(plan.warnings.join(' ')).toMatch(/missing axis selector for Size/);
  });
  it('interaction disabled by default (flag false)', () => {
    overrideVariantFlags({ interactionEnabled: false });
    expect(getEffectiveVariantInteractionEnabled()).toBe(false);
  });
  it('gated interaction: no plan when no resolved candidate (caller must check)', () => {
    const plan = buildVariantInteractionPlan([], []);
    expect(plan.steps).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });
});
