#!/usr/bin/env bun
/**
 * Classification Mapping Coverage Audit (P2 — one-shot, read-only).
 *
 * Cross-references THREE sources to answer "which ProductField slots are
 * actually available for map-on-demand attribute reactivation?":
 *   1. The LIVE field registry (repository pattern — `field_registry` DB rows
 *      observed from the store's XML export), the only authority for whether a
 *      slot is genuinely free (plan risk R7: code-level absence proves nothing).
 *   2. The bay-state-v4 release export mappings + attributes + facet profiles.
 *   3. Curation history (`curation_data_json` on onboarding items) as a DEMAND
 *      SIGNAL: how often each retired (`not_exported`, profile-less) attribute
 *      actually received curated values.
 *
 * NO writes except the optional `--out <path>` markdown report. No network.
 * All SQL access goes through src/db/repositories — this script contains no
 * raw queries of its own (house rule: repository pattern).
 *
 * Usage:
 *   bun scripts/classification-mapping-audit.ts --db <path> --workspace <id> [--out <path>]
 */
import fs from 'fs';
import path from 'node:path';
import { initDb } from '../src/db/connection';
import { listRegistry } from '../src/db/repositories/field-registry-repo';
import { listCurationDataRows, type CurationDataHistoryRow } from '../src/db/repositories/onboarding-item-repo';

// ─── Pure analysis core (exported for mapping-audit.test.ts) ──────────────────

export interface LiveFieldInfo { label: string; kind: string; dataType: string }

/** Slot classification for the audit report. */
export interface SlotAuditRecord {
  slot: string;
  /** Present in the live field registry for the audited workspace. */
  inLiveRegistry: boolean;
  live?: LiveFieldInfo;
  mappedInRelease: boolean;
  mappedAttributeId?: string;
  verdict: 'occupied_release_mapped' | 'occupied_live_only' | 'reserved_until_live_verified' | 'verify_band_code_free' | 'code_free';
  notes: string;
}

const ALL_SLOTS = Array.from({ length: 32 }, (_, i) => `ProductField${i + 1}`);
const RESERVED_NOTE_SLOTS = new Set(['ProductField31']);
const VERIFY_BAND_SLOTS = new Set(['ProductField9', 'ProductField10', 'ProductField11', 'ProductField12', 'ProductField15']);

export interface ReleaseConfigSnapshot {
  attributes: Array<Record<string, unknown>>;
  exportMappings: Array<Record<string, unknown>>;
  facetProfiles: Array<Record<string, unknown>>;
}

/** Attribute ids declared not_exported AND absent from every facet profile. */
export function retiredAttributeIds(config: ReleaseConfigSnapshot): string[] {
  const membership = profileMembershipIds(config.facetProfiles);
  return config.attributes
    .filter(a => dispositionKind(a) === 'not_exported' && !membership.has(String(a.id)))
    .map(a => String(a.id))
    .sort();
}

function dispositionKind(attr: Record<string, unknown>): string | null {
  const d = attr.exportDisposition as Record<string, unknown> | undefined;
  return typeof d?.kind === 'string' ? d.kind : null;
}

function profileMembershipIds(facetProfiles: Array<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  for (const profile of facetProfiles) {
    for (const attr of (profile.attributes ?? []) as Array<Record<string, unknown>>) {
      if (typeof attr.attributeId === 'string') ids.add(attr.attributeId);
    }
  }
  return ids;
}

/** Pure slot-coverage computation over the three audit sources. */
export function analyzeSlotCoverage(
  liveFields: ReadonlyMap<string, LiveFieldInfo>,
  config: ReleaseConfigSnapshot,
): SlotAuditRecord[] {
  const mappedFieldByAttribute = new Map<string, string>();
  const occupiedReleaseSlots = new Set<string>();
  for (const mapping of config.exportMappings) {
    const attributeId = String(mapping.attributeId);
    const catalogField = String(mapping.catalogField);
    mappedFieldByAttribute.set(attributeId, catalogField);
    occupiedReleaseSlots.add(catalogField);
  }
  return ALL_SLOTS.map((slot): SlotAuditRecord => {
    const inLive = liveFields.has(slot);
    const live = liveFields.get(slot);
    const mapperAttr = [...mappedFieldByAttribute.entries()].find(([, field]) => field === slot);
    if (mapperAttr) {
      return {
        slot,
        inLiveRegistry: inLive,
        ...(live ? { live } : {}),
        mappedInRelease: true,
        mappedAttributeId: mapperAttr[0],
        verdict: 'occupied_release_mapped',
        notes: inLive && live ? `live label "${live.label}" (${live.kind})` : 'NOT present in live registry — mapping may be stale',
      };
    }
    if (inLive) {
      return {
        slot,
        inLiveRegistry: true,
        live,
        mappedInRelease: false,
        verdict: 'occupied_live_only',
        notes: live ? `present in live registry with label "${live.label}" (${live.kind}) — NOT free` : 'present in live registry — NOT free',
      };
    }
    if (RESERVED_NOTE_SLOTS.has(slot)) {
      return {
        slot,
        inLiveRegistry: false,
        mappedInRelease: false,
        verdict: 'reserved_until_live_verified',
        notes: 'ShopSite "Product Category"; intentionally unmapped per store convention — owner sign-off required before any mapping',
      };
    }
    if (VERIFY_BAND_SLOTS.has(slot)) {
      return {
        slot,
        inLiveRegistry: false,
        mappedInRelease: false,
        verdict: 'verify_band_code_free',
        notes: 'legacy band PF9–PF15 — verify against production export before declaring free',
      };
    }
    return {
      slot,
      inLiveRegistry: false,
      mappedInRelease: false,
      verdict: 'code_free',
      notes: '',
    };
  });
}

