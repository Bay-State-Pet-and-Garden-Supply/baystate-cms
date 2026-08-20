// story: e06s03 — pure per-field governance helpers (no db imports)
export function isFieldDecisionPending(decisions: Record<string, string>, fieldKey: string): boolean {
  const v = decisions[fieldKey];
  return v === 'pending' || v === 'proposed';
}

export function canSaveProfile(decisions: Record<string, string>, _opts: { hasThreeConfirmed: boolean }): boolean {
  for (const v of Object.values(decisions)) {
    if (v === 'pending' || v === 'proposed') return false;
  }
  return true;
}
