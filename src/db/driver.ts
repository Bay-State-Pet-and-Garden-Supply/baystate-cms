/**
 * Database driver abstraction.
 * Uses bun:sqlite when available, provides a common interface.
 */
import { Database } from 'bun:sqlite';

export type DbDatabase = Database;

export function createDatabase(dbPath: string): Database {
  return new Database(dbPath);
}

export { Database };
