import * as XLSX from 'xlsx';
import type { ColumnMapping, SpreadsheetRow } from '../shared/schemas/onboarding';

export interface ParsedSpreadsheet {
  headers: string[];
  rows: Record<string, string>[];
  sheetName: string;
  totalRows: number;
}

/**
 * Parse an uploaded spreadsheet (XLS, XLSX, CSV) into headers and raw rows.
 */
export function parseSpreadsheet(buffer: ArrayBuffer, fileName: string): ParsedSpreadsheet {
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

    const upc = raw[mapping.upc]?.trim();

    // Concatenate split description columns if nameMergeWith is set
    let name = raw[mapping.name]?.trim() ?? '';
    if (mapping.nameMergeWith) {
      const part2 = raw[mapping.nameMergeWith]?.trim() ?? '';
      if (part2) {
        name = (name + part2).trim();
      }
    }

    if (!upc) {
      errors.push({ row: rowNumber, message: 'Missing UPC' });
      continue;
    }
    if (!name) {
      errors.push({ row: rowNumber, message: 'Missing product name' });
      continue;
    }

    const price = mapping.price ? raw[mapping.price]?.trim() || null : null;
    const quantityRaw = mapping.quantity ? raw[mapping.quantity]?.trim() : null;
    const quantity = quantityRaw ? parseInt(quantityRaw, 10) : null;
    const brandHint = mapping.brand ? raw[mapping.brand]?.trim() || null : null;
    const departmentHint = mapping.department ? raw[mapping.department]?.trim() || null : null;
    const sourceUrlRaw = mapping.sourceUrl ? raw[mapping.sourceUrl]?.trim() || null : null;

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
    });
  }

  return { valid, errors };
}
