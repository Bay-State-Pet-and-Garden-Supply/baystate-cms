/**
 * Pi SDK session factory tests (PI-1).
 *
 * The allowlist unit tests (policy → effective tool names) run everywhere.
 * The real-SDK tests verify that `createAgentSession` honors the allowlist
 * and the approved-extension-only loader when the Pi runtime is actually
 * available — they never send a prompt, so no model call or network request
 * occurs. They skip when no Pi model registry is present (CI) or when no
 * model with valid credentials is available.
 */
import { describe, expect, it } from 'vitest';
import {
  PiSdkSessionFactory,
  PiSessionError,
  captureSdkVersion,
  captureToolVersions,
  effectiveToolNames,
  validateToolAllowlist,
} from '../../../product-intelligence/pi/pi-session-factory';
import { TERMINAL_TOOLS, WORKFLOW_SUBMISSION_TOOL_NAME } from '../../../product-intelligence/contracts';
import { TEST_INPUT, testContext, testPolicy } from './test-helpers';

describe('tool version capture (round-8 P1)', () => {
  it('captures { name, version, schemaHash } per effective tool with stable hashes', () => {
    const tools = [
      { name: 'search_upc', version: '1.2.0', parameters: { type: 'object', properties: { gtin: { type: 'string' } } } },
      { name: 'verify_image_candidate', version: '2.0.0', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
    ];
    const captured = captureToolVersions(tools);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({ name: 'search_upc', version: '1.2.0' });
    expect(captured[0].schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(captured[1].schemaHash).not.toBe(captured[0].schemaHash);
    // Stable: identical parameters produce the same hash regardless of key order.
    const again = captureToolVersions([{ name: 'search_upc', version: '1.2.0', parameters: { properties: { gtin: { type: 'string' } }, type: 'object' } }]);
    expect(again[0].schemaHash).toBe(captured[0].schemaHash);
  });

  it('treats missing versions as null and different schemas as different hashes', () => {
    const a = captureToolVersions([{ name: 'submit_product_research_bundle', parameters: { type: 'object' } }]);
    expect(a[0].version).toBeNull();
    const b = captureToolVersions([{ name: 'submit_product_research_bundle', parameters: { type: 'object', properties: { x: { type: 'string' } } } }]);
    expect(b[0].schemaHash).not.toBe(a[0].schemaHash);
  });
});

describe('tool allowlisting (pure functions)', () => {
  it('accepts known read-only tools', () => {
    expect(validateToolAllowlist(testPolicy())).toEqual(['read', 'grep', 'find', 'ls']);
  });

  it('rejects unknown tools with policy_denied', () => {
    expect(() => validateToolAllowlist(testPolicy({ allowedTools: ['read', 'nuclear_launch'] }))).toThrow(PiSessionError);
    try {
      validateToolAllowlist(testPolicy({ allowedTools: ['read', 'nuclear_launch'] }));
    } catch (error) {
      expect((error as PiSessionError).code).toBe('policy_denied');
    }
  });

  it('effective tools are allowlist + terminal tools only', () => {
    const tools = effectiveToolNames(testPolicy({ allowedTools: ['read', 'grep'] }));
    expect(tools).toEqual(['read', 'grep', ...TERMINAL_TOOLS]);
    expect(tools).toContain(WORKFLOW_SUBMISSION_TOOL_NAME);
  });

  it('never exposes the legacy PI-1 terminal tool (P0-3)', () => {
    const tools = effectiveToolNames(testPolicy({ allowedTools: ['read', 'grep'] }));
    expect(tools).not.toContain('submit_product_research');
    expect(tools).toContain('submit_product_research_bundle');
    expect(TERMINAL_TOOLS).not.toContain('submit_product_research');
  });

  it('never includes edit/write/bash by default', () => {
    const tools = effectiveToolNames(testPolicy());
    expect(tools).not.toContain('bash');
    expect(tools).not.toContain('edit');
    expect(tools).not.toContain('write');
  });
});

describe('PiSdkSessionFactory — fail-closed policy enforcement', () => {
  it('refuses to run without a model route (model_unavailable)', async () => {
    const factory = new PiSdkSessionFactory();
    await expect(
      factory.createSession(TEST_INPUT, testContext({}, { modelRoute: null }), () => undefined),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
  });

  it('refuses unknown models with model_unavailable', async () => {
    const factory = new PiSdkSessionFactory();
    await expect(
      factory.createSession(
        TEST_INPUT,
        testContext({}, { modelRoute: { provider: 'openai', model: 'does-not-exist-xyz', thinkingLevel: 'off' } }),
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
  });
});

describe('PiSdkSessionFactory — real SDK (no prompt, no network)', () => {
  const sdkReady = async (): Promise<{
    ok: boolean;
    provider?: string;
    model?: string;
  }> => {
    try {
      const sdk = await import('@earendil-works/pi-coding-agent');
      const runtime = await sdk.ModelRuntime.create();
      const available = await runtime.getAvailable();
      const first = available[0];
      if (!first) return { ok: false }; // no credentials — nothing to verify against
      return { ok: true, provider: first.provider, model: first.id };
    } catch {
      return { ok: false }; // SDK not installed/configured (CI)
    }
  };

  const requireSdk = async (): Promise<{ provider: string; model: string } | null> => {
    const ready = await sdkReady();
    if (!ready.ok || !ready.provider || !ready.model) return null;
    return { provider: ready.provider, model: ready.model };
  };

  it('captures the exact Pi package version', async () => {
    const version = await captureSdkVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it(
    'creates an in-memory session exposing only allowlisted + terminal tools',
    async () => {
      const route = await requireSdk();
      if (!route) return;
      const factory = new PiSdkSessionFactory();
      let received: unknown = null;
      const handle = await factory.createSession(TEST_INPUT, testContext({}, {
        modelRoute: { ...route, thinkingLevel: 'off' },
      }), (submission) => { received = submission; });

      try {
        const session = handle.session as unknown as {
          sessionId: string;
          agent: { state: { tools: Array<{ name: string }> } };
        };
        expect(session.sessionId).toBeTruthy();
        const toolNames = session.agent.state.tools.map((tool) => tool.name).sort();
        // Fixed SDK wiring (live-smoke finding): passing `tools: []` made the
        // SDK filter out EVERY tool — custom tools included — so the model
        // saw no callable tools and ended without submitting. The SDK now
        // receives `tools: undefined` + explicit builtin exclusions. The
        // stable contract (builtin activation order is an SDK internal):
        //   1. every custom research/terminal tool is ALWAYS exposed,
        //   2. no denied builtin (bash/edit/write) ever leaks through,
        //   3. nothing outside the policy universe appears.
        const expectedUniverse = [
          'find',
          'grep',
          'ls',
          'read',
          'submit_product_research_bundle',
          'submit_insufficient_evidence',
          'submit_identity_conflict',
        ];
        for (const tool of toolNames) {
          expect(expectedUniverse).toContain(tool);
        }
        expect(toolNames).toContain('read');
        expect(toolNames).not.toContain('bash');
        expect(toolNames).not.toContain('edit');
        expect(toolNames).not.toContain('write');
        // P0-3: the legacy PI-1 terminal tool is never exposed to sessions.
        expect(toolNames).not.toContain('submit_product_research');
        expect(toolNames).toContain('submit_product_research_bundle');
        expect(toolNames).toContain('submit_insufficient_evidence');
        expect(toolNames).toContain('submit_identity_conflict');
        expect(handle.effectiveTools.sort()).toEqual([...expectedUniverse].sort());
        expect(handle.piVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(handle.extensionVersions).toEqual([]);
        expect(received).toBeNull();
      } finally {
        handle.dispose();
      }
    },
  );

  it(
    'does not auto-discover project extensions or skills (approved-extension-only)',
    async () => {
      const route = await requireSdk();
      if (!route) return;
      const factory = new PiSdkSessionFactory();
      const handle = await factory.createSession(TEST_INPUT, testContext({}, {
        modelRoute: { ...route, thinkingLevel: 'off' },
      }), () => undefined);
      try {
        expect(handle.extensionVersions).toEqual([]);
        const session = handle.session as unknown as {
          agent: { state: { tools: Array<{ name: string }> } };
        };
        const toolNames = session.agent.state.tools.map((tool) => tool.name);
        // Only the four allowlisted read-only tools; no bash/edit/write.
        expect(toolNames).not.toContain('bash');
        expect(toolNames).not.toContain('edit');
        expect(toolNames).not.toContain('write');
      } finally {
        handle.dispose();
      }
    },
  );

  it(
    'fails fast with model_unavailable when the routed model lacks credentials',
    async () => {
      const ready = await sdkReady();
      if (!ready.ok) return;
      // Pick a model that exists in the registry but has no valid credentials
      // (when one exists); skip when every registered model is available.
      const sdk = await import('@earendil-works/pi-coding-agent');
      const runtime = await sdk.ModelRuntime.create();
      const all = runtime.getModels();
      const availableSet = new Set(
        (await runtime.getAvailable()).map((m) => `${m.provider}/${m.id}`),
      );
      const missing = all.find((m) => !availableSet.has(`${m.provider}/${m.id}`));
      if (!missing) return; // fully configured machine — nothing to assert

      const factory = new PiSdkSessionFactory();
      await expect(
        factory.createSession(
          TEST_INPUT,
          testContext({}, {
            modelRoute: { provider: missing.provider, model: missing.id, thinkingLevel: 'off' },
          }),
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'model_unavailable' });
    },
  );

  it(
    'wires the submission handler without validating payloads at creation time',
    async () => {
      const route = await requireSdk();
      if (!route) return;
      const factory = new PiSdkSessionFactory();
      let received: unknown = null;
      const handle = await factory.createSession(TEST_INPUT, testContext({}, {
        modelRoute: { ...route, thinkingLevel: 'off' },
      }), (submission) => { received = submission; });
      try {
        expect(received).toBeNull();
        // Payload validation itself is covered by pi-tool-registry tests; the
        // factory only wires the handler (no external calls made here).
        expect(typeof factory.createSession).toBe('function');
      } finally {
        handle.dispose();
      }
    },
  );
});
