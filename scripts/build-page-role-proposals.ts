#!/usr/bin/env bun
/**
 * Build page-role PROPOSALS for bay-state-v4 (ChatGPT v4 review fix #6).
 *
 * Produces a CURATION ARTIFACT — deterministic proposals for human
 * ratification. It does NOT modify the release's shopsite-projection.json
 * (which keeps its current roles until a human ratifies).
 *
 * Pipeline per page:
 *   1. ROLE-DETECT first (navigation → shop_all → merchandising → legacy)
 *   2. CANONICAL MATCHING only for remaining candidates, using weighted
 *      evidence (species/department agreement > family agreement >
 *      distinctive subtype tokens > normalized overlap > legacy evidence)
 *   3. Confidence classes: exact / high / ambiguous / role_conflict /
 *      unmatched / ratified (already-rolled pages)
 *
 * Output: src/classification/curation/page-role-proposals.json
 * Idempotent: fixed createdAt, stable sort order.
 *
 * Usage: bun run scripts/build-page-role-proposals.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const RELEASE_DIR = path.join(ROOT, 'src', 'classification', 'releases', 'bay-state-v4');
const LEGACY_MAPPINGS_FILE = path.join(ROOT, 'src', 'classification', 'taxonomy', 'shopsite-field-mappings.json');
const OUT_FILE = path.join(ROOT, 'src', 'classification', 'curation', 'page-role-proposals.json');
const CREATED_AT = '2026-08-17T00:00:00.000Z';

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const projection = loadJson(path.join(RELEASE_DIR, 'shopsite-projection.json')).entries as Array<{
  pageName: string;
  role: string;
  nodeId: string | null;
  productCount: number;
}>;
const hierarchy = loadJson(path.join(RELEASE_DIR, 'hierarchy.json')).entries as Array<{
  id: string;
  label: string;
  parentId: string | null;
  classifiable: boolean;
  departmentId: string;
}>;
const legacyAssignments = loadJson(LEGACY_MAPPINGS_FILE).categoryPageAssignments as Record<string, string[]>;

// ─── Normalization ─────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bshop all\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(name: string): Set<string> {
  return new Set(normalizeName(name).split(' ').filter(Boolean));
}

// Species/department hints: first-token species agreement (weight 5).
const SPECIES_HINTS: Record<string, string[]> = {
  dog: ['dog'],
  cat: ['cat'],
  bird: ['bird', 'caged bird', 'wild bird'],
  horse: ['horse'],
  livestock: ['livestock', 'poultry', 'cattle', 'goat', 'pig', 'bee', 'chicken'],
  lawn: ['lawn', 'garden', 'grass', 'plant'],
  fencing: ['fence', 'fencing'],
  heating: ['heating', 'propane', 'wood', 'fuel'],
  power: ['power', 'lawn mower', 'chainsaw', 'pressure washer'],
  towing: ['trailer', 'towing', 'hitch'],
  apparel: ['work', 'boots', 'gloves', 'apparel'],
  wildlife: ['wildlife', 'deer', 'squirrel'],
};

// Leaf + browse node label lookup (normalized) with species tag.
const nodesByNormalizedLabel = new Map<string, (typeof hierarchy)[number]>();
for (const node of hierarchy) {
  nodesByNormalizedLabel.set(normalizeName(node.label), node);
}

// Legacy page evidence: normalized legacy page name → v3 type id.
const legacyPageToType = new Map<string, string>();
for (const [typeId, pages] of Object.entries(legacyAssignments)) {
  for (const page of pages) legacyPageToType.set(normalizeName(page), typeId);
}

// v3 type id → leaf node id (legacyTypeIds bijection on leaves).
const typeIdToLeafNode = new Map<string, string>();
for (const node of hierarchy) {
  if (node.classifiable) typeIdToLeafNode.set(node.id, node.id);
}

function speciesOfPage(pageName: string): string | null {
  const norm = normalizeName(pageName);
  for (const [species, hints] of Object.entries(SPECIES_HINTS)) {
    for (const hint of hints) {
      if (norm.startsWith(hint)) return species;
    }
  }
  return null;
}

function speciesOfNode(node: { id: string; label: string; departmentId: string }): string | null {
  const norm = normalizeName(node.label);
  for (const [species, hints] of Object.entries(SPECIES_HINTS)) {
    for (const hint of hints) {
      if (norm.startsWith(hint) || norm.includes(hint)) return species;
    }
  }
  // Fall back to department id species.
  const deptNorm = node.departmentId;
  for (const [species, hints] of Object.entries(SPECIES_HINTS)) {
    for (const hint of hints) {
      if (deptNorm.includes(hint)) return species;
    }
  }
  return null;
}

// ─── Role detection (step 1) ───────────────────────────────────────────────────

function detectRole(pageName: string): { role: string; merchandisingKind?: string; brand?: string } | null {
  if (/\bshop all\b/i.test(pageName)) return { role: 'shop_all_aggregate' };
  if (/^##facebook|^#services|delivery|landscape services|propane filling|lawn equipment rental|^home$/i.test(pageName)) {
    return { role: 'navigation' };
  }
  const brandMatch = /^brand\s*-\s*(.+)$/i.exec(pageName);
  if (brandMatch) return { role: 'merchandising', merchandisingKind: 'brand', brand: brandMatch[1].trim() };
  if (/featured|special offers|season|gift shop|candles|refreshments|soap|grills|holiday|fall shop|winter supplies|the fall|the holiday/i.test(pageName)) {
    return { role: 'merchandising' };
  }
  return null;
}

// ─── Canonical matching (step 2) ───────────────────────────────────────────────

interface Candidate {
  nodeId: string;
  label: string;
  score: number;
  reasons: string[];
}

function scoreCandidate(pageName: string, node: (typeof hierarchy)[number]): Candidate {
  const reasons: string[] = [];
  let score = 0;
  const pageNorm = normalizeName(pageName);
  const pageTokens = tokenSet(pageName);

  // Species agreement (weight 5).
  const pageSpecies = speciesOfPage(pageName);
  const nodeSpecies = speciesOfNode(node);
  if (pageSpecies && nodeSpecies && pageSpecies === nodeSpecies) {
    score += 5;
    reasons.push(`species:${pageSpecies}`);
  } else if (pageSpecies && nodeSpecies && pageSpecies !== nodeSpecies) {
    score -= 6;
    reasons.push(`species-conflict:${pageSpecies}!=${nodeSpecies}`);
  }

  // Family agreement (weight 3): family browse node or family-like tokens.
  const familyTokens = ['food', 'treats', 'toys', 'litter', 'beds', 'grooming', 'feeders', 'seed', 'supplements', 'health'];
  const pageFamily = [...pageTokens].filter(t => familyTokens.includes(t));
  const nodeFamily = [...tokenSet(node.label)].filter(t => familyTokens.includes(t));
  const sharedFamily = pageFamily.filter(t => nodeFamily.includes(t));
  if (sharedFamily.length > 0) {
    score += 3 * sharedFamily.length;
    reasons.push(`family:${sharedFamily.join(',')}`);
  }

  // Normalized token overlap (weight 1 per token).
  const nodeTokens = tokenSet(node.label);
  const overlap = [...pageTokens].filter(t => nodeTokens.has(t));
  score += overlap.length;
  if (overlap.length > 0) reasons.push(`overlap:${overlap.join(',')}`);

  // Distinctive subtype tokens: page tokens beyond species/family/overlap
  // that are unique to this candidate's label (weight 2 each).
  const distinctive = [...pageTokens].filter(
    t => !familyTokens.includes(t) && !nodeTokens.has(t) && t.length > 2,
  );
  if (distinctive.length === 0) {
    score += 2;
    reasons.push('no-distinctive-remainder');
  }

  // Legacy evidence (weight 4): page name appears in legacy type→page map.
  const legacyType = legacyPageToType.get(pageNorm);
  if (legacyType && typeIdToLeafNode.has(legacyType) && typeIdToLeafNode.get(legacyType) === node.id) {
    score += 4;
    reasons.push(`legacy:${legacyType}`);
  } else if (legacyType) {
    score += 1;
    reasons.push(`legacy-partial:${legacyType}`);
  }

  return { nodeId: node.id, label: node.label, score, reasons };
}

function matchCanonical(pageName: string): { role: string; nodeId: string | null; confidence: string; evidence: string[]; alternatives: Array<{ nodeId: string; score: number }> } {
  const candidates: Candidate[] = [];
  const normalized = normalizeName(pageName);

  // Exact normalized label match first.
  const exact = nodesByNormalizedLabel.get(normalized);
  if (exact) {
    return {
      role: exact.classifiable ? 'canonical_leaf' : 'canonical_browse',
      nodeId: exact.id,
      confidence: 'exact',
      evidence: [`exact normalized label match → ${exact.label}`],
      alternatives: [],
    };
  }

  for (const node of hierarchy) {
    if (node.classifiable || node.parentId === null) continue; // leaves + roots only? browse nodes too
    const cand = scoreCandidate(pageName, node);
    if (cand.score >= 3) candidates.push(cand);
  }
  // Include classifiable leaves too.
  for (const node of hierarchy) {
    if (!node.classifiable) continue;
    const cand = scoreCandidate(pageName, node);
    if (cand.score >= 3) candidates.push(cand);
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return { role: 'needs_review', nodeId: null, confidence: 'unmatched', evidence: ['no candidate scored >= 3'], alternatives: [] };
  }

  const top = candidates[0];
  const second = candidates[1];
  const gap = top.score - (second?.score ?? 0);

  if (gap >= 4 && top.score >= 8) {
    return {
      role: top.nodeId && hierarchy.find(n => n.id === top.nodeId)?.classifiable ? 'canonical_leaf' : 'canonical_browse',
      nodeId: top.nodeId,
      confidence: 'exact',
      evidence: top.reasons,
      alternatives: candidates.slice(1, 3).map(c => ({ nodeId: c.nodeId, score: c.score })),
    };
  }
  if (gap >= 2 && top.score >= 6) {
    return {
      role: top.nodeId && hierarchy.find(n => n.id === top.nodeId)?.classifiable ? 'canonical_leaf' : 'canonical_browse',
      nodeId: top.nodeId,
      confidence: 'high',
      evidence: top.reasons,
      alternatives: candidates.slice(1, 3).map(c => ({ nodeId: c.nodeId, score: c.score })),
    };
  }
  return {
    role: 'needs_review',
    nodeId: null,
    confidence: 'ambiguous',
    evidence: top.reasons,
    alternatives: candidates.slice(0, 3).map(c => ({ nodeId: c.nodeId, score: c.score })),
  };
}

// ─── Assemble proposals ─────────────────────────────────────────────────────────

const proposals = projection.map(page => {
  const detected = detectRole(page.pageName);
  if (page.role !== 'needs_review') {
    return {
      pageName: page.pageName,
      productCount: page.productCount,
      proposedRole: page.role,
      proposedNodeId: page.nodeId,
      confidence: 'ratified',
      evidence: ['current release role'],
      alternatives: [],
    };
  }
  if (detected) {
    return {
      pageName: page.pageName,
      productCount: page.productCount,
      proposedRole: detected.role,
      proposedNodeId: null,
      confidence: detected.role === 'merchandising' && detected.merchandisingKind === 'brand' ? 'high' : 'exact',
      evidence: [`role detection: ${detected.role}${detected.brand ? ` (brand ${detected.brand})` : ''}`],
      alternatives: [],
    };
  }
  const matched = matchCanonical(page.pageName);
  return {
    pageName: page.pageName,
    productCount: page.productCount,
    proposedRole: matched.role,
    proposedNodeId: matched.nodeId,
    confidence: matched.confidence,
    evidence: matched.evidence,
    alternatives: matched.alternatives,
  };
});

// Sort: ratified first, then exact, high, ambiguous, unmatched.
const CONF_ORDER: Record<string, number> = { ratified: 0, exact: 1, high: 2, ambiguous: 3, unmatched: 4 };
proposals.sort((a, b) => {
  const diff = (CONF_ORDER[a.confidence] ?? 5) - (CONF_ORDER[b.confidence] ?? 5);
  if (diff !== 0) return diff;
  return a.pageName.localeCompare(b.pageName);
});

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
const out = {
  schemaVersion: 1,
  createdAt: CREATED_AT,
  generatedBy: 'scripts/build-page-role-proposals.ts',
  notes: [
    'Curation artifact — deterministic PROPOSALS for human ratification. Ratified assignments must be written back to shopsite-projection.json (role + nodeId) with decisionSource curated.',
    'Role detection runs BEFORE canonical matching (navigation → shop_all → merchandising → legacy).',
    'Confidence: exact (unique, score>=8 or exact label), high (unique, score>=6), ambiguous (multiple candidates), unmatched (none >=3). Brand - X pages are always merchandising.',
    'needs_review must reach 0 in shopsite-projection.json before the compiler phase (ChatGPT gate).',
  ],
  proposals,
};
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');

// ─── Report ─────────────────────────────────────────────────────────────────────

const byConfidence: Record<string, number> = {};
const byRole: Record<string, number> = {};
for (const p of proposals) {
  byConfidence[p.confidence] = (byConfidence[p.confidence] ?? 0) + 1;
  byRole[p.proposedRole] = (byRole[p.proposedRole] ?? 0) + 1;
}
console.log('=== page-role proposals ===');
console.log('by confidence:', JSON.stringify(byConfidence));
console.log('by proposed role:', JSON.stringify(byRole));

// Validation: proposedNodeIds must exist and respect classifiability.
const nodeById = new Map(hierarchy.map(n => [n.id, n]));
let invalid = 0;
for (const p of proposals) {
  if (!p.proposedNodeId) continue;
  const node = nodeById.get(p.proposedNodeId);
  if (!node) { console.log(`INVALID node ref: ${p.pageName} → ${p.proposedNodeId}`); invalid++; continue; }
  if (p.proposedRole === 'canonical_leaf' && !node.classifiable) {
    console.log(`INVALID: ${p.pageName} proposes canonical_leaf on non-classifiable ${p.proposedNodeId}`); invalid++;
  }
  if (p.proposedRole === 'canonical_browse' && node.classifiable) {
    console.log(`INVALID: ${p.pageName} proposes canonical_browse on classifiable ${p.proposedNodeId}`); invalid++;
  }
}
console.log(`proposals: ${proposals.length}, invalid refs: ${invalid}`);
if (invalid) process.exit(1);

// Show the ambiguous + unmatched pages (human decision list).
console.log('\n=== AMBIGUOUS / UNMATCHED (human decision) ===');
for (const p of proposals) {
  if (p.confidence === 'ambiguous' || p.confidence === 'unmatched') {
    const alts = p.alternatives.map(a => `${a.nodeId}(${a.score})`).join(', ');
    console.log(`  [${p.confidence}] ${p.pageName} (${p.productCount} products)${alts ? ` — alts: ${alts}` : ''}`);
  }
}
