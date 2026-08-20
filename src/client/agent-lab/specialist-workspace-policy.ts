export interface PolicySnapshotDisplay {
  configId: string;
  allowedTools: string[];
  researchTools: string[];
  allowedSourceDomains: string[];
  modelRoute: { provider: string; model: string; thinkingLevel: string } | null;
  maxToolCalls: number | null;
  maxCostUsd: number | null;
  deadlineMs: number | null;
  isReadOnly: true;
}

/** Parse the immutable server policy for read-only display. */
export function toPolicySnapshotDisplay(policyJson: string): PolicySnapshotDisplay | null {
  try {
    const policy = JSON.parse(policyJson) as Record<string, unknown>;
    return buildPolicySnapshot(policy);
  } catch {
    return null;
  }
}

function buildPolicySnapshot(policy: Record<string, unknown>): PolicySnapshotDisplay {
  return {
    configId: readString(policy.configId),
    allowedTools: readStrings(policy.allowedTools),
    researchTools: readStrings(policy.researchTools),
    allowedSourceDomains: readStrings(policy.allowedSourceDomains),
    modelRoute: readModelRoute(policy.modelRoute),
    maxToolCalls: readNumber(policy.maxToolCalls),
    maxCostUsd: readNumber(policy.maxCostUsd),
    deadlineMs: readNumber(policy.deadlineMs),
    isReadOnly: true,
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function readModelRoute(value: unknown): PolicySnapshotDisplay['modelRoute'] {
  if (!value || typeof value !== 'object') return null;
  const route = value as Record<string, unknown>;
  if (typeof route.provider !== 'string' || typeof route.model !== 'string') return null;
  return {
    provider: route.provider,
    model: route.model,
    thinkingLevel: typeof route.thinkingLevel === 'string' ? route.thinkingLevel : 'medium',
  };
}
