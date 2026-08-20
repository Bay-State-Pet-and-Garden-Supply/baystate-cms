// story: e06s01, e07s01 — readiness rail state machine (server-derived, no grandfather; e07s01 Degraded when active but evidence-derived testsPass false)
export type ReadinessOverall = 'Not configured' | 'Draft' | 'Needs testing' | 'Ready for approval' | 'Active' | 'Degraded';

export interface ReadinessStep {
  id: number;
  label: string;
  status: 'complete' | 'active' | 'pending' | 'blocked';
}

export interface ReadinessState {
  overall: ReadinessOverall;
  steps: ReadinessStep[];
}

export interface ReadinessInput {
  hasProfile: boolean;
  hasIndex: boolean;
  hasDraft: boolean;
  confirmedCount: number;
  testsPass: boolean;
  isActive: boolean;
  needsRevalidation: boolean;
  productCount: number;
}

const STEP_LABELS = [
  '1. Official domain verified',
  '2. Product URLs indexed',
  '3. 3 representative products confirmed',
  '4. Draft generated',
  '5. Required tests pass',
  '6. Human approval/activation',
];

// story: e06s01
export function deriveReadinessState(input: ReadinessInput): ReadinessState {
  if (input.needsRevalidation && input.isActive) {
    return buildState('Degraded', input);
  }
  // e07s01: active but evidence-derived testsPass false → Degraded (not Draft)
  if (input.isActive && !input.testsPass) {
    return buildState('Degraded', input);
  }
  if (!input.hasProfile && !input.hasIndex) {
    return buildState('Not configured', input);
  }
  if (input.isActive && input.testsPass && !input.needsRevalidation) {
    return buildState('Active', input);
  }
  if (input.hasDraft && input.testsPass && input.confirmedCount >= 3) {
    return buildState('Ready for approval', input);
  }
  if (input.hasDraft && input.confirmedCount >= 3) {
    return buildState('Needs testing', input);
  }
  if (input.hasDraft || input.hasProfile) {
    return buildState('Draft', input);
  }
  return buildState('Not configured', input);
}

function buildState(overall: ReadinessOverall, input: ReadinessInput): ReadinessState {
  const steps: ReadinessStep[] = STEP_LABELS.map((label, idx) => ({
    id: idx + 1,
    label,
    status: deriveStepStatus(idx + 1, overall, input),
  }));
  return { overall, steps };
}

function deriveStepStatus(stepId: number, overall: ReadinessOverall, input: ReadinessInput): ReadinessStep['status'] {
  if (overall === 'Degraded') return 'blocked';
  if (overall === 'Active') return 'complete';
  if (stepId === 1) return input.hasProfile || input.hasIndex ? 'complete' : 'pending';
  if (stepId === 2) return input.hasIndex ? 'complete' : 'pending';
  if (stepId === 3) return input.confirmedCount >= 3 ? 'complete' : input.hasIndex ? 'active' : 'pending';
  if (stepId === 4) return input.hasDraft ? 'complete' : 'pending';
  if (stepId === 5) return input.testsPass ? 'complete' : input.hasDraft ? 'active' : 'pending';
  if (stepId === 6) return overall === 'Ready for approval' ? 'active' : 'pending';
  return 'pending';
}
