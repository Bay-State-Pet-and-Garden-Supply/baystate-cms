import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  decodeNumericEntities,
  parseShopSitePagesXml,
  ShopSitePagesXmlParserAdapter,
  shopSitePagesXmlParserAdapter,
  toPageRecords,
} from '../../shopsite/page-parser';

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'shopsite-pages-bay-state-redacted.xml');

function fixtureText(): string {
  return fs.readFileSync(FIXTURE_PATH, 'utf8');
}

describe('parseShopSitePagesXml', () => {
  it('parses the redacted fixture with the expected page count', () => {
    const doc = parseShopSitePagesXml(fixtureText());
    expect(doc.pages).toHaveLength(12);
  });

  it('captures the root version and Response block', () => {
    const doc = parseShopSitePagesXml(fixtureText());
    expect(doc.version).toBe('15.0');
    expect(doc.responseCode).toBe('1');
    expect(doc.responseDescription).toBe('success');
  });

  it('decodes named entities in page names', () => {
    const doc = parseShopSitePagesXml(fixtureText());
    const names = doc.pages.map(p => p.name);
    expect(names).toContain('#Bay State Pet & Garden Supply');
    expect(names).toContain('About: Bay State Pet & Garden Supply');
    expect(names).toContain('##FaceBook Store');
  });

  it('captures numeric entity decoding in product link names', () => {
    const doc = parseShopSitePagesXml(fixtureText());
    const scienceDiet = doc.pages.find(p => p.pageId === '2288');
    expect(scienceDiet).toBeDefined();
    expect(scienceDiet!.productLinks).toContain(
      'Science Diet Adult Perfect Digestion Chicken & Rice Entrée Dog Food 12.8 oz.',
    );
    // Windows-1252 curly quotes (&#145;/&#146;) and &apos; decode to '.
    const plants = doc.pages.find(p => p.pageId === '2311');
    expect(plants).toBeDefined();
    expect(plants!.productLinks).toContain('Columbine Earlybird ‘Purple and White’');
    expect(plants!.productLinks).toContain('Oriental Poppy ‘Brilliant\'');
  });

  it('captures pageId, pageFileName, and empty parentRef on every page', () => {
    const doc = parseShopSitePagesXml(fixtureText());
    expect(doc.pages.length).toBeGreaterThan(0);
    for (const page of doc.pages) {
      expect(page.pageId).toMatch(/^\d+$/);
      expect(page.pageFileName.length).toBeGreaterThan(0);
      expect(page.parentRef).toBeNull();
    }
  });

  it('captures productLinks on product pages and none elsewhere', () => {
    const doc = parseShopSitePagesXml(fixtureText());
    const withLinks = doc.pages.filter(p => p.productLinks.length > 0);
    expect(withLinks.length).toBeGreaterThanOrEqual(5);
    expect(withLinks.length).toBeLessThanOrEqual(12);
    const woodPellets = doc.pages.find(p => p.pageId === '1924');
    expect(woodPellets!.productLinks.length).toBe(15);
    const hidden = doc.pages.find(p => p.pageId === '494');
    expect(hidden!.productLinks).toEqual([]);
  });

  it('preserves the exact raw <Page> fragment', () => {
    const doc = parseShopSitePagesXml(fixtureText());
    for (const page of doc.pages) {
      expect(page.rawXml.startsWith('<Page>')).toBe(true);
      expect(page.rawXml.endsWith('</Page>')).toBe(true);
      expect(page.rawXml).toContain(`<PageID>${page.pageId}</PageID>`);
      expect(page.rawXml).toContain(`<PageFileName>${page.pageFileName}</PageFileName>`);
    }
  });

  it('preserves unknown elements in the ordered fields map', () => {
    const doc = parseShopSitePagesXml(fixtureText());
    const home = doc.pages.find(p => p.pageId === '1463');
    expect(home).toBeDefined();
    expect(home!.fields.Template).toBe('BayStatePet_Home');
    expect(home!.fields.Columns).toBe('Five columns');
    expect(home!.fields.PageSitemapPriority).toBe('Google Default');
    expect(home!.fields.SearchProducts).toBe('checked');
    // Field order follows document order: Name appears before PageTitle.
    const keys = Object.keys(home!.fields);
    expect(keys.indexOf('Name')).toBeLessThan(keys.indexOf('PageTitle'));
  });

  it('keeps block raw fragments for ProductLinks', () => {
    const doc = parseShopSitePagesXml(fixtureText());
    const woodPellets = doc.pages.find(p => p.pageId === '1924');
    expect(woodPellets!.blocks.ProductLinks).toMatch(/^<ProductLinks>/);
    expect(woodPellets!.blocks.ProductLinks).toContain('</ProductLinks>');
    expect(woodPellets!.blocks.ProductLinks).toContain('<Product>');
  });

  it('redacted text fields carry the REDACTED placeholder', () => {
    const doc = parseShopSitePagesXml(fixtureText());
    const contact = doc.pages.find(p => p.pageId === '1865');
    expect(contact).toBeDefined();
    expect(contact!.fields.Text1).toBe('REDACTED');
  });
});

