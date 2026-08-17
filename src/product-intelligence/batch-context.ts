/**
 * Deterministic batch intelligence for weak supplier spreadsheets (issue #57).
 *
 * This module only derives bounded, non-authoritative context from ProductSeed
 * rows. It does not discover products, assign identity, or turn a spreadsheet
 * pattern into a product fact. The batch is analyzed once and the resulting
 * typed artifact can be replayed for each row workflow.
 */
import { z } from 'zod';
import { hashCanonicalJson } from '../shared/stable-id';
import {
  finalizeSpecialistArtifact,
  validateSpecialistArtifactEnvelope,
  type SpecialistArtifactEnvelope,
} from './specialists/artifacts';
import {
  BatchContextSchema,
  ProductSeedSchema,
  type BatchContext,
  type ProductSeed,
} from './product-seed';

export const BATCH_CONTEXT_ARTIFACT_TYPE = 'batch_context' as const;
export const BATCH_CONTEXT_ARTIFACT_SCHEMA_VERSION = '1.0.0' as const;
export const BATCH_CONTEXT_SPECIALIST = 'batch-intelligence' as const;
export const BATCH_CONTEXT_SPECIALIST_VERSION = '1.0.0' as const;

const MAX_BATCH_ROWS = 500;
const MAX_ROW_RELATIONSHIPS = 8;
const MAX_ROW_HINTS = 12;
const MAX_BATCH_RELATIONSHIPS = 2_000;
const MAX_BATCH_SIGNALS = 2_000;
const MAX_REASON_LENGTH = 160;

export const BatchSeedRowSchema = z.object({
  rowId: z.string().trim().min(1).max(128),
  productSeed: ProductSeedSchema,
}).strict();
export type BatchSeedRow = z.infer<typeof BatchSeedRowSchema>;

export const BatchIntelligenceInputSchema = z.object({
  batchId: z.string().trim().min(1).max(128),
  /** Supplier/import version. The caller owns its meaning; it is never inferred. */
  batchVersion: z.string().trim().min(1).max(128),
  batchName: z.string().trim().max(256).nullish(),
  rows: z.array(BatchSeedRowSchema).min(1).max(MAX_BATCH_ROWS),
}).strict();
export type BatchIntelligenceInput = z.infer<typeof BatchIntelligenceInputSchema>;

export const BatchRelationshipKindSchema = z.enum(['duplicate', 'near_duplicate', 'likely_variant']);
export type BatchRelationshipKind = z.infer<typeof BatchRelationshipKindSchema>;

export const BatchRelationshipReasonSchema = z.enum([
  'same_normalized_name',
  'high_name_overlap',
  'shared_family_tokens',
  'different_size_or_pack',
  'sku_sequence',
  'shared_repeated_brand_token',
  'abbreviated_family',
  'same_price_pattern',
]);
export type BatchRelationshipReason = z.infer<typeof BatchRelationshipReasonSchema>;

export const BatchRelationshipSchema = z.object({
  rowId: z.string().min(1).max(128),
  relatedRowId: z.string().min(1).max(128),
  kind: BatchRelationshipKindSchema,
  /** Similarity is a ranking aid, not confidence or identity. */
  score: z.number().finite().min(0).max(1),
  reasons: z.array(BatchRelationshipReasonSchema).min(1).max(8),
}).strict();
export type BatchRelationship = z.infer<typeof BatchRelationshipSchema>;

export const BatchSignalSchema = z.object({
  kind: z.enum([
    'repeated_brand_token',
    'abbreviated_family',
    'size_variant_group',
    'sku_sequence',
    'misleading_price_pattern',
    'duplicate_rows',
    'near_duplicate_rows',
  ]),
  /** Row ids are references only; no supplier row is copied into a hint. */
  rowIds: z.array(z.string().min(1).max(128)).min(1).max(MAX_BATCH_ROWS),
  value: z.string().min(1).max(256),
  warning: z.string().min(1).max(512),
}).strict();
export type BatchSignal = z.infer<typeof BatchSignalSchema>;

