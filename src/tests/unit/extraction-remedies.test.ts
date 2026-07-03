import { expect, test, describe, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  getDomainStatus,
  recordDomainStatus,
  clearDomainStatus,
  listAllDomainStatuses,
} from '../../db/repositories/domain-status-repo';
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

  describe('listAllDomainStatuses (read-only diagnostics)', () => {
    test('returns rows sorted by domain ascending', () => {
      recordDomainStatus('zeta.example.com', 'ok', 'zeta reason');
      recordDomainStatus('alpha.example.com', 'blocked', 'alpha reason');
      recordDomainStatus('mid.example.com', 'offline', 'mid reason');

      const all = listAllDomainStatuses();
      const domains = all.map((r) => r.domain);
      expect(domains).toEqual([...domains].sort());
      expect(domains).toContain('alpha.example.com');
      expect(domains).toContain('mid.example.com');
      expect(domains).toContain('zeta.example.com');
    });

    test('returns a >7-day-old row without deleting it', () => {
      const domain = 'ancient.example.com';
      recordDomainStatus(domain, 'blocked', 'long-running block');

      // Manually rewind checked_at to 30 days ago.
      const db = getDb();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      db.query('UPDATE domain_status SET checked_at = ? WHERE domain = ?').run(thirtyDaysAgo, domain);

      // listAllDomainStatuses must surface the stale row.
      const rows = listAllDomainStatuses();
      const found = rows.find((r) => r.domain === domain);
      expect(found).toBeDefined();
      expect(found?.status).toBe('blocked');
      expect(found?.reason).toBe('long-running block');

      // And critically: the row must still exist in the table.
      const stillThere = db
        .query('SELECT COUNT(*) as count FROM domain_status WHERE domain = ?')
        .get(domain) as { count: number };
      expect(stillThere.count).toBe(1);

      // For comparison: getDomainStatus() WOULD have deleted it.
      const evicted = getDomainStatus(domain);
      expect(evicted).toBeNull();
      const after = db
        .query('SELECT COUNT(*) as count FROM domain_status WHERE domain = ?')
        .get(domain) as { count: number };
      expect(after.count).toBe(0);
    });

    test('returns no rows when the table is empty', () => {
      // Clear any rows from earlier tests to validate the empty case.
      const db = getDb();
      db.query('DELETE FROM domain_status').run();

      const all = listAllDomainStatuses();
      expect(all).toEqual([]);
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
