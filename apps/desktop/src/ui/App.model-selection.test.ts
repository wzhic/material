import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_SUBSCRIPTION_CONFIGURATION_DISPLAY_NAME,
  CODEX_SUBSCRIPTION_CONFIGURATION_ID,
  CodexSubscriptionState,
  CodexSubscriptionStatus,
} from '../codex-subscription/types';
import { ModelConfigurationSummary } from '../model/types';
import {
  analysisStatusAfterResult,
  codexAnalysisAvailabilityNotice,
  createAnalysisModelOptions,
  dispatchAnalysisCancellation,
  keepValidModelSelection,
  requestAnalysisCancellation,
} from './App';

const apiConfiguration = (
  overrides: Partial<ModelConfigurationSummary> = {},
): ModelConfigurationSummary => ({
  availableModels: [{ id: 'shared/model', ownedBy: 'account' }],
  baseUrl: 'https://example.com/v1',
  connectionStatus: 'ready',
  createdAt: '2026-08-26T00:00:00.000Z',
  displayName: '自有模型',
  hasCredential: true,
  id: CODEX_SUBSCRIPTION_CONFIGURATION_ID,
  lastCheckedAt: '2026-08-26T00:00:00.000Z',
  manualModelId: null,
  providerId: 'custom-openai-compatible',
  providerName: 'OpenAI 兼容 API',
  selectedModelId: 'shared/model',
  updatedAt: '2026-08-26T00:00:00.000Z',
  writeVersion: 1,
  ...overrides,
});

const codexState = (
  overrides: Partial<CodexSubscriptionState> = {},
): CodexSubscriptionState => ({
  accountLabel: 'a***@example.com',
  lastError: null,
  models: [{
    defaultReasoningEffort: 'medium',
    displayName: 'Codex Model',
    id: 'shared/model',
    inputModalities: ['text'],
    isDefault: true,
    modelSlug: 'shared-model-slug',
    supportedReasoningEfforts: [],
  }],
  pendingLoginId: null,
  planType: 'plus',
  rateLimits: null,
  selectedModelId: 'shared/model',
  status: 'ready',
  ...overrides,
});

