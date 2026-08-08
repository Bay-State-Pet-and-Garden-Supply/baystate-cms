// fallow-ignore-file unused-export

/**
 * Deterministic catalog evidence scan.
 *
 * Scans canonical product JSON files plus store/field-registry.json and
 * produces a byte-identical content-addressed evidence artifact. The scan
 * records field presence, distinct-value hashes, delimiter-character
 * frequencies on ProductField1–25, name-only Page observations from preserved
 * ProductOnPages fragments, and a source tree hash. It never infers field
 * semantics from value frequency.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalJsonFileString, hashCanonicalJson, sha256Hex } from '../shared/stable-id';
import type { CatalogEvidenceVerifier } from './config-validation';

const FIELD_REGISTRY_FILE = 'store/field-registry.json';
const PRODUCTS_DIR = 'products';
const DELIMITER_CANDIDATES = [',', ';', '|', '/', '>', '\n'] as const;
const MULTI_VALUE_FIELD_PREFIX = /^ProductField([1-9]|1[0-9]|2[0-5])$/;
const PAGE_NAME_PATTERN = /<Name>([^<]*)<\/Name>/g;
const SAMPLE_SKU_CAP = 10;

export interface CatalogFieldEvidence {
  xmlField: string;
  /** Products whose customFields contains the field key. */
  recordCount: number;
  /** Products with a non-empty trimmed value. */
  nonEmptyCount: number;
  distinctValueCount: number;
  /** SHA-256 of the canonical sorted list of non-empty distinct values. */
  distinctValueHash: string;
  /** Deterministic occurrence counts of candidate delimiter characters. */
  delimiterEvidence: Array<{ character: string; occurrenceCount: number }>;
}

export interface CatalogPageObservation {
  pageName: string;
  productCount: number;
  sampleSkus: string[];
}

export interface CatalogEvidence {
  schemaVersion: number;
  sourceTreeHash: string;
  productFileCount: number;
  parseFailureCount: number;
  /** Relative product paths (sorted) that failed to parse. */
  parseFailures: Array<{ path: string; reason: string }>;
  fieldRegistry: {
    entryCount: number;
    xmlFields: string[];
  };
  /** Sorted by xmlField. */
  fields: CatalogFieldEvidence[];
  /** Sorted by pageName. */
  pages: CatalogPageObservation[];
}

interface ProductScanResult {
  fileHash: string;
  sku: string | null;
  customFields: Record<string, string>;
  pageNames: string[];
}

function xmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractPageNames(product: Record<string, unknown>): string[] {
  const shopsite = product.shopsite;
  if (!shopsite || typeof shopsite !== 'object') return [];
  const preserved = (shopsite as Record<string, unknown>).preserved;
  if (!preserved || typeof preserved !== 'object') return [];
  const blocks = (preserved as Record<string, unknown>).advancedBlocks as Record<string, unknown> | undefined;
  const raw = typeof blocks?.ProductOnPages === 'string'
    ? blocks.ProductOnPages
    : (preserved as Record<string, unknown>).unknownElements && typeof (preserved as Record<string, unknown>).unknownElements === 'object'
      ? ((preserved as Record<string, unknown>).unknownElements as Record<string, unknown>).ProductOnPages
      : undefined;
  if (raw === undefined) return [];
  const rawString = typeof raw === 'string' ? raw : String(raw);
  const names: string[] = [];
  PAGE_NAME_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PAGE_NAME_PATTERN.exec(rawString)) !== null) {
    const name = xmlDecode(match[1] ?? '').trim();
    if (name) names.push(name);
  }
  return names;
}

async function listJsonFiles(root: string, dir: string, relative: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Unable to list product directory ${dir}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const files: string[] = [];
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'images') continue; // media assets, never product records
      files.push(...await listJsonFiles(root, childPath, childRelative));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(childRelative);
    }
  }
  return files;
}