export const BatchRowContextHintSchema = z.object({
  kind: z.enum([
    'repeated_brand_token',
    'family_token',
    'abbreviated_family',
    'size_variant',
    'sku_sequence',
    'price_pattern',
    'relationship',
  ]),
  value: z.string().min(1).max(256),
  /** Explicitly identifies why this hint was included for this row. */
  relatedRowIds: z.array(z.string().min(1).max(128)).max(MAX_ROW_RELATIONSHIPS).default([]),
}).strict();
export type BatchRowContextHint = z.infer<typeof BatchRowContextHintSchema>;

export const BatchRowContextSchema = z.object({
  rowId: z.string().min(1).max(128),
  authoritative: z.literal(false),
  contextVersion: z.literal(BATCH_CONTEXT_ARTIFACT_SCHEMA_VERSION),
  /** Hash of the canonical batch input used to derive this context. */
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  relatedRowIds: z.array(z.string().min(1).max(128)).max(MAX_ROW_RELATIONSHIPS),
  hints: z.array(BatchRowContextHintSchema).max(MAX_ROW_HINTS),
}).strict();
export type BatchRowContext = z.infer<typeof BatchRowContextSchema>;

export const BatchContextArtifactPayloadSchema = z.object({
  contextSchemaVersion: z.literal(1),
  authoritative: z.literal(false),
  batchId: z.string().min(1).max(128),
  batchVersion: z.string().min(1).max(128),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Canonical seed snapshot makes the artifact self-contained and replayable. */
  rows: z.array(BatchSeedRowSchema).min(1).max(MAX_BATCH_ROWS),
  /** All derived relationships remain inspectable in the batch artifact. */
  relationships: z.array(BatchRelationshipSchema).max(MAX_BATCH_RELATIONSHIPS),
  signals: z.array(BatchSignalSchema).max(MAX_BATCH_SIGNALS),
  /** Per-row views are bounded; they are the only views passed to workflows. */
  rowContexts: z.array(BatchRowContextSchema).min(1).max(MAX_BATCH_ROWS),
}).strict().superRefine((payload, ctx) => {
  const rowIds = payload.rows.map((row) => row.rowId);
  if (new Set(rowIds).size !== rowIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rows'], message: 'batch rows must have unique rowId values' });
  }
  const expectedInputHash = hashCanonicalJson({
    batchId: payload.batchId,
    batchVersion: payload.batchVersion,
    rows: [...payload.rows].sort((a, b) => a.rowId.localeCompare(b.rowId)),
  });
  if (expectedInputHash !== payload.inputHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inputHash'], message: 'inputHash does not match the canonical batch seed snapshot' });
  }
  for (const [index, rowContext] of payload.rowContexts.entries()) {
    if (rowContext.inputHash !== payload.inputHash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rowContexts', index, 'inputHash'], message: 'row context inputHash does not match batch inputHash' });
    }
  }
});
export type BatchContextArtifactPayload = z.infer<typeof BatchContextArtifactPayloadSchema>;

/** Registry entry used by #48 typed-artifact validation gates. */
export const BATCH_CONTEXT_ARTIFACT_SCHEMA = {
  name: BATCH_CONTEXT_ARTIFACT_TYPE,
  version: BATCH_CONTEXT_ARTIFACT_SCHEMA_VERSION,
  schema: BatchContextArtifactPayloadSchema,
  description: 'Deterministic, bounded, non-authoritative supplier batch context',
} as const;

export interface BatchIntelligenceResult {
  artifact: SpecialistArtifactEnvelope;
  payload: BatchContextArtifactPayload;
  /** Envelope content hash: provenance for every row view returned below. */
  batchContextHash: string;
  batchContextVersion: typeof BATCH_CONTEXT_ARTIFACT_SCHEMA_VERSION;
  rowContexts: ReadonlyMap<string, BatchContext>;
}

