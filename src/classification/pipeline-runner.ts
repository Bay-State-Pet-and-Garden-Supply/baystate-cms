import { getDb } from '../db/connection';
import { randomUUID } from 'node:crypto';
import type { ClassificationStageName, StageDefinition, StageContext, StageInput, StageOutput } from './types';
import type { ClassificationEvidence, ClassificationProposal } from '../shared/types';

const now = () => new Date().toISOString();

function recordStageResult(runId: string, stageName: ClassificationStageName, status: string, outputJson?: string, errorMessage?: string): string {
  const id = randomUUID();
  getDb().run(`INSERT INTO classification_stage_results (id, run_id, stage_name, status, output_json, error_message, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, runId, stageName, status, outputJson ?? null, errorMessage ?? null, now(), now()]);
  return id;
}

function persistEvidence(runId: string, sku: string, evidence: ClassificationEvidence[], onboardingItemId?: string): void {
  if (evidence.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`INSERT INTO classification_evidence (id, run_id, onboarding_item_id, product_sku, stage_name, source, reliability, attribute_id, source_url, source_field, snippet, value_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const e of evidence) stmt.run(e.id || randomUUID(), runId, onboardingItemId ?? null, sku, e.stageName, e.source, e.reliability, e.attributeId ?? null, e.sourceUrl ?? null, e.sourceField ?? null, e.snippet ?? null, JSON.stringify(e.value ?? null), JSON.stringify(e.metadata ?? {}), now());
}

function persistProposals(runId: string, sku: string, proposals: ClassificationProposal[], configSnapshotHash?: string): void {
  if (proposals.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, is_bulk_acceptable, is_stale, staleness_reason, config_snapshot_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of proposals) stmt.run(p.id || randomUUID(), runId, sku, p.proposalType, p.targetId ?? null, JSON.stringify(p.proposedValue), p.confidence, p.status, p.isBulkAcceptable ? 1 : 0, p.isStale ? 1 : 0, p.stalenessReason ?? null, configSnapshotHash ?? null, now());
}

function linkProposalEvidence(proposalId: string, evidenceIds: string[]): void {
  if (evidenceIds.length === 0) return;
  const db = getDb();
  try {
    db.run('PRAGMA foreign_keys = OFF');
    const stmt = db.prepare('INSERT OR IGNORE INTO classification_proposal_evidence (proposal_id, evidence_id) VALUES (?, ?)');
    for (const evId of evidenceIds) stmt.run(proposalId, evId);
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}

export async function runPipeline(stages: StageDefinition[], context: StageContext, input: StageInput): Promise<{ evidence: ClassificationEvidence[]; proposals: ClassificationProposal[] }> {
  const order = resolveStageOrder(stages);
  const allEvidence: ClassificationEvidence[] = [...input.evidence];
  const allProposals: ClassificationProposal[] = [...input.allProposals];
  const acceptedProposals: ClassificationProposal[] = [...input.acceptedProposals];

  for (const stageName of order) {
    const stage = stages.find(s => s.name === stageName);
    if (!stage) continue;
    const stageInput: StageInput = { sku: input.sku, onboardingItemId: input.onboardingItemId, evidence: allEvidence, acceptedProposals, allProposals };
    try {
      const result = await stage.execute(stageInput, context);
      if (result.status === 'succeeded') {
        const out = result.output;
        try { persistEvidence(context.runId, input.sku, out.evidence, input.onboardingItemId); } catch {}
        try { persistProposals(context.runId, input.sku, out.proposals, context.configSnapshotRef?.hash); } catch {}
        try { for (const p of out.proposals) linkProposalEvidence(p.id, p.evidenceIds ?? []); } catch {}
        allEvidence.push(...out.evidence);
        allProposals.push(...out.proposals);
        recordStageResult(context.runId, stageName, 'succeeded', JSON.stringify({ ec: out.evidence.length, pc: out.proposals.length }));
      } else if (result.status === 'abstained') {
        recordStageResult(context.runId, stageName, 'abstained', undefined, result.reason);
        allProposals.push({ id: randomUUID(), runId: context.runId, productSku: input.sku, proposalType: 'reviewable_abstention', targetId: stageName, proposedValue: { reason: result.reason }, confidence: 0, evidenceIds: [], status: 'pending', isBulkAcceptable: false, isStale: false, stalenessReason: null, createdAt: now() });
      } else {
        recordStageResult(context.runId, stageName, 'failed', undefined, result.error);
      }
    } catch (err) {
      recordStageResult(context.runId, stageName, 'failed', undefined, err instanceof Error ? err.message : String(err));
    }
  }
  return { evidence: allEvidence, proposals: allProposals };
}

function resolveStageOrder(stages: StageDefinition[]): ClassificationStageName[] {
  const names = new Set(stages.map(s => s.name));
  const inDegree = new Map<ClassificationStageName, number>();
  const dependents = new Map<ClassificationStageName, ClassificationStageName[]>();
  for (const s of stages) { inDegree.set(s.name, 0); dependents.set(s.name, []); for (const dep of s.requires) { if (names.has(dep)) { inDegree.set(s.name, (inDegree.get(s.name) ?? 0) + 1); dependents.set(dep, [...(dependents.get(dep) ?? []), s.name]); } } }
  const queue: ClassificationStageName[] = []; for (const [n, d] of inDegree) if (d === 0) queue.push(n);
  const result: ClassificationStageName[] = [];
  while (queue.length) { const n = queue.shift()!; result.push(n); for (const dep of dependents.get(n) ?? []) { const nd = (inDegree.get(dep) ?? 1) - 1; inDegree.set(dep, nd); if (nd === 0) queue.push(dep); } }
  for (const s of stages) if (!result.includes(s.name)) result.push(s.name);
  return result;
}
