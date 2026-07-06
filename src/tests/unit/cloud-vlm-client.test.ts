import { describe, it, expect } from 'vitest';
import { parseJsonFromVlmResponse, coercePackagingOcrData, PACKAGING_OCR_PROMPT } from '../../onboarding/packaging-ocr';

describe('Cloud VLM — Response Parsing', () => {
  it('reuses the same PACKAGING_OCR_PROMPT as local OCR', () => {
    expect(PACKAGING_OCR_PROMPT).toBeTruthy();
    expect(PACKAGING_OCR_PROMPT).toContain('productName');
    expect(PACKAGING_OCR_PROMPT).toContain('brand');
    expect(PACKAGING_OCR_PROMPT).toContain('species');
    expect(PACKAGING_OCR_PROMPT).toContain('flavorVariety');
    expect(PACKAGING_OCR_PROMPT).toContain('dietaryLabels');
    expect(PACKAGING_OCR_PROMPT).toContain('confidenceByField');
  });

  it('parses a well-formed JSON response from cloud VLM', () => {
    const raw = JSON.stringify({
      productName: 'Blue Buffalo Wilderness Chicken',
      brand: 'Blue Buffalo',
      species: ['Dog'],
      flavorVariety: 'Chicken',
      color: 'Brown',
      size: '24 lb',
      weight: '24 lb',
      lifeStage: 'Adult',
      productForm: 'Dry Food',
      confidenceByField: { productName: 0.95, brand: 0.9, species: 0.85 },
    });

    const parsed = parseJsonFromVlmResponse(raw);
    expect(parsed).toBeTruthy();
    expect(parsed!.productName).toBe('Blue Buffalo Wilderness Chicken');
    expect(parsed!.brand).toBe('Blue Buffalo');
  });

  it('parses response with markdown code fences', () => {
    const raw = '```json\n{"productName": "Wellness Core Grain Free", "brand": "Wellness", "species": ["Dog"], "confidenceByField": {"productName": 0.9}}\n```';
    const parsed = parseJsonFromVlmResponse(raw);
    expect(parsed).toBeTruthy();
    expect(parsed!.productName).toBe('Wellness Core Grain Free');
  });

  it('parses response with surrounding prose', () => {
    const raw = 'Here is the JSON:\n{"productName": "Taste of the Wild", "brand": "Taste of the Wild", "species": ["Dog"]}\nI hope this helps.';
    const parsed = parseJsonFromVlmResponse(raw);
    expect(parsed).toBeTruthy();
    expect(parsed!.productName).toBe('Taste of the Wild');
  });

  it('returns null for empty response', () => {
    expect(parseJsonFromVlmResponse('')).toBeNull();
    expect(parseJsonFromVlmResponse(null as unknown as string)).toBeNull();
    expect(parseJsonFromVlmResponse('   ')).toBeNull();
  });

  it('returns null for non-JSON response', () => {
    expect(parseJsonFromVlmResponse('I could not analyze this image.')).toBeNull();
  });

  it('coerces parsed data to valid PackagingOcrData shape', () => {
    const parsed = {
      productName: 'Blue Buffalo Wilderness Chicken',
      brand: 'Blue Buffalo',
      species: ['Dog'],
      flavorVariety: 'Chicken',
      visibleTextLines: ['Blue Buffalo', 'Wilderness', 'Chicken Recipe'],
      confidenceByField: { productName: 0.95, brand: 0.9 },
    };

    const result = coercePackagingOcrData(parsed, {
      imageSourceUrl: 'https://example.com/image.jpg',
      model: 'openai:gpt-4o',
      parser: 'cloud-vlm-client.ts',
      rawResponseExcerpt: parsed.productName,
    });

    expect(result).toBeTruthy();
    expect(result!.productName).toBe('Blue Buffalo Wilderness Chicken');
    expect(result!.brand).toBe('Blue Buffalo');
    expect(result!.species).toEqual(['Dog']);
    expect(result!.metadata?.model).toBe('openai:gpt-4o');
  });

  it('coerces scalar species to array', () => {
    const parsed = { species: 'Dog', productName: 'Test', confidenceByField: {} };
    const result = coercePackagingOcrData(parsed);
    expect(result).toBeTruthy();
    expect(result!.species).toEqual(['Dog']);
  });

  it('handles null fields and empty arrays gracefully', () => {
    const parsed = {
      productName: null,
      brand: null,
      species: [],
      flavorVariety: null,
      confidenceByField: {},
    };
    const result = coercePackagingOcrData(parsed);
    expect(result).toBeTruthy();
    expect(result!.productName).toBeNull();
    expect(result!.species).toEqual([]);
  });

  it('clamps confidence values to 0-1 range', () => {
    const parsed = {
      productName: 'Test',
      confidenceByField: { productName: 1.5, brand: -0.5, species: 0.85 },
    };
    const result = coercePackagingOcrData(parsed);
    expect(result).toBeTruthy();
    expect(result!.confidenceByField.productName).toBe(1);
    expect(result!.confidenceByField.brand).toBe(0);
    expect(result!.confidenceByField.species).toBe(0.85);
  });

  it('handles confidenceByField gracefully with empty result when confidenceByField is not an object', () => {
    const parsed = {
      productName: 'Test Product',
      confidenceByField: 'not-an-object',
    };
    const result = coercePackagingOcrData(parsed);
    // coercePackagingOcrData normalizes iterable values and defaults to {}
    expect(result).toBeTruthy();
    expect(result!.confidenceByField).toEqual({});
  });
});
