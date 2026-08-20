// story: e06s03 — SaveBar governance guard
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { SaveBar } from '../../client/components/profile-builder/components/SaveBar';

describe('SaveBar — governance guard', () => {
  const baseState: any = {
    dirty: true, draft: { domain: 'acme.com', runtime: 'rendered', productUrl: 'https://acme.com/p/1' },
    requests: { save: { loading: false, error: null, success: false }, loadProfiles: { loading: false }, validation: { loading: false }, preview: { loading: false }, snapshot: { loading: false } },
    validation: { summary: { failingSamples: 0 } }, activeProfile: null, pageHtml: '<html></html>', fields: {}, extractionPreview: null,
    generation: { fieldSuggestions: { titleSelector: { decision: 'pending', selector: 'h1', warnings: [] } }, customFieldSuggestions: [] },
    samples: [], profiles: [], snapshot: null,
  };
  it('blocks Save when per-field decision pending', () => {
    const controller: any = { saveProfile: () => {} };
    const { container } = render(React.createElement(SaveBar, { state: baseState, controller }));
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
  it('allows Save when all decisions accepted and no pending', () => {
    const state = { ...baseState, generation: { fieldSuggestions: { titleSelector: { decision: 'accepted', selector: 'h1', warnings: [] } }, customFieldSuggestions: [] } };
    const controller: any = { saveProfile: () => {} };
    const { container } = render(React.createElement(SaveBar, { state, controller }));
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});