export interface DemandSignalRow { proposedItems: number; acceptedItems: number }

/**
 * Demand signal from curation history: distinct ITEM counts per unmapped
 * attribute with any curated field_assignment proposal / accepted value.
 * Input comes exclusively from the repository (`listCurationDataRows`) —
 * no SQL here.
 */
export function collectDemandSignals(
  historyRows: readonly CurationDataHistoryRow[],
  unmappedAttributeIds: readonly string[],
): { demand: Map<string, DemandSignalRow>; scannedItems: number; parseFailures: number } {
  const demand = new Map<string, DemandSignalRow>(unmappedAttributeIds.map(id => [id, { proposedItems: 0, acceptedItems: 0 }]));
  let scannedItems = 0;
  let parseFailures = 0;
  for (const row of historyRows) {
    if (!row.curationDataJson) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.curationDataJson) as Record<string, unknown>;
    } catch {
      parseFailures += 1;
      continue;
    }
    scannedItems += 1;
    const proposals = Array.isArray(payload.classificationProposals) ? payload.classificationProposals as Array<Record<string, unknown>> : [];
    const decisions = Array.isArray(payload.classificationDecisions) ? payload.classificationDecisions as Array<Record<string, unknown>> : [];
    const acceptedProposalIds = new Set(
      decisions.filter(d => d.decision === 'accepted').map(d => String(d.proposalId ?? '')),
    );
    const hitAttrs = new Map<string, { proposed: boolean; accepted: boolean }>();
    for (const proposal of proposals) {
      if (proposal.proposalType !== 'field_assignment') continue;
      const targetId = String(proposal.targetId ?? '');
      if (!demand.has(targetId)) continue;
      const status = String(proposal.status ?? '');
      const entry = hitAttrs.get(targetId) ?? { proposed: false, accepted: false };
      // A proposal counts as accepted when reviewed+accepted OR durable accepted status.
      if (status === 'accepted' || acceptedProposalIds.has(String(proposal.id ?? ''))) entry.accepted = true;
      else entry.proposed = true;
      hitAttrs.set(targetId, entry);
    }
    for (const [attrId, { proposed, accepted }] of hitAttrs) {
      const d = demand.get(attrId)!;
      if (proposed || accepted) d.proposedItems += 1;
      if (accepted) d.acceptedItems += 1;
    }
  }
  return { demand, scannedItems, parseFailures };
}

