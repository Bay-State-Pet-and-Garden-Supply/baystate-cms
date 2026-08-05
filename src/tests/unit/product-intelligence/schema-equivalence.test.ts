/**
 * TypeBox ↔ Zod schema-equivalence tests (PI-1).
 *
 * The terminal submission tool gate is the TypeBox schema (what the Pi SDK
 * validates against) while the durable contract is the Zod schema (what the
 * executor persists). Drift between the two would either reject valid agent
 * bundles or admit payloads the contract forbids. These tests pin both
 * schemas to the same structure and behavior:
 *
 * 1. path-set equivalence — every leaf path, its type, enum/const values,
 *    numeric bounds, array constraints, and formats agree;
 * 2. behavioral equivalence — a corpus of valid and mutated payloads must be
 *    accepted/rejected identically by both validators.
 *
 * Normalization: Zod's JSON-schema export marks `.default()`-bearing fields
 * as required, but Zod's runtime accepts missing values for them (applying
 * the default). TypeBox marks them optional. Since the tool's `execute()`
 * re-validates with Zod, the acceptance behavior is what matters — the
 * equivalence check treats default-bearing fields as optional on both sides.
 */
import { describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import { StructuredSubmissionSchema } from '../../../product-intelligence/contracts';
import { SubmissionTypeBoxSchema } from '../../../product-intelligence/pi/pi-tool-registry';
import { ABSTENTION_SUBMISSION, validSubmission } from './test-helpers';

// ---------------------------------------------------------------------------
// JSON-schema path extraction
// ---------------------------------------------------------------------------

interface NormalizedLeaf {
  path: string;
  type: string;
  optional?: boolean;
  const?: unknown;
  enums?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  format?: string;
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  format?: string;
  default?: unknown;
  required?: string[];
};

function walkJsonSchema(schema: JsonSchema, base: string, leaves: NormalizedLeaf[]): void {
  if (schema.anyOf) {
    // Union of string literals (TypeBox) is the same constraint as an enum
    // (Zod): normalize anyOf-of-consts to a single enum leaf so both sides
    // compare equal.
    const constBranches = schema.anyOf.filter((branch) => branch.const !== undefined);
    if (constBranches.length === schema.anyOf.length && constBranches.length > 0) {
      const enums = constBranches.map((branch) => branch.const);
      leaves.push({ path: base, type: 'enum', enums });
      return;
    }
    for (const branch of schema.anyOf) {
      walkJsonSchema(branch, base, leaves);
    }
    return;
  }
  if (schema.const !== undefined) {
    leaves.push({ path: base, type: 'const', const: schema.const });
    return;
  }
  if (schema.enum) {
    leaves.push({ path: base, type: 'enum', enums: schema.enum });
    return;
  }
  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    for (const [key, child] of Object.entries(schema.properties)) {
      walkJsonSchema(child, base ? `${base}.${key}` : key, leaves);
      if (!required.has(key)) {
        // Mark the deepest leaf of this subtree optional (only matters for the
        // object root; kept simple by tagging all leaves under the key).
        for (const leaf of leaves) {
          if (leaf.path.startsWith(`${base ? `${base}.` : ''}${key}`)) leaf.optional = true;
        }
      }
    }
    return;
  }
  if (schema.items) {
    walkJsonSchema(schema.items, `${base}[i]`, leaves);
    const minItems = schema.minItems;
    if (minItems !== undefined) {
      for (const leaf of leaves) {
        if (leaf.path.startsWith(`${base}[i]`)) leaf.minItems = minItems;
      }
    }
    return;
  }
  const type = Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
  leaves.push({
    path: base,
    type: type ?? 'unknown',
    format: schema.format,
    minimum: schema.minimum,
    maximum: schema.maximum,
  });
}

function leafMap(schema: JsonSchema): Map<string, NormalizedLeaf> {
  const leaves: NormalizedLeaf[] = [];
  walkJsonSchema(schema, '', leaves);
  // Union branches produce duplicate paths with different constraints; keep
  // each branch so both sides agree on the full set.
  return new Map(leaves.map((leaf) => [`${leaf.path}|${leaf.type}|${JSON.stringify(leaf.const ?? null)}|${JSON.stringify(leaf.enums ?? null)}`, leaf]));
}

