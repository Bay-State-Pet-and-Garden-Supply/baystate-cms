/**
 * Per-specialist policies (epic #47, issue #48).
 *
 * Specialists reuse the existing Product Intelligence governance (PI-5):
 * the same immutable `ProductIntelligencePolicySchema`, the same configId
 * snapshot self-verification, and the same reduction rules. This module only
 * binds a policy to a specialist by name and verifies the snapshot — actual
 * enforcement stays in the existing PolicyGateway and executors, so a
 * specialist can never invent its own governance.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/48
 */
import { z } from 'zod';
import { ProductIntelligencePolicySchema, type ProductIntelligencePolicy } from '../contracts';
import { verifyPolicySnapshot } from '../policy';

/** A named per-specialist policy assignment (same governance as PI runs). */
export const SpecialistPolicyAssignmentSchema = z.object({
  /** Specialist name (must resolve in the capability registry). */
  specialist: z.string().min(1).max(128),
  /** Existing immutable Product Intelligence policy schema (PI-5). */
  policy: ProductIntelligencePolicySchema,
});
export type SpecialistPolicyAssignment = z.infer<typeof SpecialistPolicyAssignmentSchema>;

/** Parse + validate a per-specialist policy assignment (throws on invalid shape). */
export function parseSpecialistPolicyAssignment(value: unknown): SpecialistPolicyAssignment {
  return SpecialistPolicyAssignmentSchema.parse(value);
}

/** Reuse PI-5 snapshot verification for a specialist policy. */
export function verifySpecialistPolicy(policy: ProductIntelligencePolicy): { valid: boolean; reason?: string } {
  return verifyPolicySnapshot(policy);
}

/** Throw when the specialist policy snapshot is not self-consistent. */
export function assertSpecialistPolicyValid(policy: ProductIntelligencePolicy): void {
  const verified = verifySpecialistPolicy(policy);
  if (!verified.valid) {
    throw new Error(`specialist policy snapshot is not self-consistent: ${verified.reason ?? 'unknown'}`);
  }
}