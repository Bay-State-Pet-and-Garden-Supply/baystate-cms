import { describe, expect, it } from 'vitest';
import { safeTimingEqual } from '../../shared/timing-safe';

describe('safeTimingEqual', () => {
  it('returns true for matching strings', () => {
    expect(safeTimingEqual('secret-token-123', 'secret-token-123')).toBe(true);
    expect(safeTimingEqual('', '')).toBe(true);
  });

  it('returns false for mismatched strings', () => {
    expect(safeTimingEqual('secret-token-123', 'secret-token-456')).toBe(false);
    expect(safeTimingEqual('secret-token-123', 'secret-token-1234')).toBe(false);
    expect(safeTimingEqual('secret-token-123', '')).toBe(false);
    expect(safeTimingEqual('a', 'b')).toBe(false);
  });
});