function normalizeZodJson(schema: unknown): JsonSchema {
  // Fields with a `default` are optional on input at runtime even though the
  // JSON-schema export lists them as required.
  const json = structuredClone(schema) as JsonSchema;
  const dropDefaultedFromRequired = (node: JsonSchema): void => {
    if (node.properties) {
      const required = (node.required ?? []).filter((key) => !(node.properties?.[key]?.default !== undefined));
      if (required.length > 0) node.required = required;
      else delete node.required;
      for (const child of Object.values(node.properties)) dropDefaultedFromRequired(child);
    }
    if (node.items) dropDefaultedFromRequired(node.items);
    if (node.anyOf) for (const branch of node.anyOf) dropDefaultedFromRequired(branch);
    // Remove `default` keywords (TypeBox does not emit them; they do not
    // affect acceptance).
    delete node.default;
  };
  dropDefaultedFromRequired(json);
  return json;
}

// ---------------------------------------------------------------------------
// Behavioral corpus
// ---------------------------------------------------------------------------

const MUTATIONS: Array<{ name: string; payload: unknown }> = [
  { name: 'missing schemaVersion', payload: (() => { const { schemaVersion: _omit, ...rest } = validSubmission(); return rest; })() },
  { name: 'missing identity', payload: (() => { const { identity: _omit, ...rest } = validSubmission(); return rest; })() },
  { name: 'missing identity.gtinMatch', payload: { ...validSubmission(), identity: { ...validSubmission().identity, gtinMatch: undefined } } },
  { name: 'missing identity.summary', payload: { ...validSubmission(), identity: { ...validSubmission().identity, summary: undefined } } },
  { name: 'identity.gtinMatch wrong type', payload: { ...validSubmission(), identity: { ...validSubmission().identity, gtinMatch: 42 } } },
  { name: 'identity.gtinMatch invalid enum', payload: { ...validSubmission(), identity: { ...validSubmission().identity, gtinMatch: 'yes' } } },
  { name: 'identity.registerNameMatch invalid enum', payload: { ...validSubmission(), identity: { ...validSubmission().identity, registerNameMatch: 'probably' } } },
  { name: 'identity.summary wrong type', payload: { ...validSubmission(), identity: { ...validSubmission().identity, summary: {} } } },
  { name: 'missing evidenceSources[0].id', payload: { ...validSubmission(), evidenceSources: [{ ...validSubmission().evidenceSources[0], id: undefined }] } },
  { name: 'evidenceSources[0].url invalid', payload: { ...validSubmission(), evidenceSources: [{ ...validSubmission().evidenceSources[0], url: 'not-a-url' }] } },
  { name: 'evidenceSources[0].accessedAt invalid', payload: { ...validSubmission(), evidenceSources: [{ ...validSubmission().evidenceSources[0], accessedAt: 'yesterday' }] } },
  { name: 'evidenceSources[0].kind invalid enum', payload: { ...validSubmission(), evidenceSources: [{ ...validSubmission().evidenceSources[0], kind: 'blog' }] } },
  { name: 'evidenceItems[0].sourceIds empty', payload: { ...validSubmission(), evidenceItems: [{ ...validSubmission().evidenceItems[0], sourceIds: [] }] } },
  { name: 'evidenceItems[0].sourceIds wrong type', payload: { ...validSubmission(), evidenceItems: [{ ...validSubmission().evidenceItems[0], sourceIds: 'src-1' }] } },
  { name: 'evidenceItems[0].value wrong type', payload: { ...validSubmission(), evidenceItems: [{ ...validSubmission().evidenceItems[0], value: 42 }] } },
  { name: 'evidenceItems wrong type', payload: { ...validSubmission(), evidenceItems: 'none' } },
  { name: 'evidenceSources null', payload: { ...validSubmission(), evidenceSources: null } },
  { name: 'productProposal.fields[0].field missing', payload: { ...validSubmission(), productProposal: { fields: [{ value: 'x', evidenceIds: [] }] } } },
  { name: 'classificationProposal.productTypeId invented string (structural)', payload: { ...validSubmission(), classificationProposal: { productTypeId: 'invented', categoryPageId: null, attributes: [] } } },
  { name: 'classificationProposal.attributes[0].value wrong type', payload: { ...validSubmission(), classificationProposal: { productTypeId: null, categoryPageId: null, attributes: [{ fieldName: 'f', value: 42, evidenceIds: [] }] } } },
  { name: 'images[0].rightsStatus invalid enum', payload: { ...validSubmission(), images: [{ url: 'https://example.com/i.jpg', sourceId: 'src-1', rightsStatus: 'probably-fine', identityMatch: 'exact', evidenceIds: [] }] } },
  { name: 'images[0].identityMatch invalid enum', payload: { ...validSubmission(), images: [{ url: 'https://example.com/i.jpg', sourceId: 'src-1', rightsStatus: 'confirmed', identityMatch: 'definitely', evidenceIds: [] }] } },
  { name: 'images[0].url invalid', payload: { ...validSubmission(), images: [{ url: 'not-a-url', sourceId: 'src-1', rightsStatus: 'confirmed', identityMatch: 'exact', evidenceIds: [] }] } },
  { name: 'conflicts[0].severity invalid enum', payload: { ...validSubmission(), conflicts: [{ id: 'c1', severity: 'severe', category: 'x', summary: 's', evidenceIds: [] }] } },
  { name: 'abstention.scope invalid enum', payload: { ...validSubmission(), abstention: { scope: 'sometimes', reason: 'r', actionableNextStep: 'n', targets: [] } } },
  { name: 'abstention missing reason', payload: { ...validSubmission(), abstention: { scope: 'full', actionableNextStep: 'n', targets: [] } } },
  { name: 'confidence out of range high', payload: { ...validSubmission(), confidence: 1.5 } },
  { name: 'confidence out of range low', payload: { ...validSubmission(), confidence: -0.1 } },
  { name: 'confidence wrong type', payload: { ...validSubmission(), confidence: 'high' } },
  { name: 'schemaVersion wrong literal', payload: { ...validSubmission(), schemaVersion: 2 } },
  { name: 'extra unknown top-level key', payload: { ...validSubmission(), sneakyExtra: 'x' } },
  { name: 'empty evidence arrays', payload: { ...validSubmission(), evidenceSources: [], evidenceItems: [] } },
  { name: 'missing defaulted top-level arrays', payload: { ...validSubmission(), evidenceSources: undefined, evidenceItems: undefined, images: undefined, conflicts: undefined } },
  { name: 'missing defaulted classification attributes', payload: { ...validSubmission(), classificationProposal: { productTypeId: null, categoryPageId: null } } },
  { name: 'full abstention', payload: ABSTENTION_SUBMISSION },
  { name: 'valid bundle', payload: validSubmission() },
];

