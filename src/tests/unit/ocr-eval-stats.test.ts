import { describe, expect, it } from 'vitest';
import { wilsonInterval } from '../../onboarding/ocr-eval/stats';

describe('wilsonInterval (ocr-eval stats)', () => {
  it('matches known bounds for p̂=0.5, n=20', () => {
    const { lower, upper } = wilsonInterval(0.5, 20);
    expect(lower).toBeCloseTo(0.299, 2);
    expect(upper).toBeCloseTo(0.701, 2);
  });

  it('degenerate n=1 gives a wide interval inside [0,1]', () => {
    const { lower, upper } = wilsonInterval(1, 1);
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(upper).toBeLessThanOrEqual(1);
    expect(lower).toBeLessThan(upper);
    expect(lower).toBeLessThan(0.5);
    expect(upper).toBeGreaterThan(0.5);
  });

  it('n<=0 returns a degenerate zero interval', () => {
    expect(wilsonInterval(0.5, 0)).toEqual({ lower: 0, upper: 0 });
  });

  it('narrows monotonically as n grows', () => {
    const width = (n: number) => {
      const { lower, upper } = wilsonInterval(0.7, n);
      return upper - lower;
    };
    expect(width(200)).toBeLessThan(width(100));
    expect(width(100)).toBeLessThan(width(50));
  });
});
