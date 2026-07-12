/**
 * Catalog Product Evidence Extraction Stage
 *
 * A StageDefinition factory that wraps the shared evidence extractor
 * for catalog products. Captures the product state at creation time
 * so evidence reflects a consistent snapshot.
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import type { Product } from '../../shared/types';
import type { PageRow } from '../../db/repositories/page-repo';
import { buildCatalogProductEvidenceInput } from '../catalog-product-source';
import { extractProductEvidence } from '../product-evidence-extractor';

/**
 * Create an evidence_extraction stage for a catalog product.
 *
 * The stage captures the product data and page index at the time of
 * creation, ensuring a consistent snapshot for the classification run.
 *
 * @param product - The Product object to classify
 * @param workspacePath - Path to the workspace
 * @param pages - Current page index (for existing page context)
 */
export function createCatalogEvidenceExtractionStage(
  product: Product,
  workspacePath: string,
  pages?: PageRow[],
): StageDefinition {
  const source = buildCatalogProductEvidenceInput(product, workspacePath, pages);

  return {
    name: 'evidence_extraction',
    requires: [],
    evidenceFrom: [],
    execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
      try {
        const result = await extractProductEvidence(source.normalizedInput, input, context);

        if (result.evidence.length === 0) {
          return { status: 'abstained', reason: 'No new evidence extracted from catalog product.' };
        }

        return {
          status: 'succeeded',
          output: {
            evidence: result.evidence,
            proposals: [],
            abstained: false,
          },
        };
      } catch (err: any) {
        return {
          status: 'failed',
          error: `Catalog evidence extraction failed: ${err.message}`,
        };
      }
    },
  };
}
