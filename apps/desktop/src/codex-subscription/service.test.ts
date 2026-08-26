import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerRuntimeClosedEvent,
} from './client';
import { CodexSubscriptionError } from './errors';
import { CodexSubscriptionService } from './service';
import {
  CODEX_DEVICE_VERIFICATION_URL,
  CODEX_SUBSCRIPTION_CONFIGURATION_ID,
} from './types';
import type { ModelCompletionRequest } from '../model/types';

const LOGIN_ID = 'login.session:abc';

const deferred = <T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

class FakeClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];

  private running = true;

  readonly start = vi.fn(async () => {
    this.running = true;
  });

  readonly stop = vi.fn(() => {
    this.running = false;
  });

  private readonly notificationListeners = new Set<(
    notification: CodexAppServerNotification,
  ) => void>();

  private readonly serverRequestListeners = new Set<(
    request: CodexAppServerRequest,
  ) => void>();

  private readonly runtimeClosedListeners = new Set<(
    event: CodexAppServerRuntimeClosedEvent,
  ) => void>();

  constructor(private handler: (method: string, params: unknown) => unknown | Promise<unknown>) {}

  setHandler(handler: (method: string, params: unknown) => unknown | Promise<unknown>): void {
    this.handler = handler;
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: CodexAppServerRequest) => void): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onRuntimeClosed(
    listener: (event: CodexAppServerRuntimeClosedEvent) => void,
  ): () => void {
    this.runtimeClosedListeners.add(listener);
    return () => this.runtimeClosedListeners.delete(listener);
  }

  getGeneration(): number | null {
    return this.running ? 1 : null;
  }

  readonly invalidateGeneration = vi.fn((
    generation: number,
    code: CodexAppServerRuntimeClosedEvent['code'] = 'RUNTIME_UNAVAILABLE',
  ) => {
    if (!this.running || generation !== 1) return false;
    this.running = false;
    this.runtimeClosedListeners.forEach((listener) => listener({ code, generation }));
    return true;
  });

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    return await this.handler(method, params) as T;
  }

  async requestIfRunning<T>(
    generation: number,
    method: string,
    params?: unknown,
  ): Promise<T> {
    if (!this.running || generation !== 1) {
      throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    }
    return this.request<T>(method, params);
  }

  emit(method: string, params?: unknown, generation = 1): void {
    this.notificationListeners.forEach((listener) => listener({ generation, method, params }));
  }

  requestFromServer(method: string, params?: unknown, generation = 1): void {
    this.serverRequestListeners.forEach((listener) => listener({
      generation,
      id: 99,
      method,
      params,
    }));
  }

  close(code: CodexAppServerRuntimeClosedEvent['code'] = 'RUNTIME_UNAVAILABLE'): void {
    this.running = false;
    this.runtimeClosedListeners.forEach((listener) => listener({ code, generation: 1 }));
  }
}

const model = (id: string, modalities = ['text'], catalogId = id) => ({
  additionalSpeedTiers: [],
  availabilityNux: null,
  defaultReasoningEffort: 'low',
  defaultServiceTier: null,
  description: `${id} model`,
  displayName: id,
  hidden: false,
  id: catalogId,
  inputModalities: modalities,
  isDefault: true,
  model: id,
  modelSpecialty: null,
  multiAgentVersion: null,
  serviceTiers: [],
  supportedReasoningEfforts: [{ description: 'Fast', reasoningEffort: 'low' }],
  supportsPersonality: false,
  upgrade: null,
  upgradeInfo: null,
});