describe('toPageRecords', () => {
  it('emits exported_guid verified records with unique identity keys', () => {
    const doc = parseShopSitePagesXml(fixtureText());
    const records = toPageRecords(doc);
    expect(records).toHaveLength(doc.pages.length);
    const keys = new Set<string>();
    for (const record of records) {
      expect(record.identity.kind).toBe('exported_guid');
      expect(record.identity.status).toBe('verified');
      expect(record.identity.key).toMatch(/^\d+$/);
      expect(record.availability).toBe('available');
      expect(record.parentRef).toBeNull();
      expect(record.name.length).toBeGreaterThan(0);
      keys.add(record.identity.key);
    }
    expect(keys.size).toBe(records.length);
  });

  it('degrades pages without a PageID to unverified name-only identity', () => {
    const records = toPageRecords({
      version: '15.0',
      responseCode: '1',
      responseDescription: 'success',
      pages: [
        {
          pageId: '',
          name: 'Legacy Page',
          pageFileName: 'legacy.html',
          parentRef: null,
          productLinks: [],
          rawXml: '<Page><Name>Legacy Page</Name></Page>',
          fields: { Name: 'Legacy Page' },
          blocks: {},
        },
      ],
    });
    expect(records[0].identity.kind).toBe('unverified_name_only');
    expect(records[0].identity.status).toBe('unverified');
    expect(records[0].name).toBe('Legacy Page');
  });
});

describe('ShopSitePagesXmlParserAdapter', () => {
  it('parses the fixture through the adapter contract', () => {
    const adapter = new ShopSitePagesXmlParserAdapter();
    expect(adapter.name).toBe('shopsite-pages-xml-1');
    const records = adapter.parsePagesXml(fixtureText());
    expect(records).toHaveLength(12);
    expect(records[0].identity.kind).toBe('exported_guid');
  });

  it('exposes the singleton adapter', () => {
    expect(shopSitePagesXmlParserAdapter.name).toBe('shopsite-pages-xml-1');
    expect(shopSitePagesXmlParserAdapter.parsePagesXml(fixtureText())).toHaveLength(12);
  });
});

describe('decodeNumericEntities', () => {
  it('decodes Latin-1 and Windows-1252 numeric references', () => {
    expect(decodeNumericEntities('Entr&#233;e')).toBe('Entrée');
    expect(decodeNumericEntities('&#145;quoted&#146;')).toBe('\u2018quoted\u2019');
    expect(decodeNumericEntities('&#65;')).toBe('A');
    expect(decodeNumericEntities('plain')).toBe('plain');
    expect(decodeNumericEntities('bad &#99999999; ref')).toBe('bad &#99999999; ref');
  });
});

const liveExportPath = process.env.SHOP_SITE_PAGES_XML;

describe('full live export (opt-in via SHOP_SITE_PAGES_XML)', () => {
  it.skipIf(!liveExportPath)('parses the full export with 211 pages and unique PageIDs', () => {
    const text = fs.readFileSync(liveExportPath!, 'utf8');
    const doc = parseShopSitePagesXml(text);
    expect(doc.pages).toHaveLength(211);
    const ids = new Set(doc.pages.map(p => p.pageId));
    expect(ids.size).toBe(211);
    const fileNames = new Set(doc.pages.map(p => p.pageFileName));
    expect(fileNames.size).toBe(211);
    expect(doc.pages.every(p => p.parentRef === null)).toBe(true);
    const withLinks = doc.pages.filter(p => p.productLinks.length > 0);
    expect(withLinks.length).toBe(153);
    expect(doc.pages.filter(p => p.pageId === '').length).toBe(0);
  });
});
