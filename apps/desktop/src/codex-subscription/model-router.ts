import {
  CODEX_SUBSCRIPTION_CONFIGURATION_ID,
} from './types';
import type { ModelCompletionPort } from '../analysis-engine';
import type {
  ModelCompletionRequest,
  ModelInvocationResult,
} from '../model/types';

/**
 * Routes only the explicit virtual Codex configuration to the subscription
 * sidecar. Failures are returned unchanged and never retry through an API-key
 * provider.
 */
export class CodexSubscriptionModelRouter implements ModelCompletionPort {
  constructor(
    private readonly apiKeyModels: ModelCompletionPort,
    private readonly codexSubscription: ModelCompletionPort,
  ) {}

  complete(
    request: ModelCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ModelInvocationResult> {
    if (request.configurationId === CODEX_SUBSCRIPTION_CONFIGURATION_ID) {
      return this.codexSubscription.complete(request, signal);
    }
    return this.apiKeyModels.complete(request, signal);
  }
}