const signedInHandler = (
  rateUsedPercent = 20,
): ((method: string, params: unknown) => unknown) => (method) => {
  if (method === 'account/read') {
    return {
      account: { email: 'person@example.com', planType: 'plus', type: 'chatgpt' },
      requiresOpenaiAuth: true,
    };
  }
  if (method === 'model/list') {
    return { data: [model('gpt-5.6-sol')], nextCursor: null };
  }
  if (method === 'account/rateLimits/read') {
    return {
      rateLimitResetCredits: { availableCount: 2, credits: null },
      rateLimits: {
        credits: null,
        individualLimit: null,
        limitId: 'codex',
        limitName: null,
        planType: 'plus',
        primary: {
          resetsAt: 1_787_654_400,
          usedPercent: rateUsedPercent,
          windowDurationMins: null,
        },
        rateLimitReachedType: null,
        secondary: null,
        spendControlReached: false,
      },
      rateLimitsByLimitId: null,
    };
  }
  if (method === 'account/logout' || method === 'turn/interrupt') return {};
  throw new Error(`Unexpected method ${method}`);
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const analysisRequest = (modelId = 'gpt-5.6-sol'): ModelCompletionRequest => ({
  configurationId: CODEX_SUBSCRIPTION_CONFIGURATION_ID,
  format: 'json',
  maxTokens: 8_192,
  messages: [
    { content: 'Analyze the supplied evidence and return JSON.', role: 'system' },
    { content: '{"evidence":[{"id":"evidence-1","text":"sample"}]}', role: 'user' },
  ],
  modelId,
  outputSchema: {
    additionalProperties: false,
    properties: { result: { type: 'string' } },
    required: ['result'],
    type: 'object',
  },
  temperature: 0.2,
  thinking: 'disabled',
});

const appliedThreadStart = (
  params: unknown,
  threadId = 'thread-1',
  returnedModelId?: string,
  returnedReasoningEffort?: string,
): Record<string, unknown> => {
  const request = params as {
    approvalPolicy: string;
    config: { model_reasoning_effort: string };
    cwd: string;
    model: string;
    runtimeWorkspaceRoots: string[];
  };
  return {
    activePermissionProfile: null,
    approvalPolicy: request.approvalPolicy,
    approvalsReviewer: 'user',
    cwd: request.cwd,
    instructionSources: [],
    model: returnedModelId ?? request.model,
    modelProvider: 'openai',
    multiAgentMode: 'explicitRequestOnly',
    reasoningEffort: returnedReasoningEffort ?? request.config.model_reasoning_effort,
    runtimeWorkspaceRoots: request.runtimeWorkspaceRoots,
    sandbox: { networkAccess: false, type: 'readOnly' },
    serviceTier: null,
    thread: {
      agentNickname: null,
      agentRole: null,
      canAcceptDirectInput: true,
      cliVersion: '0.149.1',
      createdAt: 1_777_000_000,
      cwd: request.cwd,
      ephemeral: true,
      extra: null,
      forkedFromId: null,
      gitInfo: null,
      historyMode: 'legacy',
      id: threadId,
      modelProvider: 'openai',
      name: null,
      parentThreadId: null,
      path: null,
      preview: '',
      projectId: null,
      recencyAt: null,
      section: null,
      sectionEnteredAt: null,
      sessionId: 'session-1',
      source: 'appServer',
      status: { type: 'idle' },
      threadSource: null,
      turns: [],
      updatedAt: 1_777_000_000,
    },
  };
};

const agentMessage = (text: string, id = 'message-1'): Record<string, unknown> => ({
  delivery: null,
  id,
  memoryCitation: null,
  phase: 'final_answer',
  text,
  type: 'agentMessage',
});

const userMessage = (text: string, id = 'user-message-1'): Record<string, unknown> => ({
  clientId: null,
  content: [{ text, text_elements: [], type: 'text' }],
  id,
  type: 'userMessage',
});

const reasoningItem = (id = 'reasoning-1'): Record<string, unknown> => ({
  content: ['private reasoning'],
  id,
  summary: ['reasoning summary'],
  type: 'reasoning',
});

const commandExecutionItem = (id = 'command-1'): Record<string, unknown> => ({
  aggregatedOutput: null,
  command: 'pwd',
  commandActions: [],
  cwd: '/tmp',
  durationMs: null,
  exitCode: null,
  id,
  pluginId: null,
  processId: null,
  scriptPath: null,
  source: 'agent',
  status: 'inProgress',
  type: 'commandExecution',
});

const runtimeTurn = (
  id: string,
  status: 'completed' | 'failed' | 'inProgress' | 'interrupted',
  items: unknown[] = [],
  error: Record<string, unknown> | null = null,
): Record<string, unknown> => ({
  completedAt: status === 'inProgress' ? null : 1_777_000_001,
  durationMs: status === 'inProgress' ? null : 1_000,
  error,
  id,
  items,
  itemsView: 'full',
  startedAt: 1_777_000_000,
  status,
});

const turnStartResponse = (turnId: string, items: unknown[] = []): Record<string, unknown> => ({
  turn: runtimeTurn(turnId, 'inProgress', items),
});

const turnStarted = (threadId: string, turnId: string, items: unknown[] = []):
Record<string, unknown> => ({
  threadId,
  turn: runtimeTurn(turnId, 'inProgress', items),
});

const turnCompleted = (
  threadId: string,
  turnId: string,
  items: unknown[] = [],
  status: 'completed' | 'failed' | 'interrupted' = 'completed',
  error: Record<string, unknown> | null = null,
): Record<string, unknown> => ({
  threadId,
  turn: runtimeTurn(turnId, status, items, error),
});

const itemCompleted = (
  threadId: string,
  turnId: string,
  item: unknown,
): Record<string, unknown> => ({ completedAtMs: 1_777_000_001_000, item, threadId, turnId });

const itemStarted = (
  threadId: string,
  turnId: string,
  item: unknown,
): Record<string, unknown> => ({ item, startedAtMs: 1_777_000_000_000, threadId, turnId });

const rateLimitUpdate = (
  usedPercent: number,
  options: { reachedType?: string | null; spendControlReached?: boolean } = {},
): Record<string, unknown> => ({
  rateLimits: {
    credits: null,
    individualLimit: null,
    limitId: 'codex',
    limitName: null,
    planType: 'plus',
    primary: { resetsAt: null, usedPercent, windowDurationMins: null },
    rateLimitReachedType: options.reachedType ?? null,
    secondary: null,
    spendControlReached: options.spendControlReached ?? false,
  },
});

describe('Codex subscription service', () => {
  let directory: string;
  let settingsPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'material-codex-service-test-'));
    settingsPath = path.join(directory, 'settings.json');
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('reads a masked ChatGPT account and visible text models without auto-selecting', async () => {
    const client = new FakeClient((method) => {
      if (method === 'account/read') {
        return {
          account: { email: 'person@example.com', planType: 'plus', type: 'chatgpt' },
          requiresOpenaiAuth: true,
        };
      }
      if (method === 'model/list') {
        return {
          data: [
            model('gpt-text'),
            model('gpt-text-image', ['text', 'image']),
            model('gpt-image-only', ['image']),
            { ...model('gpt-hidden'), hidden: true },
          ],
          nextCursor: null,
        };
      }
      if (method === 'account/rateLimits/read') {
        return signedInHandler()('account/rateLimits/read', undefined);
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const service = new CodexSubscriptionService({
      client,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const state = await service.getState();

    expect(state).toMatchObject({
      accountLabel: 'p***@e***.com',
      planType: 'plus',
      selectedModelId: null,
      status: 'ready',
    });
    expect(state.models.map((entry) => entry.id)).toEqual(['gpt-text', 'gpt-text-image']);
    expect(state.models[1].inputModalities).toEqual(['text', 'image']);
    expect(client.calls.find((call) => call.method === 'model/list')?.params)
      .toMatchObject({ includeHidden: false });
    expect(JSON.stringify(state)).not.toContain('person@example.com');
    expect(state.rateLimits?.buckets[0]).toMatchObject({
      primary: { usedPercent: 20, windowDurationMins: null },
    });
    expect(state.rateLimits?.resetCreditsAvailable).toBe(2);
  });

  it('migrates a unique legacy slug selection while sending its provider slug and effort',
    async () => {
    await writeFile(settingsPath, JSON.stringify({ selectedModelId: 'gpt-real' }));
    const client = new FakeClient((method, params) => {
      if (method === 'model/list') {
        return { data: [model('gpt-real', ['text'], 'preset-a')], nextCursor: null };
      }
      if (method === 'thread/start') return appliedThreadStart(params);
      if (method === 'turn/start') {
        setImmediate(() => {
          const message = agentMessage('{"result":"OK"}', 'item-1');
          client.emit('item/completed', itemCompleted('thread-1', 'turn-1', message));
          client.emit('turn/completed', turnCompleted('thread-1', 'turn-1', [message]));
        });
        return turnStartResponse('turn-1');
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const state = await service.getState();
    expect(state.selectedModelId).toBe('preset-a');
    expect(state.models).toMatchObject([{
      defaultReasoningEffort: 'low',
      id: 'preset-a',
      modelSlug: 'gpt-real',
    }]);

    await expect(service.testSelectedModel()).resolves.toMatchObject({
      requestedModelId: 'gpt-real',
      returnedModelId: 'gpt-real',
    });
    const threadParams = client.calls.find((call) => call.method === 'thread/start')?.params;
    const turnParams = client.calls.find((call) => call.method === 'turn/start')?.params;
    expect(threadParams).toMatchObject({
      config: { model_reasoning_effort: 'low' },
      model: 'gpt-real',
    });
    expect(turnParams).toMatchObject({ effort: 'low', model: 'gpt-real' });
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      selectedModelId: 'preset-a',
    });
  });

  it.each([
    {
      catalog: [{ ...model('gpt-real'), model: undefined }],
      label: 'missing model slug',
    },
    {
      catalog: [model('gpt-a', ['text'], 'preset-a'), model('gpt-b', ['text'], 'preset-a')],
      label: 'catalog id collision',
    },
    {
      catalog: [{ ...model('gpt-real'), defaultReasoningEffort: '' }],
      label: 'missing default reasoning effort',
    },
    {
      catalog: [{ ...model('gpt-real'), inputModalities: undefined }],
      label: 'missing input modalities',
    },
    {
      catalog: [{ ...model('gpt-real'), inputModalities: ['text', 'video'] }],
      label: 'invalid input modality',
    },
    {
      catalog: [{ ...model('gpt-real'), description: undefined }],
      label: 'missing required description',
    },
    {
      catalog: [{ ...model('gpt-real'), serviceTiers: [{ id: 'fast', name: 'Fast' }] }],
      label: 'malformed service tier',
    },
    {
      catalog: [{ ...model('gpt-real'), supportsPersonality: undefined }],
      label: 'missing required personality capability',
    },
    {
      catalog: [{ ...model('gpt-real'), defaultReasoningEffort: 'high' }],
      label: 'default effort absent from supported efforts',
    },
    {
      catalog: [{
        ...model('gpt-real'),
        supportedReasoningEfforts: [{ description: null, reasoningEffort: 'low' }],
      }],
      label: 'malformed supported effort shape',
    },
  ])('fails closed on an invalid locked catalog: $label', async ({ catalog }) => {
    const client = new FakeClient((method, params) => {
      if (method === 'model/list') return { data: catalog, nextCursor: null };
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({
      models: [],
      status: 'unavailable',
    });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('rejects every omitted field required by the pinned Model contract', async () => {
    const requiredModelKeys = [
      'additionalSpeedTiers',
      'availabilityNux',
      'defaultReasoningEffort',
      'defaultServiceTier',
      'description',
      'displayName',
      'hidden',
      'id',
      'inputModalities',
      'isDefault',
      'model',
      'modelSpecialty',
      'multiAgentVersion',
      'serviceTiers',
      'supportedReasoningEfforts',
      'supportsPersonality',
      'upgrade',
      'upgradeInfo',
    ] as const;

    for (const key of requiredModelKeys) {
      const malformed = { ...model('gpt-real') } as Record<string, unknown>;
      delete malformed[key];
      const client = new FakeClient((method, params) => {
        if (method === 'model/list') return { data: [malformed], nextCursor: null };
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });

      await expect(service.getState(), key).resolves.toMatchObject({ status: 'unavailable' });
      expect(client.invalidateGeneration, key).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
    }
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['non-string', 42],
  ] as const)('fails closed on a %s locked catalog pagination cursor',
    async (_label, nextCursor) => {
    const client = new FakeClient((method, params) => {
      if (method === 'model/list') {
        return nextCursor === undefined
          ? { data: [model('gpt-real')] }
          : { data: [model('gpt-real')], nextCursor };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({
      models: [],
      status: 'unavailable',
    });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
    });

  it('keeps distinct preset ids that share one provider model slug', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'model/list') {
        return {
          data: [
            model('gpt-shared', ['text'], 'preset-fast'),
            {
              ...model('gpt-shared', ['text'], 'preset-deep'),
              defaultReasoningEffort: 'high',
              supportedReasoningEfforts: [{
                description: 'Deep',
                reasoningEffort: 'high',
              }],
            },
          ],
          nextCursor: null,
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const state = await service.getState();

    expect(state.models).toMatchObject([
      { defaultReasoningEffort: 'low', id: 'preset-fast', modelSlug: 'gpt-shared' },
      { defaultReasoningEffort: 'high', id: 'preset-deep', modelSlug: 'gpt-shared' },
    ]);
  });

  it('clears an ambiguous legacy slug selection instead of guessing a preset', async () => {
    await writeFile(settingsPath, JSON.stringify({ selectedModelId: 'gpt-shared' }));
    const client = new FakeClient((method, params) => {
      if (method === 'model/list') {
        return {
          data: [
            model('gpt-shared', ['text'], 'preset-fast'),
            model('gpt-shared', ['text'], 'preset-deep'),
          ],
          nextCursor: null,
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const state = await service.getState();

    expect(state.selectedModelId).toBeNull();
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      selectedModelId: null,
    });
  });

  it.each([
    {
      account: { email: null, planType: 'plus', type: 'chatgpt' },
      code: 'SECURITY_VIOLATION',
      label: 'requiresOpenaiAuth false',
      requiresOpenaiAuth: false,
    },
    {
      account: { email: null, planType: 'future-plan', type: 'chatgpt' },
      code: 'PROTOCOL_ERROR',
      label: 'unknown required plan',
      requiresOpenaiAuth: true,
    },
    {
      account: { email: 42, planType: 'plus', type: 'chatgpt' },
      code: 'PROTOCOL_ERROR',
      label: 'malformed account email',
      requiresOpenaiAuth: true,
    },
  ])('fails closed on invalid account/read contract: $label', async (fixture) => {
    const client = new FakeClient((method, params) => method === 'account/read'
      ? { account: fixture.account, requiresOpenaiAuth: fixture.requiresOpenaiAuth }
      : signedInHandler()(method, params));
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({ status: 'unavailable' });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(
      1,
      fixture.code === 'PROTOCOL_ERROR' ? 'PROTOCOL_ERROR' : 'RUNTIME_UNAVAILABLE',
    );
  });

  it('rejects a rate-limit read without the required authoritative snapshot', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') return {};
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({ status: 'unavailable' });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('accepts the sparse rate-limit response allowed by the pinned runtime schema', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        return { rateLimits: { primary: { usedPercent: 7 } } };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({
      rateLimits: {
        buckets: [{
          limitId: 'codex',
          primary: {
            resetsAt: null,
            usedPercent: 7,
            windowDurationMins: null,
          },
        }],
        resetCreditsAvailable: null,
      },
      status: 'ready',
    });
    expect(client.invalidateGeneration).not.toHaveBeenCalled();
  });

  it('accepts matching legacy and keyed authoritative rate-limit snapshots', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        const response = signedInHandler()(method, params) as Record<string, unknown>;
        return {
          ...response,
          rateLimitsByLimitId: { codex: response.rateLimits },
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({
      rateLimits: { buckets: [{ limitId: 'codex' }] },
      status: 'ready',
    });
    expect(client.invalidateGeneration).not.toHaveBeenCalled();
  });

  it('rejects conflicting legacy and keyed authoritative rate-limit snapshots', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        const response = signedInHandler()(method, params) as Record<string, unknown>;
        const rateLimits = response.rateLimits as Record<string, unknown>;
        const primary = rateLimits.primary as Record<string, unknown>;
        return {
          ...response,
          rateLimitsByLimitId: {
            codex: {
              ...rateLimits,
              primary: { ...primary, usedPercent: 99 },
            },
          },
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({ status: 'unavailable' });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('keeps the legacy snapshot when a keyed rate-limit map omits its id', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        const response = signedInHandler()(method, params) as Record<string, unknown>;
        const rateLimits = response.rateLimits as Record<string, unknown>;
        return {
          ...response,
          rateLimitsByLimitId: {
            secondary: { ...rateLimits, limitId: 'secondary' },
          },
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({
      rateLimits: {
        buckets: [
          { limitId: 'secondary' },
          { limitId: 'codex' },
        ],
      },
      status: 'ready',
    });
    expect(client.invalidateGeneration).not.toHaveBeenCalled();
  });

  it('accepts a sparse keyed bucket allowed by the pinned runtime schema', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        const response = signedInHandler()(method, params) as Record<string, unknown>;
        return {
          ...response,
          rateLimitsByLimitId: { secondary: { limitId: 'secondary' } },
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({
      rateLimits: {
        buckets: [
          { limitId: 'secondary', primary: null, secondary: null },
          { limitId: 'codex' },
        ],
      },
      status: 'ready',
    });
    expect(client.invalidateGeneration).not.toHaveBeenCalled();
  });

  it('fails closed before analysis when legacy and mapped rate windows contradict', async () => {
    let rateReadCount = 0;
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        rateReadCount += 1;
        const response = signedInHandler(rateReadCount === 1 ? 20 : 100)(
          method,
          params,
        ) as Record<string, unknown>;
        if (rateReadCount === 1) return response;
        const legacy = response.rateLimits as Record<string, unknown>;
        return {
          ...response,
          rateLimitsByLimitId: {
            codex: {
              ...legacy,
              primary: {
                ...(legacy.primary as Record<string, unknown>),
                usedPercent: 42,
              },
            },
          },
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({ error: { code: 'RESPONSE_INVALID' }, ok: false });
    expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(0);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('rejects a rate map whose key differs from the snapshot limit id', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        const response = signedInHandler()(method, params) as Record<string, unknown>;
        return {
          ...response,
          rateLimitsByLimitId: { secondary: response.rateLimits },
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({ status: 'unavailable' });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('accepts a consistent legacy and mapped rate snapshot', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        const response = signedInHandler(42)(method, params) as Record<string, unknown>;
        return {
          ...response,
          rateLimitsByLimitId: { codex: response.rateLimits },
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({
      rateLimits: { buckets: [{ limitId: 'codex', primary: { usedPercent: 42 } }] },
      status: 'ready',
    });
    expect(client.invalidateGeneration).not.toHaveBeenCalled();
  });

  it('rejects a malformed reset-credit row in the authoritative rate response', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        const response = signedInHandler()(method, params) as Record<string, unknown>;
        return {
          ...response,
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [{ id: 'missing-required-fields' }],
          },
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({ status: 'unavailable' });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('rejects a non-integer reset-credit count from the pinned response', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        const response = signedInHandler()(method, params) as Record<string, unknown>;
        return {
          ...response,
          rateLimitResetCredits: { availableCount: 2.5, credits: null },
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({ status: 'unavailable' });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('rejects a rate-window percentage outside the pinned int32 range', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        const response = signedInHandler()(method, params) as Record<string, unknown>;
        const limits = response.rateLimits as Record<string, unknown>;
        return {
          ...response,
          rateLimits: {
            ...limits,
            primary: {
              ...(limits.primary as Record<string, unknown>),
              usedPercent: 2_147_483_648,
            },
          },
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({ status: 'unavailable' });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('rejects a spend-control percentage outside the pinned int32 range', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'account/rateLimits/read') {
        const response = signedInHandler()(method, params) as Record<string, unknown>;
        const limits = response.rateLimits as Record<string, unknown>;
        return {
          ...response,
          rateLimits: {
            ...limits,
            individualLimit: {
              limit: '100',
              remainingPercent: 2_147_483_648,
              resetsAt: 1_787_654_400,
              used: '0',
            },
          },
        };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    await expect(service.getState()).resolves.toMatchObject({ status: 'unavailable' });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('does not invent a plan and fails closed when the filtered catalog exceeds 200 models',
    async () => {
      const client = new FakeClient((method) => {
        if (method === 'account/read') {
          return {
            account: { email: null, planType: 'unknown', type: 'chatgpt' },
            requiresOpenaiAuth: true,
          };
        }
        if (method === 'model/list') {
          return {
            data: Array.from({ length: 201 }, (_, index) => model(`gpt-${index}`)),
            nextCursor: null,
          };
        }
        if (method === 'account/rateLimits/read') {
          return signedInHandler()('account/rateLimits/read', undefined);
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });

      const state = await service.getState();

      expect(state).toMatchObject({ models: [], planType: null, status: 'unavailable' });
      expect(state.lastError?.code).toBe('PROTOCOL_ERROR');
      expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
    });

  it('keeps browser authUrl in main and returns only the opaque login id', async () => {
    const openExternal = vi.fn(async () => undefined);
    const client = new FakeClient((method) => {
      if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      if (method === 'account/login/start') {
        return {
          authUrl: 'https://chatgpt.com/auth?redirect_uri=http://localhost:1455/callback',
          loginId: LOGIN_ID,
          type: 'chatgpt',
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const service = new CodexSubscriptionService({ client, openExternal, settingsPath });

    const result = await service.startBrowserLogin();
    const state = await service.getState();

    expect(result).toEqual({ loginId: LOGIN_ID });
    expect(JSON.stringify(result)).not.toContain('chatgpt.com');
    expect(openExternal).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/chatgpt\.com/));
    expect(state).toMatchObject({ pendingLoginId: LOGIN_ID, status: 'loginPending' });
  });

  it('discards a browser login response that arrives after logout', async () => {
    const loginStart = deferred<unknown>();
    const openExternal = vi.fn(async () => undefined);
    const client = new FakeClient((method) => {
      if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      if (method === 'account/login/start') return loginStart.promise;
      if (method === 'account/login/cancel') return { status: 'canceled' };
      if (method === 'account/logout') return {};
      throw new Error(`Unexpected method ${method}`);
    });
    const service = new CodexSubscriptionService({ client, openExternal, settingsPath });
    const started = service.startBrowserLogin().catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'account/login/start'))
        .toHaveLength(1);
    });

    await service.logout();
    loginStart.resolve({
      authUrl: 'https://chatgpt.com/auth?redirect_uri=http://localhost:1455/callback',
      loginId: LOGIN_ID,
      type: 'chatgpt',
    });

    await expect(started).resolves.toMatchObject({ code: 'TEST_FAILED' });
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'account/login/cancel'))
        .toEqual([{ method: 'account/login/cancel', params: { loginId: LOGIN_ID } }]);
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(await service.getState()).toMatchObject({
      pendingLoginId: null,
      status: 'signedOut',
    });
  });

  it('discards a device-code login response that arrives after logout', async () => {
    const loginStart = deferred<unknown>();
    const client = new FakeClient((method) => {
      if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      if (method === 'account/login/start') return loginStart.promise;
      if (method === 'account/login/cancel') return { status: 'canceled' };
      if (method === 'account/logout') return {};
      throw new Error(`Unexpected method ${method}`);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    const started = service.startDeviceLogin().catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'account/login/start'))
        .toHaveLength(1);
    });

    await service.logout();
    loginStart.resolve({
      loginId: LOGIN_ID,
      type: 'chatgptDeviceCode',
      userCode: 'ABCD-1234',
      verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
    });

    await expect(started).resolves.toMatchObject({ code: 'TEST_FAILED' });
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'account/login/cancel'))
        .toEqual([{ method: 'account/login/cancel', params: { loginId: LOGIN_ID } }]);
    });
    expect(await service.getState()).toMatchObject({
      pendingLoginId: null,
      status: 'signedOut',
    });
  });

  it('hydrates account, catalog, and limits before exposing a successful login', async () => {
    let signedIn = false;
    const modelsReady = deferred<unknown>();
    const client = new FakeClient((method, params) => {
      if (method === 'account/read') {
        return signedIn
          ? signedInHandler()(method, params)
          : { account: null, requiresOpenaiAuth: true };
      }
      if (method === 'account/login/start') {
        return {
          loginId: LOGIN_ID,
          type: 'chatgptDeviceCode',
          userCode: 'ABCD-1234',
          verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
        };
      }
      if (method === 'model/list') return modelsReady.promise;
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    const events: unknown[] = [];
    service.onLoginCompleted((event) => events.push(event));
    await service.startDeviceLogin();
    signedIn = true;

    client.emit('account/login/completed', {
      error: null,
      loginId: LOGIN_ID,
      success: true,
    });
    await flush();

    expect(await service.getState()).toMatchObject({
      accountLabel: null,
      models: [],
      selectedModelId: null,
      status: 'loginPending',
    });
    expect(events).toEqual([]);

    modelsReady.resolve({ data: [model('gpt-5.6-sol')], nextCursor: null });
    await vi.waitFor(async () => {
      expect((await service.getState()).status).toBe('ready');
    });

    expect(await service.getState()).toMatchObject({
      accountLabel: 'p***@e***.com',
      status: 'ready',
    });
    expect(events).toEqual([expect.objectContaining({ loginId: LOGIN_ID, success: true })]);
  });

  it('rejects starting another login while a ChatGPT account is already ready', async () => {
    const client = new FakeClient(signedInHandler());
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();

    await expect(service.startDeviceLogin()).rejects.toMatchObject({
      code: 'LOGIN_IN_PROGRESS',
    });
    expect(client.calls.filter((call) => call.method === 'account/login/start')).toHaveLength(0);
  });

  it('fails closed when two different early login completions arrive', async () => {
    const loginStart = deferred<unknown>();
    const client = new FakeClient((method) => {
      if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      if (method === 'account/login/start') return loginStart.promise;
      throw new Error(`Unexpected method ${method}`);
    });
    client.invalidateGeneration.mockImplementationOnce((generation, code) => {
      loginStart.reject(new CodexSubscriptionError('RUNTIME_UNAVAILABLE'));
      client.close(code);
      return generation === 1;
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    const start = service.startDeviceLogin().catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'account/login/start'))
        .toHaveLength(1);
    });

    client.emit('account/login/completed', {
      error: null,
      loginId: LOGIN_ID,
      success: true,
    });
    client.emit('account/login/completed', {
      error: null,
      loginId: 'other.login:2',
      success: true,
    });
    await start;

    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
    expect(await service.getState()).toMatchObject({
      pendingLoginId: null,
      status: 'unavailable',
    });
  });

  it('rejects a non-official browser URL before opening it', async () => {
    const openExternal = vi.fn(async () => undefined);
    const client = new FakeClient((method) => {
      if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      if (method === 'account/login/start') {
        return {
          authUrl: 'https://chatgpt.com.attacker.invalid/login',
          loginId: LOGIN_ID,
          type: 'chatgpt',
        };
      }
      if (method === 'account/login/cancel') return { status: 'canceled' };
      throw new Error(`Unexpected method ${method}`);
    });
    const service = new CodexSubscriptionService({ client, openExternal, settingsPath });

    await expect(service.startBrowserLogin()).rejects.toMatchObject({
      code: 'SECURITY_VIOLATION',
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'RUNTIME_UNAVAILABLE');
    await expect(client.requestIfRunning(1, 'account/read'))
      .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(await service.getState()).toMatchObject({ status: 'unavailable' });
  });

  it('returns only the fixed device verification URL and opens no renderer-provided URL',
    async () => {
      const openExternal = vi.fn(async () => undefined);
      const client = new FakeClient((method) => {
        if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
        if (method === 'account/login/start') {
          return {
            loginId: LOGIN_ID,
            type: 'chatgptDeviceCode',
            userCode: 'ABCD-1234',
            verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
          };
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const service = new CodexSubscriptionService({ client, openExternal, settingsPath });

      const result = await service.startDeviceLogin();
      await service.openDeviceVerificationPage();

      expect(result).toEqual({
        loginId: LOGIN_ID,
        userCode: 'ABCD-1234',
        verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
      });
      expect(openExternal).toHaveBeenCalledOnce();
      expect(openExternal).toHaveBeenCalledWith(CODEX_DEVICE_VERIFICATION_URL);
    });

  it('settles login cancellation once and ignores a late success notification', async () => {
    const client = new FakeClient((method) => {
      if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      if (method === 'account/login/start') {
        return {
          loginId: LOGIN_ID,
          type: 'chatgptDeviceCode',
          userCode: 'ABCD-1234',
          verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
        };
      }
      if (method === 'account/login/cancel') return { status: 'canceled' };
      throw new Error(`Unexpected method ${method}`);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    const events: unknown[] = [];
    service.onLoginCompleted((event) => events.push(event));
    await service.startDeviceLogin();

    await service.cancelLogin(LOGIN_ID);
    client.emit('account/login/completed', {
      error: null,
      loginId: LOGIN_ID,
      success: true,
    });
    await flush();

    expect(events).toEqual([expect.objectContaining({
      loginId: LOGIN_ID,
      success: false,
    })]);
    expect(await service.getState()).toMatchObject({
      pendingLoginId: null,
      status: 'signedOut',
    });
  });

  it('keeps cancellation terminal once but converges to an account that won the race',
    async () => {
      let authoritativeSignedIn = false;
      const client = new FakeClient((method, params) => {
        if (method === 'account/read') {
          return authoritativeSignedIn
            ? signedInHandler()(method, params)
            : { account: null, requiresOpenaiAuth: true };
        }
        if (method === 'account/login/start') {
          return {
            loginId: LOGIN_ID,
            type: 'chatgptDeviceCode',
            userCode: 'ABCD-1234',
            verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
          };
        }
        if (method === 'account/login/cancel') {
          authoritativeSignedIn = true;
          return { status: 'canceled' };
        }
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });
      const events: unknown[] = [];
      service.onLoginCompleted((event) => events.push(event));
      await service.startDeviceLogin();

      await service.cancelLogin(LOGIN_ID);
      client.emit('account/login/completed', {
        error: null,
        loginId: LOGIN_ID,
        success: true,
      });
      await flush();

      expect(events).toEqual([expect.objectContaining({
        loginId: LOGIN_ID,
        success: false,
      })]);
      expect(await service.getState()).toMatchObject({
        accountLabel: 'p***@e***.com',
        pendingLoginId: null,
        status: 'ready',
      });
    });

  it('clears loginPending at the ten-minute deadline before a stuck cancel returns', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => undefined);
      const client = new FakeClient((method) => {
        if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
        if (method === 'account/login/start') {
          return {
            loginId: LOGIN_ID,
            type: 'chatgptDeviceCode',
            userCode: 'ABCD-1234',
            verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
          };
        }
        if (method === 'account/login/cancel') return never;
        throw new Error(`Unexpected method ${method}`);
      });
      const service = new CodexSubscriptionService({
        client,
        loginTimeoutMs: 600_000,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });
      await service.startDeviceLogin();

      await vi.advanceTimersByTimeAsync(600_000);
      await Promise.resolve();

      expect(await service.getState()).toMatchObject({
        pendingLoginId: null,
        status: 'signedOut',
      });
      expect(client.calls.filter((call) => call.method === 'account/login/cancel'))
        .toHaveLength(1);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a pending login immediately when its sidecar generation closes', async () => {
    const client = new FakeClient((method) => {
      if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      if (method === 'account/login/start') {
        return {
          loginId: LOGIN_ID,
          type: 'chatgptDeviceCode',
          userCode: 'ABCD-1234',
          verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    const events: unknown[] = [];
    service.onLoginCompleted((event) => events.push(event));
    await service.startDeviceLogin();

    client.close();
    await flush();

    expect(await service.getState()).toMatchObject({
      accountLabel: null,
      pendingLoginId: null,
      status: 'unavailable',
    });
    expect(events).toEqual([expect.objectContaining({
      error: expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }),
      loginId: LOGIN_ID,
      success: false,
    })]);
  });

  it('invalidates a stale catalog after refresh failure and blocks testing it', async () => {
    const client = new FakeClient(signedInHandler());
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();
    await service.selectModel('gpt-5.6-sol');
    client.setHandler((method, params) => {
      if (method === 'model/list') throw new CodexSubscriptionError('PROTOCOL_ERROR');
      return signedInHandler()(method, params);
    });

    await expect(service.refreshModels()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    const state = await service.getState();
    await expect(service.testSelectedModel()).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    });

    expect(state.models).toEqual([]);
    expect(state.status).toBe('unavailable');
    expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(0);
  });

  it('never continues model pagination on a replacement generation', async () => {
    const client = new FakeClient(signedInHandler());
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();
    const modelCallsBeforeRefresh = client.calls.filter(
      (call) => call.method === 'model/list',
    ).length;
    client.setHandler((method, params) => {
      if (method === 'model/list') {
        client.close();
        return { data: [model('page-one')], nextCursor: 'page-two' };
      }
      return signedInHandler()(method, params);
    });

    await expect(service.refreshModels()).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    });

    expect(client.calls.filter((call) => call.method === 'model/list'))
      .toHaveLength(modelCallsBeforeRefresh + 1);
    expect(client.start).toHaveBeenCalledOnce();
    expect(await service.getState()).toMatchObject({ status: 'unavailable' });
  });

  it('does not hydrate account models or limits across a sidecar generation', async () => {
    const client = new FakeClient(signedInHandler());
    const replacementClient = new FakeClient(signedInHandler());
    const clientFactory = vi.fn(async () => replacementClient);
    const service = new CodexSubscriptionService({
      client,
      clientFactory,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();
    const modelCallsBeforeRefresh = client.calls.filter(
      (call) => call.method === 'model/list',
    ).length;
    const limitCallsBeforeRefresh = client.calls.filter(
      (call) => call.method === 'account/rateLimits/read',
    ).length;
    client.setHandler((method, params) => {
      if (method === 'account/read') {
        client.close();
        return signedInHandler()(method, params);
      }
      return signedInHandler()(method, params);
    });

    await expect(service.refreshAccount()).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    });

    expect(client.calls.filter((call) => call.method === 'model/list'))
      .toHaveLength(modelCallsBeforeRefresh);
    expect(client.calls.filter((call) => call.method === 'account/rateLimits/read'))
      .toHaveLength(limitCallsBeforeRefresh);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(await service.getState()).toMatchObject({ status: 'unavailable' });

    await expect(service.refreshAccount()).resolves.toMatchObject({ status: 'ready' });
    expect(clientFactory).toHaveBeenCalledOnce();
  });

  it('blocks a probe while subscription limits are exhausted', async () => {
    const client = new FakeClient(signedInHandler(140));
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();
    await service.selectModel('gpt-5.6-sol');

    await expect(service.testSelectedModel()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await service.getState()).rateLimits?.buckets[0].primary?.usedPercent).toBe(100);
    expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(0);
  });

  it('maps the locked runtime usageLimitExceeded error to limited state', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return appliedThreadStart(params);
      }
      if (method === 'turn/start') {
        setImmediate(() => client.emit('error', {
          error: {
            additionalDetails: null,
            codexErrorInfo: 'usageLimitExceeded',
            message: 'redacted',
          },
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: true,
        }));
        return turnStartResponse('turn-1');
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();
    await service.selectModel('gpt-5.6-sol');

    await expect(service.testSelectedModel()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });

    expect(await service.getState()).toMatchObject({ status: 'limited' });
    expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });

  it('runs one ephemeral fail-closed thread and one turn without returning message text',
    async () => {
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') {
          return appliedThreadStart(params);
        }
        if (method === 'turn/start') {
          setImmediate(() => {
            const message = agentMessage('{"result":"OK"}', 'item-1');
            client.emit('item/completed', itemCompleted('thread-1', 'turn-1', message));
            client.emit('turn/completed', turnCompleted('thread-1', 'turn-1', [message]));
          });
          return turnStartResponse('turn-1');
        }
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        now: () => new Date('2026-08-25T00:00:00.000Z'),
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });
      await service.getState();
      await service.selectModel('gpt-5.6-sol');

      const result = await service.testSelectedModel();

      const threadCalls = client.calls.filter((call) => call.method === 'thread/start');
      const turnCalls = client.calls.filter((call) => call.method === 'turn/start');
      expect(threadCalls).toHaveLength(1);
      expect(turnCalls).toHaveLength(1);
      expect(threadCalls[0].params).toMatchObject({
        allowProviderModelFallback: false,
        approvalPolicy: 'never',
        dynamicTools: [],
        environments: [],
        ephemeral: true,
        model: 'gpt-5.6-sol',
        sandbox: 'read-only',
        selectedCapabilityRoots: [],
      });
      expect(turnCalls[0].params).toMatchObject({
        approvalPolicy: 'never',
        environments: [],
        model: 'gpt-5.6-sol',
        sandboxPolicy: { networkAccess: false, type: 'readOnly' },
      });
      expect(JSON.stringify(turnCalls[0].params)).not.toContain('"const"');
      expect(result).toEqual({
        checkedAt: '2026-08-25T00:00:00.000Z',
        durationMs: expect.any(Number),
        planType: 'plus',
        requestedModelId: 'gpt-5.6-sol',
        returnedModelId: 'gpt-5.6-sol',
      });
      expect(result).not.toHaveProperty('content');
      expect(JSON.stringify(result)).not.toContain('{"result":"OK"}');
    });

  it('accepts sparse thread, turn, item, and usage fields allowed by the pinned schema',
    async () => {
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') {
          const full = appliedThreadStart(params);
          const thread = full.thread as Record<string, unknown>;
          return {
            approvalPolicy: full.approvalPolicy,
            approvalsReviewer: full.approvalsReviewer,
            cwd: full.cwd,
            model: full.model,
            modelProvider: full.modelProvider,
            runtimeWorkspaceRoots: [],
            sandbox: { type: 'readOnly' },
            thread: {
              cliVersion: thread.cliVersion,
              createdAt: thread.createdAt,
              cwd: thread.cwd,
              ephemeral: thread.ephemeral,
              id: thread.id,
              modelProvider: thread.modelProvider,
              preview: thread.preview,
              projectId: thread.projectId,
              sessionId: thread.sessionId,
              source: 'vscode',
              status: thread.status,
              turns: thread.turns,
              updatedAt: thread.updatedAt,
            },
          };
        }
        if (method === 'turn/start') {
          setImmediate(() => {
            client.emit('thread/tokenUsage/updated', {
              threadId: 'thread-1',
              tokenUsage: {
                last: {
                  cachedInputTokens: 0,
                  inputTokens: 2,
                  outputTokens: 1,
                  reasoningOutputTokens: 0,
                  totalTokens: 3,
                },
                total: {
                  cachedInputTokens: 0,
                  inputTokens: 2,
                  outputTokens: 1,
                  reasoningOutputTokens: 0,
                  totalTokens: 3,
                },
              },
              turnId: 'turn-1',
            });
            const message = { id: 'item-1', text: '{"result":"OK"}', type: 'agentMessage' };
            client.emit('item/completed', itemCompleted('thread-1', 'turn-1', message));
            client.emit('turn/completed', {
              threadId: 'thread-1',
              turn: { id: 'turn-1', items: [message], status: 'completed' },
            });
          });
          return { turn: { id: 'turn-1', items: [], status: 'inProgress' } };
        }
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });
      await service.getState();
      await service.selectModel('gpt-5.6-sol');

      await expect(service.testSelectedModel()).resolves.toMatchObject({
        requestedModelId: 'gpt-5.6-sol',
        returnedModelId: 'gpt-5.6-sol',
      });
      expect(client.invalidateGeneration).not.toHaveBeenCalled();
    });

  it('invalidates the generation when applied thread isolation differs from the request',
    async () => {
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') {
          return {
            ...appliedThreadStart(params),
            sandbox: { networkAccess: true, type: 'readOnly' },
          };
        }
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });
      await service.getState();
      await service.selectModel('gpt-5.6-sol');

      await expect(service.testSelectedModel()).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
      });

      expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
      expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
      expect((await service.getState()).status).toBe('unavailable');
    });

  it('invalidates a thread response from a non-OpenAI subscription provider', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return { ...appliedThreadStart(params), modelProvider: 'unexpected-provider' };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();
    await service.selectModel('gpt-5.6-sol');

    await expect(service.testSelectedModel()).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('completes analysis with the explicitly requested catalog model and strict turn bounds',
    async () => {
      const requestedCatalogId = 'luna-preset';
      const requestedProviderModelId = 'gpt-5.6-luna';
      const client = new FakeClient(async (method, params) => {
        if (method === 'model/list') {
          return {
            data: [
              model('gpt-5.6-sol'),
              {
                ...model(requestedProviderModelId, ['text'], requestedCatalogId),
                defaultReasoningEffort: 'high',
                isDefault: false,
                supportedReasoningEfforts: [{
                  description: 'Deep',
                  reasoningEffort: 'high',
                }],
              },
            ],
            nextCursor: null,
          };
        }
        if (method === 'thread/start') {
          return appliedThreadStart(params, 'analysis-thread-1');
        }
        if (method === 'turn/start') {
          const turnParams = params as { cwd: string };
          expect(await readdir(turnParams.cwd)).toEqual([]);
          setImmediate(() => {
            client.emit('thread/tokenUsage/updated', {
              threadId: 'analysis-thread-1',
              tokenUsage: {
                last: {
                  cacheWriteInputTokens: 0,
                  cachedInputTokens: 5,
                  inputTokens: 20,
                  outputTokens: 4,
                  reasoningOutputTokens: 2,
                  totalTokens: 24,
                },
                modelContextWindow: 200_000,
                total: {
                  cacheWriteInputTokens: 0,
                  cachedInputTokens: 5,
                  inputTokens: 20,
                  outputTokens: 4,
                  reasoningOutputTokens: 2,
                  totalTokens: 24,
                },
              },
              turnId: 'analysis-turn-1',
            });
            const message = agentMessage('{"result":"done"}');
            client.emit('item/completed', itemCompleted(
              'analysis-thread-1',
              'analysis-turn-1',
              message,
            ));
            client.emit('turn/completed', turnCompleted(
              'analysis-thread-1',
              'analysis-turn-1',
              [message],
            ));
          });
          return turnStartResponse('analysis-turn-1');
        }
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        now: () => new Date('2026-08-26T00:00:00.000Z'),
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });
      await service.getState();
      await service.selectModel('gpt-5.6-sol');

      const result = await service.complete(analysisRequest(requestedCatalogId));

      expect(result).toMatchObject({
        audit: {
          configurationId: CODEX_SUBSCRIPTION_CONFIGURATION_ID,
          modelId: requestedCatalogId,
          providerId: 'codex-subscription',
          providerReasoningEffort: 'high',
          providerRequestedModelId: requestedProviderModelId,
          providerReturnedModelId: requestedProviderModelId,
          status: 'succeeded',
        },
        completion: {
          content: '{"result":"done"}',
          modelId: requestedCatalogId,
          providerId: 'codex-subscription',
          usage: {
            available: true,
            completionTokens: 4,
            promptCacheHitTokens: 5,
            promptCacheMissTokens: 15,
            promptTokens: 20,
            totalTokens: 24,
          },
        },
        ok: true,
      });
      expect((await service.getState()).selectedModelId).toBe('gpt-5.6-sol');
      const threadCalls = client.calls.filter((call) => call.method === 'thread/start');
      const turnCalls = client.calls.filter((call) => call.method === 'turn/start');
      expect(threadCalls).toHaveLength(1);
      expect(turnCalls).toHaveLength(1);
      expect(threadCalls[0].params).toMatchObject({
        allowProviderModelFallback: false,
        approvalPolicy: 'never',
        dynamicTools: [],
        environments: [],
        ephemeral: true,
        config: { model_reasoning_effort: 'high' },
        model: requestedProviderModelId,
        sandbox: 'read-only',
        selectedCapabilityRoots: [],
      });
      expect(turnCalls[0].params).toMatchObject({
        approvalPolicy: 'never',
        environments: [],
        effort: 'high',
        model: requestedProviderModelId,
        outputSchema: analysisRequest(requestedCatalogId).outputSchema,
        sandboxPolicy: { networkAccess: false, type: 'readOnly' },
        summary: 'none',
      });
      expect(turnCalls[0].params).not.toHaveProperty('sandboxPolicy.access');
      const threadParams = threadCalls[0].params as {
        cwd: string;
        runtimeWorkspaceRoots: string[];
      };
      const turnParams = turnCalls[0].params as {
        cwd: string;
        runtimeWorkspaceRoots: string[];
      };
      expect(threadParams.runtimeWorkspaceRoots).toEqual([threadParams.cwd]);
      expect(turnParams.cwd).toBe(threadParams.cwd);
      expect(turnParams.runtimeWorkspaceRoots).toEqual([threadParams.cwd]);
    });

  it('accepts strict user and reasoning items but exposes only the final agent message',
    async () => {
      const input = userMessage('ignored user content secret');
      const reasoning = reasoningItem();
      const finalMessage = agentMessage('{"result":"safe"}');
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') return appliedThreadStart(params);
        if (method === 'turn/start') {
          setImmediate(() => client.emit('turn/completed', turnCompleted(
            'thread-1',
            'turn-1',
            [input, reasoning, finalMessage],
          )));
          return turnStartResponse('turn-1', [input, reasoning]);
        }
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });

      const result = await service.complete(analysisRequest());

      expect(result).toMatchObject({
        completion: { content: '{"result":"safe"}' },
        ok: true,
      });
      expect(JSON.stringify(result)).not.toContain('ignored user content secret');
      expect(JSON.stringify(result)).not.toContain('private reasoning');
      expect(JSON.stringify(result)).not.toContain('reasoning summary');
    });

  it('fails the generation and interrupts a tool item returned by turn/start', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') return appliedThreadStart(params);
      if (method === 'turn/start') {
        return turnStartResponse('turn-1', [commandExecutionItem()]);
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({
      audit: { status: 'failed' },
      error: { code: 'SERVICE_UNAVAILABLE' },
      ok: false,
    });
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'RUNTIME_UNAVAILABLE');
    expect(await service.getState()).toMatchObject({
      lastError: { code: 'SECURITY_VIOLATION' },
      status: 'unavailable',
    });
  });

  it('fails the generation and interrupts a tool item in turn/started', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') return appliedThreadStart(params);
      if (method === 'turn/start') {
        setImmediate(() => client.emit('turn/started', turnStarted(
          'thread-1',
          'turn-1',
          [commandExecutionItem()],
        )));
        return turnStartResponse('turn-1');
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({
      audit: { status: 'failed' },
      error: { code: 'SERVICE_UNAVAILABLE' },
      ok: false,
    });
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'RUNTIME_UNAVAILABLE');
  });

  it('fails the generation and interrupts a tool item in turn/completed', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') return appliedThreadStart(params);
      if (method === 'turn/start') {
        setImmediate(() => client.emit('turn/completed', turnCompleted(
          'thread-1',
          'turn-1',
          [commandExecutionItem()],
        )));
        return turnStartResponse('turn-1');
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({
      error: { code: 'SERVICE_UNAVAILABLE' },
      ok: false,
    });
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'RUNTIME_UNAVAILABLE');
  });

  it('fails closed when turn/start omits a required Turn field', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') return appliedThreadStart(params);
      if (method === 'turn/start') {
        const response = turnStartResponse('turn-1');
        delete (response.turn as Record<string, unknown>).items;
        return response;
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({ error: { code: 'RESPONSE_INVALID' }, ok: false });
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('fails closed when turn/completed omits a required Turn field', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') return appliedThreadStart(params);
      if (method === 'turn/start') {
        setImmediate(() => {
          const completed = turnCompleted(
            'thread-1',
            'turn-1',
            [agentMessage('{"result":"done"}')],
          );
          delete ((completed.turn as Record<string, unknown>)).status;
          client.emit('turn/completed', completed);
        });
        return turnStartResponse('turn-1');
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({ error: { code: 'RESPONSE_INVALID' }, ok: false });
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('treats a returned user-message image as a security violation', async () => {
    const widenedInput = {
      clientId: null,
      content: [{ path: '/tmp/unexpected.png', type: 'localImage' }],
      id: 'user-message-image',
      type: 'userMessage',
    };
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') return appliedThreadStart(params);
      if (method === 'turn/start') return turnStartResponse('turn-1', [widenedInput]);
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' }, ok: false });
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'RUNTIME_UNAVAILABLE');
  });

  it('keeps the returned model unknown when authoritative preflight rejects the catalog',
    async () => {
      let catalogReads = 0;
      const client = new FakeClient((method, params) => {
        if (method === 'model/list') {
          catalogReads += 1;
          if (catalogReads > 1) {
            return { data: [model('different-preset')], nextCursor: null };
          }
        }
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });

      const result = await service.complete(analysisRequest());

      expect(result).toMatchObject({
        audit: {
          providerRequestedModelId: null,
          providerReturnedModelId: null,
          status: 'failed',
        },
        error: { code: 'MODEL_NOT_AVAILABLE' },
        ok: false,
      });
      expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(0);
    });

  it('keeps the returned model unknown when cancelled during thread creation', async () => {
    const threadStart = deferred<unknown>();
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') return threadStart.promise;
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    const controller = new AbortController();

    const invocation = service.complete(analysisRequest(), controller.signal);
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(1);
    });
    controller.abort();

    await expect(invocation).resolves.toMatchObject({
      audit: {
        providerRequestedModelId: 'gpt-5.6-sol',
        providerReturnedModelId: null,
        status: 'cancelled',
      },
      error: { code: 'CANCELLED' },
      ok: false,
    });
    const threadCall = client.calls.find((call) => call.method === 'thread/start');
    expect(threadCall).toBeDefined();
    if (!threadCall) throw new Error('thread/start was not called');
    threadStart.resolve(appliedThreadStart(threadCall.params));
    await flush();
    expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
  });

  it('keeps the returned model unknown when thread creation exceeds the deadline', async () => {
    const threadStart = deferred<unknown>();
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') return threadStart.promise;
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      analysisTimeoutMs: 15,
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({
      audit: {
        providerRequestedModelId: 'gpt-5.6-sol',
        providerReturnedModelId: null,
        status: 'timed_out',
      },
      error: { code: 'TIMEOUT' },
      ok: false,
    });
    const threadCall = client.calls.find((call) => call.method === 'thread/start');
    expect(threadCall).toBeDefined();
    if (!threadCall) throw new Error('thread/start was not called');
    threadStart.resolve(appliedThreadStart(threadCall.params));
    await flush();
    expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
  });

  it('records a valid returned model when another thread response field is rejected',
    async () => {
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') {
          return { ...appliedThreadStart(params), modelProvider: 'unexpected-provider' };
        }
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });

      const result = await service.complete(analysisRequest());

      expect(result).toMatchObject({
        audit: {
          providerRequestedModelId: 'gpt-5.6-sol',
          providerReturnedModelId: 'gpt-5.6-sol',
          status: 'failed',
        },
        error: { code: 'RESPONSE_INVALID' },
        ok: false,
      });
      expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
      expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
    });

  it.each([
    ['nested provider', 'modelProvider', 'unexpected-provider'],
    ['nested working directory', 'cwd', '/unexpected-working-directory'],
  ] as const)('rejects a mismatched %s while retaining the returned model audit',
    async (_label, field, value) => {
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') {
          const response = appliedThreadStart(params);
          return {
            ...response,
            thread: {
              ...(response.thread as Record<string, unknown>),
              [field]: value,
            },
          };
        }
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });

      const result = await service.complete(analysisRequest());

      expect(result).toMatchObject({
        audit: {
          providerRequestedModelId: 'gpt-5.6-sol',
          providerReturnedModelId: 'gpt-5.6-sol',
          status: 'failed',
        },
        error: { code: 'RESPONSE_INVALID' },
        ok: false,
      });
      expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
      expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
    });

  it.each([
    {
      label: 'non-null service tier',
      mutate: (response: Record<string, unknown>) => ({ ...response, serviceTier: 'priority' }),
    },
    {
      label: 'non-user approvals reviewer',
      mutate: (response: Record<string, unknown>) => ({
        ...response,
        approvalsReviewer: 'auto_review',
      }),
    },
    {
      label: 'materialized thread path',
      mutate: (response: Record<string, unknown>) => ({
        ...response,
        thread: { ...(response.thread as Record<string, unknown>), path: '/tmp/thread.jsonl' },
      }),
    },
    {
      label: 'preloaded thread turns',
      mutate: (response: Record<string, unknown>) => ({
        ...response,
        thread: {
          ...(response.thread as Record<string, unknown>),
          turns: [runtimeTurn('prior-turn', 'completed')],
        },
      }),
    },
    {
      label: 'forked thread',
      mutate: (response: Record<string, unknown>) => ({
        ...response,
        thread: { ...(response.thread as Record<string, unknown>), forkedFromId: 'prior-thread' },
      }),
    },
    {
      label: 'sub-agent source',
      mutate: (response: Record<string, unknown>) => ({
        ...response,
        thread: {
          ...(response.thread as Record<string, unknown>),
          source: { subAgent: 'review' },
        },
      }),
    },
    {
      label: 'mismatched custom service source',
      mutate: (response: Record<string, unknown>) => ({
        ...response,
        thread: {
          ...(response.thread as Record<string, unknown>),
          source: { custom: 'another_desktop_service' },
        },
      }),
    },
  ])('rejects a thread/start response with $label and retains its returned model',
    async ({ mutate }) => {
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') return mutate(appliedThreadStart(params));
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });

      const result = await service.complete(analysisRequest());

      expect(result).toMatchObject({
        audit: { providerReturnedModelId: 'gpt-5.6-sol', status: 'failed' },
        error: { code: 'RESPONSE_INVALID' },
        ok: false,
      });
      expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
      expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
    });

  it('keeps the returned model unknown when the thread response model is invalid', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return { ...appliedThreadStart(params), model: 'invalid model slug' };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({
      audit: {
        providerRequestedModelId: 'gpt-5.6-sol',
        providerReturnedModelId: null,
        status: 'failed',
      },
      error: { code: 'RESPONSE_INVALID' },
      ok: false,
    });
    expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('marks token usage unavailable when the runtime sends no usage notification', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return appliedThreadStart(params);
      }
      if (method === 'turn/start') {
        setImmediate(() => client.emit('turn/completed', turnCompleted(
          'thread-1',
          'turn-1',
          [agentMessage('{"result":"done"}', 'item-1')],
        )));
        return turnStartResponse('turn-1');
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({
      completion: {
        usage: {
          available: false,
          completionTokens: 0,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 0,
          promptTokens: 0,
          totalTokens: 0,
        },
      },
      ok: true,
    });
  });

  it('fails closed on internally inconsistent token telemetry', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') return appliedThreadStart(params);
      if (method === 'turn/start') {
        setImmediate(() => {
          client.emit('thread/tokenUsage/updated', {
            threadId: 'thread-1',
            tokenUsage: {
              last: {
                cacheWriteInputTokens: 0,
                cachedInputTokens: 11,
                inputTokens: 10,
                outputTokens: 4,
                reasoningOutputTokens: 5,
                totalTokens: 99,
              },
              modelContextWindow: 200_000,
              total: {
                cacheWriteInputTokens: 0,
                cachedInputTokens: 11,
                inputTokens: 10,
                outputTokens: 4,
                reasoningOutputTokens: 5,
                totalTokens: 99,
              },
            },
            turnId: 'turn-1',
          });
          client.emit('turn/completed', turnCompleted(
            'thread-1',
            'turn-1',
            [agentMessage('{"result":"done"}', 'item-1')],
          ));
        });
        return turnStartResponse('turn-1');
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({
      audit: { status: 'failed' },
      error: { code: 'RESPONSE_INVALID' },
      ok: false,
    });
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('defaults an omitted cache-write count allowed by the pinned runtime schema', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') return appliedThreadStart(params);
      if (method === 'turn/start') {
        setImmediate(() => {
          client.emit('thread/tokenUsage/updated', {
            threadId: 'thread-1',
            tokenUsage: {
              last: {
                cachedInputTokens: 2,
                inputTokens: 10,
                outputTokens: 4,
                reasoningOutputTokens: 1,
                totalTokens: 14,
              },
              modelContextWindow: 200_000,
              total: {
                cacheWriteInputTokens: 0,
                cachedInputTokens: 2,
                inputTokens: 10,
                outputTokens: 4,
                reasoningOutputTokens: 1,
                totalTokens: 14,
              },
            },
            turnId: 'turn-1',
          });
          client.emit('turn/completed', turnCompleted(
            'thread-1',
            'turn-1',
            [agentMessage('{"result":"done"}', 'item-1')],
          ));
        });
        return turnStartResponse('turn-1');
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({
      completion: {
        usage: {
          available: true,
          completionTokens: 4,
          promptCacheHitTokens: 2,
          promptCacheMissTokens: 8,
          promptTokens: 10,
          totalTokens: 14,
        },
      },
      ok: true,
    });
    expect(client.invalidateGeneration).not.toHaveBeenCalled();
  });

  it('fails closed on a model reroute and records the provider-returned model', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return appliedThreadStart(params);
      }
      if (method === 'turn/start') {
        setImmediate(() => client.emit('model/rerouted', {
          fromModel: 'gpt-5.6-sol',
          reason: 'highRiskCyberActivity',
          threadId: 'thread-1',
          toModel: 'gpt-5.6-sol-snapshot',
          turnId: 'turn-1',
        }));
        return turnStartResponse('turn-1');
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({
      audit: {
        modelId: 'gpt-5.6-sol',
        providerReturnedModelId: 'gpt-5.6-sol-snapshot',
        status: 'failed',
      },
      error: { code: 'MODEL_NOT_AVAILABLE' },
      ok: false,
    });
    expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(1);
    expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
  });

  it.each([
    {
      label: 'reroute reason',
      method: 'model/rerouted',
      params: {
        fromModel: 'gpt-5.6-sol',
        reason: 'capacity',
        threadId: 'thread-1',
        toModel: 'gpt-5.6-sol-snapshot',
        turnId: 'turn-1',
      },
    },
    {
      label: 'error retry flag',
      method: 'error',
      params: {
        error: {
          additionalDetails: null,
          codexErrorInfo: 'serverOverloaded',
          message: 'redacted',
        },
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    },
  ])('fails closed on a malformed $label notification', async ({ method, params }) => {
    const client = new FakeClient((requestMethod, requestParams) => {
      if (requestMethod === 'thread/start') return appliedThreadStart(requestParams);
      if (requestMethod === 'turn/start') {
        setImmediate(() => client.emit(method, params));
        return turnStartResponse('turn-1');
      }
      return signedInHandler()(requestMethod, requestParams);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({ error: { code: 'RESPONSE_INVALID' }, ok: false });
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('fails closed when the applied thread model differs and audits the actual model', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return appliedThreadStart(params, 'thread-1', 'gpt-5.6-sol-snapshot');
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const result = await service.complete(analysisRequest());

    expect(result).toMatchObject({
      audit: {
        modelId: 'gpt-5.6-sol',
        providerReturnedModelId: 'gpt-5.6-sol-snapshot',
        status: 'failed',
      },
      error: { code: 'RESPONSE_INVALID' },
      ok: false,
    });
    expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
  });

  it('fails closed when the applied reasoning effort differs from the catalog snapshot',
    async () => {
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') {
          return appliedThreadStart(params, 'thread-1', undefined, 'high');
        }
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });

      const result = await service.complete(analysisRequest());

      expect(result).toMatchObject({
        audit: {
          modelId: 'gpt-5.6-sol',
          providerReasoningEffort: 'low',
          providerRequestedModelId: 'gpt-5.6-sol',
          providerReturnedModelId: 'gpt-5.6-sol',
          status: 'failed',
        },
        error: { code: 'RESPONSE_INVALID' },
        ok: false,
      });
      expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
      expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
    });

  it('honors cancellation that occurs while the runtime account is initializing', async () => {
    const accountRead = deferred<unknown>();
    let accountReads = 0;
    const client = new FakeClient((method, params) => {
      if (method === 'account/read') {
        accountReads += 1;
        if (accountReads === 1) return accountRead.promise;
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    const controller = new AbortController();

    const completion = service.complete(analysisRequest(), controller.signal);
    await vi.waitFor(() => expect(accountReads).toBe(1));
    controller.abort();

    await expect(completion).resolves.toMatchObject({
      audit: { status: 'cancelled' },
      error: { code: 'CANCELLED' },
      ok: false,
    });
    expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(0);
    accountRead.resolve(signedInHandler()('account/read', undefined));
    await flush();
  });

  it('includes runtime initialization in the fixed analysis deadline', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => undefined);
      const client = new FakeClient((method, params) => {
        if (method === 'account/read') return never;
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        analysisTimeoutMs: 60_000,
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });

      const completion = service.complete(analysisRequest());
      const rejected = expect(completion).resolves.toMatchObject({
        audit: { status: 'timed_out' },
        error: { code: 'TIMEOUT' },
        ok: false,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;

      expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps the analysis deadline to TIMEOUT and interrupts one late-bound turn once',
    async () => {
      const turnStart = deferred<unknown>();
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') {
          return appliedThreadStart(params);
        }
        if (method === 'turn/start') return turnStart.promise;
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        analysisTimeoutMs: 15,
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });

      const result = await service.complete(analysisRequest());
      expect(result).toMatchObject({
        audit: { status: 'timed_out' },
        error: { code: 'TIMEOUT' },
        ok: false,
      });
      turnStart.resolve(turnStartResponse('turn-1'));
      await flush();

      expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    });

  it('interrupts a late-bound turn once after cancellation without a started notification',
    async () => {
      const turnStart = deferred<unknown>();
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') return appliedThreadStart(params);
        if (method === 'turn/start') return turnStart.promise;
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });
      const controller = new AbortController();

      const invocation = service.complete(analysisRequest(), controller.signal);
      await vi.waitFor(() => {
        expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
      });
      controller.abort();
      await expect(invocation).resolves.toMatchObject({
        audit: { status: 'cancelled' },
        error: { code: 'CANCELLED' },
        ok: false,
      });

      turnStart.resolve(turnStartResponse('turn-1'));
      await flush();
      expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    });

  it('applies the fixed deadline to authoritative preflight and never starts a thread after it',
    async () => {
      vi.useFakeTimers();
      try {
        let accountReads = 0;
        const never = new Promise<never>(() => undefined);
        const client = new FakeClient((method, params) => {
          if (method === 'account/read') {
            accountReads += 1;
            if (accountReads > 1) return never;
          }
          return signedInHandler()(method, params);
        });
        const service = new CodexSubscriptionService({
          client,
          openExternal: vi.fn(async () => undefined),
          probeTimeoutMs: 60_000,
          settingsPath,
        });
        await service.getState();
        await service.selectModel('gpt-5.6-sol');

        const probe = service.testSelectedModel();
        const rejected = expect(probe).rejects.toMatchObject({ code: 'TEST_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(60_000);
        await rejected;

        expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

  it('interrupts at most once when turn/start resolves after the probe deadline', async () => {
    const turnStart = deferred<unknown>();
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return appliedThreadStart(params);
      }
      if (method === 'turn/start') return turnStart.promise;
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      probeTimeoutMs: 15,
      settingsPath,
    });
    await service.getState();
    await service.selectModel('gpt-5.6-sol');

    const probeError = await service.testSelectedModel().catch((error: unknown) => error);
    expect(probeError).toMatchObject({ code: 'TEST_TIMEOUT' });
    turnStart.resolve(turnStartResponse('turn-1'));
    await flush();

    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
  });

  it('rejects a state mutation without cancelling the active model call', async () => {
    const turnStart = deferred<unknown>();
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return appliedThreadStart(params);
      }
      if (method === 'turn/start') return turnStart.promise;
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();
    await service.selectModel('gpt-5.6-sol');
    const probe = service.testSelectedModel();
    let settled = false;
    void probe.finally(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    });

    await expect(service.logout()).rejects.toMatchObject({ code: 'TEST_FAILED' });
    await flush();
    expect(settled).toBe(false);
    client.emit('turn/started', turnStarted('thread-1', 'turn-1'));
    turnStart.resolve(turnStartResponse('turn-1'));
    await flush();
    const message = agentMessage('{"result":"OK"}', 'item-1');
    client.emit('item/completed', itemCompleted('thread-1', 'turn-1', message));
    client.emit('turn/completed', turnCompleted('thread-1', 'turn-1', [message]));

    await expect(probe).resolves.toMatchObject({ requestedModelId: 'gpt-5.6-sol' });

    expect(client.calls.filter((call) => call.method === 'account/logout')).toHaveLength(0);
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(0);
  });

  it('fails before a thread is established and refreshes an account transition', async () => {
    const threadStart = deferred<unknown>();
    let signedIn = true;
    const client = new FakeClient((method, params) => {
      if (method === 'account/read' && !signedIn) {
        return { account: null, requiresOpenaiAuth: true };
      }
      if (method === 'thread/start') return threadStart.promise;
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();

    const invocation = service.complete(analysisRequest());
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(1);
    });
    signedIn = false;
    client.emit('account/updated', { authMode: 'chatgpt', planType: 'plus' });

    await expect(invocation).resolves.toMatchObject({
      audit: { errorCode: 'AUTHENTICATION_FAILED', status: 'failed' },
      error: { code: 'AUTHENTICATION_FAILED' },
      ok: false,
    });
    expect(await service.getState()).toMatchObject({
      accountLabel: null,
      models: [],
      rateLimits: null,
      status: 'signedOut',
    });
    expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(0);

    threadStart.resolve({
      model: 'gpt-5.6-sol',
      thread: { ephemeral: true, id: 'late-thread' },
    });
    await flush();
    expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
  });

  it('ignores delayed preflight data after an account transition refresh wins', async () => {
    const staleCatalog = deferred<unknown>();
    let catalogReads = 0;
    const client = new FakeClient((method, params) => {
      if (method === 'model/list') {
        catalogReads += 1;
        if (catalogReads === 2) return staleCatalog.promise;
        const id = catalogReads >= 3 ? 'gpt-5.6-luna' : 'gpt-5.6-sol';
        return { data: [model(id)], nextCursor: null };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();

    const invocation = service.complete(analysisRequest());
    await vi.waitFor(() => expect(catalogReads).toBe(2));
    client.emit('account/updated', { authMode: 'chatgpt', planType: 'plus' });

    await expect(invocation).resolves.toMatchObject({
      error: { code: 'AUTHENTICATION_FAILED' },
      ok: false,
    });
    expect((await service.getState()).models.map((item) => item.id))
      .toEqual(['gpt-5.6-luna']);
    expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(0);

    staleCatalog.resolve({ data: [model('stale-model')], nextCursor: null });
    await flush();
    expect((await service.getState()).models.map((item) => item.id))
      .toEqual(['gpt-5.6-luna']);
    expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(0);
  });

  it('ignores late thread notifications from a previous invocation before binding a new thread',
    async () => {
      const preflightAccount = deferred<unknown>();
      let accountReads = 0;
      const client = new FakeClient((method, params) => {
        if (method === 'account/read') {
          accountReads += 1;
          if (accountReads === 2) return preflightAccount.promise;
        }
        if (method === 'thread/start') {
          return appliedThreadStart(params, 'fresh-thread');
        }
        if (method === 'turn/start') {
          setImmediate(() => client.emit('turn/completed', turnCompleted(
            'fresh-thread',
            'fresh-turn',
            [agentMessage('{"result":"fresh"}', 'fresh-item')],
          )));
          return turnStartResponse('fresh-turn');
        }
        return signedInHandler()(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });
      await service.getState();

      const invocation = service.complete(analysisRequest());
      let settled = false;
      void invocation.finally(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(accountReads).toBe(2));

      client.emit('thread/tokenUsage/updated', {
        threadId: 'previous-thread',
        tokenUsage: {
          last: {
            cacheWriteInputTokens: 0,
            cachedInputTokens: 1,
            inputTokens: 2,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 3,
          },
          modelContextWindow: 200_000,
          total: {
            cacheWriteInputTokens: 0,
            cachedInputTokens: 1,
            inputTokens: 2,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 3,
          },
        },
        turnId: 'previous-turn',
      });
      const staleMessage = agentMessage('{"result":"stale"}', 'stale-item');
      client.emit('item/completed', itemCompleted(
        'previous-thread',
        'previous-turn',
        staleMessage,
      ));
      client.emit('model/rerouted', {
        fromModel: 'gpt-5.6-sol',
        reason: 'highRiskCyberActivity',
        threadId: 'previous-thread',
        toModel: 'stale-reroute',
        turnId: 'previous-turn',
      });
      client.emit('turn/completed', turnCompleted(
        'previous-thread',
        'previous-turn',
        [staleMessage],
      ));
      await flush();

      expect(settled).toBe(false);
      expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(0);
      expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(0);

      preflightAccount.resolve(signedInHandler()('account/read', undefined));
      await expect(invocation).resolves.toMatchObject({
        audit: {
          providerReturnedModelId: 'gpt-5.6-sol',
          status: 'succeeded',
        },
        completion: {
          content: '{"result":"fresh"}',
          usage: { available: false },
        },
        ok: true,
      });
      expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(0);
    });

  it('fails closed on fractional rate telemetry from the pinned runtime', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return appliedThreadStart(params, 'analysis-thread-1');
      }
      if (method === 'turn/start') return turnStartResponse('analysis-turn-1');
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const invocation = service.complete(analysisRequest());
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    });
    client.emit('account/rateLimits/updated', rateLimitUpdate(42.5));

    await expect(invocation).resolves.toMatchObject({
      error: { code: 'RESPONSE_INVALID' },
      ok: false,
    });
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
    expect(await service.getState()).toMatchObject({ status: 'unavailable' });
  });

  it('keeps a turn running on ordinary integer rate telemetry and refreshes after success',
    async () => {
      let rateUsedPercent = 20;
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') {
          return appliedThreadStart(params, 'analysis-thread-1');
        }
        if (method === 'turn/start') return turnStartResponse('analysis-turn-1');
        return signedInHandler(rateUsedPercent)(method, params);
      });
      const service = new CodexSubscriptionService({
        client,
        openExternal: vi.fn(async () => undefined),
        settingsPath,
      });

      const invocation = service.complete(analysisRequest());
      await vi.waitFor(() => {
        expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
      });
      rateUsedPercent = 42;
      client.emit('account/rateLimits/updated', rateLimitUpdate(42));
      await flush();
      expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(0);

      const message = agentMessage('{"result":"done"}');
      client.emit('item/completed', itemCompleted(
        'analysis-thread-1',
        'analysis-turn-1',
        message,
      ));
      client.emit('turn/completed', turnCompleted(
        'analysis-thread-1',
        'analysis-turn-1',
        [message],
      ));

      await expect(invocation).resolves.toMatchObject({ ok: true });
      expect((await service.getState()).rateLimits?.buckets[0].primary?.usedPercent)
        .toBe(42);
      expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(0);
    });

  it('interrupts once on a running rate-limit transition and refreshes limits', async () => {
    let rateUsedPercent = 20;
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return appliedThreadStart(params, 'analysis-thread-1');
      }
      if (method === 'turn/start') return turnStartResponse('analysis-turn-1');
      return signedInHandler(rateUsedPercent)(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();

    const invocation = service.complete(analysisRequest());
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    });
    rateUsedPercent = 100;
    client.emit('account/rateLimits/updated', rateLimitUpdate(100));

    await expect(invocation).resolves.toMatchObject({
      audit: { errorCode: 'RATE_LIMITED', status: 'failed' },
      error: { code: 'RATE_LIMITED' },
      ok: false,
    });
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(await service.getState()).toMatchObject({
      accountLabel: 'p***@e***.com',
      lastError: null,
      status: 'limited',
    });

    client.emit('turn/completed', turnCompleted(
      'analysis-thread-1',
      'analysis-turn-1',
      [agentMessage('{"result":"late"}', 'late-message')],
    ));
    await flush();
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect((await service.getState()).status).toBe('limited');
  });

  it('invalidates an idle generation after any unexpected server request', async () => {
    const client = new FakeClient(signedInHandler());
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await expect(service.getState()).resolves.toMatchObject({ status: 'ready' });

    client.requestFromServer('item/tool/requestUserInput', {});
    await flush();

    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'RUNTIME_UNAVAILABLE');
    expect(await service.getState()).toMatchObject({
      lastError: { code: 'SECURITY_VIOLATION' },
      models: [],
      status: 'unavailable',
    });
    await expect(client.requestIfRunning(1, 'account/read'))
      .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
  });

  it('invalidates an idle generation after a forbidden tool notification', async () => {
    const client = new FakeClient(signedInHandler());
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await expect(service.getState()).resolves.toMatchObject({ status: 'ready' });

    client.emit('item/started', itemStarted(
      'idle-thread',
      'idle-turn',
      commandExecutionItem(),
    ));
    await flush();

    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'RUNTIME_UNAVAILABLE');
    expect(await service.getState()).toMatchObject({
      lastError: { code: 'SECURITY_VIOLATION' },
      models: [],
      status: 'unavailable',
    });
  });

  it('invalidates an idle generation after a malformed account update', async () => {
    const client = new FakeClient(signedInHandler());
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await expect(service.getState()).resolves.toMatchObject({ status: 'ready' });

    client.emit('account/updated', { authMode: 42 });
    await flush();

    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'PROTOCOL_ERROR');
    expect(await service.getState()).toMatchObject({
      lastError: { code: 'PROTOCOL_ERROR' },
      status: 'unavailable',
    });
  });

  it('keeps an active security terminal and interrupts once before invalidation', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') return appliedThreadStart(params);
      if (method === 'turn/start') return turnStartResponse('turn-1');
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    const invocation = service.complete(analysisRequest());
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    });
    client.requestFromServer('item/tool/requestUserInput', {});

    await expect(invocation).resolves.toMatchObject({
      audit: {
        errorCode: 'SERVICE_UNAVAILABLE',
        providerReturnedModelId: 'gpt-5.6-sol',
        status: 'failed',
      },
      error: { code: 'SERVICE_UNAVAILABLE' },
      ok: false,
    });
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'RUNTIME_UNAVAILABLE');
    expect(await service.getState()).toMatchObject({
      lastError: { code: 'SECURITY_VIOLATION' },
      status: 'unavailable',
    });

    client.emit('turn/completed', turnCompleted(
      'thread-1',
      'turn-1',
      [agentMessage('{"result":"late"}', 'late-item')],
    ));
    await flush();
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
  });

  it('ignores a delayed server request from an older runtime generation', async () => {
    const client = new FakeClient(signedInHandler());
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();

    client.requestFromServer('item/tool/requestUserInput', {}, 0);
    await flush();

    expect(client.invalidateGeneration).not.toHaveBeenCalled();
    await expect(service.refreshModels()).resolves.toHaveLength(1);
    await expect(service.getState()).resolves.toMatchObject({ status: 'ready' });
    expect(client.getGeneration()).toBe(1);
  });

  it('ignores a forbidden notification from an older runtime generation', async () => {
    const client = new FakeClient(signedInHandler());
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();

    client.emit('item/started', itemStarted(
      'stale-thread',
      'stale-turn',
      commandExecutionItem(),
    ), 0);
    await flush();

    expect(client.invalidateGeneration).not.toHaveBeenCalled();
    await expect(service.getState()).resolves.toMatchObject({ status: 'ready' });
  });

  it('interrupts the only turn when any non-allowlisted item is observed', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return appliedThreadStart(params);
      }
      if (method === 'turn/start') {
        setImmediate(() => client.emit('item/started', {
          item: commandExecutionItem('item-1'),
          startedAtMs: 1_777_000_000_000,
          threadId: 'thread-1',
          turnId: 'turn-1',
        }));
        return turnStartResponse('turn-1');
      }
      return signedInHandler()(method, params);
    });
    const replacementClient = new FakeClient(signedInHandler());
    const clientFactory = vi.fn(async () => replacementClient);
    const service = new CodexSubscriptionService({
      client,
      clientFactory,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();
    await service.selectModel('gpt-5.6-sol');

    await expect(service.testSelectedModel()).rejects.toMatchObject({
      code: 'SECURITY_VIOLATION',
    });
    await flush();

    expect(client.calls.filter((call) => call.method === 'thread/start')).toHaveLength(1);
    expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
    expect(client.invalidateGeneration).toHaveBeenCalledWith(1, 'RUNTIME_UNAVAILABLE');
    await expect(client.requestIfRunning(1, 'account/read'))
      .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(await service.getState()).toMatchObject({ status: 'unavailable' });

    const recovered = await service.refreshAccount();

    expect(clientFactory).toHaveBeenCalledOnce();
    expect(recovered).toMatchObject({ accountLabel: 'p***@e***.com', status: 'ready' });
  });

  it('keeps logout authoritative when an older account refresh finishes later', async () => {
    let signedIn = true;
    let holdRefreshCatalog = false;
    const delayedCatalog = deferred<unknown>();
    const client = new FakeClient((method, params) => {
      if (method === 'account/logout') {
        signedIn = false;
        return {};
      }
      if (method === 'account/read' && !signedIn) {
        return { account: null, requiresOpenaiAuth: true };
      }
      if (method === 'model/list' && holdRefreshCatalog) return delayedCatalog.promise;
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();
    holdRefreshCatalog = true;
    const refreshResult = service.refreshAccount().catch((error: unknown) => error);
    await flush();

    await service.logout();
    delayedCatalog.resolve({ data: [model('gpt-5.6-sol')], nextCursor: null });
    const refreshError = await refreshResult;

    expect(refreshError).toMatchObject({ code: 'TEST_FAILED' });
    expect(await service.getState()).toMatchObject({
      accountLabel: null,
      models: [],
      selectedModelId: null,
      status: 'signedOut',
    });
  });

  it('verifies logout with account/read and clears the persisted model selection', async () => {
    let signedIn = true;
    const client = new FakeClient((method, params) => {
      if (method === 'account/logout') {
        signedIn = false;
        return {};
      }
      if (method === 'account/read' && !signedIn) {
        return { account: null, requiresOpenaiAuth: true };
      }
      return signedInHandler()(method, params);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.getState();
    await service.selectModel('gpt-5.6-sol');

    await service.logout();

    expect(client.calls.slice(-2).map((call) => call.method)).toEqual([
      'account/logout',
      'account/read',
    ]);
    expect(await service.getState()).toMatchObject({
      accountLabel: null,
      models: [],
      selectedModelId: null,
      status: 'signedOut',
    });
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      selectedModelId: null,
    });
  });

  it('does not continue logout after login cancellation closes its generation', async () => {
    const client = new FakeClient((method) => {
      if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      if (method === 'account/login/start') {
        return {
          loginId: LOGIN_ID,
          type: 'chatgptDeviceCode',
          userCode: 'ABCD-1234',
          verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const service = new CodexSubscriptionService({
      client,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });
    await service.startDeviceLogin();
    client.setHandler((method) => {
      if (method === 'account/login/cancel') {
        client.close();
        return { status: 'canceled' };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    await expect(service.logout()).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    });

    expect(client.calls.filter((call) => call.method === 'account/logout')).toHaveLength(0);
    expect(client.start).toHaveBeenCalledOnce();
    expect(await service.getState()).toMatchObject({
      pendingLoginId: null,
      status: 'unavailable',
    });
  });

  it('explicitly rebuilds an unavailable runtime before refreshing account state', async () => {
    const recoveredClient = new FakeClient((method, params) => signedInHandler()(method, params));
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('missing runtime'))
      .mockResolvedValueOnce(recoveredClient);
    const service = new CodexSubscriptionService({
      client: null,
      clientFactory: factory,
      openExternal: vi.fn(async () => undefined),
      settingsPath,
    });

    expect(await service.getState()).toMatchObject({ status: 'unavailable' });
    await expect(service.refreshAccount()).resolves.toMatchObject({ status: 'ready' });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(recoveredClient.start).toHaveBeenCalledOnce();
  });
});