/** Render the markdown report. PURE. */
export function renderAuditReport(input: {
  workspaceId: string;
  dbPath: string;
  generatedAt: string;
  slotRecords: SlotAuditRecord[];
  unmappedAttributes: readonly string[];
  demand: ReadonlyMap<string, DemandSignalRow>;
  scannedItems: number;
  parseFailures: number;
}): string {
  const lines: string[] = [];
  lines.push('# Classification Mapping Coverage Audit');
  lines.push('');
  lines.push(`Generated: \`${input.generatedAt}\``);
  lines.push(`Workspace: \`${input.workspaceId}\``);
  lines.push(`DB: \`${input.dbPath}\``);
  lines.push('');
  lines.push('One-shot read-only audit (plan section B.P2.2). Live field-registry presence is the ONLY basis for declaring a slot free (risk R7); PF31 stays reserved-until-live-verified regardless of absence.');
  lines.push('');

  const freeRecords = input.slotRecords.filter(r => !r.inLiveRegistry && r.verdict !== 'occupied_release_mapped');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Release-mapped slots: ${input.slotRecords.filter(r => r.verdict === 'occupied_release_mapped').length}`);
  lines.push(`- Live-occupied but release-unmapped slots: ${input.slotRecords.filter(r => r.verdict === 'occupied_live_only').length}`); 
  lines.push(`- Genuinely FREE slots (absent from BOTH release mappings AND live registry): ${freeRecords.length}${freeRecords.length > 0 ? ` (${freeRecords.map(r => r.slot).join(', ')})` : ' — none'}`);
  lines.push('');
  if (freeRecords.length === 0) {
    lines.push('**Conclusion: no map-on-demand capacity exists today.** Every ProductField slot is either mapped in the release or occupied by live store data. The hybrid disposition therefore resolves fully to RETIRE-BY-DEFAULT for the audited attributes until the store frees or adds slots.');
  } else {
    lines.push('Map-on-demand candidates must still clear: demonstrated demand + owner sign-off on reserved slots + profile membership granted in the SAME authored release.');
  }
  lines.push('');

  lines.push('## Occupied slots (mapped in bay-state-v4)');
  lines.push('');
  lines.push('| Slot | Attribute | In live registry | Live label / kind |');
  lines.push('|---|---|---|---|');
  for (const record of input.slotRecords.filter(r => r.verdict === 'occupied_release_mapped')) {
    lines.push(`| ${record.slot} | ${record.mappedAttributeId} | ${record.inLiveRegistry ? 'yes' : 'NO (stale?)'} | ${record.live ? `${record.live.label} / ${record.live.kind}` : '—'} |`);
  }
  lines.push('');

  lines.push('## Free slots (candidate pool for map-on-demand)');
  lines.push('');
  lines.push('| Slot | Live registry status | Verification verdict | Notes |');
  lines.push('|---|---|---|---|');
  for (const record of input.slotRecords.filter(r => r.verdict !== 'occupied_release_mapped')) {
    const status = record.inLiveRegistry ? `present (${record.live?.label})` : 'absent';
    lines.push(`| ${record.slot} | ${status} | ${record.verdict} | ${record.notes} |`);
  }
  lines.push('');

  lines.push('## Demand signal — retired (`not_exported`, profile-less) attributes');
  lines.push('');
  lines.push(`Scanned \`${input.scannedItems}\` item(s) with persisted curation payloads (\`${input.parseFailures}\` unparseable row(s) skipped).`);
  lines.push('');
  lines.push('| Attribute | Items with curated proposal | Items with accepted value |');
  lines.push('|---|---|---|');
  for (const attrId of input.unmappedAttributes) {
    const d = input.demand.get(attrId) ?? { proposedItems: 0, acceptedItems: 0 };
    lines.push(`| ${attrId} | ${d.proposedItems} | ${d.acceptedItems} |`);
  }
  lines.push('');
  lines.push('Disposition rule (plan section D): HYBRID — these attributes stay retired by default; map-on-demand requires demonstrated demand above PLUS a live-verified free slot PLUS a new authored release granting profile membership in the same artifact.');
  lines.push('');
  return lines.join('\n');
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (import.meta.main) {
  function fail(message: string): never {
    console.error(`classification-mapping-audit: ${message}`);
    process.exit(1);
  }

  function parseArgs(argv: string[]): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i]!;
      if (arg.startsWith('--')) {
        const eq = arg.indexOf('=');
        if (eq >= 0) {
          out[arg.slice(2, eq)] = arg.slice(eq + 1);
        } else {
          const key = arg.slice(2);
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith('--')) {
            out[key] = next;
            i += 1;
          } else {
            out[key] = true;
          }
        }
      }
    }
    return out;
  }

  const args = parseArgs(process.argv.slice(2));
  const dbPath = String(args.db ?? '');
  const workspaceId = String(args.workspace ?? '');
  if (!dbPath || !fs.existsSync(dbPath)) fail('--db <path> is required (and must exist).');
  if (!workspaceId) fail('--workspace <id> is required.');
  const outPath = args.out ? String(args.out) : null;

  initDb(dbPath);

  // Source 1: live field registry (repository pattern; no raw SQL anywhere in
  // this script).
  const liveFields = new Map<string, LiveFieldInfo>(
    listRegistry(workspaceId).map(row => [row.xmlField, { label: row.label, kind: row.kind, dataType: row.dataType }]),
  );

  // Source 2: v4 release config (immutable artifacts, plain file reads).
  const releaseDir = path.resolve(import.meta.dir, '../src/classification/releases/bay-state-v4');
  const readEntries = (fileName: string): Array<Record<string, unknown>> => {
    const parsed = JSON.parse(fs.readFileSync(path.join(releaseDir, fileName), 'utf8')) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? parsed.entries as Array<Record<string, unknown>> : [];
  };
  const config: ReleaseConfigSnapshot = {
    attributes: readEntries('attributes.json'),
    exportMappings: readEntries('export-mappings.json'),
    facetProfiles: readEntries('facet-profiles.json'),
  };

  // Source 3: demand signal from curation history (repository pattern).
  const unmapped = retiredAttributeIds(config);
  const { demand, scannedItems, parseFailures } = collectDemandSignals(listCurationDataRows(), unmapped);

  const report = renderAuditReport({
    workspaceId,
    dbPath,
    generatedAt: new Date().toISOString(),
    slotRecords: analyzeSlotCoverage(liveFields, config),
    unmappedAttributes: unmapped,
    demand,
    scannedItems,
    parseFailures,
  });

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report, 'utf8');
    console.log(`Audit written to ${outPath}`);
  } else {
    console.log(report);
  }
}
