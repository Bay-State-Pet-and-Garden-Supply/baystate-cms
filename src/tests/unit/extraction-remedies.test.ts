import { expect, test, describe, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { getDomainStatus, recordDomainStatus, clearDomainStatus } from '../../db/repositories/domain-status-repo';
import { validateExtraction } from '../../onboarding/extraction-validator';

describe('Extraction Remedies and Validation Tests', () => {
  const testDbPath = 'src/tests/unit/extraction-remedies-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  describe('Domain Status Repository', () => {
    test('should record and check domain status correctly', () => {
      const domain = 'earthanimal.com';
      const status = 'blocked';
      const reason = 'Matches WAF block';

      const entry = recordDomainStatus(domain, status, reason);
      expect(entry.domain).toBe('earthanimal.com');
      expect(entry.status).toBe('blocked');
      expect(entry.reason).toBe(reason);

      const retrieved = getDomainStatus(domain);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.status).toBe('blocked');
      expect(retrieved?.reason).toBe(reason);
    });

    test('should normalize domains (lowercase & strip www.)', () => {
      const entry = recordDomainStatus('WWW.EarthAnimal.com', 'offline', 'Offline reason');
      expect(entry.domain).toBe('earthanimal.com');

      const retrieved = getDomainStatus('earthanimal.com');
      expect(retrieved?.status).toBe('offline');
    });

    test('should support clearing domain status', () => {
      const cleared = clearDomainStatus('earthanimal.com');
      expect(cleared).toBe(true);

      const retrieved = getDomainStatus('earthanimal.com');
      expect(retrieved).toBeNull();
    });
  });

  describe('Extraction Validator', () => {
    const expected = {
      name: 'Woof Poomergency Lavender Wet Dog Food',
      brandHint: 'Woof',
    };

    test('should pass valid extractions', () => {
      const data = {
        title: 'Woof Poomergency Lavender Wet Dog Food',
        sourceUrl: 'https://mywoof.com/products/poomergency',
      };
      const result = validateExtraction(data, expected);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    test('should catch empty title as offline', () => {
      const data = {
        title: '',
        sourceUrl: 'https://mywoof.com/products/poomergency',
      };
      const result = validateExtraction(data, expected);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('offline');
      expect(result.reason).toContain('empty');
    });

    test('should catch Cloudflare blocks', () => {
      const data = {
        title: 'Sorry, you have been blocked | Earth Animal',
        sourceUrl: 'https://earthanimal.com/products/rolls',
      };
      const result = validateExtraction(data, expected);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('blocked');
    });

    test('should catch dead page messages', () => {
      const data = {
        title: 'This Shopify store is currently unavailable.',
        sourceUrl: 'https://chefscut.com/products/jerky',
      };
      const result = validateExtraction(data, expected);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('offline');
      expect(result.reason).toContain('unavailable');
    });

    test('should flag catalog mismatches (e.g. Baby Wipes instead of Dog Food)', () => {
      const data = {
        title: 'BABY WIPE PINK 72PC | Price Power USA, Inc.',
        sourceUrl: 'https://pricepower.com/06863',
      };
      const result = validateExtraction(data, expected);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('mismatch');
      expect(result.reason).toContain('Catalog mismatch');
    });
  });
});
