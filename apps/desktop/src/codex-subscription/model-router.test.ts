import { describe, expect, it, vi } from 'vitest';

import { CodexSubscriptionModelRouter } from './model-router';
import { CODEX_SUBSCRIPTION_CONFIGURATION_ID } from './types';
import type { ModelCompletionPort } from '../analysis-engine';
import type {
  ModelCompletionRequest,
  ModelInvocationResult,
} from '../model/types';

const request = (configurationId: string): ModelCompletionRequest => ({
  configurationId,
  format: 'json',
  maxTokens: 1,
  messages: [
    { content: 'system', role: 'system' },
    { content: '{}', role: 'user' },
  ],
  modelId: 'gpt-test',
  outputSchema: { additionalProperties: false, properties: {}, type: 'object' },
  thinking: 'disabled',
});

const failure = (configurationId: string): ModelInvocationResult => ({
  audit: {
    adapterVersion: 'test',
    configurationId,
    configurationVersion: 1,
    durationMs: 0,
    errorCode: 'RATE_LIMITED',
    finishedAt: '2026-08-26T00:00:00.000Z',
    modelId: 'gpt-test',
    providerId: 'test',
    providerReasoningEffort: null,
    providerRequestedModelId: 'gpt-test',
    providerReturnedModelId: null,
    startedAt: '2026-08-26T00:00:00.000Z',
    status: 'failed',
  },
  error: { code: 'RATE_LIMITED', message: 'limited' },
  ok: false,
});

describe('Codex subscription model router', () => {
  it('routes only the explicit virtual configuration without fallback', async () => {
    const apiComplete = vi.fn<ModelCompletionPort['complete']>();
    const codexComplete = vi.fn<ModelCompletionPort['complete']>();
    codexComplete.mockResolvedValue(failure(CODEX_SUBSCRIPTION_CONFIGURATION_ID));
    const router = new CodexSubscriptionModelRouter(
      { complete: apiComplete },
      { complete: codexComplete },
    );

    const result = await router.complete(request(CODEX_SUBSCRIPTION_CONFIGURATION_ID));

    expect(result).toEqual(failure(CODEX_SUBSCRIPTION_CONFIGURATION_ID));
    expect(codexComplete).toHaveBeenCalledOnce();
    expect(apiComplete).not.toHaveBeenCalled();
  });

  it('preserves the existing ModelService route for stored API-key configurations', async () => {
    const apiComplete = vi.fn<ModelCompletionPort['complete']>();
    const codexComplete = vi.fn<ModelCompletionPort['complete']>();
    apiComplete.mockResolvedValue(failure('stored-config'));
    const router = new CodexSubscriptionModelRouter(
      { complete: apiComplete },
      { complete: codexComplete },
    );

    await router.complete(request('stored-config'));

    expect(apiComplete).toHaveBeenCalledOnce();
    expect(codexComplete).not.toHaveBeenCalled();
  });
});
