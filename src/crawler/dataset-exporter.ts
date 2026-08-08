import fs from 'node:fs';
import path from 'node:path';
import { type ScrapedProductEvidence, ScrapedProductEvidenceSchema, computePayloadHash } from './corpus-schema.js';
import { validateCorpusLine, computeEntityId, computeObservationId } from './corpus-validator.js';

export interface ExporterOptions {
  storageDir?: string;
  filenamePrefix?: string;
}

export interface ExportReport {
  path: string;
  exported: number;
  rejected: Array<{ index: number; reason: string }>;
}

export class DatasetExporter {
  private baseDir: string;

  constructor(options?: ExporterOptions) {
    const cwd = process.cwd();
    this.baseDir = options?.storageDir || path.join(cwd, 'storage', 'training-corpus');
  }

  /**
   * Saves a list of scraped product evidence items for a given retailer domain.
   * Validates every item, assigns collision-resistant SHA-256 entity and
   * observation IDs, reports rejected records instead of silently dropping
   * them, and writes atomically (temp file + rename).
   */
  async exportToJsonl(domain: string, items: ScrapedProductEvidence[]): Promise<ExportReport> {
    const targetDir = path.join(this.baseDir, domain);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(targetDir, `evidence-${timestamp}.jsonl`);

    const exported: string[] = [];
    const rejected: Array<{ index: number; reason: string }> = [];
    const seenEntities = new Set<string>();

    items.forEach((item, index) => {
      const validation = validateCorpusLine(JSON.stringify(item), { seenEntityIds: seenEntities });
      if (!validation.ok) {
        rejected.push({ index, reason: `${validation.rejectionCode}: ${validation.rejectionReason}` });
        return;
      }
      const payloadHash = item.payloadHash || computePayloadHash(item as Record<string, unknown>);
      const entityId = item.entityId || validation.entityId || computeEntityId(item.sourceUrl);
      const observationId = item.observationId || computeObservationId(entityId, payloadHash);
      seenEntities.add(entityId);

      const enriched = ScrapedProductEvidenceSchema.parse({
        ...item,
        entityId,
        observationId,
        payloadHash,
        validationState: 'valid',
        pageKind: 'product',
        acquisitionMode: item.acquisitionMode ?? 'import_file',
      });
      exported.push(JSON.stringify(enriched));
    });

    const content = exported.join('\n') + (exported.length > 0 ? '\n' : '');
    const tempPath = path.join(targetDir, `.${path.basename(filePath)}.tmp-${process.pid}`);
    await fs.promises.writeFile(tempPath, content, 'utf-8');
    await fs.promises.rename(tempPath, filePath);
    return { path: filePath, exported: exported.length, rejected };
  }

  /**
   * Computes coverage statistics for a dataset of scraped product evidence.
   */
  computeMetrics(items: ScrapedProductEvidence[]) {
    const total = items.length;
    if (total === 0) {
      return {
        totalItems: 0,
        upcCoverage: 0,
        breadcrumbCoverage: 0,
        specsCoverage: 0,
        brandCoverage: 0,
      };
    }

    const withUpc = items.filter((i) => Boolean(i.upc || i.gtin || i.mpn)).length;
    const withBreadcrumb = items.filter((i) => i.rawBreadcrumb && i.rawBreadcrumb.length > 0).length;
    const withSpecs = items.filter((i) => i.specifications && Object.keys(i.specifications).length > 0).length;
    const withBrand = items.filter((i) => Boolean(i.brand)).length;

    return {
      totalItems: total,
      upcCoverage: Number((withUpc / total).toFixed(2)),
      breadcrumbCoverage: Number((withBreadcrumb / total).toFixed(2)),
      specsCoverage: Number((withSpecs / total).toFixed(2)),
      brandCoverage: Number((withBrand / total).toFixed(2)),
    };
  }
}
