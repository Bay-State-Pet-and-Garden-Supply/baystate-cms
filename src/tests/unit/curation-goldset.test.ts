// story: e05s03
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';

interface GoldEntry {
  sku: string;
  familyId: string | null;
  variantTokens: string[];
  expectedCuratedTitle: string;
  applicability: Record<string, string>;
  categoryPages: { expected: string[]; species: string };
  storedLlmTitle: string | null;
  deterministicFallbackTitle: string;
}

interface GoldFile {
  entries: GoldEntry[];
  version: number;
}

interface EvalFile {
  goldsetSha256: string;
}

function loadGold(): GoldFile {
  const raw = fs.readFileSync('src/tests/fixtures/curation-goldset.json', 'utf8');
  return JSON.parse(raw) as GoldFile;
}

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[-\s]+/g, ' ').trim().replace(/[()]/g, '');
}

function hasVariantToken(title: string, token: string): boolean {
  const normTitle = normalizeToken(title.toLowerCase());
  const normTok = normalizeToken(token.toLowerCase());
  if (normTok.length < 2) return true;
  // SM/LG/MD map to Small/Large/Medium in deterministic titles
  const aliasMap: Record<string, string[]> = { sm: ['small'], md: ['medium'], lg: ['large'] };
  const aliases = aliasMap[normTok] ?? [];
  if (normTitle.includes(normTok)) return true;
  return aliases.some(a => normTitle.includes(a));
}

describe('curation goldset // story: e05s03', () => {
  test('fixture exists and has 5+ families+singletons structure', () => {
    const raw = fs.readFileSync('src/tests/fixtures/curation-goldset.json', 'utf8');
    expect(raw).toContain('// story: e05s03');
    const gold = loadGold();
    expect(gold.version).toBe(1);
    expect(gold.entries.length).toBeGreaterThanOrEqual(6);
    const families = new Set(gold.entries.filter(e => e.familyId).map(e => e.familyId as string));
    expect(families.size).toBeGreaterThanOrEqual(2);
    const singletons = gold.entries.filter(e => !e.familyId);
    expect(singletons.length).toBeGreaterThanOrEqual(3);
  });

  test('each entry covers title variant preservation + applicability + category pages', () => {
    const gold = loadGold();
    for (const e of gold.entries) {
      expect(e.sku).toMatch(/^GOLD-/);
      expect(Array.isArray(e.variantTokens) && e.variantTokens.length > 0).toBe(true);
      expect(typeof e.expectedCuratedTitle).toBe('string');
      expect(typeof e.applicability).toBe('object');
      expect(Array.isArray(e.categoryPages.expected)).toBe(true);
      expect(typeof e.categoryPages.species).toBe('string');
      expect(typeof e.deterministicFallbackTitle).toBe('string');
    }
  });

  test('deterministic fallback stored titles are non-empty and plausible length', () => {
    const gold = loadGold();
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const e of gold.entries) {
      expect(e.deterministicFallbackTitle.length).toBeGreaterThan(5);
      expect(norm(e.deterministicFallbackTitle).length).toBeGreaterThan(5);
    }
  });

  test('stored LLM titles preserve variant tokens (no drop)', () => {
    const gold = loadGold();
    for (const e of gold.entries) {
      if (!e.storedLlmTitle) continue;
      // assert every protected variant token appears (with alias normalization for SM/LG/MD)
      for (const tok of e.variantTokens) {
        expect(hasVariantToken(e.storedLlmTitle, tok)).toBe(true);
      }
      // also ensure deterministic fallback preserves tokens
      for (const tok of e.variantTokens) {
        expect(hasVariantToken(e.deterministicFallbackTitle, tok)).toBe(true);
      }
      expect(e.storedLlmTitle.length).toBeGreaterThan(5);
    }
  });

  test('goldset hash matches curation-eval.json baseline', () => {
    const buf = fs.readFileSync('src/tests/fixtures/curation-goldset.json');
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const evalJson = JSON.parse(fs.readFileSync('specs/metrics/curation-eval.json', 'utf8')) as EvalFile;
    expect(hash).toBe(evalJson.goldsetSha256);
  });
});
