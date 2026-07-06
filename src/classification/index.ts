/**
 * Classification Stage Registry
 *
 * Central module that exports all available classification stages
 * in their correct dependency order. To add a new stage:
 * 1. Create the stage file in src/classification/stages/
 * 2. Import and add it to the array below
 * 3. The pipeline runner resolves dependencies automatically
 */
export { evidenceExtractionStage } from './stages/evidence-extraction';
export { nameConsolidationStage } from './stages/name-consolidation';
export { primaryProductTypeStage } from './stages/primary-product-type';
export { attributeApplicabilityStage } from './stages/attribute-applicability';
export { productAttributeProposalsStage } from './stages/attribute-proposals';
export { categoryPageProposalsStage } from './stages/category-page-proposals';
export { productDraftProjectionStage } from './stages/draft-projection';
