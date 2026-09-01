import * as XLSX from 'xlsx';
import type { ColumnMapping, SpreadsheetRow } from '../shared/schemas/onboarding';
import { captureImportedIdentity } from './imported-identity';

export interface ParsedSpreadsheet {
  headers: string[];
  rows: Record<string, string>[];
  sheetName: string;
  totalRows: number;
}

/**
 * Parse an uploaded spreadsheet (XLS, XLSX, CSV) into headers and raw rows.
 */
export function parseSpreadsheet(buffer: ArrayBuffer, _fileName: string): ParsedSpreadsheet {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('Spreadsheet has no sheets');
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found`);
  }

  // Get all rows as JSON objects (header row becomes keys)
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  if (rawRows.length === 0) {
    throw new Error('Spreadsheet has no data rows');
  }

  // Extract headers from first row keys
  const headers = Object.keys(rawRows[0]);

  // Convert all values to strings
  const rows = rawRows.map(row => {
    const stringRow: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      stringRow[key] = value === null || value === undefined ? '' : String(value);
    }
    return stringRow;
  });

  return {
    headers,
    rows,
    sheetName,
    totalRows: rows.length,
  };
}

// ─── Column Auto-Detection ────────────────────────────────────────────────────

const UPC_PATTERNS = /^(upc|ean|barcode|gtin|upc[\s_-]?code|item[\s_-]?code|sku|sku[\s_-]?no|sku[\s_-]?number)$/i;
const NAME_PATTERNS = /^(name|product[\s_-]?name|description|title|item[\s_-]?name|register[\s_-]?name|short[\s_-]?name|item[\s_-]?desc|prod[\s_-]?desc|description\d*)$/i;
const PRICE_PATTERNS = /^(price|retail[\s_-]?price|unit[\s_-]?price|msrp|cost|sell[\s_-]?price|sale[\s_-]?price|list[\s_-]?price)$/i;
const QUANTITY_PATTERNS = /^(qty|quantity|stock|on[\s_-]?hand|count|inventory|units|quantity[\s_-]?on[\s_-]?hand)$/i;
const BRAND_PATTERNS = /^(brand|manufacturer|vendor|mfg|mfr|brand[\s_-]?name|make|supplier)$/i;
const DEPARTMENT_PATTERNS = /^(dept|department|category|class|group|type|section)$/i;
const URL_PATTERNS = /^(url|source[\s_-]?url|product[\s_-]?url|link|website|source|page[\s_-]?url)$/i;

/**
 * Pattern for detecting split description columns (e.g. DESCRIPTION1, DESCRIPTION2).
 * Captures the base name and the numeric suffix.
 */
const SPLIT_DESC_PATTERN = /^(description|desc|item[\s_-]?desc|prod[\s_-]?desc)[\s_-]?(\d+)$/i;

/**
 * Auto-detect column mapping from spreadsheet headers.
 * Returns best-guess mapping with nulls for undetected optional fields.
 */
export function detectColumnMapping(headers: string[]): Partial<ColumnMapping> {
  const mapping: Partial<ColumnMapping> = {};

  // First pass: detect split description columns (DESCRIPTION1 + DESCRIPTION2)
  const descParts: Array<{ header: string; base: string; num: number }> = [];
  for (const header of headers) {
    const match = header.trim().match(SPLIT_DESC_PATTERN);
    if (match) {
      descParts.push({ header, base: match[1].toLowerCase(), num: parseInt(match[2], 10) });
    }
  }

  // If we found numbered description columns, use the lowest as name and next as merge target
  if (descParts.length >= 2) {
    descParts.sort((a, b) => a.num - b.num);
    mapping.name = descParts[0].header;
    mapping.nameMergeWith = descParts[1].header;
  }

  // Second pass: standard pattern matching
  for (const header of headers) {
    const trimmed = header.trim();
    if (!mapping.upc && UPC_PATTERNS.test(trimmed)) mapping.upc = header;
    // Only auto-detect name if we didn't already find split descriptions
    if (!mapping.name && NAME_PATTERNS.test(trimmed)) mapping.name = header;
    if (!mapping.price && PRICE_PATTERNS.test(trimmed)) mapping.price = header;
    if (!mapping.quantity && QUANTITY_PATTERNS.test(trimmed)) mapping.quantity = header;
    if (!mapping.brand && BRAND_PATTERNS.test(trimmed)) mapping.brand = header;
    if (!mapping.department && DEPARTMENT_PATTERNS.test(trimmed)) mapping.department = header;
    if (!mapping.sourceUrl && URL_PATTERNS.test(trimmed)) mapping.sourceUrl = header;
  }

  return mapping;
}

// ─── Name Normalization (incident #gloves-lg harvest) ─────────────────────────

/**
 * Size abbreviations recognized downstream by formatDeterministicTitle /
 * deriveFrozenFactsForValidation (cohort-name-coordinator.ts). A glued pair
 * like "LGHARVEST" defeats BOTH: \b-size expansion never fires (no word
 * boundary inside the fused token) and the frozen-facts extractor never sees a
 * standalone {size} slot — so multi-variant families hard-fail T7 family
 * consistency (shared skeleton mismatch) and the cohort run aborts.
 */
const SIZE_ABBREVS = ['SM', 'MD', 'LG', 'XL', 'XS', 'XXL'] as const;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Words of the brand hint joined by a flexible non-alphanumeric gap. */
function flexibleBrandPattern(brandHint: string): string | null {
  const words = brandHint.match(/[a-z0-9]+/gi);
  if (!words || words.length === 0) return null;
  return words.map(word => escapeRe(word)).join('[^A-Za-z0-9]+');
}

/**
 * Rule 1 — split a size abbreviation FUSED to a following known-brand token
 * ("BEEKEEPING GLOVES LGHARVEST LANE" + brand "Harvest Lane" →
 * "BEEKEEPING GLOVES LG HARVEST LANE"). Only fires when the letters directly
 * after the abbreviation begin the row's OWN brand hint, so unknown text is
 * never speculatively split.
 */
export function splitGluedSizeBeforeBrand(name: string, brandHint: string | null | undefined): string {
  const brand = brandHint?.trim();
  if (!brand) return name;
  const flexible = flexibleBrandPattern(brand);
  if (!flexible) return name;
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${SIZE_ABBREVS.join('|')})(?=${flexible})`, 'gi');
  // Inserting a separator space is idempotent: the split form can never rematch.
  return name.replace(re, match => `${match} `);
}

