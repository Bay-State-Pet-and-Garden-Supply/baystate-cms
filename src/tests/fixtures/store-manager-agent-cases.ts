/**
 * Deterministic Store Manager agent behavioral fixtures (epic #42, #41).
 *
 * These are NOT LLM evaluations: each case pairs fake tool-result text with a
 * proposed agent reply, and a pure rule checker decides which operating-
 * contract checks the reply passes or fails. The unit test asserts the
 * checker's verdicts match each fixture's declared expectations, so the
 * contract rules are exercised without any model or network call.
 *
 * Checked rules (mirroring the system prompt contract):
 * - allNumbersGrounded: every number the agent states appears in tool results.
 * - noInventedIdentifiers: every SKU-like token and UUID stated appears in
 *   tool results.
 * - noUnverifiedSuccess: every affirmative success-verb claim (applied,
 *   staged, stored, approved, published, synced, imported, downloaded,
 *   dismissed) is confirmed by tool results. Negated and hedged clauses are
 *   exempt (e.g. "not staged", "would apply").
 * - noStateConflation: terminal-state terms (approved, published, synced,
 *   imported) asserted affirmatively are confirmed by tool results, and
 *   "applied" is never joined with a terminal-state term in one clause.
 * - failureReportedAsUnknown: when tool results contain a failure marker
 *   (no_result / policy_denied / error / timeout / denied / failed /
 *   cancelled), the reply must acknowledge non-success instead of claiming a
 *   success outcome.
 */

export type AgentContractCheck =
  | 'allNumbersGrounded'
  | 'noStateConflation'
  | 'noUnverifiedSuccess'
  | 'noInventedIdentifiers'
  | 'failureReportedAsUnknown';

export const AGENT_CONTRACT_CHECK_ORDER: AgentContractCheck[] = [
  'allNumbersGrounded',
  'noStateConflation',
  'noUnverifiedSuccess',
  'noInventedIdentifiers',
  'failureReportedAsUnknown',
];

