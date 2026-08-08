// fallow-ignore-file unused-export

/**
 * Page import service.
 *
 * Provides the parser-adapter contract and the preview/activation seam over
 * normalized Page records:
 * - `PageParserAdapter` is the seam a real ShopSite Pages XML parser fills.
 * - `ShopSitePagesXmlParserAdapter` (the real parser) is the default adapter
 *   returned by `getPageParserAdapter()`.
 * - `NoopPageParserAdapter` remains available for tests that assert fail-closed
 *   behavior before a parser exists.
 * - Preview validates records and computes counts with NO DB effect.
 * - Activation is atomic via the page-import repo and refuses name-only
 *   identities.
 * - Verified page ref resolution is the choke point for serialization:
 *   name-only or out-of-import identities are never serializable into
 *   ProductOnPages.
 */
import { PageRecordSchema, ImportPreviewSchema, ImportActivationSchema } from '../shared/schemas/page';
import type {
  PageRecord,
  ImportPreview,
  ImportActivation,
  PageImport,
} from '../shared/schemas/page';
import {
  activatePageImport,
  computePageImportCounts,
} from '../db/repositories/page-import-repo';
import { listVerifiedPageOptions } from '../db/repositories/page-repo';
import { shopSitePagesXmlParserAdapter } from './page-parser';

/**
 * The active parser adapter used by the import flow. Defaults to the real
 * ShopSite Pages XML parser; tests may override it via
 * `setPageParserAdapterForTests()` to exercise fail-closed behavior.
 */
let activePageParserAdapter: PageParserAdapter = shopSitePagesXmlParserAdapter;

/** Test-only override seam. Pass null to restore the default real parser. */
export function setPageParserAdapterForTests(adapter: PageParserAdapter | null): void {
  activePageParserAdapter = adapter ?? shopSitePagesXmlParserAdapter;
}

/** The parser adapter used by the page import flow. */
export function getPageParserAdapter(): PageParserAdapter {
  return activePageParserAdapter;
}

export interface PageParserAdapter {
  readonly name: string;
  /** Parse a raw ShopSite Pages XML export into normalized Page records. */
  parsePagesXml(input: string): PageRecord[];
}

/**
 * Fails closed: no ShopSite Pages XML parser is registered until a real,
 * redacted Pages export exists. Creating a guessed parser would invent
 * XML contracts we cannot verify.
 */
export class NoopPageParserAdapter implements PageParserAdapter {
  readonly name = 'noop';
  parsePagesXml(_input: string): PageRecord[] {
    throw new Error(
      'No ShopSite Pages XML parser is registered. A real redacted Pages export is required before verified Page identity can exist.',
    );
  }
}

export const noopPageParserAdapter: PageParserAdapter = new NoopPageParserAdapter();

/** Deterministic preview id derived from the source hash (never persisted). */
export function computeImportId(sourceHash: string): string {
  return `import-${sourceHash.slice(0, 16)}`;
}

/**
 * Activation validation: every record must carry a verified identity
 * (exported GUID or exported File Name). Name-only data cannot activate as
 * verified; identity keys must be unique within the batch.
 */
export function validateRecordsForActivation(
  records: PageRecord[],
): { ok: true } | { ok: false; reason: string } {
  const seen = new Set<string>();
  for (const record of records) {
    if (record.identity.kind === 'unverified_name_only') {
      return { ok: false, reason: `Page "${record.name}" has an unverified name-only identity and cannot activate.` };
    }
    if (record.identity.status !== 'verified') {
      return { ok: false, reason: `Page "${record.name}" has unverified identity status.` };
    }
    const key = `${record.identity.kind}:${record.identity.key}`;
    if (seen.has(key)) {
      return { ok: false, reason: `Duplicate identity key "${key}" in the import batch.` };
    }
    seen.add(key);
  }
  return { ok: true };
}

/**
 * Preview a normalized Page import. Validates the batch, computes counts,
 * and flags name-only records for exclusion. Returns an ImportPreview with
 * status `previewed` and performs NO database writes.
 */
export function previewPageImport(input: {
  workspaceId: string;
  sourceHash: string;
  parserFormatVersion: string;
  records: PageRecord[];
}): ImportPreview {
  const parsed = PageRecordSchema.array().parse(input.records);
  const warnings: string[] = [];
  const nameOnly = parsed.filter(r => r.identity.kind === 'unverified_name_only');
  for (const record of nameOnly) {
    warnings.push(`Page "${record.name}" is name-only and will be excluded from activation.`);
  }
  const verifiedRecords = parsed.filter(r => r.identity.kind !== 'unverified_name_only');
  const counts = computePageImportCounts(parsed);
  const timestamp = new Date().toISOString();
  const importRecord: PageImport = {
    id: computeImportId(input.sourceHash),
    workspaceId: input.workspaceId,
    sourceHash: input.sourceHash,
    parserFormatVersion: input.parserFormatVersion,
    status: 'previewed',
    counts,
    createdAt: timestamp,
    activatedAt: null,
    supersededAt: null,
    activatedBy: null,
  };
  return ImportPreviewSchema.parse({ import: importRecord, records: verifiedRecords, warnings });
}

/**
 * Activate a verified Page import atomically. Rejects any batch containing
 * name-only identities or duplicate identity keys.
 */
export function activatePageImportFromRecords(
  input: Omit<ImportActivation, 'activatedBy'> & { activatedBy?: string | null },
): PageImport {
  const payload = ImportActivationSchema.parse(input);
  const parsedRecords = PageRecordSchema.array().parse(payload.records);
  const validation = validateRecordsForActivation(parsedRecords);
  if (!validation.ok) throw new Error(validation.reason);
  return activatePageImport({
    workspaceId: payload.workspaceId,
    sourceHash: payload.sourceHash,
    parserFormatVersion: payload.parserFormatVersion,
    records: parsedRecords,
    activatedBy: payload.activatedBy,
  });
}

export interface VerifiedPageRef {
  pageId: string;
  pageName: string;
}

/** A page ref that could not be verified (name-only or out-of-import). */
export interface UnverifiedPageRef {
  pageId: string | null;
  pageName: string;
}

/** Verified page IDs (local page_index row IDs) from the active import. */
export function getActiveVerifiedPageIds(workspaceId: string): Set<string> {
  return new Set(listVerifiedPageOptions(workspaceId).map(p => p.id));
}

/**
 * Split page assignment refs into verified (serializable) and unverified
 * (never serializable) sets against the currently active import. Without an
 * active verified import every ref is unverified — fail closed.
 */
export function resolveVerifiedPageRefs(
  workspaceId: string,
  refs: Array<{ pageId: string | null; pageName: string }>,
): { verified: VerifiedPageRef[]; unverified: UnverifiedPageRef[] } {
  const verifiedOptions = listVerifiedPageOptions(workspaceId);
  const byId = new Map(verifiedOptions.map(p => [p.id, p]));
  const verified: VerifiedPageRef[] = [];
  const unverified: UnverifiedPageRef[] = [];
  for (const ref of refs) {
    const match = ref.pageId ? (byId.get(ref.pageId) ?? null) : null;
    if (match) {
      verified.push({ pageId: match.id, pageName: match.name });
    } else {
      unverified.push({ pageId: ref.pageId, pageName: ref.pageName });
    }
  }
  return { verified, unverified };
}
