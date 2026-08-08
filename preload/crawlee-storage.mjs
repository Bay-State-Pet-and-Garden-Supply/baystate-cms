/**
 * Preload script for the extraction worker.
 *
 * Sets Crawlee storage configuration BEFORE any Crawlee module
 * is imported. Crawlee reads CRAWLEE_STORAGE_DIR and
 * CRAWLEE_PURGE_ON_START at module-load time, so these must
 * be set in the process environment before the worker starts.
 *
 * Usage: node --import ./preload/crawlee-storage.mjs ...
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';

const storageDir = join(cwd(), '.baystate-cms', 'artifacts', 'crawlee-storage');

process.env.CRAWLEE_STORAGE_DIR = storageDir;
process.env.CRAWLEE_PURGE_ON_START = '1';

// Ensure the directory exists to prevent ENOENT errors
try {
  mkdirSync(join(storageDir, 'request_queues', 'default'), { recursive: true });
  mkdirSync(join(storageDir, 'datasets', 'default'), { recursive: true });
  mkdirSync(join(storageDir, 'key_value_stores', 'default'), { recursive: true });
} catch {
  // non-critical — Crawlee will create them if needed
}