type ParsedRow = {
  row: BatchSeedRow;
  normalizedName: string;
  tokens: string[];
  meaningfulTokens: string[];
  sizeTokens: string[];
  familyTokens: string[];
  skuPrefix: string | null;
  skuNumber: number | null;
  price: number | null;
};

const STOP_WORDS = new Set([
  'a', 'and', 'by', 'for', 'from', 'in', 'of', 'on', 'the', 'to', 'with',
  'dog', 'dogs', 'cat', 'cats', 'pet', 'pets', 'food', 'treat', 'treats',
]);
const VARIANT_WORDS = new Set([
  'small', 'medium', 'large', 'mini', 'regular', 'assorted', 'original',
  'size', 'count', 'ct', 'pack', 'pk', 'case', 'oz', 'ounce', 'ounces',
  'lb', 'lbs', 'pound', 'pounds', 'g', 'gram', 'grams', 'kg', 'ml', 'l',
]);

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value).split(/\s+/u).filter(Boolean);
}

function sizeTokens(value: string): string[] {
  const normalized = normalizeText(value);
  const found = new Set<string>();
  const pattern = /\b\d+(?:\.\d+)?\s?(?:oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg|ml|l|ct|count|pk|pack|case)\b/gu;
  for (const match of normalized.matchAll(pattern)) found.add(match[0].replace(/\s+/g, ' '));
  for (const token of tokenize(value)) {
    if (['small', 'medium', 'large', 'mini'].includes(token)) found.add(token);
  }
  return [...found].sort();
}

function skuParts(sku: string): { prefix: string; number: number } | null {
  const normalized = sku.normalize('NFKC').trim().toUpperCase();
  const match = /^(.*?)(\d+)$/.exec(normalized);
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return null;
  return { prefix: match[1], number };
}

function numericPrice(price: ProductSeed['price']): number | null {
  if (typeof price === 'number') return Number.isFinite(price) ? price : null;
  const normalized = price.replace(/[$,]/g, '').trim();
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function setIntersection(a: string[], b: string[]): string[] {
  const bSet = new Set(b);
  return [...new Set(a.filter((token) => bSet.has(token)))].sort();
}

function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / union.size;
}

function initials(tokens: string[]): string {
  return tokens.map((token) => token[0]).join('');
}

function parseRow(row: BatchSeedRow): ParsedRow {
  const normalizedName = normalizeText(row.productSeed.name);
  const tokens = tokenize(row.productSeed.name);
  const sizes = sizeTokens(row.productSeed.name);
  const sizeParts = new Set(sizes.flatMap((size) => tokenize(size)));
  const meaningfulTokens = tokens.filter((token) => !STOP_WORDS.has(token) && !sizeParts.has(token));
  // Family tokens intentionally exclude only generic merchandising words and
  // measured variants. They are clues for grouping, never product facts.
  const familyTokens = meaningfulTokens.filter((token) => !VARIANT_WORDS.has(token));
  const sku = skuParts(row.productSeed.sku);
  return {
    row,
    normalizedName,
    tokens,
    meaningfulTokens,
    sizeTokens: sizes,
    familyTokens,
    skuPrefix: sku?.prefix ?? null,
    skuNumber: sku?.number ?? null,
    price: numericPrice(row.productSeed.price),
  };
}

function commonFirstTokens(rows: ParsedRow[]): Map<string, string[]> {
  const occurrences = new Map<string, string[]>();
  for (const row of rows) {
    // A repeated leading token is the safest deterministic brand-token cue;
    // never call it a confirmed brand.
    const leading = row.meaningfulTokens.slice(0, 2);
    for (const token of leading) {
      const ids = occurrences.get(token) ?? [];
      if (!ids.includes(row.row.rowId)) ids.push(row.row.rowId);
      occurrences.set(token, ids);
    }
  }
  return new Map([...occurrences.entries()].filter(([, ids]) => ids.length >= 2));
}

