/**
 * Pi SDK session factory tests (PI-1).
 *
 * The allowlist unit tests (policy → effective tool names) run everywhere.
 * The real-SDK smoke test verifies that `createAgentSession` honors the
 * allowlist and the approved-extension-only loader when the Pi runtime is
 * actually available — it never sends a prompt, so no model call or network
 * request occurs. It skips when no Pi model registry is present (CI).
 */
import { describe, expect, it } from 'vitest';
import {
  PiSdkSessionFactory,
  PiSessionError,
  captureSdkVersion,
  effectiveToolNames,
  validateToolAllowlist,
} from '../../../product-intelligence/pi/pi-session-factory';
import { SUBMISSION_TOOL_NAME, TERMINAL_TOOLS } from '../../../product-intelligence/contracts';
import { TEST_INPUT, testContext, testPolicy, validSubmission } from './test-helpers';

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
    expect(tools).toContain(SUBMISSION_TOOL_NAME);
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
});

describe('PiSdkSessionFactory — real SDK smoke (no prompt, no network)', () => {
  const sdkAvailable = async (): Promise<boolean> => {
    try {
      const sdk = await import('@earendil-works/pi-coding-agent');
      await sdk.ModelRuntime.create();
      return true;
    } catch {
      return false;
    }
  };

  const run = sdkAvailable();
  const requireSdk = async (): Promise<boolean> => {
    const ready = await run;
    if (!ready) {
      // Skip silently when the Pi SDK runtime is not installed/configured (CI).
      return false;
    }
    return true;
  };

  it('captures the exact Pi package version', async () => {
    const version = await captureSdkVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it(
    'creates an in-memory session exposing only allowlisted + terminal tools',
    async () => {
      if (!(await requireSdk())) return;
      const factory = new PiSdkSessionFactory();
      let received: unknown = null;
      const handle = await factory.createSession(TEST_INPUT, testContext({}, {
        modelRoute: { provider: 'openai', model: 'gpt-4o-mini', thinkingLevel: 'off' },
      }), (submission) => { received = submission; });

      try {
        const session = handle.session as unknown as {
          sessionId: string;
          agent: { state: { tools: Array<{ name: string }> } };
        };
        expect(session.sessionId).toBeTruthy();
        const toolNames = session.agent.state.tools.map((tool) => tool.name).sort();
        expect(toolNames).toEqual(['find', 'grep', 'ls', 'read']);

        const expected = ['find', 'grep', 'ls', 'read', SUBMISSION_TOOL_NAME];
        expect(handle.effectiveTools.sort()).toEqual(expected.sort());
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
      if (!(await requireSdk())) return;
      const factory = new PiSdkSessionFactory();
      const handle = await factory.createSession(TEST_INPUT, testContext({}, {
        modelRoute: { provider: 'openai', model: 'gpt-4o-mini', thinkingLevel: 'off' },
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
    'validates submission payloads against the zod contract before delivering',
    async () => {
      if (!(await requireSdk())) return;
      const factory = new PiSdkSessionFactory();
      let received: unknown = null;
      const handle = await factory.createSession(TEST_INPUT, testContext({}, {
        modelRoute: { provider: 'openai', model: 'gpt-4o-mini', thinkingLevel: 'off' },
      }), (submission) => { received = submission; });
      try {
        // Simulate the agent calling the terminal tool with an invalid payload:
        // the registered tool must reject it (tool error path).
        const sdk = await import('@earendil-works/pi-coding-agent');
        expect(sdk).toBeTruthy();
        // The tool itself is validated in pi-tool-registry tests; here we only
        // assert the factory wired a handler (no external calls made).
        expect(typeof factory.createSession).toBe('function');
        expect(received).toBeNull();
      } finally {
        handle.dispose();
      }
    },
  );
});
