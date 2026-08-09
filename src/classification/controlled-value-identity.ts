/**
 * Controlled-value string identity (issue #17 work item G).
 *
 * A controlled value ID is exactly its stored canonical string after required
 * NFC normalization and trimming. Config must already contain that canonical
 * representation; labels equal IDs by the documented v2 policy. These central
 * helpers replace ad hoc case-insensitive canonicalization so the runtime
 * never guesses a canonical ID from a display label.
 *
 * Fail-closed invariants:
 * - Ambiguous normalized values cannot activate.
 * - Unknown/near-match values cannot serialize as controlled values.
 * - Runtime never guesses a canonical ID from a display label.
 *
 * Renaming a value is an identity change. The old ID must remain resolvable
 * through a reviewed alias/migration; it is never silently rewritten because
 * display text changed.
 */

/** One canonical option; label equals ID by v2 policy. */
export interface ControlledValueOption {
  value: string;
  label: string;
}

/**
 * Comparison key used for matching evidence text to a controlled value ID:
 * NFC-normalized + trimmed + case-folded (en-US). Because config validation
 * rejects normalized/case-fold collision pairs, a comparison key is unique
 * within a validated allowed-value set.
 */
export function comparisonKey(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase('en-US');
}

/**
 * The stored canonical form of a controlled value ID: NFC-normalized and
 * trimmed (no case folding — case is part of the identity). Config must
 * already contain this representation.
 */
export function canonicalForm(value: string): string {
  return value.normalize('NFC').trim();
}

export interface CanonicalValueValidation {
  ok: boolean;
  reason?: 'empty' | 'control-character' | 'non-nfc' | 'not-trimmed';
}

/**
 * Validate that a single configured controlled value is canonical:
 * non-empty, free of control characters, already NFC-normalized, and already
 * trimmed. A value that fails validation was stored in a non-canonical form
 * and must be repaired in config — it is never silently rewritten.
 */
export function validateCanonicalValue(value: string): CanonicalValueValidation {
  if (value.length === 0 || value.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }
  // eslint-disable-next-line no-control-regex -- intentional control-character rejection
  const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
  if (CONTROL_CHAR.test(value)) {
    return { ok: false, reason: 'control-character' };
  }
  if (value !== value.normalize('NFC')) {
    return { ok: false, reason: 'non-nfc' };
  }
  if (value !== value.trim()) {
    return { ok: false, reason: 'not-trimmed' };
  }
  return { ok: true };
}

export type CanonicalCollisionKind = 'exact' | 'normalized' | 'case-fold';

export interface CanonicalCollision {
  a: string;
  b: string;
  kind: CanonicalCollisionKind;
}

/**
 * Find all collision pairs inside an allowed-value set:
 * - exact: byte-identical duplicates (after canonical form),
 * - normalized: two distinct values whose NFC+trim forms are equal,
 * - case-fold: two distinct values whose comparison keys are equal.
 *
 * Any collision pair makes the set ambiguous and must be rejected at config
 * validation time.
 */
export function findCanonicalCollisions(values: string[]): CanonicalCollision[] {
  const collisions: CanonicalCollision[] = [];
  const seenExact = new Map<string, string>();
  const seenCaseFold = new Map<string, string>();

  for (const value of values) {
    const form = canonicalForm(value);
    const key = comparisonKey(value);

    const exactPrior = seenExact.get(form);
    if (exactPrior !== undefined) {
      if (exactPrior === value) {
        collisions.push({ a: exactPrior, b: value, kind: 'exact' });
      } else {
        collisions.push({ a: exactPrior, b: value, kind: 'normalized' });
      }
    } else {
      seenExact.set(form, value);
    }

    const caseFoldPrior = seenCaseFold.get(key);
    if (caseFoldPrior !== undefined && caseFoldPrior !== value) {
      collisions.push({ a: caseFoldPrior, b: value, kind: 'case-fold' });
    } else {
      seenCaseFold.set(key, value);
    }
  }

  return collisions;
}

/**
 * Resolve a candidate to the exact canonical allowed ID. The candidate is
 * compared by comparison key (NFC + trim + case fold); the result is always
 * one of the exact allowed strings. Returns null when there is no match or
 * when more than one allowed value matches the same key (ambiguity fails
 * closed — the collision should have been rejected at config validation).
 */
export function matchCanonicalValue(candidate: unknown, allowedValues: string[]): string | null {
  const raw = String(candidate ?? '').trim();
  if (!raw) return null;
  const key = comparisonKey(raw);
  const matches = allowedValues.filter(value => comparisonKey(value) === key);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolve an alias string to its exact canonical allowed ID. An alias is only
 * valid when exactly one configured alias matches the candidate by comparison
 * key AND its `mapsTo` is one of the exact allowed IDs. Unknown aliases,
 * ambiguous aliases, and aliases pointing outside the allowed set fail closed
 * (null).
 */
export function resolveAlias(
  candidate: unknown,
  aliases: Array<{ alias: string; mapsTo: string }>,
  allowedValues: string[],
): string | null {
  const raw = String(candidate ?? '');
  if (!raw) return null;
  const key = comparisonKey(raw);
  const allowed = new Set(allowedValues);
  const matches = aliases.filter(entry => comparisonKey(entry.alias) === key);
  if (matches.length !== 1) return null;
  const target = matches[0].mapsTo;
  return allowed.has(target) ? target : null;
}

/**
 * Canonical `{value, label}` option for a controlled value ID. Label equals
 * ID by the documented v2 policy — the option builder never invents a display
 * label distinct from the canonical identity.
 */
export function canonicalOption(id: string): ControlledValueOption {
  return { value: id, label: id };
}

/** Map a list of canonical IDs to their canonical options. */
export function canonicalOptions(ids: string[]): ControlledValueOption[] {
  return ids.map(canonicalOption);
}
