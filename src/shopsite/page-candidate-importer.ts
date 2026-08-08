// fallow-ignore-file unused-export

/**
 * Provisional Page candidate scanner.
 *
 * Scans preserved ProductOnPages fragments in local product JSON files and
 * produces deterministic PROVISIONAL candidates (page name, product count,
 * sorted capped sample SKUs, and a fragment-set source hash). Provisional
 * candidates are review context only — a fragment name is never a verified
 * Page identity, so these can never resolve as verified Page options or be
 * serialized into ProductOnPages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { hashCanonicalJson } from '../shared/stable-id';

export interface PageFragmentSource {
  sku: string;
  preserved?: {
    unknownElements?: Record<string, unknown>;
    advancedBlocks?: Record<string, string>;
  };
}

export interface ProvisionalPageCandidate {
  pageName: string;
  productCount: number;
  /** Sorted, capped sample SKUs (deterministic). */
  sampleSkus: string[];
}

export interface ProvisionalCandidateScan {
  schemaVersion: 1;
  /** Canonical SHA-256 of the sorted per-product fragment set. */
  fragmentSetHash: string;
  candidateCount: number;
  /** Sorted by pageName. */
  candidates: ProvisionalPageCandidate[];
}

const PAGE_TAG_PATTERN = /<(?:Name|PageName|PageLink)>([^<]*)<\/(?:Name|PageName|PageLink)>/gi;
const SAMPLE_SKU_CAP = 10;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

/**
 * Extract the deduplicated page names from a product's preserved
 * ProductOnPages fragments (unknownElements and advancedBlocks).
 */
export function extractPageNamesFromPreserved(preserved: PageFragmentSource['preserved']): string[] {
  if (!preserved) return [];
  const names = new Set<string>();
  const extract = (raw: unknown): void => {
    if (raw === undefined || raw === null) return;
    const rawString = typeof raw === 'string' ? raw : String(raw);
    PAGE_TAG_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PAGE_TAG_PATTERN.exec(rawString)) !== null) {
      const name = decodeXmlEntities(match[1]?.trim() ?? '');
      if (name) names.add(name);
    }
  };
  extract(preserved.unknownElements?.['ProductOnPages']);
  extract(preserved.advancedBlocks?.['ProductOnPages']);
  extract(preserved.advancedBlocks?.['productOnPages']);
  return [...names];
}

/**
 * Deterministic provisional candidate scan over ProductOnPages fragments.
 * Identical inputs always produce identical output (sorted per-product
 * entries and sorted candidates; the fragment-set hash is canonical).
 */
export function scanProductOnPagesCandidates(products: PageFragmentSource[]): ProvisionalCandidateScan {
  const perProduct = products
    .map(p => ({
      sku: p.sku,
      pageNames: extractPageNamesFromPreserved(p.preserved).sort(),
    }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

  const fragmentSetHash = hashCanonicalJson(perProduct);

  const counter = new Map<string, { count: number; skus: Set<string> }>();
  for (const entry of perProduct) {
    for (const pageName of entry.pageNames) {
      let c = counter.get(pageName);
      if (!c) {
        c = { count: 0, skus: new Set() };
        counter.set(pageName, c);
      }
      c.count += 1;
      c.skus.add(entry.sku);
    }
  }

  const candidates: ProvisionalPageCandidate[] = [...counter.entries()]
    .map(([pageName, c]) => ({
      pageName,
      productCount: c.count,
      sampleSkus: [...c.skus].sort().slice(0, SAMPLE_SKU_CAP),
    }))
    .sort((a, b) => (a.pageName < b.pageName ? -1 : a.pageName > b.pageName ? 1 : 0));

  return {
    schemaVersion: 1,
    fragmentSetHash,
    candidateCount: candidates.length,
    candidates,
  };
}

/**
 * Scan a workspace's product JSON files into provisional candidates.
 * Unparseable files are skipped (they contribute no fragments). File listing
 * and iteration order are sorted, so repeated scans are byte-identical.
 */
export async function scanProductOnPagesFromWorkspace(workspacePath: string): Promise<ProvisionalCandidateScan> {
  const productsDir = path.join(workspacePath, 'products');
  const files = await listProductJsonFiles(productsDir, '');
  const products: PageFragmentSource[] = [];
  for (const relative of files) {
    try {
      const fullPath = path.join(productsDir, relative);
      const buffer = await fs.promises.readFile(fullPath);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const sku = typeof parsed.sku === 'string' && parsed.sku.length > 0 ? parsed.sku : relative;
      const shopsite = parsed.shopsite as Record<string, unknown> | undefined;
      const preserved = shopsite?.preserved as PageFragmentSource['preserved'] | undefined;
      products.push({ sku, preserved });
    } catch {
      // Skip unparseable product files — they cannot contribute fragments.
    }
  }
  return scanProductOnPagesCandidates(products);
}

async function listProductJsonFiles(dir: string, relative: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'images') continue; // media assets, never product records
      files.push(...await listProductJsonFiles(childPath, childRelative));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(childRelative);
    }
  }
  return files.sort();
}