/**
 * Rule 2 — canonicalize brand-LAST names to brand-FIRST ("BEEKEEPING GLOVES LG
 * HARVEST LANE" → "HARVEST LANE BEEKEEPING GLOVES LG") when the brand phrase:
 * appears EXACTLY once, sits word-bounded at the very end, and the name does
 * not already open with it. Without this, the deterministic title fallback
 * prepends the brand (it only checks the head) and the duplicate trips T3
 * "brand must appear exactly once" — another fail-closed cohort abort.
 * Deliberately conservative: ambiguous shapes (brand mid-name, repeated brand,
 * no trailing anchor) are left untouched for curation to resolve semantically.
 */
export function moveTrailingBrandToFront(name: string, brandHint: string | null | undefined): string {
  const brand = brandHint?.trim();
  if (!brand) return name;
  const flexible = flexibleBrandPattern(brand);
  if (!flexible) return name;
  const headRe = new RegExp(`^${flexible}(?=\\s|$)`, 'i');
  if (headRe.test(name)) return name;
  const occurrences = name.match(new RegExp(`(?<![A-Za-z0-9])${flexible}(?![A-Za-z0-9])`, 'gi'));
  if (!occurrences || occurrences.length !== 1) return name;
  const tailRe = new RegExp(`^(.+?)[\\s,-]*((?:${flexible}))$`, 'i');
  const m = name.match(tailRe);
  if (!m || !m[1].trim()) return name;
  return `${brand} ${m[1].replace(/[\s,-]+$/, '').trim()}`;
}

/**
 * Import-time name normalization pipeline: glue-split, then brand-first
 * canonicalization. Deterministic, idempotent, and a no-op for clean rows.
 */
export function normalizeImportedProductName(name: string, brandHint: string | null | undefined): string {
  return moveTrailingBrandToFront(splitGluedSizeBeforeBrand(name, brandHint), brandHint);
}

/**
 * Apply a confirmed column mapping to raw spreadsheet rows,
 * producing validated SpreadsheetRow objects.
 */
export function applyColumnMapping(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
): { valid: SpreadsheetRow[]; errors: Array<{ row: number; message: string }> } {
  const valid: SpreadsheetRow[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowNumber = i + 2; // +2 because row 1 is headers, data starts at row 2

    // Milestone 5 — lossless identity: capture IMMEDIATELY after obtaining raw row
    // BEFORE any trim/join/normalize, then derive operational fields from normalized envelope
    const captured = captureImportedIdentity({ ...raw, __rowNumber: String(rowNumber) }, mapping);
    const normalizedForOperational = JSON.parse(captured.normalized_identity_json!) as { name: string; brandHint: string | null; price: string | null; quantity: string | null; departmentHint: string | null; sourceUrl: string | null; upc: string };

    const upc = normalizedForOperational.upc?.trim() ?? raw[mapping.upc]?.trim();

    // Operational name is the normalized envelope's name (already includes boundary + glue-split + brand-move)
    let name = normalizedForOperational.name;

    if (!upc) {
      errors.push({ row: rowNumber, message: 'Missing UPC' });
      continue;
    }
    if (!name) {
      errors.push({ row: rowNumber, message: 'Missing product name' });
      continue;
    }

    const price = normalizedForOperational.price;
    const quantityRaw = normalizedForOperational.quantity;
    const quantity = quantityRaw ? parseInt(quantityRaw, 10) : null;
    const brandHint = normalizedForOperational.brandHint;
    const departmentHint = normalizedForOperational.departmentHint;
    const sourceUrlRaw = normalizedForOperational.sourceUrl;

    // Validate URL if provided
    let sourceUrl: string | null = null;
    if (sourceUrlRaw) {
      try {
        new URL(sourceUrlRaw);
        sourceUrl = sourceUrlRaw;
      } catch {
        // Invalid URL, skip it silently
        sourceUrl = null;
      }
    }
    valid.push({
      upc,
      name,
      price,
      quantity: quantity !== null && !isNaN(quantity) ? quantity : null,
      brandHint,
      departmentHint,
      sourceUrl,
      rowNumber,
        rawIdentityJson: captured.raw_identity_json,
        normalizedIdentityJson: captured.normalized_identity_json,
        identityNormalizerVersion: captured.identity_normalizer_version,
        identityProvenanceHash: captured.identity_provenance_hash,
    } as SpreadsheetRow & {
      rawIdentityJson: string | null;
      normalizedIdentityJson: string | null;
      identityNormalizerVersion: number;
      identityProvenanceHash: string;
    });
  }

  return { valid, errors };
}
