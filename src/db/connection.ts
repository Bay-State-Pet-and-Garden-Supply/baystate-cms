import { Database } from './driver';
import path from 'path';
import fs from 'fs';

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    throw new Error('Database not initialized. Call initDb(dbPath) first.');
  }
  return _db;
}

export function initDb(dbPath: string): Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  _db = new Database(dbPath);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA foreign_keys = ON;');
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function resetDb(): void {
  closeDb();
  _db = null;
}
