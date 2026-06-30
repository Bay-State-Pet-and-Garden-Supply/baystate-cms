import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseSpreadsheet, detectColumnMapping, applyColumnMapping } from '../../onboarding/spreadsheet-parser';
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
