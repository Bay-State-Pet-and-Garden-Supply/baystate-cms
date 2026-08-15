/**
 * Agent Lab: Compiled Agent Prompt Builder (compiler_v1).
 *
 * Compiles an immutable session prompt from an AgentVersionSnapshot.
 * Invariants:
 * 1. Base security and execution invariants remain intact.
 * 2. Behavioral instruction rules are organized by category.
 * 3. In-context few-shot examples are budgeted deterministically up to the snapshot's token limit.
 * 4. With empty instructions and few-shots (v1 baseline), compiled text is 100% byte-for-byte
 *    identical to buildResearchPrompt().
 */
import type {
  ProductIntelligencePolicy,
  ProductResearchContext,
  ProductResearchInput,
} from '../contracts';
import type {
  AgentFewShotExample,
  AgentInstructionRule,
  AgentVersionSnapshot,
} from '../../shared/schemas/agent-training';
import { buildWorkflowSection } from '../workflow/workflow-prompt';
import { WORKFLOW_TERMINAL_TOOLS } from '../workflow/bundle';

export interface CompiledAgentPrompt {
  /** The full prompt text sent to the agent session. */
  fullText: string;
  /** FNV-1a structural hash (compatible with existing telemetry). */
  promptHash: string;
  /** Examples included within the token budget. */
  includedExamples: AgentFewShotExample[];
  /** Estimated token count for behavioral guidance + examples. */
  estimatedGuidanceTokens: number;
}

