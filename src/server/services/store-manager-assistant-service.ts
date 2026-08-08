import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection';
import { callLlmForTask } from '../../onboarding/llm-client';
import { generateProductFieldAuditReport } from './catalog-insight-service';
import { listProducts } from '../../db/repositories/product-index-repo';
import { listProposals, findSkusWithFieldValueCaseInsensitive, type CatalogProposal } from './product-field-refactor-service';

export interface AssistantCleanupReport {
  summary: string;
  reportMarkdown: string;
}

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

  const db = getDb();
  const now = new Date().toISOString();

  // Clear previous AI proposed changes for this field
  db.run(
    "DELETE FROM catalog_health_proposals WHERE workspace_id = ? AND field = ? AND status = 'proposed' AND source = 'ai'",
    [workspaceId, field]
  );

  const inserted: CatalogProposal[] = [];

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

    // Check if proposal already exists
    const existing = db.query(
      'SELECT id FROM catalog_health_proposals WHERE workspace_id = ? AND field = ? AND old_value = ? AND new_value = ? LIMIT 1'
    ).get(workspaceId, field, p.oldValue, p.newValue) as { id: string } | undefined;

    if (existing) {
      continue;
    }

    const id = randomUUID();
    db.run(
      `INSERT INTO catalog_health_proposals (id, workspace_id, field, old_value, new_value, affected_skus, reason, confidence, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        field,
        p.oldValue,
        p.newValue,
        JSON.stringify(affectedSkus),
        p.reason || 'AI recommendation',
        p.confidence || 0.8,
        'ai',
        'proposed',
        now,
        now,
      ]
    );

    inserted.push({
      id,
      workspaceId,
      field,
      oldValue: p.oldValue,
      newValue: p.newValue,
      affectedSkus,
      reason: p.reason || 'AI recommendation',
      confidence: p.confidence || 0.8,
      source: 'ai',
      status: 'proposed',
      changeSetId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return inserted;
}

/**
 * Generate a manager-readable catalog cleanup report using LLM.
 */
export async function generateStoreManagerReport(
  workspaceId: string,
  workspacePath: string
): Promise<AssistantCleanupReport> {
  // Gather overall health stats
  const db = getDb();
  
  // Total warnings/errors from product_index
  const issuesRow = db.query(
    "SELECT COUNT(*) as count FROM product_index WHERE status = 'active' AND has_warnings = 1"
  ).get() as { count: number } | undefined;
  
  const warningsCount = issuesRow?.count || 0;

  // Active proposals count
  const proposedRow = db.query(
    "SELECT COUNT(*) as count FROM catalog_health_proposals WHERE workspace_id = ? AND status = 'proposed'"
  ).get(workspaceId) as { count: number } | undefined;
  
  const proposedChangesCount = proposedRow?.count || 0;

  // Active change sets
  const csRow = db.query(
    "SELECT COUNT(*) as count FROM change_sets WHERE workspace_id = ? AND status = 'active'"
  ).get(workspaceId) as { count: number } | undefined;

  const activeChangeSetCount = csRow?.count || 0;

  const systemPrompt = `You are the Store Manager AI Assistant. Write a professional, executive-ready Catalog Cleanup Report.
Organize your response using professional Markdown.
Include sections:
1. Executive Summary
2. Catalog Health Insights (categorized by severity and common issues)
3. Recommended Corrective Actions (details on field cleanup, separator normalizations)
4. Active Change Set Status
Provide helpful, actionable context, pointing out how cleanup improves SEO, faceted search experience, and catalog integrity.`;

  const prompt = `Generate a Store Manager Cleanup Report for our Baystate CMS workspace.
Here is the current catalog status:
- Active products with validation issues: ${warningsCount}
- Pending/Proposed cleanup recommendations: ${proposedChangesCount}
- Open/Active drafts in Change Sets: ${activeChangeSetCount}

Summarize what steps should be taken next to achieve 100% catalog health. Highlight the benefits of ProductField cleanup for category taxonomy, brand consistency, and separator normalization. Keep it under 400 lines, engaging and highly professional.`;

  const reportText = await callLlmForTask('store_manager_assistant', prompt, systemPrompt, {
    allowFallback: true,
  });

  return {
    summary: `Catalog has ${warningsCount} products with warnings, ${proposedChangesCount} proposed fixes, and ${activeChangeSetCount} active change sets.`,
    reportMarkdown: reportText || 'Failed to generate store manager report.',
  };
}
