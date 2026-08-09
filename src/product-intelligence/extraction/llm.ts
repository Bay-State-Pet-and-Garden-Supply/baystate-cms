/**
 * PI-11 layer 8 (issue #29): NARROW schema-constrained LLM extraction for
 * unresolved unstructured prose ONLY.
 *
 * Rules: machine-readable data always wins; the LLM never sees raw page HTML
 * by default (only bounded field excerpts); it never overrides deterministic
 * conflicts; every contributed value is marked method 'llm_extraction' and
 * the run becomes non-deterministic (deterministicOnly: false) when this
 * layer contributes. Pure module: zod only (vitest-runnable).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/29
 */
import { z } from 'zod';



export const LlmExtractionRequestSchema = z.object({
  /** Unresolved field names ONLY (e.g. ['size', 'packCount']). */
  unresolvedFields: z.array(z.string().min(1).max(64)).min(1).max(6),
  /** Bounded page excerpts, one per unresolved field, max 300 chars each. */
  excerpts: z
    .array(
      z.object({
        field: z.string().min(1).max(64),
        text: z.string().max(300),
        sourcePath: z.string().max(200).optional(),
      }),
    )
    .max(6),
  /** Deterministic evidence already gathered — the LLM must never contradict it. */
  deterministicValues: z.record(z.string(), z.string()).default(() => ({})),
});
export type LlmExtractionRequest = z.infer<typeof LlmExtractionRequestSchema>;
const LlmExtractionResponseSchema = z.object({
  values: z
    .array(
      z.object({
        field: z.string().min(1).max(64),
        value: z.string().max(500),
        sourcePath: z.string().max(200).optional(),
        directSupport: z.boolean().default(true),
      }),
    )
    .default(() => []),
});
export type LlmExtractionResponse = z.infer<typeof LlmExtractionResponseSchema>;

export interface NarrowLlmClient {
  complete(prompt: string, schema: z.ZodType): Promise<unknown>;
}

export interface LlmExtractionAdapterOptions {
  client: NarrowLlmClient;
  model?: string;
}

export const NARROW_LLM_SYSTEM_PROMPT = `You resolve ONLY the listed unresolved product fields from the given bounded page excerpts.
Rules:
- Resolve ONLY fields present in unresolvedFields; never add other fields.
- Base each value strictly on the excerpt text for that field; never invent values.
- Never contradict the provided deterministic values; if the excerpt conflicts with them, return UNRESOLVED for that field.
- If a field cannot be resolved from its excerpt, return the value "UNRESOLVED".
- Output MUST be valid JSON matching: {"values":[{"field":"<name>","value":"<value>","sourcePath":"<optional path>","directSupport":true}]}`;

/**
 * Narrow schema-constrained LLM extraction adapter. Invoked ONLY when
 * deterministic ladder layers left a field unresolved; raw page HTML is
 * never passed; deterministic conflicts are never overridden.
 */
export class LlmExtractionAdapter {
  readonly name = 'llm_extraction';
  readonly version = '1.0.0';
  private client: NarrowLlmClient;
  readonly model: string | undefined;

  constructor(options: LlmExtractionAdapterOptions) {
    this.client = options.client;
    this.model = options.model;
  }

  async extract(request: LlmExtractionRequest): Promise<LlmExtractionResponse> {
    const prompt = narrowLlmPrompt(request);
    const raw = await this.client.complete(prompt, LlmExtractionResponseSchema);
    const parsed = LlmExtractionResponseSchema.parse(raw);
    const wanted = new Set(request.unresolvedFields);
    const values = parsed.values.filter(
      (value) =>
        wanted.has(value.field) &&
        value.value !== 'UNRESOLVED' &&
        value.value.trim().length > 0 &&
        value.directSupport !== false, // unsupported fill-ins never become evidence (review PI-11-n7)
    );
    return { values };
  }
}

/**
 * True when a local model is configured via env (BAYSTATE_CMS_PI_LLM_BASE_URL
 * + BAYSTATE_CMS_PI_LLM_MODEL). Unconfigured = layer unavailable; the ladder
 * skips it and records the reason. Tokens are env-configured, never hardcoded.
 */
export function isLlmAvailable(): boolean {
  return Boolean(process.env.BAYSTATE_CMS_PI_LLM_BASE_URL && process.env.BAYSTATE_CMS_PI_LLM_MODEL);
}

/** Build the exact prompt text (system rules + request JSON) — deterministic for tests. */
export function narrowLlmPrompt(request: LlmExtractionRequest): string {
  return `${NARROW_LLM_SYSTEM_PROMPT}

Request:
${JSON.stringify(request)}`;
}
