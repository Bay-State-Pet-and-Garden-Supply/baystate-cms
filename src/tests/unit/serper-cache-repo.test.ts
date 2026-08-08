import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  getCachedSerperResults,
  insertSerperCache,
  clearSerperCache,
  type SerperSearchResult,
} from '../../db/repositories/serper-cache-repo';

describe('Serper Cache Repository', () => {
  const testDbPath = '/tmp/baystate-cms-serper-cache-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('should return null when cache is empty', () => {
    const cached = getCachedSerperResults('non-existent-query');
    expect(cached).toBeNull();
  });

  it('should insert and retrieve cached serper results', () => {
    const query = 'test query';
    const mockResults: SerperSearchResult[] = [
      {
        title: 'Test Title 1',
        link: 'https://example.com/1',
        snippet: 'Test Snippet 1',
        position: 1,
      },
      {
        title: 'Test Title 2',
        link: 'https://example.com/2',
        snippet: 'Test Snippet 2',
        position: 2,
      },
    ];

    insertSerperCache(query, mockResults);

    const cached = getCachedSerperResults(query);
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(2);
    expect(cached![0].title).toBe('Test Title 1');
    expect(cached![0].link).toBe('https://example.com/1');
    expect(cached![1].position).toBe(2);
  });

  it('should overwrite existing cache when same query is inserted again', () => {
    const query = 'test query';
    const firstResults: SerperSearchResult[] = [
      { title: 'First', link: 'https://example.com/first', snippet: 'First', position: 1 },
    ];
    const secondResults: SerperSearchResult[] = [
      { title: 'Second', link: 'https://example.com/second', snippet: 'Second', position: 1 },
    ];

    insertSerperCache(query, firstResults);
    insertSerperCache(query, secondResults);

    const cached = getCachedSerperResults(query);
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(1);
    expect(cached![0].title).toBe('Second');
  });

  it('should clear cache', () => {
    insertSerperCache('query 1', [{ title: 'Q1', link: 'https://example.com/1', snippet: 'Q1', position: 1 }]);
    insertSerperCache('query 2', [{ title: 'Q2', link: 'https://example.com/2', snippet: 'Q2', position: 1 }]);

    expect(getCachedSerperResults('query 1')).not.toBeNull();
    expect(getCachedSerperResults('query 2')).not.toBeNull();

    clearSerperCache();

    expect(getCachedSerperResults('query 1')).toBeNull();
    expect(getCachedSerperResults('query 2')).toBeNull();
  });
});
