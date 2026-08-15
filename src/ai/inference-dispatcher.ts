/**
 * Inference Dispatcher with Resilient Failover & Policy Enforcement.
 *
 * Executes AI workloads against connection-addressed ModelTargets with
 * availability failover, data sharing policy validation, and misconfiguration tracking.
 */

import type {
  ProviderConnection,
  ModelTarget,
  AiRoutingConfig,
  ResolvedWorkloadRoute,
} from './provider-connections';
import {
  buildEffectiveRoutingConfig,
  resolveWorkloadRoute,
  isTargetPermittedByPolicy,
} from './provider-connections';
import {
  executeOpenAiChat,
  AiAvailabilityError,
  AiMisconfigurationError,
  AiPolicyDeniedError,
  type ChatMessage,
  type ChatCompletionOptions,
} from './network-transport';

export interface DispatchExecutionResult {
  content: string;
  toolCalls?: any[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  executedTarget: ModelTarget;
  wasFallback: boolean;
  warning?: string;
}

export interface DispatchWorkloadOptions extends ChatCompletionOptions {
  requiresImage?: boolean;
  routingConfig?: AiRoutingConfig;
}

/**
 * Dispatches an AI request for a specific named workload.
 */
export async function dispatchWorkloadChat(
  workload: keyof AiRoutingConfig['workloads'],
  messages: ChatMessage[],
  options: DispatchWorkloadOptions = {},
): Promise<DispatchExecutionResult> {
  const config = options.routingConfig ?? buildEffectiveRoutingConfig();
  const route: ResolvedWorkloadRoute = resolveWorkloadRoute(workload, config);

  const { primary, fallback, textDataSharing, imageDataSharing, terminalBehavior } = route;
  const requiresImage = Boolean(options.requiresImage);

  // 1. Resolve Primary Connection
  const primaryConn = config.connections[primary.connectionId];
  if (!primaryConn || !primaryConn.enabled) {
    throw new AiPolicyDeniedError(
      `Primary connection "${primary.connectionId}" for workload "${workload}" is not configured or disabled.`,
      primary.connectionId,
      primary.modelId,
    );
  }

  // 2. Validate Data Sharing Policy for Primary
  const textAllowed = isTargetPermittedByPolicy(primaryConn.trustZone, textDataSharing);
  if (!textAllowed) {
    throw new AiPolicyDeniedError(
      `Text data sharing policy "${textDataSharing}" forbids transmission to ${primaryConn.trustZone} connection "${primaryConn.label}".`,
      primary.connectionId,
      primary.modelId,
    );
  }

  if (requiresImage) {
    const imageAllowed = isTargetPermittedByPolicy(primaryConn.trustZone, imageDataSharing);
    if (!imageAllowed) {
      throw new AiPolicyDeniedError(
        `Image data sharing policy "${imageDataSharing}" forbids image transmission to ${primaryConn.trustZone} connection "${primaryConn.label}".`,
        primary.connectionId,
        primary.modelId,
      );
    }
  }

  // 3. Attempt Primary Execution
  let misconfigurationWarning: string | undefined;

  try {
    const res = await executeOpenAiChat(primaryConn, primary.modelId, messages, options);
    return {
      ...res,
      executedTarget: primary,
      wasFallback: false,
    };
  } catch (err: any) {
    // Policy denials MUST NEVER fallback (fail closed)
    if (err instanceof AiPolicyDeniedError || err?.isPolicyDenial) {
      throw err;
    }

    const isAvailability = err instanceof AiAvailabilityError || err?.isAvailabilityFailure;
    const isMisconfig = err instanceof AiMisconfigurationError || err?.isMisconfiguration;

    if (!isAvailability && !isMisconfig) {
      // Unknown non-transport error: rethrow
      throw err;
    }

    if (isMisconfig) {
      misconfigurationWarning = `Primary model "${primary.modelId}" misconfigured on "${primaryConn.label}": ${err.message}`;
      console.warn(`[InferenceDispatcher] ${misconfigurationWarning}`);
    } else {
      console.warn(
        `[InferenceDispatcher] Primary target ${primary.connectionId}:${primary.modelId} unavailable: ${err.message}. Attempting fallback...`,
      );
    }

    // 4. Evaluate Fallback Target
    if (!fallback) {
      if (terminalBehavior === 'fail_closed') {
        throw new Error(
          `Workload "${workload}" failed closed: primary target failed and no fallback is configured (${err.message}).`,
        );
      }
      throw err;
    }

    const fallbackConn = config.connections[fallback.connectionId];
    if (!fallbackConn || !fallbackConn.enabled) {
      throw new Error(
        `Fallback connection "${fallback.connectionId}" for workload "${workload}" is not configured or disabled.`,
      );
    }

    // Validate Data Sharing Policy for Fallback
    const fbTextAllowed = isTargetPermittedByPolicy(fallbackConn.trustZone, textDataSharing);
    if (!fbTextAllowed) {
      throw new AiPolicyDeniedError(
        `Cannot fallback to "${fallbackConn.label}": Text data sharing policy "${textDataSharing}" forbids transmission to ${fallbackConn.trustZone}.`,
        fallback.connectionId,
        fallback.modelId,
      );
    }

    if (requiresImage) {
      const fbImageAllowed = isTargetPermittedByPolicy(fallbackConn.trustZone, imageDataSharing);
      if (!fbImageAllowed) {
        throw new AiPolicyDeniedError(
          `Cannot fallback to "${fallbackConn.label}": Image data sharing policy "${imageDataSharing}" forbids image transmission to ${fallbackConn.trustZone}.`,
          fallback.connectionId,
          fallback.modelId,
        );
      }
    }

    // 5. Execute Fallback
    const fbRes = await executeOpenAiChat(fallbackConn, fallback.modelId, messages, options);
    return {
      ...fbRes,
      executedTarget: fallback,
      wasFallback: true,
      warning: misconfigurationWarning,
    };
  }
}