function abbreviationPairs(rows: ParsedRow[]): Array<{ abbreviation: string; family: string; rowIds: string[] }> {
  const candidates = new Map<string, { family: string; rowIds: string[] }>();
  for (const row of rows) {
    const tokens = row.familyTokens;
    for (let start = 0; start < tokens.length; start += 1) {
      for (let length = 2; length <= Math.min(4, tokens.length - start); length += 1) {
        const phraseTokens = tokens.slice(start, start + length);
        const abbreviation = initials(phraseTokens);
        if (abbreviation.length < 2) continue;
        const family = phraseTokens.join(' ');
        const existing = candidates.get(abbreviation);
        if (existing && existing.family !== family) continue;
        candidates.set(abbreviation, { family, rowIds: [...(existing?.rowIds ?? []), row.row.rowId] });
      }
    }
  }
  const result: Array<{ abbreviation: string; family: string; rowIds: string[] }> = [];
  for (const [abbreviation, entry] of candidates) {
    const matchingRows = rows.filter((row) => row.familyTokens.includes(abbreviation)).map((row) => row.row.rowId);
    const allIds = [...new Set([...entry.rowIds, ...matchingRows])];
    if (matchingRows.length > 0 && entry.family.length > abbreviation.length) {
      result.push({ abbreviation, family: entry.family, rowIds: allIds.sort() });
    }
  }
  return result.sort((a, b) => a.abbreviation.localeCompare(b.abbreviation) || a.family.localeCompare(b.family));
}

function relationFor(left: ParsedRow, right: ParsedRow, repeatedBrandTokens: Set<string>, abbreviations: Array<{ abbreviation: string; family: string }>): BatchRelationship | null {
  if (left.row.rowId === right.row.rowId) return null;
  const reasons: BatchRelationshipReason[] = [];
  const shared = setIntersection(left.familyTokens, right.familyTokens);
  const sameName = left.normalizedName === right.normalizedName;
  const overlap = jaccard(left.meaningfulTokens, right.meaningfulTokens);
  const differentSize = left.sizeTokens.join('|') !== right.sizeTokens.join('|') && (left.sizeTokens.length > 0 || right.sizeTokens.length > 0);
  const skuSequence = left.skuPrefix !== null && left.skuPrefix === right.skuPrefix && left.skuNumber !== null && right.skuNumber !== null && Math.abs(left.skuNumber - right.skuNumber) <= 3;
  const abbreviatedFamily = abbreviations.some((entry) => {
    const leftHas = left.familyTokens.includes(entry.abbreviation);
    const rightHas = right.familyTokens.some((token) => entry.family.split(' ').includes(token));
    return leftHas !== rightHas;
  });
  if (sameName) reasons.push('same_normalized_name');
  if (overlap >= 0.6 && !sameName) reasons.push('high_name_overlap');
  if (shared.length > 0) reasons.push('shared_family_tokens');
  if (differentSize) reasons.push('different_size_or_pack');
  if (skuSequence) reasons.push('sku_sequence');
  if (setIntersection(left.meaningfulTokens, right.meaningfulTokens).some((token) => repeatedBrandTokens.has(token))) {
    reasons.push('shared_repeated_brand_token');
  }
  if (abbreviatedFamily) reasons.push('abbreviated_family');
  if (left.price !== null && left.price === right.price && differentSize) reasons.push('same_price_pattern');

  let kind: BatchRelationshipKind | null = null;
  if (sameName) kind = 'duplicate';
  else if (shared.length > 0 && differentSize && (overlap >= 0.3 || skuSequence || abbreviatedFamily)) kind = 'likely_variant';
  else if (overlap >= 0.67 || (shared.length >= 2 && (skuSequence || abbreviatedFamily))) kind = 'near_duplicate';
  if (!kind) return null;
  const score = Math.min(1, Math.max(overlap, shared.length > 0 ? 0.45 : 0) + (differentSize ? 0.08 : 0) + (skuSequence ? 0.08 : 0));
  return {
    rowId: left.row.rowId,
    relatedRowId: right.row.rowId,
    kind,
    score: Number(score.toFixed(4)),
    reasons: reasons.length > 0 ? reasons : ['high_name_overlap'],
  };
}