describe('TypeBox ↔ Zod schema equivalence', () => {
  it('covers the same leaf paths with the same constraints', () => {
    const zodSchema = normalizeZodJson(StructuredSubmissionSchema.toJSONSchema() as unknown);
    const zodLeaves = leafMap(zodSchema);
    const tbLeaves = leafMap(SubmissionTypeBoxSchema as unknown as JsonSchema);

    const zodPaths = [...zodLeaves.keys()].sort();
    const tbPaths = [...tbLeaves.keys()].sort();

    expect(zodPaths).toEqual(tbPaths);
  });

  it('agrees on acceptance for every corpus payload', () => {
    const mismatches: string[] = [];
    for (const { name, payload } of MUTATIONS) {
      const typeBoxOk = Check(SubmissionTypeBoxSchema, payload);
      const zodOk = StructuredSubmissionSchema.safeParse(payload).success;
      if (typeBoxOk !== zodOk) {
        mismatches.push(`${name}: typebox=${typeBoxOk} zod=${zodOk}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('agrees on leaf-level constraints (type, enum, bounds, format)', () => {
    const zodSchema = normalizeZodJson(StructuredSubmissionSchema.toJSONSchema() as unknown);
    const zodLeaves = leafMap(zodSchema);
    const tbLeaves = leafMap(SubmissionTypeBoxSchema as unknown as JsonSchema);

    const diffs: string[] = [];
    for (const [key, zodLeaf] of zodLeaves) {
      const tbLeaf = tbLeaves.get(key);
      if (!tbLeaf) {
        diffs.push(`missing in TypeBox: ${key}`);
        continue;
      }
      if (zodLeaf.format && tbLeaf.format !== zodLeaf.format) {
        diffs.push(`format mismatch at ${key}: zod=${zodLeaf.format} typebox=${tbLeaf.format}`);
      }
      if (zodLeaf.minimum !== undefined && tbLeaf.minimum !== zodLeaf.minimum) {
        diffs.push(`minimum mismatch at ${key}: zod=${zodLeaf.minimum} typebox=${tbLeaf.minimum}`);
      }
      if (zodLeaf.maximum !== undefined && tbLeaf.maximum !== zodLeaf.maximum) {
        diffs.push(`maximum mismatch at ${key}: zod=${zodLeaf.maximum} typebox=${tbLeaf.maximum}`);
      }
      if (zodLeaf.minItems !== undefined && tbLeaf.minItems !== zodLeaf.minItems) {
        diffs.push(`minItems mismatch at ${key}: zod=${zodLeaf.minItems} typebox=${tbLeaf.minItems}`);
      }
    }
    expect(diffs).toEqual([]);
  });
});
