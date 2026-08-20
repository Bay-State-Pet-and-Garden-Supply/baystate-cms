#!/usr/bin/env bun
import { getDb, initDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import {
  findItemById,
  completeSourcingWithDecision,
  updateItemStageStatus,
} from '../src/db/repositories/onboarding-item-repo';
import {
  getCurrentSourcingGeneration,
  getCurrentGenerationAttempts,
  completeSourcingGeneration,
} from '../src/db/repositories/onboarding-evidence-repo';
import { recordAcceptances } from '../src/db/repositories/onboarding-acceptance-repo';
import { reconcileDistributorEvidence } from '../src/onboarding/sourcing-reconciler';
import { buildDistributorRecordProjection } from '../src/onboarding/sourcing/distributor-record-projection';

async function main() {
  const dbPath =
    process.argv.find((arg) => arg.startsWith('--db='))?.split('=')[1] ||
    process.env.BAYSTATE_CMS_DB_PATH ||
    process.env.DATABASE_PATH ||
    './app.db';

  initDb(dbPath);
  runMigrations();

  const db = getDb();
  const blockedItems = db
    .query(
      `SELECT id, batch_id, upc, name, stage, stage_status, sourcing_entry_policy_version
       FROM onboarding_items
       WHERE stage = 'sourcing' AND stage_status = 'needs_input'`,
    )
    .all() as Array<{
    id: string;
    batch_id: string;
    upc: string;
    name: string;
    stage: string;
    stage_status: string;
    sourcing_entry_policy_version: number;
  }>;

  console.log(`Found ${blockedItems.length} item(s) in sourcing / needs_input.`);

  let unblockedCount = 0;

  for (const item of blockedItems) {
    const generation = getCurrentSourcingGeneration(item.id);
    if (!generation) {
      console.log(`- Skipping ${item.name} (${item.id}): no sourcing generation found`);
      continue;
    }

    const attempts = getCurrentGenerationAttempts(item.id);
    if (attempts.length === 0) {
      console.log(`- Skipping ${item.name} (${item.id}): no attempts recorded in current generation`);
      continue;
    }

    const declaredVariantAxes = Array.from(
      new Set(attempts.flatMap((a) => (a.variantAxisDeclarations ?? []).map((d) => d.normalizedAxis))),
    );

    const reconcile = reconcileDistributorEvidence(item.id, attempts, generation.id, declaredVariantAxes);
    const projection = buildDistributorRecordProjection({
      itemId: item.id,
      itemUpc: String(item.upc),
      sourcingGenerationId: generation.id,
      attempts,
      acceptedAttemptIds: reconcile.acceptedAttemptIds,
      declaredVariantAxes,
      resolutions: [],
    });

    if (projection.qualified) {
      recordAcceptances(item.id, projection.acceptedAttemptIds, 'system', 'auto-resolved qualified distributor record');

      const decision = {
        schemaVersion: 2 as const,
        route: 'distributor_record_to_extraction' as const,
        origin: 'automatic_policy' as const,
        acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
        providerIds: projection.providerIds,
        sourcingGenerationId: generation.id,
        conflicts: [],
        warnings: reconcile.warnings,
        decidedAt: new Date().toISOString(),
        evidenceHash: projection.evidenceHash,
        sourceType: 'distributor_record' as const,
        target: 'extraction' as const,
      };

      const res = completeSourcingWithDecision(item.id, decision, 'extraction');
      if (res.ok) {
        completeSourcingGeneration(generation.id, 'completed');
        // Mark any open conflicts as resolved
        db.query(
          `UPDATE onboarding_evidence_conflicts
           SET status = 'resolved', resolved_at = ?, resolved_by = 'system_auto_resolve'
           WHERE item_id = ? AND status = 'open'`,
        ).run(new Date().toISOString(), item.id);

        unblockedCount++;
        console.log(`✓ Unblocked and advanced to Extraction: ${item.name} (${item.upc})`);
      } else {
        console.error(`✗ Failed to complete sourcing for ${item.name}: ${res.reason}`);
      }
    } else {
      console.log(`- Item ${item.name} did not qualify: ${projection.reasonCodes.join(', ')}`);
    }
  }

  console.log(`\nSuccessfully unblocked ${unblockedCount} of ${blockedItems.length} items to Extraction!`);
}

main().catch((err) => {
  console.error('Error running unblock script:', err);
  process.exit(1);
});
