import { describe, expect, it } from 'vitest';
import { timingSafeCompare } from '../../shared/timing-safe';

describe('timingSafeCompare', () => {
  it('returns true when strings are identical', () => {
    expect(timingSafeCompare('Bearer secret-token-123', 'Bearer secret-token-123')).toBe(true);
    expect(timingSafeCompare('', '')).toBe(true);
  });

  it('returns false when strings differ', () => {
    expect(timingSafeCompare('Bearer secret-token-123', 'Bearer wrong-token-123')).toBe(false);
    expect(timingSafeCompare('Bearer secret-token-123', 'Bearer secret-token-12')).toBe(false);
    expect(timingSafeCompare('a', 'b')).toBe(false);
  });

  it('handles non-string arguments safely', () => {
    expect(timingSafeCompare(null as any, 'secret')).toBe(false);
    expect(timingSafeCompare('secret', undefined as any)).toBe(false);
  });
});
