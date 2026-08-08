/**
 * Page proposal display helpers (issue #17 pass 3c).
 *
 * The stable Page ID is the identity; the display name is data in
 * `proposedValue.pageName`. These helpers must NEVER return a Page ID into a
 * page-name field — when no display name exists they return null and callers
 * handle the absence (skip/visible-unavailable).
 */
import { describe, expect, it } from 'vitest';
import {
  pageNameFromPageValue,
  getPageDisplayName,
  getPageIdentityId,
} from '../../shared/proposal-display';

describe('pageNameFromPageValue', () => {
  it('returns pageName from the new object shape', () => {
    expect(pageNameFromPageValue({ pageId: 'page-123', pageName: 'Dog Food' })).toBe('Dog Food');
  });

  it('returns null for { pageId } without pageName — NEVER the Page ID', () => {
    expect(pageNameFromPageValue({ pageId: 'page-id-123' })).toBeNull();
    expect(pageNameFromPageValue({ pageId: 'page-id-123', pageName: '' })).toBeNull();
    expect(pageNameFromPageValue({ pageId: 'page-id-123', pageName: '  ' })).toBeNull();
  });

  it('returns the legacy string value as the page name', () => {
    expect(pageNameFromPageValue('Dog Food')).toBe('Dog Food');
  });

  it('returns null for null/undefined/numbers/arrays', () => {
    expect(pageNameFromPageValue(null)).toBeNull();
    expect(pageNameFromPageValue(undefined)).toBeNull();
    expect(pageNameFromPageValue(42)).toBeNull();
    expect(pageNameFromPageValue(['Dog Food'])).toBeNull();
    expect(pageNameFromPageValue('')).toBeNull();
  });

  it('does not consult a target/identity argument (no ID fallback by design)', () => {
    // The legacy second argument no longer exists; a Page ID is never a name.
    expect(pageNameFromPageValue({ pageId: 'page-id-123' })).toBeNull();
  });
});

describe('getPageDisplayName', () => {
  it('uses the proposed value pageName', () => {
    expect(getPageDisplayName({
      proposedValue: { pageId: 'page-1', pageName: 'Dog Food' },
      targetId: 'page-1',
    })).toBe('Dog Food');
  });

  it('honors a revised value pageName with the same precedence as getEffectiveProposalValue', () => {
    expect(getPageDisplayName({
      proposedValue: { pageId: 'page-1', pageName: 'Original' },
      targetId: 'page-1',
      hasRevisedValue: true,
      revisedValue: { pageId: 'page-2', pageName: 'Revised' },
      hasRevisedTargetId: true,
      revisedTargetId: 'page-2',
    })).toBe('Revised');
  });

  it('returns null for an explicit-null revision (never the target Page ID)', () => {
    expect(getPageDisplayName({
      proposedValue: { pageId: 'page-1', pageName: 'Original' },
      targetId: 'page-1',
      hasRevisedValue: true,
      revisedValue: null,
      hasRevisedTargetId: true,
      revisedTargetId: 'page-1',
    })).toBeNull();
  });

  it('returns null for a malformed revision object without pageName', () => {
    expect(getPageDisplayName({
      proposedValue: { pageId: 'page-1', pageName: 'Original' },
      targetId: 'page-1',
      hasRevisedValue: true,
      revisedValue: { pageId: 'page-9' },
      hasRevisedTargetId: true,
      revisedTargetId: 'page-9',
    })).toBeNull();
  });

  it('returns the legacy string proposed value', () => {
    expect(getPageDisplayName({
      proposedValue: 'Dog Food',
      targetId: 'Dog Food',
    })).toBe('Dog Food');
  });

  it('returns null when only a Page-ID target exists (no legacy name value)', () => {
    expect(getPageDisplayName({
      proposedValue: { pageId: 'page-id-123' },
      targetId: 'page-id-123',
    })).toBeNull();
  });
});

describe('getPageIdentityId', () => {
  it('returns the reviewed pageId when a revision carries one', () => {
    expect(getPageIdentityId({
      proposedValue: { pageId: 'page-1', pageName: 'A' },
      targetId: 'page-1',
      hasRevisedValue: true,
      revisedValue: { pageId: 'page-2', pageName: 'B' },
    })).toBe('page-2');
  });

  it('returns null for legacy string proposals (no verified identity)', () => {
    expect(getPageIdentityId({ proposedValue: 'Dog Food', targetId: 'Dog Food' })).toBeNull();
  });
});
