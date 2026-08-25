import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import { CODEX_DEVICE_VERIFICATION_URL } from './types';

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

  emit(method: string, params?: unknown): void {
    this.notificationListeners.forEach((listener) => listener({ method, params }));
  }

  requestFromServer(method: string, params?: unknown): void {
    this.serverRequestListeners.forEach((listener) => listener({
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

const model = (id: string, modalities = ['text']) => ({
  defaultReasoningEffort: 'low',
  displayName: id,
  hidden: false,
  id,
  inputModalities: modalities,
  isDefault: true,
  supportedReasoningEfforts: [{ description: 'Fast', reasoningEffort: 'low' }],
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
      rateLimitResetCredits: { availableCount: 2 },
      rateLimits: {
        limitId: 'codex',
        planType: 'plus',
        primary: {
          resetsAt: 1_787_654_400,
          usedPercent: rateUsedPercent,
          windowDurationMins: null,
        },
        rateLimitReachedType: null,
        secondary: null,
      },
      rateLimitsByLimitId: null,
    };
  }
  if (method === 'account/logout' || method === 'turn/interrupt') return {};
  throw new Error(`Unexpected method ${method}`);
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
            model('gpt-audio-only', ['audio']),
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
    expect(state.models.map((entry) => entry.id)).toEqual(['gpt-text']);
    expect(client.calls.find((call) => call.method === 'model/list')?.params)
      .toMatchObject({ includeHidden: false });
    expect(JSON.stringify(state)).not.toContain('person@example.com');
    expect(state.rateLimits?.buckets[0]).toMatchObject({
      primary: { usedPercent: 20, windowDurationMins: null },
    });
    expect(state.rateLimits?.resetCreditsAvailable).toBe(2);
  });

  it('does not invent a plan and fails closed when the filtered catalog exceeds 200 models',
    async () => {
      const client = new FakeClient((method) => {
        if (method === 'account/read') {
          return { account: { email: null, type: 'chatgpt' }, requiresOpenaiAuth: true };
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
      if (method === 'account/read') return { account: null };
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
        if (method === 'account/read') return { account: null };
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
      if (method === 'account/read') return { account: null };
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
        return { model: 'gpt-5.6-sol', thread: { ephemeral: true, id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        setImmediate(() => client.emit('error', {
          error: { codexErrorInfo: 'usageLimitExceeded', message: 'redacted' },
          threadId: 'thread-1',
          turnId: 'turn-1',
        }));
        return { turn: { id: 'turn-1' } };
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
  });

  it('runs one ephemeral fail-closed thread and one turn without returning message text',
    async () => {
      const client = new FakeClient((method, params) => {
        if (method === 'thread/start') {
          return {
            model: 'gpt-5.6-sol-snapshot',
            thread: { ephemeral: true, id: 'thread-1' },
          };
        }
        if (method === 'turn/start') {
          setImmediate(() => {
            client.emit('item/completed', {
              item: { id: 'item-1', text: '{"result":"OK"}', type: 'agentMessage' },
              threadId: 'thread-1',
              turnId: 'turn-1',
            });
            client.emit('turn/completed', {
              threadId: 'thread-1',
              turn: {
                error: null,
                id: 'turn-1',
                items: [{ id: 'item-1', text: '{"result":"OK"}', type: 'agentMessage' }],
                status: 'completed',
              },
            });
          });
          return { turn: { id: 'turn-1' } };
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
      expect(result).toEqual({
        checkedAt: '2026-08-25T00:00:00.000Z',
        durationMs: expect.any(Number),
        planType: 'plus',
        requestedModelId: 'gpt-5.6-sol',
        returnedModelId: 'gpt-5.6-sol-snapshot',
      });
      expect(result).not.toHaveProperty('content');
      expect(JSON.stringify(result)).not.toContain('{"result":"OK"}');
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
        return { model: 'gpt-5.6-sol', thread: { ephemeral: true, id: 'thread-1' } };
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
    client.emit('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', items: [], status: 'inProgress' },
    });
    turnStart.resolve({ turn: { id: 'turn-1' } });
    await flush();

    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
  });

  it('rejects a state mutation in main and fails the active probe closed', async () => {
    const turnStart = deferred<unknown>();
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return { model: 'gpt-5.6-sol', thread: { ephemeral: true, id: 'thread-1' } };
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
    const probe = service.testSelectedModel().catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    });

    await expect(service.logout()).rejects.toMatchObject({ code: 'TEST_FAILED' });
    expect(await probe).toMatchObject({ code: 'TEST_FAILED' });
    client.emit('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', items: [], status: 'inProgress' },
    });
    turnStart.resolve({ turn: { id: 'turn-1' } });
    await flush();

    expect(client.calls.filter((call) => call.method === 'account/logout')).toHaveLength(0);
    expect(client.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
  });

  it('interrupts the only turn when any non-allowlisted item is observed', async () => {
    const client = new FakeClient((method, params) => {
      if (method === 'thread/start') {
        return { model: 'gpt-5.6-sol', thread: { ephemeral: true, id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        setImmediate(() => client.emit('item/started', {
          item: { command: 'pwd', id: 'item-1', type: 'commandExecution' },
          threadId: 'thread-1',
          turnId: 'turn-1',
        }));
        return { turn: { id: 'turn-1' } };
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
      if (method === 'account/read' && !signedIn) return { account: null };
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
      if (method === 'account/read' && !signedIn) return { account: null };
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
