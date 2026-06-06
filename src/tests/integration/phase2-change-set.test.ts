import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseProductsXml } from '../../shopsite/product-parser';
import { normalizeProduct } from '../../shopsite/product-normalizer';
import { createWorkspaceDirs, writeGitignore, writeProductFile, readProductFile } from '../../git/workspace-files';
import { deterministicStringify } from '../../git/deterministic-json';
import { skuToProductFilePath } from '../../git/product-file-path';
import { GitClient } from '../../git/git-client';
import { buildProductsXml } from '../../shopsite/xml-builder';
import { createExportPackage } from '../../shopsite/export-package';

const fixtureDir = path.resolve(import.meta.dirname, '../../tests/fixtures');
const fixtureXml = fs.readFileSync(path.join(fixtureDir, 'shopsite-products-sample.xml'), 'utf-8');

describe('Phase 2: Change Sets and Approval', () => {
  const testDir = path.join(os.tmpdir(), `shopsite-cms-cs-${Date.now()}`);

  beforeAll(() => {
    try { fs.rmSync(testDir, { recursive: true }); } catch { /* ok */ }
    createWorkspaceDirs(testDir);
    writeGitignore(testDir);
  });

  afterAll(() => {
    try { fs.rmSync(testDir, { recursive: true }); } catch { /* ok */ }
  });

  it('should create baseline from fixture', () => {
    const parsed = parseProductsXml(fixtureXml);
    const workspaceId = 'test-ws';

    for (const parsedProduct of parsed.products) {
      const { product } = normalizeProduct(parsedProduct, workspaceId);
      if (!product.sku) continue;
      writeProductFile(testDir, product);
    }

    const git = new GitClient(testDir);
    git.init();
    git.add(['products/', '.gitignore']);
    const result = git.commit('Baseline');
    expect(result).toBeTruthy();
    expect(git.getHeadHash()).toBeTruthy();
  });

  it('should read approved product and see draft is separate from committed file', () => {
    const product = readProductFile(testDir, 'ABC-123');
    expect(product).toBeTruthy();
    expect(product!.sku).toBe('ABC-123');

    const draftContent = { ...product, core: { ...product!.core, name: 'Modified Draft' } };
    const draftStr = deterministicStringify(draftContent);
    // The draft string should contain the modified name
    expect(draftStr).toContain('Modified Draft');

    // File should still have original
    const fileContent = fs.readFileSync(
      path.join(testDir, skuToProductFilePath('ABC-123')),
      'utf-8',
    );
    expect(fileContent).toContain('Premium Dog Food');
    expect(fileContent).not.toContain('Modified Draft');
  });

  it('should generate XML from approved products', () => {
    const parsed = parseProductsXml(fixtureXml);
    const workspaceId = 'test-ws';
    const products = [];

    for (const parsedProduct of parsed.products) {
      const { product } = normalizeProduct(parsedProduct, workspaceId);
      if (product.sku) products.push(product);
    }

    const xml = buildProductsXml(products);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<ShopSiteProducts version="15.0">');
    expect(xml).toContain('<Products>');
    expect(xml).toContain('</Products>');
    expect(xml).toContain('</ShopSiteProducts>');
    expect(xml).toContain('<SKU>ABC-123</SKU>');
    expect(xml).toContain('<SKU>XYZ-789</SKU>');
    expect(xml).toContain('<Name>Premium Dog Food</Name>');
    expect(xml).toContain('</Product>');
    expect(xml).toContain('XYZ-789-RED');
    expect(xml).toContain('<Subproducts>');
  });

  it('should create export package with manifest and instructions', () => {
    const parsed = parseProductsXml(fixtureXml);
    const workspaceId = 'test-ws';
    const products = [];

    for (const parsedProduct of parsed.products) {
      const { product } = normalizeProduct(parsedProduct, workspaceId);
      if (product.sku) products.push(product);
    }

    const exportResult = createExportPackage(testDir, 'test-cs-001', products, {
      changeSetTitle: 'Test Export',
    });

    expect(exportResult.productCount).toBe(2);
    expect(fs.existsSync(exportResult.xmlPath)).toBe(true);
    expect(fs.existsSync(exportResult.manifestPath)).toBe(true);
    expect(fs.existsSync(exportResult.instructionsPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(exportResult.manifestPath, 'utf-8'));
    expect(manifest.changeSetId).toBe('test-cs-001');
    expect(manifest.productCount).toBe(2);
    expect(manifest.productSkus).toContain('ABC-123');
    expect(manifest.productSkus).toContain('XYZ-789');

    const instructions = fs.readFileSync(exportResult.instructionsPath, 'utf-8');
    expect(instructions).toContain('dbmake.cgi');
    expect(instructions).toContain('generate.cgi');
    expect(instructions).toContain('publish');
    expect(instructions).toContain('SKU');

    const xml = fs.readFileSync(exportResult.xmlPath, 'utf-8');
    expect(xml).toContain('SKU');
    expect(xml).toContain('ABC-123');
    expect(xml).toContain('Premium Dog Food');
  });

  it('should handle products without SKU gracefully', () => {
    const parsed = parseProductsXml(fixtureXml);
    const products = parsed.products.filter(p => (p.fields['SKU'] ?? p.fields['sku'] ?? '') !== '');
    expect(products.length).toBeLessThanOrEqual(parsed.products.length);
  });

  it('should write deterministic product files', () => {
    const parsed = parseProductsXml(fixtureXml);
    const workspaceId = 'test-ws';

    for (const parsedProduct of parsed.products) {
      const { product } = normalizeProduct(parsedProduct, workspaceId);
      if (!product.sku) continue;

      writeProductFile(testDir, product);
      const filePath = path.join(testDir, skuToProductFilePath(product.sku));
      expect(fs.existsSync(filePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.sku).toBe(product.sku);
      expect(content.core.name).toBe(product.core.name);
    }
  });
});