export interface StoreManagerAgentCase {
  id: string;
  kind:
    | 'grounding'
    | 'terminology'
    | 'failed_tool'
    | 'verification'
    | 'clean_report'
    | 'identifiers';
  scenario: string;
  /** Fake tool-result text the agent could have retrieved. */
  toolResults: string[];
  /** Proposed agent reply to evaluate against the contract rules. */
  agentReply: string;
  /** Checks the reply must pass. */
  expectedPass: AgentContractCheck[];
  /** Checks the reply must fail. */
  expectedFail: AgentContractCheck[];
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWordBounded(haystack: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(haystack);
}

/** Split a reply into clauses so negation/hedging scope stays local. */
function splitClauses(reply: string): string[] {
  return reply
    .split(/[.;!?\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

const NEGATION = /(^|[\s,])(not|never|no|without|isn'?t|aren'?t|didn'?t|doesn'?t|don'?t)\b/i;
const HEDGE =
  /\b(would|could|should|might|may|if|whether|recommend|propose|suggest|ask)\b/i;

const SUCCESS_VERBS =
  /(?:applied|staged|stored|approved|published|synced|imported|downloaded|dismissed)\b/i;

const TERMINAL_STATES = ['approved', 'published', 'synced', 'imported'] as const;

const FAILURE_MARKERS =
  /\b(no_result|policy_denied|error|timeout|timed out|denied|failed|cancelled|unavailable)\b/i;

const UNKNOWN_MARKERS =
  /\b(unknown|could not|unable|not available|no result|does not exist|not found|not executed|did not run|timed out|denied|failed|cancelled)\b/i;

const SKU_TOKEN = /\b[A-Z]{2,}[A-Z0-9]*-\d{2,}\b/g;
const UUID_TOKEN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

function extractIdentifiers(reply: string): string[] {
  const out = new Set<string>();
  for (const m of reply.matchAll(SKU_TOKEN)) out.add(m[0]);
  for (const m of reply.matchAll(UUID_TOKEN)) out.add(m[0]);
  return [...out];
}

function extractNumbers(reply: string): string[] {
  // Strip identifiers first so UUID/SKU digit groups are never mistaken for
  // factual counts the reply must ground in tool results.
  const withoutIds = reply.replace(UUID_TOKEN, ' ').replace(SKU_TOKEN, ' ');
  return [...new Set(withoutIds.match(/\b\d+(?:\.\d+)?\b/g) ?? [])];
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function checkNumbersGrounded(reply: string, toolResultsText: string): boolean {
  return extractNumbers(reply).every((n) => containsWordBounded(toolResultsText, n));
}

export function checkIdentifiersGrounded(reply: string, toolResultsText: string): boolean {
  return extractIdentifiers(reply).every((id) => containsWordBounded(toolResultsText, id));
}

export function checkSuccessVerbsGrounded(reply: string, toolResultsText: string): boolean {
  for (const clause of splitClauses(reply)) {
    if (NEGATION.test(clause) || HEDGE.test(clause)) continue;
    const verbs = clause.match(SUCCESS_VERBS);
    if (!verbs) continue;
    for (const verb of verbs) {
      if (!containsWordBounded(toolResultsText, verb)) return false;
    }
  }
  return true;
}

export function checkNoStateConflation(reply: string, toolResultsText: string): boolean {
  for (const clause of splitClauses(reply)) {
    if (NEGATION.test(clause) || HEDGE.test(clause)) continue;
    // "applied ... (approved|published|synced)" in one clause is a conflation.
    if (/applied\b/.test(clause) && /\b(approved|published|synced)\b/.test(clause)) {
      return false;
    }
    for (const term of TERMINAL_STATES) {
      if (new RegExp(`\\b${term}\\b`, 'i').test(clause)) {
        if (!containsWordBounded(toolResultsText, term)) return false;
      }
    }
  }
  return true;
}

export function checkFailureReportedAsUnknown(
  reply: string,
  toolResultsText: string,
): boolean {
  if (!FAILURE_MARKERS.test(toolResultsText)) return true;
  return UNKNOWN_MARKERS.test(reply);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface AgentContractVerdict {
  check: AgentContractCheck;
  passed: boolean;
}

/** Run every contract check against one fixture case. */
export function runAgentContractChecks(
  fixture: StoreManagerAgentCase,
): AgentContractVerdict[] {
  const toolResultsText = fixture.toolResults.join(' ');
  const checks: Array<[AgentContractCheck, () => boolean]> = [
    ['allNumbersGrounded', () => checkNumbersGrounded(fixture.agentReply, toolResultsText)],
    ['noStateConflation', () => checkNoStateConflation(fixture.agentReply, toolResultsText)],
    ['noUnverifiedSuccess', () => checkSuccessVerbsGrounded(fixture.agentReply, toolResultsText)],
    ['noInventedIdentifiers', () => checkIdentifiersGrounded(fixture.agentReply, toolResultsText)],
    [
      'failureReportedAsUnknown',
      () => checkFailureReportedAsUnknown(fixture.agentReply, toolResultsText),
    ],
  ];
  return checks.map(([check, fn]) => ({ check, passed: fn() }));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const STORE_MANAGER_AGENT_CASES: StoreManagerAgentCase[] = [
  {
    id: 'grounded-summary',
    kind: 'grounding',
    scenario: 'User asks for a catalog health summary; the agent replies using only tool-reported counts.',
    toolResults: [
      'getCatalogHealthReport: totalProducts: 12, healthyProducts: 10, unhealthyProducts: 2',
      'listCatalogHealthIssues: 2 issues (1 blocker, 1 warning)',
    ],
    agentReply:
      'Your catalog has 12 products; 10 are healthy and 2 have issues. There is 1 blocker and 1 warning.',
    expectedPass: AGENT_CONTRACT_CHECK_ORDER,
    expectedFail: [],
  },
  {
    id: 'unsupported-count',
    kind: 'grounding',
    scenario: 'The agent asserts a blocker count that no tool result supports.',
    toolResults: [
      'getCatalogHealthReport: totalProducts: 12, healthyProducts: 10, unhealthyProducts: 2',
    ],
    agentReply: 'Your catalog has 12 products and 3 blockers.',
    expectedPass: [
      'noStateConflation',
      'noUnverifiedSuccess',
      'noInventedIdentifiers',
      'failureReportedAsUnknown',
    ],
    expectedFail: ['allNumbersGrounded'],
  },
  {
    id: 'foreign-proposal-id',
    kind: 'identifiers',
    scenario: 'The agent claims to have dismissed a proposal whose id never appeared in tool results.',
    toolResults: [
      'listStoredProposals: 1 stored proposal, id 1a2b3c4d-1111-4222-8333-444455556666, field ProductField24',
    ],
    agentReply: 'I dismissed stored proposal 9f8e7d6c-5555-4666-8777-888899990000.',
    expectedPass: ['allNumbersGrounded', 'noStateConflation', 'failureReportedAsUnknown'],
    expectedFail: ['noUnverifiedSuccess', 'noInventedIdentifiers'],
  },
  {
    id: 'approval-denial',
    kind: 'failed_tool',
    scenario: 'A persistent tool call was denied; the agent reports non-execution and uncertainty.',
    toolResults: [
      'applyNormalizationProposal: policy_denied — approval denied by operator; no side effects',
    ],
    agentReply:
      'The operator denied approval, so the proposal was not staged and nothing was executed. The outcome beyond the denial is unknown.',
    expectedPass: AGENT_CONTRACT_CHECK_ORDER,
    expectedFail: [],
  },
  {
    id: 'mutation-without-verification',
    kind: 'verification',
    scenario: 'The agent claims a staging success with a change-set id no tool result returned.',
    toolResults: [
      'listStoredProposals: stored proposal 1a2b3c4d-1111-4222-8333-444455556666 exists (status proposed)',
    ],
    agentReply:
      'The proposal was staged in Change Set 2a3b4c5d-2222-4333-8444-555566667777 and is ready to approve.',
    expectedPass: ['allNumbersGrounded', 'noStateConflation', 'failureReportedAsUnknown'],
    expectedFail: ['noUnverifiedSuccess', 'noInventedIdentifiers'],
  },
  {
    id: 'verified-stage-success',
    kind: 'verification',
    scenario: 'A tool result confirms staging; the agent uses the exact state vocabulary.',
    toolResults: [
      'listStoredProposals: stored proposal 1a2b3c4d-1111-4222-8333-444455556666 (status proposed)',
      'applyNormalizationProposal: success; staged in Change Set cs_7f3a (status applied, draft); changeSetId cs_7f3a',
    ],
    agentReply:
      'The stored proposal was staged in Change Set cs_7f3a; the Change Set remains a draft and is not approved, not published, and not synced.',
    expectedPass: AGENT_CONTRACT_CHECK_ORDER,
    expectedFail: [],
  },
  {
    id: 'failed-repair',
    kind: 'failed_tool',
    scenario: 'Image repair partially failed; the agent reports per-image outcomes and residual uncertainty.',
    toolResults: [
      'repairChangeSetImages: partial — 2 downloaded, 1 policy_denied (private destination), 1 timeout',
    ],
    agentReply:
      'Image repair finished with partial success: 2 images downloaded, 1 was denied for a private destination, and 1 timed out. Whether the denied image can be repaired is unknown.',
    expectedPass: AGENT_CONTRACT_CHECK_ORDER,
    expectedFail: [],
  },
  {
    id: 'clean-report',
    kind: 'clean_report',
    scenario: 'A clean catalog yields a report with no observed issues; the agent does not invent categories.',
    toolResults: [
      'getCatalogHealthReport: totalErrors: 0, totalWarnings: 0',
      'generateStoreManagerReport: no observed issues',
    ],
    agentReply: 'The report shows no observed issues: 0 blockers, 0 warnings.',
    expectedPass: AGENT_CONTRACT_CHECK_ORDER,
    expectedFail: [],
  },
  {
    id: 'state-conflation',
    kind: 'terminology',
    scenario: 'The agent describes staging as applied-and-synced, conflating draft and terminal states.',
    toolResults: [
      'listStoredProposals: proposal 1a2b3c4d-1111-4222-8333-444455556666 status proposed',
      'applyNormalizationProposal: success; staged in Change Set cs_7f3a (draft)',
    ],
    agentReply: 'The proposal was applied and the Change Set was synced to the storefront.',
    expectedPass: ['allNumbersGrounded', 'noInventedIdentifiers', 'failureReportedAsUnknown'],
    expectedFail: ['noStateConflation', 'noUnverifiedSuccess'],
  },
];
