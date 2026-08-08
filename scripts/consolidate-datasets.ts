import fs from 'node:fs';
import path from 'node:path';
import { rebuildOfflineCorpus } from '../src/classification/datasets/silver-builder.js';
import { WeakLabelRules } from '../src/classification/datasets/weak-label-rules.js';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../src/classification/config-loader.js';
import { buildWeakLabelConfigFromBundle } from '../src/classification/datasets/weak-label-rules.js';

/**
 * Offline Bronze → Silver consolidation (Milestone 8).
 *
 * Deterministic and fully offline:
 * - reads `storage/training-corpus/**`
 * - resolves weak-label targets against the ACTIVE canonical v2 configuration
 * - preserves every Bronze observation in normalized Bronze
 * - writes `silver-v2-<digest>.jsonl` (deterministic representatives only)
 * - audits every legacy `silver-v1.jsonl` row as accepted/rejected/duplicate
 *
 * Repeated runs over identical inputs are byte-identical.
 */
async function main(): Promise<void> {
  const bronzeDir = path.resolve('storage/training-corpus');
  const outputDir = path.resolve('storage/datasets');
  const catalogPath = path.resolve('storage/catalog');

  if (!fs.existsSync(bronzeDir)) {
    console.error('❌ storage/training-corpus directory not found.');
    process.exit(1);
  }

  // Resolve the ACTIVE canonical configuration (read-only). This offline
  // script has no Page-identity needs: the empty-string workspace sentinel
  // omits verifiedPageIds (fail closed) rather than guessing a workspace ID.
  let authority;
  try {
    authority = loadRuntimeConfigAuthority(catalogPath, createRuntimeActivationContext(catalogPath, ''));
  } catch (error) {
    console.error('❌ Failed to load the active classification configuration:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const bundle =
    authority.kind === 'v2'
      ? authority.bundle
      : {
          productTypes: [],
          attributes: [],
        };
  const weakRules = new WeakLabelRules(buildWeakLabelConfigFromBundle(bundle as never));

  console.log(`🚀 Starting offline Bronze → Silver consolidation`);
  console.log(`   Bronze source:      ${bronzeDir}`);
  console.log(`   Active config:      ${authority.kind === 'v2' ? 'v2 (activated)' : 'v1 (transitional)'}`);
  console.log(`   Weak rule version:  ${weakRules.version}`);

  const summary = rebuildOfflineCorpus({
    bronzeDir,
    outputDir,
    weakRules,
    legacySilverFile: path.join(outputDir, 'silver', 'silver-v1.jsonl'),
  });

  console.log(`\n✅ Rebuild complete`);
  console.log(`   Bronze observations preserved: ${summary.bronzeTotal} (accepted ${summary.bronzeAccepted}, rejected ${summary.bronzeRejected}, duplicate ${summary.bronzeDuplicates})`);
  console.log(`   Silver v2 records:             ${summary.silverRecords}`);
  console.log(`   Legacy silver-v1 rows audited: ${summary.legacyRowsAudited}`);
  console.log(`   Normalized Bronze:             ${summary.bronzeFile}`);
  console.log(`   Silver v2:                     ${summary.silverFile}`);
  console.log(`   Legacy audit:                  ${summary.auditFile}`);
  console.log(`   Bronze manifest digest:        ${summary.bronzeManifestDigest}`);
  console.log(`   Silver manifest digest:        ${summary.silverManifestDigest}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
