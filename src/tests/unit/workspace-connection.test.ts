import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../../db/connection';
import { findWorkspace } from '../../db/repositories/workspace-repo';

describe('Workspace Repo - Connection Safety', () => {
  beforeEach(() => {
    // Ensure database is reset and uninitialized before each test
    try {
      resetDb();
    } catch {
      // ignore
    }
  });

  it('should return null instead of throwing when the database is not initialized', () => {
    expect(() => findWorkspace()).not.toThrow();
    const ws = findWorkspace();
    expect(ws).toBeNull();
  });
});
