import { getDb } from '../db/connection';
import { randomUUID } from 'node:crypto';
import type { ClassificationStageName, StageDefinition, StageContext, StageInput, StageOutput, PipelineRunResult } from './types';
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
  const stmt = db.prepare(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, is_bulk_acceptable, is_stale, staleness_reason, config_snapshot_hash, evidence_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of proposals) stmt.run(p.id || randomUUID(), runId, sku, p.proposalType, p.targetId ?? null, JSON.stringify(p.proposedValue), p.confidence, p.status, p.isBulkAcceptable ? 1 : 0, p.isStale ? 1 : 0, p.stalenessReason ?? null, configSnapshotHash ?? null, JSON.stringify(p.evidenceIds ?? []), now());
}

function linkProposalEvidence(proposalId: string, evidenceIds: string[]): void {
  if (evidenceIds.length === 0) return;
  const db = getDb();
  // Only link to evidence rows that already exist (FK safety).
  // Evidence IDs may reference in-memory-only evidence that has not been,
  // or will not be, persisted — silently skip those links rather than
  // failing the transaction.
  const stmt = db.prepare('INSERT OR IGNORE INTO classification_proposal_evidence (proposal_id, evidence_id) VALUES (?, ?)');
  for (const evId of evidenceIds) {
    const exists = db.query('SELECT 1 FROM classification_evidence WHERE id = ?').get(evId);
    if (exists) stmt.run(proposalId, evId);
  }
}

/**
 * Persist a successful or abstained stage atomically. A stage result must
 * never claim success unless all evidence, proposals, and evidence links are
 * durable in the same transaction.
 */
function persistStageCompletion(options: {
  runId: string;
  sku: string;
  stageName: ClassificationStageName;
  status: 'succeeded' | 'abstained';
  evidence: ClassificationEvidence[];
  proposals: ClassificationProposal[];
  onboardingItemId?: string;
  configSnapshotHash?: string;
  outputJson?: string;
  errorMessage?: string;
}): void {
  const db = getDb();
  db.transaction(() => {
    persistEvidence(options.runId, options.sku, options.evidence, options.onboardingItemId);
    persistProposals(options.runId, options.sku, options.proposals, options.configSnapshotHash);
    for (const proposal of options.proposals) {
      linkProposalEvidence(proposal.id, proposal.evidenceIds ?? []);
    }
    recordStageResult(
      options.runId,
      options.stageName,
      options.status,
      options.outputJson,
      options.errorMessage,
    );
  })();
}

export async function runPipeline(stages: StageDefinition[], context: StageContext, input: StageInput): Promise<PipelineRunResult> {
  const order = resolveStageOrder(stages);
  const allEvidence: ClassificationEvidence[] = [...input.evidence];
  const allProposals: ClassificationProposal[] = [...input.allProposals];
  const acceptedProposals: ClassificationProposal[] = [...input.acceptedProposals];
  const stageOutputs: Partial<Record<ClassificationStageName, StageOutput>> = {};

  for (const stageName of order) {
    const stage = stages.find(s => s.name === stageName);
    if (!stage) continue;
    const stageInput: StageInput = { sku: input.sku, onboardingItemId: input.onboardingItemId, sourceKind: input.sourceKind, evidence: allEvidence, acceptedProposals, allProposals };
    let failureRecorded = false;
    try {
      const result = await stage.execute(stageInput, context);
      if (result.status === 'succeeded') {
        const out = result.output;
        const outputPayload: Record<string, unknown> = {
          ec: out.evidence.length,
          pc: out.proposals.length,
        };
        if (out.metadata) outputPayload.metadata = out.metadata;

        persistStageCompletion({
          runId: context.runId,
          sku: input.sku,
          stageName,
          status: 'succeeded',
          evidence: out.evidence,
          proposals: out.proposals,
          onboardingItemId: input.onboardingItemId,
          configSnapshotHash: context.configSnapshotRef?.hash,
          outputJson: JSON.stringify(outputPayload),
        });

        // Downstream stages only see data after the transaction commits.
        allEvidence.push(...out.evidence);
        allProposals.push(...out.proposals);
        stageOutputs[stageName] = out;
      } else if (result.status === 'abstained') {
        const abstentionProposal: ClassificationProposal = {
          id: randomUUID(),
          runId: context.runId,
          productSku: input.sku,
          proposalType: 'reviewable_abstention',
          targetId: stageName,
          proposedValue: { reason: result.reason },
          confidence: 0,
          evidenceIds: [],
          status: 'pending',
          isBulkAcceptable: false,
          isStale: false,
          stalenessReason: null,
          createdAt: now(),
        };
        const outputPayload: Record<string, unknown> = {
          ec: 0,
          pc: 1,
          reason: result.reason,
        };
        if (result.output?.metadata) {
          outputPayload.metadata = result.output.metadata;
        }
        persistStageCompletion({
          runId: context.runId,
          sku: input.sku,
          stageName,
          status: 'abstained',
          evidence: [],
          proposals: [abstentionProposal],
          onboardingItemId: input.onboardingItemId,
          configSnapshotHash: context.configSnapshotRef?.hash,
          outputJson: JSON.stringify(outputPayload),
          errorMessage: result.reason,
        });
        allProposals.push(abstentionProposal);
      } else {
        recordStageResult(context.runId, stageName, 'failed', undefined, result.error);
        failureRecorded = true;
        throw new Error(`Stage ${stageName} failed: ${result.error}`);
      }
    } catch (err) {
      if (!failureRecorded) {
        recordStageResult(
          context.runId,
          stageName,
          'failed',
          undefined,
          err instanceof Error ? err.message : String(err),
        );
      }
      throw err;
    }
  }
  return { evidence: allEvidence, proposals: allProposals, stageOutputs };
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
