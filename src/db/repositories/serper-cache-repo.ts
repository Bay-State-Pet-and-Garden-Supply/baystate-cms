import { getDb } from '../connection';

export interface SerperSearchResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

export function getCachedSerperResults(query: string): SerperSearchResult[] | null {
  const db = getDb();
  const row = db.query('SELECT results_json FROM serper_cache WHERE query = ?').get(query) as
    | { results_json: string }
    | undefined;

  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.results_json) as SerperSearchResult[];
  } catch (err) {
    console.error(`Failed to parse cached Serper results for query "${query}":`, err);
    return null;
  }
}

export function insertSerperCache(query: string, results: SerperSearchResult[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const resultsJson = JSON.stringify(results);

  db.query(
    'INSERT OR REPLACE INTO serper_cache (query, results_json, created_at) VALUES (?, ?, ?)'
  ).run(query, resultsJson, now);
}

export function clearSerperCache(): void {
  const db = getDb();
  db.query('DELETE FROM serper_cache').run();
}
