import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseSpreadsheet, detectColumnMapping, applyColumnMapping, splitGluedSizeBeforeBrand, moveTrailingBrandToFront } from '../../onboarding/spreadsheet-parser';
import type { ColumnMapping } from '../../shared/schemas/onboarding';

describe('Spreadsheet Parser', () => {
  it('should parse a basic spreadsheet and detect column mappings', () => {
    // Create a dummy workbook in memory using SheetJS
    const data = [
      ['UPC', 'Product Name', 'Price', 'Qty', 'Brand'],
      ['123456789012', 'Test Widget A', '19.99', '10', 'WidgetCorp'],
      ['987654321098', 'Test Gizmo B', '29.99', '5', 'GizmoInc']
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });

    const parsed = parseSpreadsheet(buffer, 'test.xlsx');
    expect(parsed.headers).toEqual(['UPC', 'Product Name', 'Price', 'Qty', 'Brand']);
    expect(parsed.totalRows).toBe(2);
    expect(parsed.rows[0]['Product Name']).toBe('Test Widget A');

    const mapping = detectColumnMapping(parsed.headers);
    expect(mapping.upc).toBe('UPC');
    expect(mapping.name).toBe('Product Name');
    expect(mapping.price).toBe('Price');
    expect(mapping.quantity).toBe('Qty');
    expect(mapping.brand).toBe('Brand');
  });

  it('should apply column mapping to parse rows', () => {
    const rawRows = [
      { 'UPC': '123456789012', 'Product Name': 'Test Widget A', 'Price': '19.99', 'Qty': '10', 'Brand': 'WidgetCorp', 'URL': 'https://widgetcorp.com/item' },
      { 'UPC': '987654321098', 'Product Name': 'Test Gizmo B', 'Price': '29.99', 'Qty': '5', 'Brand': 'GizmoInc', 'URL': 'invalid-url' }
    ];

    const mapping: ColumnMapping = {
      upc: 'UPC',
      name: 'Product Name',
      nameMergeWith: null,
      price: 'Price',
      quantity: 'Qty',
      brand: 'Brand',
      department: null,
      sourceUrl: 'URL'
    };

    const { valid, errors } = applyColumnMapping(rawRows, mapping);
    expect(errors.length).toBe(0);
    expect(valid.length).toBe(2);

    expect(valid[0]).toEqual({
      upc: '123456789012',
      name: 'Test Widget A',
      price: '19.99',
      quantity: 10,
      brandHint: 'WidgetCorp',
      departmentHint: null,
      sourceUrl: 'https://widgetcorp.com/item',
      rowNumber: 2
    });

    // Row 2 has an invalid URL so it should be mapped to null
    expect(valid[1].sourceUrl).toBeNull();
  });

  it('should auto-detect and merge split description columns', () => {
    const data = [
      ['SKU_NO', 'DESCRIPTION1', 'DESCRIPTION2', 'LIST_PRICE'],
      ['850067859598', 'WOOF POOMERGENCY LAV', 'ENDER', '5.99'],
      ['850067859659', 'WOOF HONESTCHEW ANTL', 'ER SM', '9.99']
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });

    const parsed = parseSpreadsheet(buffer, 'split_test.xlsx');
    expect(parsed.headers).toEqual(['SKU_NO', 'DESCRIPTION1', 'DESCRIPTION2', 'LIST_PRICE']);

    const mapping = detectColumnMapping(parsed.headers);
    expect(mapping.upc).toBe('SKU_NO');
    expect(mapping.name).toBe('DESCRIPTION1');
    expect(mapping.nameMergeWith).toBe('DESCRIPTION2');
    expect(mapping.price).toBe('LIST_PRICE');

    const { valid, errors } = applyColumnMapping(parsed.rows, mapping as ColumnMapping);
    expect(errors.length).toBe(0);
    expect(valid.length).toBe(2);

    expect(valid[0].name).toBe('WOOF POOMERGENCY LAVENDER');
    expect(valid[1].name).toBe('WOOF HONESTCHEW ANTLER SM');
  });
});