async function scanProductFile(workspacePath: string, relative: string): Promise<ProductScanResult> {
  const fullPath = path.join(workspacePath, PRODUCTS_DIR, relative);
  const buffer = await fs.promises.readFile(fullPath);
  const fileHash = sha256Hex(buffer);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('product JSON root is not an object');
  }
  const customFields = parsed.customFields as Record<string, string> | undefined;
  const sku = typeof parsed.sku === 'string' ? parsed.sku : null;
  return {
    fileHash,
    sku,
    customFields: customFields && typeof customFields === 'object' ? customFields : {},
    pageNames: extractPageNames(parsed),
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Deterministic catalog evidence scan. Two scans over identical inputs produce
 * byte-identical JSON (the artifact contains no timestamps or absolute paths).
 */
export async function scanCatalogEvidence(workspacePath: string): Promise<CatalogEvidence> {
  const productsDir = path.join(workspacePath, PRODUCTS_DIR);
  const relativeFiles = await listJsonFiles(workspacePath, productsDir, '');

  const fieldCounters = new Map<string, { recordCount: number; nonEmptyCount: number; values: Set<string>; delimiters: Map<string, number> }>();
  const pageCounter = new Map<string, { count: number; skus: Set<string> }>();
  const fileHashes: Array<{ path: string; hash: string }> = [];
  const parseFailures: Array<{ path: string; reason: string }> = [];
  let scanned = 0;

  const results = await mapWithConcurrency(relativeFiles, 32, async (relative) => {
    try {
      return { relative, scan: await scanProductFile(workspacePath, relative), error: null as string | null };
    } catch (error) {
      return {
        relative,
        scan: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  for (const result of results) {
    if (result.error !== null || result.scan === null) {
      parseFailures.push({ path: `products/${result.relative}`, reason: result.error ?? 'unknown parse failure' });
      fileHashes.push({ path: `products/${result.relative}`, hash: 'unparsed' });
      continue;
    }
    scanned += 1;
    fileHashes.push({ path: `products/${result.relative}`, hash: result.scan.fileHash });
    for (const [xmlField, rawValue] of Object.entries(result.scan.customFields)) {
      const normalized = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
      const trimmed = normalized.trim();
      let counter = fieldCounters.get(xmlField);
      if (!counter) {
        counter = { recordCount: 0, nonEmptyCount: 0, values: new Set(), delimiters: new Map() };
        fieldCounters.set(xmlField, counter);
      }
      counter.recordCount += 1;
      if (trimmed) {
        counter.nonEmptyCount += 1;
        counter.values.add(trimmed);
        if (MULTI_VALUE_FIELD_PREFIX.test(xmlField)) {
          for (const character of DELIMITER_CANDIDATES) {
            let occurrences = 0;
            for (let index = 0; index < normalized.length; index += 1) {
              if (normalized[index] === character) occurrences += 1;
            }
            if (occurrences > 0) {
              counter.delimiters.set(character, (counter.delimiters.get(character) ?? 0) + occurrences);
            }
          }
        }
      }
    }
    for (const pageName of result.scan.pageNames) {
      const page = pageCounter.get(pageName) ?? { count: 0, skus: new Set<string>() };
      page.count += 1;
      if (result.scan.sku) page.skus.add(result.scan.sku);
      pageCounter.set(pageName, page);
    }
  }

  const fields: CatalogFieldEvidence[] = [...fieldCounters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([xmlField, counter]) => ({
      xmlField,
      recordCount: counter.recordCount,
      nonEmptyCount: counter.nonEmptyCount,
      distinctValueCount: counter.values.size,
      distinctValueHash: hashCanonicalJson([...counter.values].sort()),
      delimiterEvidence: [...counter.delimiters.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([character, occurrenceCount]) => ({ character, occurrenceCount })),
    }));

  const pages: CatalogPageObservation[] = [...pageCounter.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pageName, counter]) => ({
      pageName,
      productCount: counter.count,
      sampleSkus: [...counter.skus].sort().slice(0, SAMPLE_SKU_CAP),
    }));

  let fieldRegistry = { entryCount: 0, xmlFields: [] as string[] };
  const registryPath = path.join(workspacePath, FIELD_REGISTRY_FILE);
  try {
    const buffer = await fs.promises.readFile(registryPath);
    const registry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as { entries?: Array<{ xmlField?: unknown }> };
    const xmlFields = (registry.entries ?? []).map(entry => String(entry.xmlField ?? '')).sort();
    fieldRegistry = { entryCount: xmlFields.length, xmlFields };
    fileHashes.push({ path: FIELD_REGISTRY_FILE, hash: sha256Hex(buffer) });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      // No registry yet; evidence simply reports zero entries.
    } else {
      throw new Error(`Unable to read ${FIELD_REGISTRY_FILE}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  fileHashes.sort((left, right) => left.path.localeCompare(right.path));
  const sourceTreeHash = hashCanonicalJson(fileHashes);

  const evidence: CatalogEvidence = {
    schemaVersion: 1,
    sourceTreeHash,
    productFileCount: scanned,
    parseFailureCount: parseFailures.length,
    parseFailures: [...parseFailures].sort((left, right) => left.path.localeCompare(right.path)),
    fieldRegistry,
    fields,
    pages,
  };
  return evidence;
}

/** Deterministic canonical JSON rendering of the evidence artifact. */
export function renderCatalogEvidence(evidence: CatalogEvidence): string {
  return canonicalJsonFileString(evidence);
}

// ─── Live Catalog Field attestation ───────────────────────────────────────────

/**
 * Read the live Catalog Field set from `store/field-registry.json` (the
 * attested field registry). Returns an empty list when the registry is absent
 * (unconfigured workspaces); other read errors fail closed by throwing.
 */
export function readLiveCatalogFields(workspacePath: string): string[] {
  const registryPath = path.join(workspacePath, FIELD_REGISTRY_FILE);
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(registryPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new Error(`Unable to read ${FIELD_REGISTRY_FILE}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let registry: { entries?: Array<{ xmlField?: unknown }> };
  try {
    registry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as { entries?: Array<{ xmlField?: unknown }> };
  } catch (error) {
    throw new Error(`Invalid JSON in ${FIELD_REGISTRY_FILE}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const xmlFields = (registry.entries ?? []).map(entry => String(entry.xmlField ?? '')).filter(Boolean);
  return [...new Set(xmlFields)].sort((a, b) => a.localeCompare(b));
}

// ─── Catalog-evidence verification (Milestone 7 seam) ─────────────────────────

/**
 * True when `commit` is an ancestor of (or equal to) the nested catalog HEAD
 * of the workspace repository. Fail closed on any git error or malformed hash.
 */
export function gitCommitIsAncestor(workspacePath: string, commit: string): boolean {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: workspacePath,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The real catalog-evidence verifier for the M3 activation seam. Synchronous
 * so it fits the active-validation contract; it performs three non-fake
 * checks:
 *
 * (a) artifact binding — the SHA-256 of the committed
 *     `store/classification/catalog-evidence.json` bytes equals the manifest's
 *     `catalogEvidenceHash` (the artifact is content-addressed and committed);
 * (b) commit binding — `sourceCatalogCommit` is an ancestor of the nested
 *     catalog HEAD;
 * (c) field attestation — the supplied live Catalog Field set equals the
 *     current `store/field-registry.json` xmlFields.
 *
 * The full workspace re-scan comparison (tree integrity) is enforced by
 * {@link verifyCatalogEvidenceTreeIntegrity} at activation time so every
 * runtime load stays cheap while the authoritative artifact generation moment
 * re-verifies the actual catalog tree.
 */
export function createCatalogEvidenceVerifier(workspacePath: string): CatalogEvidenceVerifier {
  return (input) => {
    // (a) committed artifact binding.
    const artifactPath = path.join(workspacePath, 'store', 'classification', 'catalog-evidence.json');
    let artifactBytes: Buffer;
    try {
      artifactBytes = fs.readFileSync(artifactPath);
    } catch {
      return {
        verified: false,
        reason: `Catalog evidence artifact is missing at ${artifactPath}; re-run the evidence scan and activation.`,
      };
    }
    const artifactHash = sha256Hex(artifactBytes);
    if (artifactHash !== input.catalogEvidenceHash) {
      return {
        verified: false,
        reason: `Catalog evidence artifact SHA-256 ${artifactHash} does not match manifest.catalogEvidenceHash ${input.catalogEvidenceHash}.`,
      };
    }

    // (b) source catalog commit ancestry.
    if (!gitCommitIsAncestor(workspacePath, input.sourceCatalogCommit)) {
      return {
        verified: false,
        reason: `sourceCatalogCommit ${input.sourceCatalogCommit} is not an ancestor of the nested catalog HEAD.`,
      };
    }

    // (c) live field-registry attestation.
    let live: string[];
    try {
      live = readLiveCatalogFields(workspacePath);
    } catch (error) {
      return {
        verified: false,
        reason: `Unable to read the live field registry: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const attested = [...input.catalogFields].sort((a, b) => a.localeCompare(b));
    if (live.length !== attested.length || live.some((field, index) => field !== attested[index])) {
      return {
        verified: false,
        reason: 'The attested live Catalog Field set does not match the current store/field-registry.json xmlFields.',
      };
    }

    return { verified: true };
  };
}

/**
 * Activation-time tree integrity gate. Re-scans the live workspace and
 * compares the re-generated artifact hash to the expected hash, proving that
 * the catalog tree has not drifted since the evidence artifact was generated.
 * Used by the config-store before the atomic swap.
 */
export async function verifyCatalogEvidenceTreeIntegrity(
  workspacePath: string,
  expectedArtifactHash: string,
): Promise<{ verified: boolean; reason?: string }> {
  try {
    const rescanned = await scanCatalogEvidence(workspacePath);
    const artifact = renderCatalogEvidence(rescanned);
    const hash = sha256Hex(artifact);
    if (hash !== expectedArtifactHash) {
      return {
        verified: false,
        reason: `Catalog tree re-scan hash ${hash} does not match the expected artifact hash ${expectedArtifactHash}; re-run the evidence scan and regenerate the candidate before activation.`,
      };
    }
    return { verified: true };
  } catch (error) {
    return {
      verified: false,
      reason: `Catalog evidence re-scan failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
