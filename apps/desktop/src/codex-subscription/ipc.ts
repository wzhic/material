import { ipcMain } from 'electron';

import { CodexSubscriptionError, toPublicCodexError } from './errors';
import { CodexSubscriptionService } from './service';
import {
  CODEX_SUBSCRIPTION_IPC_CHANNELS,
  CodexSubscriptionResult,
} from './types';

type Publish = (channel: string, payload: unknown) => void;

const REQUEST_CHANNELS = [
  CODEX_SUBSCRIPTION_IPC_CHANNELS.cancelLogin,
  CODEX_SUBSCRIPTION_IPC_CHANNELS.getRateLimits,
  CODEX_SUBSCRIPTION_IPC_CHANNELS.getState,
  CODEX_SUBSCRIPTION_IPC_CHANNELS.logout,
  CODEX_SUBSCRIPTION_IPC_CHANNELS.openDeviceVerificationPage,
  CODEX_SUBSCRIPTION_IPC_CHANNELS.refreshAccount,
  CODEX_SUBSCRIPTION_IPC_CHANNELS.refreshModels,
  CODEX_SUBSCRIPTION_IPC_CHANNELS.selectModel,
  CODEX_SUBSCRIPTION_IPC_CHANNELS.startBrowserLogin,
  CODEX_SUBSCRIPTION_IPC_CHANNELS.startDeviceLogin,
  CODEX_SUBSCRIPTION_IPC_CHANNELS.testSelectedModel,
] as const;

const failure = (error: unknown): CodexSubscriptionResult<never> => ({
  error: toPublicCodexError(error),
  ok: false,
});

const invalidInput = (): CodexSubscriptionResult<never> =>
  failure(new CodexSubscriptionError('INVALID_INPUT'));

const safely = async <T>(operation: () => Promise<T>):
Promise<CodexSubscriptionResult<T>> => {
  try {
    return { data: await operation(), ok: true };
  } catch (error) {
    return failure(error);
  }
};

const validLoginId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

const validModelId = (value: unknown): value is string | null =>
  value === null
  || (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value));

export const registerCodexSubscriptionIpc = (
  service: CodexSubscriptionService,
  isTrustedSender: (webContentsId: number) => boolean,
  publish: Publish,
): (() => void) => {
  REQUEST_CHANNELS.forEach((channel) => ipcMain.removeHandler(channel));

  const trusted = (webContentsId: number): boolean => isTrustedSender(webContentsId);
  ipcMain.handle(CODEX_SUBSCRIPTION_IPC_CHANNELS.getState, (event, ...args: unknown[]) =>
    trusted(event.sender.id) && args.length === 0
      ? safely(() => service.getState()) : invalidInput());
  ipcMain.handle(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.startBrowserLogin,
    (event, ...args: unknown[]) => trusted(event.sender.id) && args.length === 0
      ? safely(() => service.startBrowserLogin())
      : invalidInput(),
  );
  ipcMain.handle(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.startDeviceLogin,
    (event, ...args: unknown[]) => trusted(event.sender.id) && args.length === 0
      ? safely(() => service.startDeviceLogin())
      : invalidInput(),
  );
  ipcMain.handle(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.openDeviceVerificationPage,
    (event, ...args: unknown[]) => trusted(event.sender.id) && args.length === 0
      ? safely(() => service.openDeviceVerificationPage())
      : invalidInput(),
  );
  ipcMain.handle(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.cancelLogin,
    (event, ...args: unknown[]) => trusted(event.sender.id)
      && args.length === 1
      && validLoginId(args[0])
      ? safely(() => service.cancelLogin(args[0] as string))
      : invalidInput(),
  );
  ipcMain.handle(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.refreshAccount,
    (event, ...args: unknown[]) => trusted(event.sender.id) && args.length === 0
      ? safely(() => service.refreshAccount())
      : invalidInput(),
  );
  ipcMain.handle(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.refreshModels,
    (event, ...args: unknown[]) => trusted(event.sender.id) && args.length === 0
      ? safely(() => service.refreshModels())
      : invalidInput(),
  );
  ipcMain.handle(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.selectModel,
    (event, ...args: unknown[]) => trusted(event.sender.id)
      && args.length === 1
      && validModelId(args[0])
      ? safely(() => service.selectModel(args[0] as string | null))
      : invalidInput(),
  );
  ipcMain.handle(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.getRateLimits,
    (event, ...args: unknown[]) => trusted(event.sender.id) && args.length === 0
      ? safely(() => service.getRateLimits())
      : invalidInput(),
  );
  ipcMain.handle(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.testSelectedModel,
    (event, ...args: unknown[]) => trusted(event.sender.id) && args.length === 0
      ? safely(() => service.testSelectedModel())
      : invalidInput(),
  );
  ipcMain.handle(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.logout,
    (event, ...args: unknown[]) => trusted(event.sender.id) && args.length === 0
      ? safely(() => service.logout()) : invalidInput(),
  );

  const unsubscribers = [
    service.onStateChanged((state) => {
      try {
        publish(CODEX_SUBSCRIPTION_IPC_CHANNELS.stateChanged, state);
      } catch {
        // A closing renderer must not affect the main-process service.
      }
    }),
    service.onLoginCompleted((event) => {
      try {
        publish(CODEX_SUBSCRIPTION_IPC_CHANNELS.loginCompleted, event);
      } catch {
        // A closing renderer must not affect the main-process service.
      }
    }),
    service.onRateLimitsChanged((limits) => {
      try {
        publish(CODEX_SUBSCRIPTION_IPC_CHANNELS.rateLimitsChanged, limits);
      } catch {
        // A closing renderer must not affect the main-process service.
      }
    }),
  ];

  return () => {
    REQUEST_CHANNELS.forEach((channel) => ipcMain.removeHandler(channel));
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
};
