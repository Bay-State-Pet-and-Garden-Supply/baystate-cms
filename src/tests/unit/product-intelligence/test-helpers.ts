/**
 * Shared test doubles and fixtures for Product Intelligence tests (PI-1).
 * No external calls occur: the fake session factory never touches the Pi SDK.
 */
import type { ProductResearchContext, ProductResearchInput, StructuredSubmission } from '../../../../src/product-intelligence/contracts';
import type { TerminalResultSubmission } from '../../../../src/product-intelligence/contracts';
import type { ProductResearchBundle, InsufficientEvidenceSubmission } from '../../../../src/product-intelligence/workflow/bundle';
import type { PiSessionFactory, PiSessionHandle, PiSessionLike } from '../../../../src/product-intelligence/pi/pi-session-factory';

const VALID_GTIN = '085000079585';

/**
 * A PI-4 workflow research bundle that passes validateTerminalSubmission:
 * exact identity, evidence ids cited, no classification/image/conflict
 * entries that would trigger CMS-controlled checks.
 */
export function validBundle(overrides: Partial<ProductResearchBundle> = {}): ProductResearchBundle {
  return {
    schemaVersion: 1,
    gtin: VALID_GTIN,
    inputName: 'STELLA CHKN BROTH 16OZ',
    identity: {
      status: 'exact_match',
      brand: null,
      canonicalName: null,
      variant: null,
      manufacturer: null,
      netContent: null,
      packCount: null,
      evidenceIds: ['ev-bundle-1'],
    },
    commerceFacts: [],
    classificationProposals: [],
    imageCandidates: [],
    conflicts: [],
    disposition: 'research_complete',
    ...overrides,
  };
}

/** A PI-4 workflow abstention (insufficient evidence) that passes validation. */
export function insufficientEvidenceSubmission(
  overrides: Partial<InsufficientEvidenceSubmission> = {},
): InsufficientEvidenceSubmission {
  return {
    schemaVersion: 1,
    gtin: VALID_GTIN,
    inputName: 'STELLA CHKN BROTH 16OZ',
    reason: 'No extractable product fields on the page',
    actionableNextStep: 'Try the browser snapshot layer',
    evidenceIds: ['ev-bundle-1'],
    attemptedSteps: ['extract_product_page'],
    ...overrides,
  };
}

export const TEST_INPUT: ProductResearchInput = {
  gtin: VALID_GTIN,
  registerName: 'STELLA CHKN BROTH 16OZ',
  brandHint: 'Stella & Chewys',
  departmentHint: 'Pet Food',
};

export function testPolicy(overrides: Record<string, unknown> = {}): ProductResearchContext['policy'] {
  return {
    configId: 'config-test-0001',
    allowedTools: ['read', 'grep', 'find', 'ls'],
    networkPolicy: 'local_only',
    dataSharingPolicy: 'local_only',
    modelRoute: { provider: 'openai', model: 'gpt-4o-mini', thinkingLevel: 'off' },
    maxToolCalls: 50,
    maxCostUsd: 1,
    deadlineMs: 300_000,
    ...overrides,
  } as ProductResearchContext['policy'];
}

export function testContext(
  overrides: Partial<ProductResearchContext> = {},
  policyOverrides: Record<string, unknown> = {},
): ProductResearchContext {
  return {
    runId: 'run-test-0001',
    workspaceId: 'ws-test',
    workspacePath: '/tmp/ws-test',
    policy: testPolicy(policyOverrides),
    executionMode: 'shadow',
    existingEvidenceRefs: [],
    ...overrides,
  };
}

export function validSubmission(overrides: Partial<StructuredSubmission> = {}): StructuredSubmission {
  return {
    schemaVersion: 1,
    identity: {
      gtinMatch: 'exact',
      gtinEvidenceIds: ['ev-gtin-1'],
      registerNameMatch: 'exact',
      registerNameEvidenceIds: ['ev-name-1'],
      summary: 'GTIN resolves to the exact product; register name matches.',
    },
    evidenceSources: [
      {
        id: 'src-1',
        url: 'https://supplier.example.com/p/085000079585',
        title: 'Supplier listing',
        domain: 'supplier.example.com',
        kind: 'supplier',
        accessedAt: '2026-08-04T00:00:00.000Z',
      },
    ],
    evidenceItems: [
      {
        id: 'ev-gtin-1',
        field: 'gtin',
        value: VALID_GTIN,
        sourceIds: ['src-1'],
        quote: 'UPC 085000079585',
      },
    ],
    productProposal: {
      fields: [{ field: 'title', value: 'Stella & Chewys Chicken Broth 16 oz', evidenceIds: ['ev-gtin-1'] }],
    },
    classificationProposal: { productTypeId: null, categoryPageId: null, attributes: [] },
    images: [],
    conflicts: [],
    abstention: null,
    confidence: 0.9,
    ...overrides,
  };
}