describe('analysis model selection options', () => {
  it('combines ready API Key and ready Codex models with explicit source labels', () => {
    const options = createAnalysisModelOptions([apiConfiguration()], codexState());

    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({
      configurationId: CODEX_SUBSCRIPTION_CONFIGURATION_ID,
      label: expect.stringContaining('API Key'),
      source: 'api-key',
    });
    expect(options[1]).toMatchObject({
      configurationDisplayName: CODEX_SUBSCRIPTION_CONFIGURATION_DISPLAY_NAME,
      configurationId: CODEX_SUBSCRIPTION_CONFIGURATION_ID,
      label: expect.stringContaining('Codex 订阅 · Beta'),
      source: 'codex-subscription',
    });
    expect(options[1]?.label).toContain('shared-model-slug');
    expect(options[1]?.label).toContain('medium');
    expect(options[0]?.value).not.toBe(options[1]?.value);
  });

  it.each<CodexSubscriptionStatus>([
    'unavailable',
    'signedOut',
    'loginPending',
    'limited',
    'testing',
    'error',
  ])('does not offer Codex models while status is %s', (status) => {
    const options = createAnalysisModelOptions([], codexState({ status }));
    expect(options).toEqual([]);
  });

  it('uses the analysis-page choice independently from the test preference', () => {
    expect(createAnalysisModelOptions([], codexState({ selectedModelId: null }))).toHaveLength(1);
    expect(createAnalysisModelOptions([], codexState({ selectedModelId: 'removed-model' })))
      .toHaveLength(1);
  });

  it('keeps only unique text-capable Codex models', () => {
    const model = codexState().models[0];
    const options = createAnalysisModelOptions([], codexState({
      models: [
        model,
        { ...model, displayName: '重复目录项' },
        { ...model, id: 'image-only', inputModalities: ['image'] },
      ],
    }));

    expect(options.map((option) => option.modelId)).toEqual(['shared/model']);
  });

  it('keeps separate catalog presets that share one provider model slug', () => {
    const shared = codexState().models[0];
    const options = createAnalysisModelOptions([], codexState({
      models: [
        shared,
        {
          ...shared,
          defaultReasoningEffort: 'high',
          displayName: 'Codex Model Deep',
          id: 'shared/deep-preset',
        },
      ],
    }));

    expect(options.map((option) => option.modelId)).toEqual([
      'shared/model',
      'shared/deep-preset',
    ]);
    expect(options.every((option) => option.label.includes('shared-model-slug'))).toBe(true);
  });

  it('does not offer Codex models after a reported limit is exhausted', () => {
    expect(createAnalysisModelOptions([], codexState({
      rateLimits: {
        buckets: [{
          limitId: 'primary',
          limitName: '5 hour',
          planType: 'plus',
          primary: { resetsAt: null, usedPercent: 100, windowDurationMins: 300 },
          rateLimitReachedType: null,
          secondary: null,
        }],
        checkedAt: '2026-08-26T00:00:00.000Z',
        resetCreditsAvailable: null,
      },
    }))).toEqual([]);
  });

  it('only offers ready API Key configurations', () => {
    const options = createAnalysisModelOptions([
      apiConfiguration({ connectionStatus: 'unchecked', id: 'unchecked' }),
      apiConfiguration({ connectionStatus: 'error', id: 'error' }),
      apiConfiguration({ id: 'ready' }),
    ], null);
    expect(options).toHaveLength(1);
    expect(options[0]?.configurationId).toBe('ready');
  });

  it('clears invalid selections and never auto-selects an available option', () => {
    const options = createAnalysisModelOptions([apiConfiguration()], codexState());
    expect(keepValidModelSelection('', options)).toBe('');
    expect(keepValidModelSelection('removed', options)).toBe('');
    expect(keepValidModelSelection(options[1]?.value ?? '', options)).toBe(options[1]?.value);
  });

  it('preserves a Codex draft through transient testing but clears terminal invalidation', () => {
    const readyOptions = createAnalysisModelOptions([], codexState());
    const selection = readyOptions[0]?.value ?? '';

    expect(keepValidModelSelection(selection, [], codexState({ status: 'testing' })))
      .toBe(selection);
    expect(keepValidModelSelection(selection, [], codexState({ status: 'limited' }))).toBe('');
    expect(keepValidModelSelection(selection, [], codexState({ status: 'error' }))).toBe('');
  });

  it.each<[CodexSubscriptionStatus, string]>([
    ['unavailable', '运行组件当前不可用'],
    ['signedOut', '尚未连接 ChatGPT 订阅'],
    ['loginPending', '正在等待登录完成'],
    ['limited', '额度当前受限'],
    ['error', '订阅状态异常'],
  ])('explains why Codex is unavailable while status is %s', (status, expected) => {
    const apiOptions = createAnalysisModelOptions([apiConfiguration()], codexState({ status }));
    const notice = codexAnalysisAvailabilityNotice(codexState({ status }), true);

    expect(apiOptions).toHaveLength(1);
    expect(apiOptions[0]?.source).toBe('api-key');
    expect(notice).toContain(expected);
  });

  it('explains empty and transient Codex catalogs without exposing login secrets', () => {
    const emptyCatalogState = codexState({ models: [] });
    const notices = [
      codexAnalysisAvailabilityNotice(emptyCatalogState, true),
      codexAnalysisAvailabilityNotice(codexState({ status: 'testing' }), true),
      codexAnalysisAvailabilityNotice(null, false),
    ];

    expect(createAnalysisModelOptions([apiConfiguration()], emptyCatalogState))
      .toHaveLength(1);
    expect(notices[0]).toContain('没有可用于文本分析的模型');
    expect(notices[1]).toContain('已有 Codex 草稿选择会暂时保留');
    expect(notices[2]).toContain('正在读取 Codex 订阅状态');
    expect(notices.join(' ')).not.toMatch(/https?:|token|user.?code|auth.*url/i);
  });
});

describe('analysis cancellation UI state', () => {
  it('enters cancelling once and rejects duplicate cancellation requests', () => {
    const first = requestAnalysisCancellation('running');
    const duplicate = requestAnalysisCancellation(first.status);

    expect(first).toEqual({ shouldCancel: true, status: 'cancelling' });
    expect(duplicate).toEqual({ shouldCancel: false, status: 'cancelling' });
  });

  it('settles a cancelling run from the underlying success, cancellation, or failure', () => {
    expect(analysisStatusAfterResult({ ok: true })).toBe('succeeded');
    expect(analysisStatusAfterResult({
      error: { code: 'CANCELLED' },
      ok: false,
    })).toBe('cancelled');
    expect(analysisStatusAfterResult({
      error: { code: 'MODEL_FAILED' },
      ok: false,
    })).toBe('failed');
  });

  it('claims a run before an asynchronous status updater and calls cancel exactly once', () => {
    const requestedRunIds = new Set<string>();
    const delayedStatusUpdates: Array<() => void> = [];
    const observedStatuses: string[] = [];
    const cancel = vi.fn();
    const staleRun = { clientRunId: 'run-1', status: 'running' as const };
    const dispatchWithDeferredUpdater = (): boolean => dispatchAnalysisCancellation(
      staleRun,
      requestedRunIds,
      (status) => delayedStatusUpdates.push(() => observedStatuses.push(status)),
      cancel,
    );

    expect(dispatchWithDeferredUpdater()).toBe(true);
    expect(dispatchWithDeferredUpdater()).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('run-1');
    expect(observedStatuses).toEqual([]);

    delayedStatusUpdates.forEach((apply) => apply());
    expect(observedStatuses).toEqual(['cancelling']);
  });
});
