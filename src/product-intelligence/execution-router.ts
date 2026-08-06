/**
 * Execution router: selects the active Product Intelligence executor from
 * runtime feature flags (PI-1).
 *
 * Selection rules (fail closed):
 * - `productIntelligence.enabled === false`      -> legacy executor
 * - enabled but `pi.enabled === false`           -> legacy executor
 * - enabled, Pi enabled, Pi executor available   -> Pi executor
 * - enabled, Pi enabled, but no Pi executor      -> legacy executor (Pi absent
 *   must never break existing onboarding)
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/18
 */
import { LEGACY_EXECUTOR_NAME, PI_EXECUTOR_NAME } from './contracts';
import type { ProductIntelligenceExecutor } from './executor';
import { getProductIntelligenceFlags } from './flags';
import type { ProductIntelligenceFlags } from './flags';

export interface ExecutorSelection {
  /** Stable executor name. */
  name: string;
  executor: ProductIntelligenceExecutor;
  /** Why this executor was selected. */
  reason: string;
}

export interface ExecutionRouter {
  /**
   * Resolve the executor for a run. Never throws for flag/availability
   * reasons — it falls back to the legacy executor instead.
   */
  resolveExecutor(): Promise<ExecutorSelection>;
  /** All executors known to the router (for comparison UIs). */
  listExecutors(): Promise<ExecutorSelection[]>;
  /** PI-10: same-configuration reruns prefer the named executor when available. */
  resolveExecutorPreferring(name: string): Promise<ExecutorSelection>;
}

export interface ExecutionRouterDeps {
  /** Pi-backed executor. Optional: onboarding works without it. */
  pi?: ProductIntelligenceExecutor | null;
  /** Deterministic fallback executor. Required. */
  legacy: ProductIntelligenceExecutor;
  /** Flag source. Defaults to the runtime effective flags. */
  flags?: () => ProductIntelligenceFlags;
}

export function createExecutionRouter(deps: ExecutionRouterDeps): ExecutionRouter {
  const flagsProvider = deps.flags ?? getProductIntelligenceFlags;

  return {
  async resolveExecutor(): Promise<ExecutorSelection> {
      const flags = flagsProvider();
      // PI-9: the kill switch returns every workspace to the normal pipeline.
      if (process.env.BAYSTATE_CMS_PI_KILL_SWITCH === 'true' || flags.killSwitch) {
        return {
          name: LEGACY_EXECUTOR_NAME,
          executor: deps.legacy,
          reason: 'kill_switch: product intelligence disabled',
        };
      }
      if (!flags.productIntelligenceEnabled) {
        return {
          name: LEGACY_EXECUTOR_NAME,
          executor: deps.legacy,
          reason: 'productIntelligence.enabled is false',
        };
      }
      if (!flags.piEnabled) {
        return {
          name: LEGACY_EXECUTOR_NAME,
          executor: deps.legacy,
          reason: 'productIntelligence.piEnabled is false',
        };
      }
      if (deps.pi) {
        return {
          name: PI_EXECUTOR_NAME,
          executor: deps.pi,
          reason: 'productIntelligence.enabled and piEnabled are true',
        };
      }
      return {
        name: LEGACY_EXECUTOR_NAME,
        executor: deps.legacy,
        reason: 'Pi executor is not installed or configured',
      };
    },
    /**
     * PI-10 same-configuration rerun: prefer the named executor when it is
     * still available under the current flags, otherwise fall back to normal
     * resolution ("where still available").
     */
    async resolveExecutorPreferring(name: string): Promise<ExecutorSelection> {
      const selection = await this.resolveExecutor();
      if (selection.name === name) return selection;
      if (name === PI_EXECUTOR_NAME && deps.pi) {
        // The Pi executor is installed; only the flags diverted us.
        return { name: PI_EXECUTOR_NAME, executor: deps.pi, reason: 'rerun: requested Pi executor' };
      }
      return selection;
    },

    async listExecutors(): Promise<ExecutorSelection[]> {
      const selections: ExecutorSelection[] = [];
      // Active executor first.
      selections.push(await this.resolveExecutor());
      if (deps.pi && selections[0].name !== PI_EXECUTOR_NAME) {
        selections.push({
          name: PI_EXECUTOR_NAME,
          executor: deps.pi,
          reason: 'available but not active under current flags',
        });
      }
      if (selections[0].name !== LEGACY_EXECUTOR_NAME) {
        selections.push({
          name: LEGACY_EXECUTOR_NAME,
          executor: deps.legacy,
          reason: 'available but not active under current flags',
        });
      }
      return selections;
    },
  };
}