/** Narrow a terminal submission to the PI-1 envelope shape (tests). */
export function asPi1Submission(submission: TerminalResultSubmission | null): StructuredSubmission | null {
  if (!submission) return null;
  const candidate = submission as { identity?: { gtinMatch?: unknown } };
  if (candidate.identity && 'gtinMatch' in candidate.identity) {
    return submission as unknown as StructuredSubmission;
  }
  return null;
}

export const ABSTENTION_SUBMISSION: StructuredSubmission = {
  ...validSubmission(),
  identity: { ...validSubmission().identity, gtinMatch: 'unknown', gtinEvidenceIds: [] },
  productProposal: { fields: [] },
  abstention: {
    scope: 'full',
    reason: 'No authoritative source resolves this GTIN.',
    actionableNextStep: 'Provide the product package photo for OCR.',
    targets: [],
  },
  confidence: 0.1,
};

// ---------------------------------------------------------------------------
// Fake session
// ---------------------------------------------------------------------------

export interface FakeSession extends PiSessionLike {
  promptText: string | null;
  aborted: boolean;
  disposed: boolean;
  /** Manually settle the prompt as if the agent finished. */
  finish(): void;
  /** Reject the prompt as if the session crashed. */
  failWith(error: Error): void;
  /** Emit a synthetic SDK event to the executor's listener. */
  emit(event: unknown): void;
  emitToolStart(name: string): void;
  emitToolEnd(name: string, isError?: boolean): void;
  emitAgentEnd(): void;
}

function createFakeSession(): FakeSession {
  let resolvePrompt: () => void = () => undefined;
  let rejectPrompt: (error: Error) => void = () => undefined;
  const promptPromise = new Promise<void>((resolve, reject) => {
    resolvePrompt = resolve;
    rejectPrompt = reject;
  });

  const listeners: Array<(event: unknown) => void> = [];
  const session: FakeSession = {
    sessionId: 'fake-session',
    promptText: null,
    aborted: false,
    disposed: false,
    prompt(text: string): Promise<void> {
      session.promptText = text;
      return promptPromise;
    },
    async abort(): Promise<void> {
      session.aborted = true;
      rejectPrompt(new Error('Aborted'));
      await Promise.resolve();
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    agent: {
      async waitForIdle(): Promise<void> {
        await Promise.resolve();
      },
    },
    dispose(): void {
      session.disposed = true;
    },
    finish(): void {
      session.emitAgentEnd();
      resolvePrompt();
    },
    failWith(error: Error): void {
      rejectPrompt(error);
    },
    emit(event: unknown): void {
      for (const listener of listeners) listener(event);
    },
    emitToolStart(name: string): void {
      session.emit({ type: 'tool_execution_start', toolName: name });
    },
    emitToolEnd(name: string, isError = false): void {
      session.emit({ type: 'tool_execution_end', toolName: name, isError });
    },
    emitAgentEnd(): void {
      session.emit({ type: 'agent_end', messages: [] });
    },
  };
  return session;
}

// ---------------------------------------------------------------------------
// Fake session factory
// ---------------------------------------------------------------------------

export class FakeSessionFactory implements PiSessionFactory {
  created: FakeSession[] = [];
  failWith: Error | null = null;
  /** Latest submission handler passed by the executor (drives the submit tool). */
  lastSubmissionHandler: ((submission: TerminalResultSubmission) => void) | null = null;
  effectiveTools: string[] = ['read', 'grep', 'find', 'ls', 'submit_product_research_bundle'];
  piVersion: string | null = '0.83.0';
  /** Round-8 (review P1): captured tool versions the fake session reports. */
  toolVersions: Array<{ name: string; version: string | null; schemaHash: string }> = [];

  async createSession(
    _input: ProductResearchInput,
    _context: ProductResearchContext,
    onSubmission: (submission: TerminalResultSubmission) => void,
  ): Promise<PiSessionHandle> {
    if (this.failWith) throw this.failWith;
    this.lastSubmissionHandler = onSubmission;
    const session = createFakeSession();
    this.created.push(session);
    return {
      session,
      piVersion: this.piVersion,
      extensionVersions: [],
      effectiveTools: this.effectiveTools,
      toolVersions: this.toolVersions ?? [],
      dispose: () => session.dispose(),
    };
  }
}

/** Run a submission through the executor's onSubmission handler like the tool would. */
export function submitViaTool(factory: FakeSessionFactory, submission: TerminalResultSubmission): void {
  if (!factory.lastSubmissionHandler) throw new Error('No submission handler registered');
  factory.lastSubmissionHandler(submission);
}
