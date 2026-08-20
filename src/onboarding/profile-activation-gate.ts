// story: e06s04

export interface GateInput {
  requiredResults: Array<{ field: string; success: boolean }>;
  wrongProduct: boolean;
  wrongVariant: boolean;
  waiver: boolean;
  confirmedCount: number;
  imageRuleOk?: boolean;
}

export interface GateResult {
  allowed: boolean;
  blockReason: string | null;
  reviseAction: string | null;
  reason: string | null;
}

export function evaluateGate(input: GateInput): GateResult {
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
