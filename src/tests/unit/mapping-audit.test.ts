/**
 * Classification Mapping Audit (P2) tests — plan B.P2.2.
 *
 * Hand-checks the free-slot computation against the committed bay-state-v4
 * release (PF31 reserved note present; PF9–12/PF15 verification band), and
 * proves the demand signal is computed from repository rows with NO raw SQL
 * in the script itself (house rule: SQL lives only in repositories).
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeSlotCoverage,
  collectDemandSignals,
  retiredAttributeIds,
  type ReleaseConfigSnapshot,
} from '../../../scripts/classification-mapping-audit';
import { listCurationDataRows } from '../../db/repositories/onboarding-item-repo';

const RELEASE_DIR = path.resolve(__dirname, '../../classification/releases/bay-state-v4');

const config: ReleaseConfigSnapshot = (() => {
  const readEntries = (fileName: string): Array<Record<string, unknown>> =>
    (JSON.parse(fs.readFileSync(path.join(RELEASE_DIR, fileName), 'utf8')) as { entries: unknown }).entries as Array<Record<string, unknown>>;
  return {
    attributes: readEntries('attributes.json'),
    exportMappings: readEntries('export-mappings.json'),
    facetProfiles: readEntries('facet-profiles.json'),
  };
})();

function recordBySlot(records: ReturnType<typeof analyzeSlotCoverage>, slot: string) {
  return records.find(r => r.slot === slot);
}

describe('mapping audit — free-slot computation (hand-checked)', () => {
  const records = analyzeSlotCoverage(new Map(), config);

  it('marks all 19 release-mapped slots as occupied_release_mapped', () => {
    const mapped = records.filter(r => r.verdict === 'occupied_release_mapped');
    expect(mapped).toHaveLength(19);
    // Spot-check the compiled projections and the brand field.
    expect(recordBySlot(records, 'ProductField13')?.mappedAttributeId).toBe('canonical-category-id');
    expect(recordBySlot(records, 'ProductField14')?.mappedAttributeId).toBe('canonical-breadcrumb');
    expect(recordBySlot(records, 'ProductField16')?.mappedAttributeId).toBe('brand');
  });

  it('flags PF31 as reserved-until-live-verified with the owner-sign-off note', () => {
    const pf31 = recordBySlot(records, 'ProductField31');
    expect(pf31?.verdict).toBe('reserved_until_live_verified');
    expect(pf31?.notes).toContain('owner sign-off');
    expect(pf31?.inLiveRegistry).toBe(false);
    expect(pf31?.mappedInRelease).toBe(false);
  });

  it('puts PF9–PF12 and PF15 in the verification band with an explicit verify note', () => {
    for (const slot of ['ProductField9', 'ProductField10', 'ProductField11', 'ProductField12', 'ProductField15']) {
      const record = recordBySlot(records, slot);
      expect(record?.verdict, slot).toBe('verify_band_code_free');
      expect(record?.notes).toContain('verify against production export');
    }
  });

  it('live-registry presence overrides code-level freeness (risk R7)', () => {
    // If a "code-free" slot secretly exists in the live registry, it must be
    // classified occupied_live_only, never free.
    const live = new Map([['ProductField9', { label: 'Legacy Store Data', kind: 'custom', dataType: 'string' }]]);
    const recordsWithLive = analyzeSlotCoverage(live, config);
    const pf9 = recordBySlot(recordsWithLive, 'ProductField9');
    expect(pf9?.verdict).toBe('occupied_live_only');
    expect(pf9?.notes).toContain('NOT free');
  });

  it('the eight retired attributes match the plan inventory', () => {
    expect(retiredAttributeIds(config)).toEqual([
      'btu-rating',
      'fuel-type',
      'hose-length',
      'joule-rating',
      'npk-ratio',
      'protein-pct',
      'safety-toe-type',
      'towing-capacity-lbs',
    ]);
  });
});

describe('mapping audit — demand signals', () => {
  it('counts distinct items with curated proposals/accepted values per attribute', () => {
    const rows = [
      {
        id: 'item-1',
        upc: 'UPC-1',
        name: 'Heater A',
        curationDataJson: JSON.stringify({
          classificationProposals: [
            { id: 'p1', proposalType: 'field_assignment', targetId: 'btu-rating', status: 'pending' },
            { id: 'p2', proposalType: 'field_assignment', targetId: 'fuel-type', status: 'accepted' },
            { id: 'p3', proposalType: 'primary_product_type', targetId: 'heating' },
          ],
          classificationDecisions: [],
        }),
      },
      {
        id: 'item-2',
        upc: 'UPC-2',
        name: 'Heater B',
        curationDataJson: JSON.stringify({
          classificationProposals: [
            { id: 'p4', proposalType: 'field_assignment', targetId: 'btu-rating', status: 'pending' },
          ],
          classificationDecisions: [
            { id: 'd1', proposalId: 'p4', decision: 'accepted' },
          ],
        }),
      },
      { id: 'item-3', upc: 'UPC-3', name: 'No payload', curationDataJson: null },
      { id: 'item-4', upc: 'UPC-4', name: 'Corrupt', curationDataJson: '{not json' },
    ];
    const unmapped = retiredAttributeIds(config);
    const { demand, scannedItems, parseFailures } = collectDemandSignals(rows, unmapped);
    expect(scannedItems).toBe(2);
    expect(parseFailures).toBe(1);
    // Superset semantics: an accepted value also had a curated proposal, so
    // accepted items count in BOTH columns ("with accepted value" ⊆ "with proposal").
    expect(demand.get('btu-rating')).toEqual({ proposedItems: 2, acceptedItems: 1 });
    expect(demand.get('fuel-type')).toEqual({ proposedItems: 1, acceptedItems: 1 });
    expect(demand.get('npk-ratio')).toEqual({ proposedItems: 0, acceptedItems: 0 });
  });

  it('demand collection consumes REPOSITORY rows only — no raw SQL in the script', () => {
    // Structural assertion of the house rule: the script must import its rows
    // from src/db/repositories/* and contain no direct .query(/.run( SQL.
    const script = fs.readFileSync(
      path.resolve(__dirname, '../../../scripts/classification-mapping-audit.ts'),
      'utf8',
    );
    expect(script).toContain("from '../src/db/repositories/field-registry-repo'");
    expect(script).toContain("from '../src/db/repositories/onboarding-item-repo'");
    expect(script).toContain('listCurationDataRows()');
    expect(script).not.toMatch(/\.query\(/);
    expect(script).not.toMatch(/\bSELECT\b.*\bFROM\b/s);
    // And the repository function itself is the durable seam:
    expect(typeof listCurationDataRows).toBe('function');
  });
});
