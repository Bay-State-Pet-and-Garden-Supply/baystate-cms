import { callLlmForTask } from '../../onboarding/llm-client';
import { generateProductFieldAuditReport } from './catalog-insight-service';
import { findSkusWithFieldValueCaseInsensitive, type CatalogProposal } from './product-field-refactor-service';
import {
  deleteGeneratedProposals,
  findDuplicateProposal,
  insertProposal,
} from '../../db/repositories/catalog-health-proposal-repo';

/**
 * Generate AI-assisted suggestions for a ProductField and store them as proposals.
 */
export async function generateAiProposals(
  workspaceId: string,
  field: string
): Promise<CatalogProposal[]> {
  const report = generateProductFieldAuditReport(workspaceId, field);
  
  // Prepare a clean list of values for the prompt
  // Sort values: suspicious ones first, then lower frequency ones
  const valuesForPrompt = report.values.map(v => {
    const isSuspicious = report.suspiciousValues.some(sv => sv.value === v.value);
    const suspiciousReasons = report.suspiciousValues.find(sv => sv.value === v.value)?.reasons || [];
    return {
      value: v.value,
      frequency: v.frequency,
      isSuspicious,
      suspiciousReasons,
    };
  });

  // Limit value count to avoid huge context window issues
  const truncatedValues = valuesForPrompt.slice(0, 100);

  const systemPrompt = `You are a professional ecommerce catalog data architect and the Baystate CMS Store Manager AI Assistant.
Your task is to analyze product attribute values, identify formatting issues, casing duplicates, typos, taxonomy drift, and semantic duplicates, and suggest canonical replacements.
Return ONLY valid JSON matching this schema:
{
  "proposals": [
    {
      "oldValue": "existing value in catalog",
      "newValue": "suggested canonical value",
      "reason": "explanation of change (e.g. 'casing normalization', 'semantic grouping of Feline/Cat', 'typo correction')",
      "confidence": 0.95
    }
  ]
}`;

  const prompt = `Analyze the custom field "${field}" (labeled "${report.label}") in our store catalog.
Here is the list of unique values (up to 100 values, showing frequencies and any system-flagged issues):
${JSON.stringify(truncatedValues, null, 2)}

Provide renaming suggestions for formatting, casing, spelling corrections, or category consolidation. 
DO NOT propose changes where the oldValue and newValue are identical. 
Confidence should be a decimal between 0.1 and 0.99 (depending on how sure you are).`;

  const response = await callLlmForTask('product_field_refactor', prompt, systemPrompt, {
    allowFallback: true,
    // Real workspace identity so the general callLlmForTask path creates and
    // terminalizes an ai_model_calls row for this workspace (epic #42, #37).
    workspaceId,
  });

  if (!response) {
    throw new Error('No response from AI model config.');
  }

  // Parse JSON response safely
  let json: { proposals: any[] };
  try {
    // Strip markdown code block wrappers if any
    const cleanJsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
    json = JSON.parse(cleanJsonStr);
  } catch (err) {
    console.error('Failed to parse AI response as JSON:', response);
    throw new Error(`AI response format invalid: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!json.proposals || !Array.isArray(json.proposals)) {
    throw new Error('AI response did not return a proposals array.');
  }

  const inserted: CatalogProposal[] = [];

  // Clear previous AI proposed changes for this field (workspace-scoped)
  deleteGeneratedProposals(workspaceId, field, 'ai');

  for (const p of json.proposals) {
    if (!p.oldValue || !p.newValue || p.oldValue === p.newValue) {
      continue;
    }

    // Look up affected SKUs dynamically to avoid the 50-SKU limit
    const affectedSkus = findSkusWithFieldValueCaseInsensitive(field, p.oldValue);

    if (affectedSkus.length === 0) {
      // Skip if we can't find products using this oldValue
      continue;
    }

    // Check if proposal already exists in this workspace
    const existingId = findDuplicateProposal(workspaceId, field, p.oldValue, p.newValue);
    if (existingId) {
      continue;
    }

    inserted.push(
      insertProposal({
        workspaceId,
        field,
        oldValue: p.oldValue,
        newValue: p.newValue,
        affectedSkus,
        reason: p.reason || 'AI recommendation',
        confidence: p.confidence || 0.8,
        source: 'ai',
        status: 'proposed',
      }),
    );
  }

  return inserted;
}
