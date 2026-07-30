import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inferBrandFromSearchResults, inferDomainForBrand } from '../../onboarding/brand-inferrer';
import * as llmClient from '../../onboarding/llm-client';
import * as brandSiteRepo from '../../db/repositories/brand-site-repo';

vi.mock('../../onboarding/llm-client', () => ({
  callLlmForTask: vi.fn(),
}));

vi.mock('../../db/repositories/brand-site-repo', () => ({
  listAllBrandSites: vi.fn(),
}));

describe('Brand Inferrer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('inferDomainForBrand', () => {
    it('should correctly infer official domain matching the brand slug', () => {
      const searchResults = [
        { link: 'https://www.nylabone.com/products/chew-toy' },
        { link: 'https://www.chewy.com/nylabone-power-chew/dp/12345' },
        { link: 'https://nylabone.com/about' },
        { link: 'https://www.amazon.com/Nylabone-Chew-Ring/dp/B000' }
      ];

      const domain = inferDomainForBrand('Nylabone', searchResults);
      expect(domain).toBe('nylabone.com');
    });

    it('returns the registrable brand domain instead of a store subdomain', () => {
      const searchResults = [
        { link: 'https://shop.nylabone.com/products/chew-toy' },
        { link: 'https://support.nylabone.com/article/123' },
      ];

      expect(inferDomainForBrand('Nylabone', searchResults)).toBe('nylabone.com');
    });

    it('should ignore common retailers when inferring domain', () => {
      const searchResults = [
        { link: 'https://www.chewy.com/nylabone' },
        { link: 'https://www.amazon.com/nylabone' }
      ];

      const domain = inferDomainForBrand('Nylabone', searchResults);
      expect(domain).toBeNull();
    });
  });

  describe('inferBrandFromSearchResults (Heuristic)', () => {
    it('should match known brand from brand_sites table', async () => {
      // Mock LLM to throw/fail so it falls back to heuristics
      vi.spyOn(llmClient, 'callLlmForTask').mockRejectedValue(new Error('LLM not configured'));

      vi.spyOn(brandSiteRepo, 'listAllBrandSites').mockReturnValue([
        { id: '1', brandName: 'nylabone', domain: 'nylabone.com', successCount: 1, lastUsedAt: null, createdAt: '', urlPattern: null, sourceStrategy: 'official_first' },
        { id: '2', brandName: 'kong', domain: 'kongcompany.com', successCount: 1, lastUsedAt: null, createdAt: '', urlPattern: null, sourceStrategy: 'official_first' }
      ]);

      const searchResults = [
        { title: 'Nylabone Power Chew Durable Ring Dog Chew Toy', snippet: 'Buy Nylabone Power Chew ring...', link: 'https://www.chewy.com/nylabone-ring' },
        { title: 'Amazon.com: Nylabone Giant Ring Chew Toy', snippet: 'Nylabone classic ring toy is perfect...', link: 'https://www.amazon.com/nylabone-giant-ring' }
      ];

      const result = await inferBrandFromSearchResults('12345', searchResults);
      expect(result).not.toBeNull();
      expect(result?.brand).toBe('nylabone');
      expect(result?.source).toBe('heuristic');
      expect(result?.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('rejects low-confidence heuristic inference', async () => {
      vi.spyOn(llmClient, 'callLlmForTask').mockRejectedValue(new Error('LLM not configured'));
      vi.spyOn(brandSiteRepo, 'listAllBrandSites').mockReturnValue([]);

      const result = await inferBrandFromSearchResults('12345', [
        { title: 'MaybeBrand Dog Toy', snippet: '', link: 'https://retailer-one.example/item' },
        { title: 'MaybeBrand Pet Toy', snippet: '', link: 'https://retailer-two.example/item' },
      ]);
      expect(result).toBeNull();
    });

    it('should infer new brand using frequency analysis on capitalized words when brand is unknown', async () => {
      vi.spyOn(llmClient, 'callLlmForTask').mockRejectedValue(new Error('LLM not configured'));
      vi.spyOn(brandSiteRepo, 'listAllBrandSites').mockReturnValue([]);

      const searchResults = [
        { title: 'Benebone Wishbone Durable Dog Chew Toy', snippet: 'Benebone is made in USA...', link: 'https://www.benebone.com/wishbone' },
        { title: 'Benebone Wishbone Bacon Flavor Medium Dog Chew', snippet: 'Shop Benebone bacon wishbone...', link: 'https://www.amazon.com/benebone' },
        { title: 'Benebone Durable Chew For Dogs Medium Bacon', snippet: 'Dogs love Benebone chew...', link: 'https://www.petco.com/benebone' }
      ];

      const result = await inferBrandFromSearchResults('12345', searchResults);
      expect(result).not.toBeNull();
      expect(result?.brand).toBe('Benebone');
      expect(result?.source).toBe('heuristic');
      expect(result?.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result?.inferredDomain).toBe('benebone.com');
    });
  });

  describe('inferBrandFromSearchResults (LLM)', () => {
    it('should successfully parse LLM JSON response', async () => {
      vi.spyOn(llmClient, 'callLlmForTask').mockResolvedValue(JSON.stringify({
        brand: 'Kong',
        confidence: 0.95
      }));

      const searchResults = [
        { title: 'KONG Classic Dog Toy Red Medium', snippet: 'The KONG classic is gold standard...', link: 'https://www.kongcompany.com/products/classic' }
      ];

      const result = await inferBrandFromSearchResults('12345', searchResults);
      expect(result).not.toBeNull();
      expect(result?.brand).toBe('Kong');
      expect(result?.source).toBe('llm');
      expect(result?.confidence).toBe(0.95);
      expect(result?.inferredDomain).toBe('kongcompany.com');
    });

    it('clamps LLM confidence to the valid range', async () => {
      vi.spyOn(llmClient, 'callLlmForTask').mockResolvedValue(JSON.stringify({
        brand: 'Kong',
        confidence: 4.2,
      }));

      const result = await inferBrandFromSearchResults('12345', [
        { title: 'KONG Classic Dog Toy', snippet: '', link: 'https://kongcompany.com/classic' },
      ]);
      expect(result?.confidence).toBe(1);
    });

    it('should fall back to heuristics if LLM response is malformed', async () => {
      vi.spyOn(llmClient, 'callLlmForTask').mockResolvedValue('Not JSON');
      vi.spyOn(brandSiteRepo, 'listAllBrandSites').mockReturnValue([
        { id: '2', brandName: 'kong', domain: 'kongcompany.com', successCount: 1, lastUsedAt: null, createdAt: '', urlPattern: null, sourceStrategy: 'official_first' }
      ]);

      const searchResults = [
        { title: 'KONG Classic Dog Toy Red Medium', snippet: 'The KONG classic is gold standard...', link: 'https://www.chewy.com/kong' },
        { title: 'Amazon.com: KONG Classic Red Dog Toy', snippet: 'KONG Classic Red Dog Toy...', link: 'https://www.amazon.com/kong' }
      ];

      const result = await inferBrandFromSearchResults('12345', searchResults);
      expect(result).not.toBeNull();
      expect(result?.brand).toBe('kong');
      expect(result?.source).toBe('heuristic');
    });
  });
});