describe('Import name normalization (glued size+brand / brand-last)', () => {
  const fullMapping: ColumnMapping = {
    upc: 'UPC',
    name: 'Product Name',
    price: null,
    quantity: null,
    brand: 'Brand',
    department: null,
    sourceUrl: null,
    nameMergeWith: null,
  };

  it('splits a size abbreviation fused to the row brand hint (incident regression)', () => {
    expect(splitGluedSizeBeforeBrand('BEEKEEPING GLOVES LGHARVEST LANE', 'Harvest Lane'))
      .toBe('BEEKEEPING GLOVES LG HARVEST LANE');
    expect(splitGluedSizeBeforeBrand('BEEKEEPING JACKET XLHARVEST LANE', 'HARVEST LANE'))
      .toBe('BEEKEEPING JACKET XL HARVEST LANE');
    // lowercase distributor variant
    expect(splitGluedSizeBeforeBrand('beekeeping gloves lgharvest lane', 'harvest lane'))
      .toBe('beekeeping gloves lg harvest lane');
  });

  it('never splits when the letters after the abbreviation are not the brand', () => {
    // CHEWLIMITED glue is product-word fusion, not size+brand — left for curation
    expect(splitGluedSizeBeforeBrand('NYLABONE POWER CHEWLIMITED CHKN XS', 'NYLABONE'))
      .toBe('NYLABONE POWER CHEWLIMITED CHKN XS');
    // unknown trailing text — no speculative splits
    expect(splitGluedSizeBeforeBrand('GLOVES LGMYSTERY', 'Harvest Lane'))
      .toBe('GLOVES LGMYSTERY');
  });

  it('is a no-op without a brand hint', () => {
    expect(splitGluedSizeBeforeBrand('BEEKEEPING GLOVES LGHARVEST LANE', null))
      .toBe('BEEKEEPING GLOVES LGHARVEST LANE');
    expect(moveTrailingBrandToFront('WIDGET BOARD SOLID ACME', '')).toBe('WIDGET BOARD SOLID ACME');
  });

  it('moves a word-bounded trailing brand phrase to canonical brand-first form', () => {
    expect(moveTrailingBrandToFront('BEEKEEPING GLOVES LG HARVEST LANE', 'Harvest Lane'))
      .toBe('Harvest Lane BEEKEEPING GLOVES LG');
    // comma/hyphen separators before the trailing brand are tolerated
    expect(moveTrailingBrandToFront('Gloves Large - Harvest Lane', 'Harvest Lane'))
      .toBe('Harvest Lane Gloves Large');
  });

  it('leaves ambiguous shapes untouched', () => {
    // already brand-first → idempotent
    expect(moveTrailingBrandToFront('HARVEST LANE BEEKEEPING GLOVES LG', 'Harvest Lane'))
      .toBe('HARVEST LANE BEEKEEPING GLOVES LG');
    // brand appears twice → refuse (cannot disambiguate)
    expect(moveTrailingBrandToFront('HARVEST LANE SUIT VENTED HARVEST LANE', 'Harvest Lane'))
      .toBe('HARVEST LANE SUIT VENTED HARVEST LANE');
    // trailing text only PARTIALLY matches the brand → refuse
    expect(moveTrailingBrandToFront('SUIT VENTED HARVEST', 'Harvest Lane'))
      .toBe('SUIT VENTED HARVEST');
  });

  it('end-to-end: applyColumnMapping normalizes dirty rows exactly like the manual data fix', () => {
    const rawRows = [
      { UPC: '753677468139', 'Product Name': 'BEEKEEPING GLOVES LGHARVEST LANE', Brand: 'Harvest Lane' },
      { UPC: '018214856511', 'Product Name': 'NYLABONE POWER CHEWLIMITED CHKN XS', Brand: 'NYLABONE' },
      { UPC: '123456789012', 'Product Name': 'CLEAN NAME SM', Brand: 'Acme' },
    ];
    const { valid, errors } = applyColumnMapping(rawRows, fullMapping);
    expect(errors.length).toBe(0);
    // glued size+brand split AND brand moved to front — matches the DB fix
    expect(valid[0].name).toBe('Harvest Lane BEEKEEPING GLOVES LG');
    // identical-across-siblings glue never trips T2 — deliberately untouched
    expect(valid[1].name).toBe('NYLABONE POWER CHEWLIMITED CHKN XS');
    // clean row passthrough
    expect(valid[2].name).toBe('CLEAN NAME SM');
  });
});
