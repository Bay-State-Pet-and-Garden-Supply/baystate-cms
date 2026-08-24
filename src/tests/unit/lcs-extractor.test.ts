import { describe, expect, test } from 'vitest';
import { extractConsensusName, longestCommonSubstring } from '../../onboarding/lcs-extractor';

describe('longestCommonSubstring', () => {
  test('returns empty string for empty input', () => {
    expect(longestCommonSubstring('', 'test')).toBe('');
    expect(longestCommonSubstring('test', '')).toBe('');
    expect(longestCommonSubstring('', '')).toBe('');
  });

  test('extracts exact match preserving original casing from first string', () => {
    expect(longestCommonSubstring('Hello World', 'hello world')).toBe('Hello World');
  });

  test('extracts longest common substring between search result titles', () => {
    const a = 'Woof Honest Chew Natural Antler Dog Chew, Small - Amazon.com';
    const b = 'Woof Honest Chew Antler Small | Chewy';
    expect(longestCommonSubstring(a, b)).toBe('Woof Honest Chew ');
  });

  test('returns empty string when no characters match', () => {
    expect(longestCommonSubstring('abc', 'xyz')).toBe('');
  });

  test('handles substring at beginning, middle, and end', () => {
    expect(longestCommonSubstring('prefix_target_suffix', 'target')).toBe('target');
    expect(longestCommonSubstring('start_foo', 'foo_end')).toBe('foo');
  });
});

describe('extractConsensusName', () => {
  test('returns null when given fewer than 2 titles', () => {
    expect(extractConsensusName([])).toBeNull();
    expect(extractConsensusName(['Single Title'])).toBeNull();
  });

  test('derives consensus product name from multiple marketplace titles', () => {
    const titles = [
      'Woof Honest Chew Natural Antler Dog Chew, Small - Amazon.com',
      'Woof Honest Chew Antler Small | Chewy',
      'Woof Honest Chew Antler Sm Dog Treat | Petco',
    ];
    const consensus = extractConsensusName(titles);
    expect(consensus).toBe('Woof Honest Chew');
  });

  test('strips common site suffixes before computing consensus', () => {
    const titles = [
      'Acme Super Widget 100 - Amazon.com',
      'Acme Super Widget 100 | Chewy.com',
      'Acme Super Widget 100 | Walmart.com',
    ];
    const consensus = extractConsensusName(titles);
    expect(consensus).toBe('Acme Super Widget 100');
  });

  test('returns null if common substring length is below minLength', () => {
    const titles = ['Cat Toy', 'Cat Bed'];
    expect(extractConsensusName(titles, 10)).toBeNull();
  });
});
