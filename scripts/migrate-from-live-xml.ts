import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { hashJson } from '../src/git/deterministic-json';
import { computeContentHash } from '../src/shopsite/drift';

const WORKSPACE_PATH = '/Users/nickborrello/Desktop/Projects/shopsite-cms/workspaces/Bay State';
const DB_PATH = path.join(WORKSPACE_PATH, '.shopsite-cms/app.db');
const TEMP_XML_PATH = path.join(WORKSPACE_PATH, '.shopsite-cms/temp_live_products.xml');

interface XmlEntry {
  graphic: string | null;
  moreInfoGraphic: string | null;
  additionalImages: string[];
}

async function runMigration() {
  console.log('--- Starting Live Media Gallery Image Migration ---');
  if (!fs.existsSync(DB_PATH)) {
    console.error(`SQLite database not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);

  // 1. Get connection settings
  console.log('Step 1: Retrieving connection settings...');
  const conn = db.query('SELECT * FROM shopsite_connection LIMIT 1').get() as any;
  if (!conn || !conn.cgi_base_url || !conn.merchant_id || !conn.password_secret_ref) {
    console.error('Connection settings not fully configured in database.');
    db.close();
    process.exit(1);
  }

  const cgiBaseUrl = conn.cgi_base_url.replace(/\/$/, '');
  const cgiUrl = `${cgiBaseUrl}/db_xml.cgi`;
  const authHeader = 'Basic ' + Buffer.from(`${conn.merchant_id}:${conn.password_secret_ref}`).toString('base64');

  console.log(`CGI URL: ${cgiUrl}`);
  console.log(`Merchant: ${conn.merchant_id}`);

  // 2. Fetch live XML and write to disk
  console.log('Step 2: Fetching live XML from ShopSite...');
  const params = new URLSearchParams();
  params.set('clientApp', '1');
  params.set('dbname', 'products');
  params.set('version', '15.0');

  const response = await fetch(cgiUrl, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'User-Agent': 'ShopSiteCMS/0.1.0',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Failed to download live XML (HTTP ${response.status}): ${text.slice(0, 300)}`);
    db.close();
    process.exit(1);
  }

  console.log('Writing live XML to temporary file...');
  const destStream = fs.createWriteStream(TEMP_XML_PATH);
  const reader = response.body?.getReader();
  if (!reader) {
    console.error('Response body reader not available.');
    db.close();
    process.exit(1);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    destStream.write(value);
  }
  destStream.end();
  console.log(`Wrote live XML to ${TEMP_XML_PATH}`);

  // 3. Parse XML and build product map
  console.log('Step 3: Parsing live XML...');
  const xmlMap = new Map<string, XmlEntry>();
  const fileStream = fs.createReadStream(TEMP_XML_PATH);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let productBlock = '';
  let insideProduct = false;
  let sku = '';
  let graphic: string | null = null;
  let moreInfoGraphic: string | null = null;
  let additionalImages: string[] = [];

  for await (const line of rl) {
    if (line.includes('<Product>')) {
      insideProduct = true;
      sku = '';
      graphic = null;
      moreInfoGraphic = null;
      additionalImages = [];
      continue;
    }

    if (insideProduct) {
      const skuMatch = line.match(/<SKU>(.*)<\/SKU>/i);
      if (skuMatch) {
        sku = skuMatch[1].trim();
        continue;
      }

      const graphicMatch = line.match(/<Graphic>(.*)<\/Graphic>/i);
      if (graphicMatch) {
        graphic = graphicMatch[1].trim();
        if (graphic === 'none' || graphic === '') graphic = null;
        continue;
      }

      const migMatch = line.match(/<MoreInformationGraphic>(.*)<\/MoreInformationGraphic>/i);
      if (migMatch) {
        moreInfoGraphic = migMatch[1].trim();
        if (moreInfoGraphic === 'none' || moreInfoGraphic === '') moreInfoGraphic = null;
        continue;
      }

      const imgMatch = line.match(/<MoreInfoImage(\d+)>(.*)<\/MoreInfoImage\d+>/i);
      if (imgMatch) {
        const val = imgMatch[2].trim();
        if (val && val !== 'none') {
          additionalImages.push(val);
        }
        continue;
      }

      if (line.includes('</Product>')) {
        insideProduct = false;
        if (sku) {
          xmlMap.set(sku, {
            graphic,
            moreInfoGraphic,
            additionalImages,
          });
        }
      }
    }
  }

  console.log(`Parsed ${xmlMap.size} product records from live XML.`);

  // 4. Load and migrate product JSON files
  console.log('Step 4: Migrating product JSON files on disk and in database...');
  const productDir = path.join(WORKSPACE_PATH, 'products');
  const files = fs.readdirSync(productDir).filter(f => f.endsWith('.json'));

  let updatedCount = 0;
  const now = new Date().toISOString();

  // Prepare SQLite statements
  const updateStmt = db.prepare(`
    UPDATE product_index
    SET primary_image = ?,
        product_hash = ?,
        last_pulled_remote_hash = ?,
        last_synced_remote_hash = ?,
        sync_status = 'synced',
        updated_at = ?
    WHERE sku = ?
  `);

  db.transaction(() => {
    for (const file of files) {
      const filePath = path.join(productDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const product = JSON.parse(content);
      const sku = product.sku;

      const xmlEntry = xmlMap.get(sku);
      if (!xmlEntry) continue;

      let changed = false;

      // Update primary image
      const targetPrimary = xmlEntry.graphic || xmlEntry.moreInfoGraphic || null;
      if (product.core.media.primary !== targetPrimary) {
        product.core.media.primary = targetPrimary;
        changed = true;
      }

      // Update additional images
      if (JSON.stringify(product.core.media.additional) !== JSON.stringify(xmlEntry.additionalImages)) {
        product.core.media.additional = xmlEntry.additionalImages;
        changed = true;
      }

      // Update unknownElements for MoreInformationGraphic
      const unknownElements = product.shopsite.preserved.unknownElements || {};
      if (xmlEntry.moreInfoGraphic && xmlEntry.moreInfoGraphic !== 'none' && xmlEntry.moreInfoGraphic !== xmlEntry.graphic) {
        if (unknownElements.MoreInformationGraphic !== xmlEntry.moreInfoGraphic) {
          unknownElements.MoreInformationGraphic = xmlEntry.moreInfoGraphic;
          changed = true;
        }
      } else {
        if ('MoreInformationGraphic' in unknownElements) {
          delete unknownElements.MoreInformationGraphic;
          changed = true;
        }
      }

      // Cleanup any legacy MoreInfoImage keys in unknownElements
      for (let i = 1; i <= 20; i++) {
        const key = `MoreInfoImage${i}`;
        if (key in unknownElements) {
          delete unknownElements[key];
          changed = true;
        }
      }

      product.shopsite.preserved.unknownElements = unknownElements;

      if (changed) {
        product.metadata.updatedAt = now;
        const newProductHash = hashJson(product);
        const newContentHash = computeContentHash(product);

        // Save back to file
        fs.writeFileSync(filePath, JSON.stringify(product, null, 2) + '\n', 'utf8');

        // Update database index
        updateStmt.run(
          product.core.media.primary,
          newProductHash,
          newContentHash,
          newContentHash,
          now,
          sku
        );

        updatedCount++;
      }
    }
  })();

  db.close();
  console.log(`Successfully migrated ${updatedCount} products on disk and in database.`);

  // Clean up temp XML file
  if (fs.existsSync(TEMP_XML_PATH)) {
    fs.unlinkSync(TEMP_XML_PATH);
    console.log('Removed temporary live XML file.');
  }

  console.log('--- Migration Completed ---');
}

runMigration().catch(console.error);
