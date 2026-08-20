// story: e06s04, e07s01 — evidence-gated activation (fail-closed on missing_matrix / artifact_mismatch / missing_samples)
import type { MatrixResult } from './profile-test-matrix';

export interface GateInput {
  requiredResults: Array<{ field: string; success: boolean }>;
  wrongProduct: boolean;
  wrongVariant: boolean;
  waiver: boolean;
  confirmedCount: number;
  imageRuleOk?: boolean;
  // e07s01 evidence (optional for backward compat; when supplied, fail-closed)
  matrixResult?: MatrixResult | null;
  expectedArtifactHashes?: string[] | null;
  sampleIds?: string[];
}

export interface GateResult {
  allowed: boolean;
  blockReason: string | null;
  reviseAction: string | null;
  reason: string | null;
}

export function evaluateGate(input: GateInput): GateResult {
  // e07s01 evidence checks (when caller opts into evidence gating)
  const hasEvidenceFields = 'matrixResult' in input || 'expectedArtifactHashes' in input || 'sampleIds' in input;
  if (hasEvidenceFields) {
    if (input.matrixResult === null || input.matrixResult === undefined) {
      return { allowed: false, blockReason: 'missing_matrix', reviseAction: 'Run test matrix against all confirmed samples', reason: 'missing_matrix' };
    }
    if (input.expectedArtifactHashes && input.expectedArtifactHashes.length > 0) {
      const expected = [...input.expectedArtifactHashes].sort();
      const actual = [...new Set(input.matrixResult!.rows.flatMap(r => r.cells.map(c => c.artifactHash)))].sort();
      const mismatch = expected.length !== actual.length || expected.some((h, i) => h !== actual[i]);
      if (mismatch) {
        return { allowed: false, blockReason: 'artifact_mismatch', reviseAction: 'Revise captures — artifact hashes do not match expected set', reason: `artifact_mismatch expected=${expected.join(',')} actual=${actual.join(',')}` };
      }
    }
    if (input.sampleIds && input.sampleIds.length > 0) {
      const seen = new Set(input.matrixResult!.rows.map(r => r.sampleId));
      const missing = input.sampleIds.filter(id => !seen.has(id));
      if (missing.length > 0) {
        return { allowed: false, blockReason: 'missing_samples', reviseAction: `Run matrix against missing samples: ${missing.join(', ')}`, reason: `missing_samples: ${missing.join(', ')}` };
      }
    }
  }

  if (input.wrongProduct) return { allowed: false, blockReason: 'wrong_product', reviseAction: 'Revise selectors to avoid wrong_product', reason: 'wrong_product detected' };
  if (input.wrongVariant) return { allowed: false, blockReason: 'wrong_variant', reviseAction: 'Revise selectors to avoid wrong_variant', reason: 'wrong_variant detected' };
  if (input.imageRuleOk === false) return { allowed: false, blockReason: 'image rule failed', reviseAction: 'Revise image selectors per two-sample rule', reason: 'image rule failed' };

  const failing = input.requiredResults.filter(r => !r.success);
  if (failing.length > 0) {
    const field = failing[0].field;
    return { allowed: false, blockReason: `${field} failed on 1 of ${input.requiredResults.length}`, reviseAction: `Revise ${field} selector`, reason: `${field} failed` };
  }

  if (input.confirmedCount < 3 && !input.waiver) {
    return { allowed: false, blockReason: 'needs_waiver: <3 confirmed products without audited waiver', reviseAction: null, reason: 'needs_waiver' };
  }

  return { allowed: true, blockReason: null, reviseAction: null, reason: null };
}

export function canActivateVersion(input: { draftVersion: string; passingVersion: string | null }): boolean {
  if (!input.passingVersion) return false;
  return input.draftVersion === input.passingVersion;
}
