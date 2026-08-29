import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerCodexSubscriptionIpc } from './ipc';
import { CodexSubscriptionService } from './service';
import {
  CODEX_SUBSCRIPTION_IPC_CHANNELS,
  CodexSubscriptionState,
} from './types';

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      ipcState.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel),
  },
}));

const state: CodexSubscriptionState = {
  accountLabel: null,
  lastError: null,
  models: [],
  pendingLoginId: null,
  planType: null,
  rateLimits: null,
  selectedModelId: null,
  status: 'signedOut',
};

describe('Codex subscription IPC boundary', () => {
  let getState: ReturnType<typeof vi.fn>;
  let cancelLogin: ReturnType<typeof vi.fn>;
  let selectModel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ipcState.handlers.clear();
    getState = vi.fn(async () => state);
    cancelLogin = vi.fn(async () => null);
    selectModel = vi.fn(async () => state);
    const noEvent = (): (() => void) => () => undefined;
    const service = {
      cancelLogin,
      getRateLimits: vi.fn(async () => null),
      getState,
      logout: vi.fn(async () => null),
      onLoginCompleted: noEvent,
      onRateLimitsChanged: noEvent,
      onStateChanged: noEvent,
      openDeviceVerificationPage: vi.fn(async () => null),
      refreshAccount: vi.fn(async () => state),
      refreshModels: vi.fn(async () => []),
      selectModel,
      startBrowserLogin: vi.fn(),
      startDeviceLogin: vi.fn(),
      testSelectedModel: vi.fn(),
    } as unknown as CodexSubscriptionService;
    registerCodexSubscriptionIpc(service, (id) => id === 7, vi.fn());
  });

  it('accepts an exact no-argument call only from the bound renderer', async () => {
    const handler = ipcState.handlers.get(CODEX_SUBSCRIPTION_IPC_CHANNELS.getState);
    expect(handler).toBeDefined();

    expect(await handler?.({ sender: { id: 7 } })).toMatchObject({ ok: true });
    expect(await handler?.({ sender: { id: 7 } }, 'extra')).toMatchObject({
      error: { code: 'INVALID_INPUT' },
      ok: false,
    });
    expect(await handler?.({ sender: { id: 8 } })).toMatchObject({
      error: { code: 'INVALID_INPUT' },
      ok: false,
    });
    expect(getState).toHaveBeenCalledOnce();
  });

  it('accepts one bounded opaque login id and rejects controls or extra arguments', async () => {
    const handler = ipcState.handlers.get(CODEX_SUBSCRIPTION_IPC_CHANNELS.cancelLogin);

    expect(await handler?.({ sender: { id: 7 } }, 'login.session:abc'))
      .toMatchObject({ ok: true });
    expect(await handler?.({ sender: { id: 7 } }, 'login\nmalicious'))
      .toMatchObject({ error: { code: 'INVALID_INPUT' }, ok: false });
    expect(await handler?.({ sender: { id: 7 } }, 'login.session:abc', 'extra'))
      .toMatchObject({ error: { code: 'INVALID_INPUT' }, ok: false });
    expect(cancelLogin).toHaveBeenCalledOnce();
  });

  it('requires exactly one validated model selection argument', async () => {
    const handler = ipcState.handlers.get(CODEX_SUBSCRIPTION_IPC_CHANNELS.selectModel);

    expect(await handler?.({ sender: { id: 7 } }, null)).toMatchObject({ ok: true });
    expect(await handler?.({ sender: { id: 7 } })).toMatchObject({
      error: { code: 'INVALID_INPUT' },
      ok: false,
    });
    expect(await handler?.({ sender: { id: 7 } }, 'model with prompt'))
      .toMatchObject({ error: { code: 'INVALID_INPUT' }, ok: false });
    expect(selectModel).toHaveBeenCalledOnce();
    expect(selectModel).toHaveBeenCalledWith(null);
  });
});