function boundedReason(value: string): string {
  return value.length <= MAX_REASON_LENGTH ? value : `${value.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

/**
 * Derive one content-addressed batch artifact. The result is pure for a given
 * batch id/version/seed set except for non-hash provenance timestamp metadata.
 */
export function deriveBatchIntelligence(input: BatchIntelligenceInput, options: { createdAt?: string; codeCommit?: string | null } = {}): BatchIntelligenceResult {
  const parsed = BatchIntelligenceInputSchema.parse(input);
  const rows = parsed.rows.map(parseRow).sort((a, b) => a.row.rowId.localeCompare(b.row.rowId));
  if (new Set(rows.map((row) => row.row.rowId)).size !== rows.length) {
    throw new Error('batch rows must have unique rowId values');
  }
  const inputHash = hashCanonicalJson({
    batchId: parsed.batchId,
    batchVersion: parsed.batchVersion,
    rows: rows.map((row) => row.row),
  });
  const brandTokens = commonFirstTokens(rows);
  const repeatedBrandTokens = new Set(brandTokens.keys());
  const abbreviations = abbreviationPairs(rows);
  const relationships: BatchRelationship[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    for (let next = index + 1; next < rows.length; next += 1) {
      const relation = relationFor(rows[index], rows[next], repeatedBrandTokens, abbreviations);
      if (relation && relationships.length + 2 <= MAX_BATCH_RELATIONSHIPS) {
        relationships.push(relation);
        relationships.push({ ...relation, rowId: relation.relatedRowId, relatedRowId: relation.rowId });
      }
    }
  }
  relationships.sort((a, b) => a.rowId.localeCompare(b.rowId) || a.relatedRowId.localeCompare(b.relatedRowId));

  const signals: BatchSignal[] = [];
  for (const [token, rowIds] of brandTokens) {
    signals.push({ kind: 'repeated_brand_token', rowIds: [...rowIds].sort(), value: token, warning: 'Repeated leading token is a search hint only; it is not a confirmed brand.' });
  }
  for (const abbreviation of abbreviations) {
    signals.push({ kind: 'abbreviated_family', rowIds: abbreviation.rowIds, value: `${abbreviation.abbreviation} → ${abbreviation.family}`, warning: 'Abbreviation expansion is a batch hypothesis and requires row-level source verification.' });
  }
  const variantGroups = new Map<string, string[]>();
  for (const relation of relationships.filter((entry) => entry.kind === 'likely_variant')) {
    const ids = [relation.rowId, relation.relatedRowId].sort();
    const key = ids.join('|');
    variantGroups.set(key, ids);
  }
  for (const rowIds of variantGroups.values()) {
    signals.push({ kind: 'size_variant_group', rowIds, value: 'size_or_pack_difference', warning: 'Rows may be variants; size/pack must be verified from authoritative product evidence.' });
  }
  const skuGroups = new Map<string, string[]>();
  for (const row of rows) {
    if (row.skuPrefix && row.skuNumber !== null) {
      const ids = skuGroups.get(row.skuPrefix) ?? [];
      ids.push(row.row.rowId);
      skuGroups.set(row.skuPrefix, ids);
    }
  }
  for (const [prefix, rowIds] of skuGroups) {
    if (rowIds.length >= 2) signals.push({ kind: 'sku_sequence', rowIds: rowIds.sort(), value: `${prefix}#`, warning: 'SKU sequencing is an ordering hint only; a SKU never establishes product identity or GTIN.' });
  }
  const prices = new Map<string, string[]>();
  for (const row of rows) {
    if (row.price !== null) {
      const key = row.price.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
      prices.set(key, [...(prices.get(key) ?? []), row.row.rowId]);
    }
  }
  for (const [price, rowIds] of prices) {
    if (rowIds.length >= 2) {
      signals.push({ kind: 'misleading_price_pattern', rowIds: rowIds.sort(), value: price, warning: 'Repeated supplier price is non-identifying and may be promotional, rounded, or unrelated to variant size.' });
    }
  }
  const duplicateIds = relationships.filter((entry) => entry.kind === 'duplicate').map((entry) => entry.rowId);
  if (duplicateIds.length > 0) signals.push({ kind: 'duplicate_rows', rowIds: [...new Set(duplicateIds)].sort(), value: 'normalized_name', warning: 'Duplicate is a reviewable row relationship, not proof the products are the same catalog identity.' });
  const nearIds = relationships.filter((entry) => entry.kind === 'near_duplicate').map((entry) => entry.rowId);
  if (nearIds.length > 0) signals.push({ kind: 'near_duplicate_rows', rowIds: [...new Set(nearIds)].sort(), value: 'name_overlap', warning: 'Near-duplicate is a reviewable similarity cue and may still represent different products.' });
  signals.sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value));
  signals.splice(MAX_BATCH_SIGNALS);

  const rowContexts = rows.map((row) => {
    const related = relationships.filter((entry) => entry.rowId === row.row.rowId).sort((a, b) => b.score - a.score || a.relatedRowId.localeCompare(b.relatedRowId)).slice(0, MAX_ROW_RELATIONSHIPS);
    const relatedIds = [...new Set(related.map((entry) => entry.relatedRowId))];
    const hints: BatchRowContextHint[] = [];
    for (const [token, ids] of brandTokens) {
      if (ids.includes(row.row.rowId)) hints.push({ kind: 'repeated_brand_token', value: token, relatedRowIds: ids.filter((id) => id !== row.row.rowId).slice(0, MAX_ROW_RELATIONSHIPS) });
    }
    const family = row.familyTokens.slice(0, 4).join(' ');
    if (family) hints.push({ kind: 'family_token', value: family, relatedRowIds: relatedIds.slice(0, MAX_ROW_RELATIONSHIPS) });
    for (const abbreviation of abbreviations.filter((entry) => entry.rowIds.includes(row.row.rowId)).slice(0, 2)) {
      hints.push({ kind: 'abbreviated_family', value: `${abbreviation.abbreviation} → ${abbreviation.family}`, relatedRowIds: abbreviation.rowIds.filter((id) => id !== row.row.rowId).slice(0, MAX_ROW_RELATIONSHIPS) });
    }
    if (row.sizeTokens.length > 0) hints.push({ kind: 'size_variant', value: row.sizeTokens.join(', '), relatedRowIds: related.filter((entry) => entry.reasons.includes('different_size_or_pack')).map((entry) => entry.relatedRowId).slice(0, MAX_ROW_RELATIONSHIPS) });
    if (row.skuPrefix && row.skuNumber !== null && (skuGroups.get(row.skuPrefix)?.length ?? 0) >= 2) hints.push({ kind: 'sku_sequence', value: `${row.skuPrefix}#`, relatedRowIds: (skuGroups.get(row.skuPrefix) ?? []).filter((id) => id !== row.row.rowId).slice(0, MAX_ROW_RELATIONSHIPS) });
    for (const relation of related.slice(0, 4)) hints.push({ kind: 'relationship', value: `${relation.kind}: ${boundedReason(relation.reasons.join(', '))}`, relatedRowIds: [relation.relatedRowId] });
    const ownPrice = row.price === null ? null : row.price.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    if (ownPrice && (prices.get(ownPrice)?.length ?? 0) >= 2) hints.push({ kind: 'price_pattern', value: `repeated supplier price ${ownPrice}`, relatedRowIds: (prices.get(ownPrice) ?? []).filter((id) => id !== row.row.rowId).slice(0, MAX_ROW_RELATIONSHIPS) });
    const boundedHints = hints.slice(0, MAX_ROW_HINTS);
    return { rowId: row.row.rowId, authoritative: false as const, contextVersion: BATCH_CONTEXT_ARTIFACT_SCHEMA_VERSION, inputHash, relatedRowIds: relatedIds, hints: boundedHints } satisfies BatchRowContext;
  });

  const payload: BatchContextArtifactPayload = {
    contextSchemaVersion: 1,
    authoritative: false,
    batchId: parsed.batchId,
    batchVersion: parsed.batchVersion,
    inputHash,
    rows: rows.map((row) => row.row),
    relationships,
    signals,
    rowContexts,
  };
  const artifact = finalizeSpecialistArtifact({
    artifactType: BATCH_CONTEXT_ARTIFACT_TYPE,
    payload,
    payloadSchema: BatchContextArtifactPayloadSchema,
    lineage: { workflowRef: parsed.batchId },
    provenance: {
      specialist: BATCH_CONTEXT_SPECIALIST,
      specialistVersion: BATCH_CONTEXT_SPECIALIST_VERSION,
      invokedBy: 'orchestrator',
      codeCommit: options.codeCommit ?? null,
      createdAt: options.createdAt,
    },
  });
  const workflowContexts = new Map<string, BatchContext>();
  for (const context of rowContexts) {
    workflowContexts.set(context.rowId, BatchContextSchema.parse({
      batchId: parsed.batchId,
      batchName: parsed.batchName ?? null,
      itemIndex: rows.findIndex((row) => row.row.rowId === context.rowId),
      authoritative: false,
      schemaVersion: 1,
      siblingSkus: context.relatedRowIds
        .map((id) => rows.find((row) => row.row.rowId === id)?.row.productSeed.sku)
        .filter((sku): sku is string => Boolean(sku))
        .slice(0, MAX_ROW_RELATIONSHIPS),
      contextVersion: BATCH_CONTEXT_ARTIFACT_SCHEMA_VERSION,
      contextHash: artifact.contentHash,
      hints: Object.fromEntries(context.hints.slice(0, MAX_ROW_HINTS).map((hint, index) => [`${hint.kind}_${index + 1}`, hint.value])),
    }));
  }
  return { artifact, payload, batchContextHash: artifact.contentHash, batchContextVersion: BATCH_CONTEXT_ARTIFACT_SCHEMA_VERSION, rowContexts: workflowContexts };
}

/** Alias emphasizing that callers should derive once and fan out row views. */
export const deriveBatchContext = deriveBatchIntelligence;
export const analyzeBatch = deriveBatchIntelligence;
export const buildBatchContextArtifact = deriveBatchIntelligence;

/** Return only the bounded context view for one row; unknown rows fail closed. */
export function contextForBatchRow(result: BatchIntelligenceResult, rowId: string): BatchContext | null {
  return result.rowContexts.get(rowId) ?? null;
}

/** Validate a previously serialized batch artifact before replay. */
export function parseBatchContextArtifact(value: unknown): BatchContextArtifactPayload {
  const envelope = value as { artifactType?: unknown };
  if (envelope?.artifactType !== BATCH_CONTEXT_ARTIFACT_TYPE) throw new Error('not a batch_context artifact');
  const validated = validateSpecialistArtifactEnvelope(value);
  if (!validated.valid) throw new Error(`batch_context artifact failed validation: ${validated.issues.join('; ')}`);
  return BatchContextArtifactPayloadSchema.parse(validated.envelope.payload);
}

export { BatchContextSchema };
export type { BatchContext, ProductSeed };