export function compileAgentPrompt(
  version: AgentVersionSnapshot | null,
  input: ProductResearchInput,
  context: ProductResearchContext,
): CompiledAgentPrompt {
  const { policy, executionMode, existingEvidenceRefs } = context;

  const inputJson = JSON.stringify({
    gtin: input.gtin,
    registerName: input.registerName,
    brandHint: input.brandHint ?? null,
    departmentHint: input.departmentHint ?? null,
    price: input.price ?? null,
    quantity: input.quantity ?? null,
    existingOnboardingItemId: input.existingOnboardingItemId ?? null,
  });

  const constraints = [
    `- Allowed built-in tools: ${policy.allowedTools.length > 0 ? policy.allowedTools.join(', ') : '(none)'}`,
    `- Network policy: ${policy.networkPolicy}`,
    `- Data sharing policy: ${dataSharingDescription(policy)}`,
    `- Hard deadline: ${policy.deadlineMs} ms from session start`,
    `- Maximum tool calls: ${policy.maxToolCalls}`,
    `- You have ~${Math.max(1, Math.round(policy.deadlineMs / 60_000))} minutes. Timebox research; submit with the best available evidence before the deadline — an honest partial submission or abstention beats none.`,
  ].join('\n');

  // Format domain instructions
  const instructionsText = formatInstructionsSection(version?.instructions ?? []);

  // Budget and format few-shot examples
  const tokenBudget = version?.fewShotTokenBudget ?? 4000;
  const { sectionText: fewShotText, includedExamples, tokenCount } = budgetFewShotExamples(
    version?.fewShotExamples ?? [],
    tokenBudget,
  );

  const text = [
    'You are a bounded product-research worker for a retail catalog CMS. You research ONE product and submit a structured evidence bundle. You do not write files, publish anything, or create or apply change sets.',
    '',
    '## Product input (untrusted JSON)',
    '```json',
    inputJson,
    '```',
    '',
    'The register name and hints may be imperfect or wrong. Your job is to determine the exact product and document evidence. If the GTIN does not resolve to a single exact product, state the identity conflict or abstain.',
    '',
    '## Execution constraints',
    constraints,
    '',
    `## Termination\nWhen research is complete, call a terminal tool exactly once. ` +
    `The terminal tools are: ${WORKFLOW_TERMINAL_TOOLS.join(', ')}. ` +
    'Never propose using an image whose exact-product match or reuse rights are unknown. ' +
    'Do not invent taxonomy, Category Page, attribute, Product Type, or ProductField identifiers. ' +
    'If you cannot complete the research, submit a full abstention with an actionable next step — do not end the conversation with prose alone.',
    instructionsText.length > 0 ? '' : '',
    instructionsText,
    fewShotText.length > 0 ? '' : '',
    fewShotText,
    '',
    buildWorkflowSection(input, context),
    '',
    `## Execution mode\n${executionModeLabel(executionMode)}`,
    existingEvidenceRefs.length > 0
      ? `\n## Existing evidence\nYou may reuse these previously stored evidence references: ${existingEvidenceRefs.join(', ')}. Cite them as sources only if you verified their content.`
      : '',
    '',
    '## Response contract',
    'End the session by calling the terminal submission tool. Prose outside the tool call is never recorded as a product result.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const guidanceEstimate = estimateTokens(instructionsText) + tokenCount;

  return {
    fullText: text,
    promptHash: hashPrompt(text),
    includedExamples,
    estimatedGuidanceTokens: guidanceEstimate,
  };
}

// ─── Formatters & Token Budgeting ───────────────────────────────────────────

const CATEGORY_TITLES: Record<string, string> = {
  identity: 'Identity & GTIN resolution',
  extraction: 'Web extraction & attribute parsing',
  facts: 'Fact prioritization & conflict resolution',
  classification: 'Taxonomy & category page guidance',
  sources: 'Source preferences & anti-patterns',
  abstention: 'Abstention criteria',
};

function formatInstructionsSection(instructions: AgentInstructionRule[]): string {
  if (instructions.length === 0) return '';

  const grouped: Record<string, string[]> = {};
  for (const rule of instructions) {
    if (!grouped[rule.category]) grouped[rule.category] = [];
    grouped[rule.category].push(rule.rule);
  }

  const sections: string[] = ['## Behavioral domain guidelines'];
  for (const [cat, rules] of Object.entries(grouped)) {
    const title = CATEGORY_TITLES[cat] ?? cat;
    sections.push(`### ${title}`);
    for (const r of rules) {
      sections.push(`- ${r}`);
    }
  }

  return sections.join('\n');
}

function budgetFewShotExamples(
  examples: AgentFewShotExample[],
  tokenBudget: number,
): { sectionText: string; includedExamples: AgentFewShotExample[]; tokenCount: number } {
  const activeExamples = examples.filter((e) => e.isActive);
  if (activeExamples.length === 0) {
    return { sectionText: '', includedExamples: [], tokenCount: 0 };
  }

  const included: AgentFewShotExample[] = [];
  let currentTokens = 0;

  for (const ex of activeExamples) {
    const formatted = formatSingleExample(ex);
    const cost = estimateTokens(formatted);
    if (currentTokens + cost > tokenBudget) {
      break;
    }
    included.push(ex);
    currentTokens += cost;
  }

  if (included.length === 0) {
    return { sectionText: '', includedExamples: [], tokenCount: 0 };
  }

  const text = [
    '## In-context reference examples',
    'Use these examples to understand expected output format and reasoning pattern:',
    '',
    ...included.map(formatSingleExample),
  ].join('\n');

  return {
    sectionText: text,
    includedExamples: included,
    tokenCount: currentTokens,
  };
}

function formatSingleExample(ex: AgentFewShotExample): string {
  return [
    `### Example: ${ex.gtin} (${ex.registerName})`,
    `**Rationale / Explanation**: ${ex.explanation}`,
    '```json',
    JSON.stringify(
      {
        input: {
          gtin: ex.gtin,
          registerName: ex.registerName,
          brandHint: ex.brandHint ?? null,
          price: ex.price ?? null,
          quantity: ex.quantity ?? null,
        },
        expectedOutput: ex.expectedOutput,
      },
      null,
      2,
    ),
    '```',
    '',
  ].join('\n');
}

/**
 * Fast rough token estimator (approx 4 chars per token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ─── Helpers (Preserving identical behavior to pi-prompt-builder) ────────────

function dataSharingDescription(policy: ProductIntelligencePolicy): string {
  switch (policy.dataSharingPolicy) {
    case 'local_only':
      return 'local processing only; do not send fetched content or product input to any third party';
    case 'cloud_models_only':
      return 'fetched content may be sent only to the configured model provider; never onward';
    case 'cloud_models_and_sources':
      return 'fetched content may be sent to the configured model provider and to allowlisted research sources';
  }
}

function executionModeLabel(mode: string): string {
  switch (mode) {
    case 'shadow':
      return 'shadow — results are evaluated and compared, never imported or published.';
    case 'interactive':
      return 'interactive — a human reviews your submission before anything else happens.';
    case 'onboarding':
      return 'onboarding — your submission feeds the human review stage of an onboarding item.';
    default:
      return mode;
  }
}

function hashPrompt(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
