/**
 * Specialist capability registry (epic #47, issue #48).
 *
 * The registry exposes specialist metadata and configuration. It holds the
 * capability definitions (name/version/kind/input/output contracts) plus
 * per-specialist configuration descriptors with validated values. The
 * registry intentionally does NOT route or dispatch work: `resolveSpecialist`
 * is a lookup only. Only the orchestrator selects specialists for execution
 * (the orchestrator itself lands in a later issue — this issue pins the
 * boundary so no specialist can ever be invoked without orchestration).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/48
 */
import { z } from 'zod';
import { SpecialistCapabilitySchema, type SpecialistCapability, type SpecialistKind } from './contracts';

/** Per-key configuration descriptor exposed by the registry. */
export const SpecialistConfigurationDescriptorSchema = z.object({
  key: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  /** Zod schema the configured value must satisfy (registry-validated). */
  valueSchema: z.custom<z.ZodType<unknown>>(),
  default: z.unknown().nullish(),
  description: z.string().max(1024).nullish(),
});
export type SpecialistConfigurationDescriptor = z.infer<typeof SpecialistConfigurationDescriptorSchema>;

export interface SpecialistRegistrationOptions {
  /** Per-specialist configuration descriptors (metadata exposed by the registry). */
  configuration?: SpecialistConfigurationDescriptor[];
  /** Initial configuration values keyed by descriptor key (validated on register). */
  configurationValues?: Record<string, unknown>;
}

export class SpecialistRegistry {
  private readonly byName = new Map<string, SpecialistCapability>();
  private readonly configDescriptors = new Map<string, Map<string, SpecialistConfigurationDescriptor>>();
  private readonly configValues = new Map<string, Map<string, unknown>>();

  /** Register a capability definition. Duplicate names and invalid
   *  configuration (including bad defaults) fail closed at registration. */
  register(capability: SpecialistCapability, options: SpecialistRegistrationOptions = {}): this {
    const parsed = SpecialistCapabilitySchema.parse(capability);
    if (this.byName.has(parsed.name)) {
      throw new Error(`Duplicate specialist registration: ${parsed.name}`);
    }
    this.byName.set(parsed.name, parsed);

    const descriptors = (options.configuration ?? []).map((descriptor) =>
      SpecialistConfigurationDescriptorSchema.parse(descriptor),
    );
    const descriptorMap = new Map<string, SpecialistConfigurationDescriptor>();
    for (const descriptor of descriptors) {
      if (descriptorMap.has(descriptor.key)) {
        throw new Error(`Duplicate configuration descriptor '${descriptor.key}' for specialist '${parsed.name}'`);
      }
      descriptorMap.set(descriptor.key, descriptor);
    }
    this.configDescriptors.set(parsed.name, descriptorMap);

    const values = new Map<string, unknown>();
    for (const [key, descriptor] of descriptorMap) {
      const initial = options.configurationValues?.[key] ?? descriptor.default;
      if (initial !== undefined && initial !== null) {
        this.assertConfigurationValue(parsed.name, descriptor, initial);
      }
      values.set(key, initial ?? null);
    }
    this.configValues.set(parsed.name, values);
    return this;
  }

  private assertConfigurationValue(
    specialist: string,
    descriptor: SpecialistConfigurationDescriptor,
    value: unknown,
  ): void {
    const parsed = descriptor.valueSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `invalid configuration '${specialist}.${descriptor.key}': ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Metadata exposure
  // -------------------------------------------------------------------------

  list(): SpecialistCapability[] {
    return [...this.byName.values()];
  }

  /** Lookup only — the registry never selects a specialist for execution. */
  get(name: string): SpecialistCapability | undefined {
    return this.byName.get(name);
  }

  /** Alias making the lookup-only semantics explicit (see ADR 0018). */
  resolveSpecialist(name: string): SpecialistCapability | undefined {
    return this.get(name);
  }

  names(): string[] {
    return [...this.byName.keys()].sort();
  }

  byKind(kind: SpecialistKind): SpecialistCapability[] {
    return this.list().filter((capability) => capability.kind === kind);
  }

  // -------------------------------------------------------------------------
  // Configuration exposure
  // -------------------------------------------------------------------------

  getConfigurationDescriptors(name: string): SpecialistConfigurationDescriptor[] {
    return [...(this.configDescriptors.get(name)?.values() ?? [])];
  }

  getConfiguration(name: string): Record<string, unknown> | null {
    const values = this.configValues.get(name);
    if (!values) return null;
    return Object.fromEntries(values);
  }

  setConfiguration(name: string, key: string, value: unknown): void {
    const descriptor = this.configDescriptors.get(name)?.get(key);
    if (!descriptor) {
      throw new Error(`specialist '${name}' has no configuration key '${key}'`);
    }
    this.assertConfigurationValue(name, descriptor, value);
    this.configValues.get(name)?.set(key, value);
  }

  hasConfiguration(name: string): boolean {
    return (this.configDescriptors.get(name)?.size ?? 0) > 0;
  }
}