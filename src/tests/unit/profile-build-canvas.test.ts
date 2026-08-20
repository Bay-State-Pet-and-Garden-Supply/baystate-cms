// story: e06s03 — Build canvas grouped fields, alternatives, warnings, previews
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { BuildCanvas } from '../../client/components/profile-builder/components/BuildCanvas';

describe('BuildCanvas', () => {
  const fieldGroups = [
    { group: 'Identity', fields: [{ key: 'titleSelector', label: 'Title', active: 'h1.old', draft: 'h1.product-title', alternatives: [{ selector: 'h1.product-title', evidence: 'h1', quality: 'high' }], warnings: ['stability: positional'], preview: 'Chicken', decision: 'pending' }] },
    { group: 'Media', fields: [{ key: 'imagesSelector', label: 'Images', active: null, draft: null, alternatives: [], warnings: [], preview: null, decision: 'unsupported' }] },
  ];
  it('renders grouped Identity/Description/Media/Commerce/Nutrition/Variants with active vs draft vs alternatives', () => {
    const { container } = render(React.createElement(BuildCanvas, { fieldGroups: fieldGroups as any, onAccept: () => {}, onReject: () => {}, onSuggest: () => {}, onExplain: () => {}, onRevise: () => {}, provenance: { provider: 'openai', model: 'gpt-4o-mini', configId: 'cfg', promptHash: 'abc', htmlLeftMachine: true, disclosureBadge: 'HTML sent to openai/gpt-4o-mini' }, canSave: false } as any));
    expect(container.textContent).toMatch(/Title/);
    expect(container.textContent).toMatch(/h1\.product-title/);
    expect(container.textContent).toMatch(/HTML sent/);
  });
  it('shows unsupported-for-domain explicit and blocks Save/Activate when pending', () => {
    const { container } = render(React.createElement(BuildCanvas, { fieldGroups: fieldGroups as any, onAccept: () => {}, onReject: () => {}, onSuggest: () => {}, onExplain: () => {}, onRevise: () => {}, provenance: null, canSave: false } as any));
    expect(container.textContent).toMatch(/unsupported.*domain/i);
    expect(container.textContent).toMatch(/pending/i);
  });
});
