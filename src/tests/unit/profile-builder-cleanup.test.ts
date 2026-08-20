// story: e07s03 — deletion guard for GenerateSelectorPopover + independent fetch hop
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('profile builder cleanup (e07s03)', () => {
  it('GenerateSelectorPopover.tsx does not exist', () => {
    const p = path.resolve('src/client/components/profile-builder/components/GenerateSelectorPopover.tsx');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('controller does not contain independent fetchPageHtml hop', () => {
    const controllerPath = path.resolve('src/client/components/profile-builder/hooks/useProfileBuilderController.ts');
    const content = fs.readFileSync(controllerPath, 'utf-8');
    // The separate fetchPageHtml(url) call that raced with snapshot must be gone
    expect(content).not.toMatch(/\bfetchPageHtml\s*\(\s*url\s*\)/);
    // generateSelectorFromOuterHtml implementation must be deleted (only comments may remain)
    expect(content).not.toMatch(/const generateSelectorFromOuterHtml\s*=\s*useCallback/);
    expect(content).not.toMatch(/generateSelectorFromElement\s*\(\s*\{\s*html:/);
    // Local eval stays but is labeled instant preview — not evidence
    expect(content).toMatch(/instant preview — not evidence/);
  });

  it('FieldCard no longer imports GenerateSelectorPopover', () => {
    const cardPath = path.resolve('src/client/components/profile-builder/components/FieldCard.tsx');
    const content = fs.readFileSync(cardPath, 'utf-8');
    expect(content).not.toMatch(/from '\.\/GenerateSelectorPopover'/);
    expect(content).not.toMatch(/<GenerateSelectorPopover/);
  });
});
