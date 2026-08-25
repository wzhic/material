import { contextBridge, ipcRenderer } from 'electron';

import {
  CODEX_SUBSCRIPTION_IPC_CHANNELS,
  CodexLoginCompletedEvent,
  CodexRateLimitsSummary,
  CodexSubscriptionApi,
  CodexSubscriptionState,
} from './codex-subscription/types';
import { MATERIAL_IPC_CHANNELS, MaterialApi } from './media/types';
import { MODEL_IPC_CHANNELS, ModelApi } from './model/types';
import { PRODUCT_IPC_CHANNELS, ProductApi } from './product/types';
import { RECORD_IPC_CHANNELS, RecordApi } from './record/types';

const productApi: ProductApi = {
  list: (query) => ipcRenderer.invoke(PRODUCT_IPC_CHANNELS.list, query),
  get: (id) => ipcRenderer.invoke(PRODUCT_IPC_CHANNELS.get, id),
  findDuplicates: (input, excludeId) =>
    ipcRenderer.invoke(PRODUCT_IPC_CHANNELS.findDuplicates, input, excludeId),
  create: (input) => ipcRenderer.invoke(PRODUCT_IPC_CHANNELS.create, input),
  update: (id, expectedVersion, input) =>
    ipcRenderer.invoke(PRODUCT_IPC_CHANNELS.update, id, expectedVersion, input),
  remove: (id, expectedVersion) =>
    ipcRenderer.invoke(PRODUCT_IPC_CHANNELS.remove, id, expectedVersion),
  snapshot: (id, selection) =>
    ipcRenderer.invoke(PRODUCT_IPC_CHANNELS.snapshot, id, selection),
  storageStatus: () => ipcRenderer.invoke(PRODUCT_IPC_CHANNELS.storageStatus),
  listBackups: () => ipcRenderer.invoke(PRODUCT_IPC_CHANNELS.listBackups),
  createBackup: () => ipcRenderer.invoke(PRODUCT_IPC_CHANNELS.createBackup),
  restoreBackup: (id) => ipcRenderer.invoke(PRODUCT_IPC_CHANNELS.restoreBackup, id),
};

const recordApi: RecordApi = {
  list: (query) => ipcRenderer.invoke(RECORD_IPC_CHANNELS.list, query),
  get: (id) => ipcRenderer.invoke(RECORD_IPC_CHANNELS.get, id),
  saveFeedback: (id, input) =>
    ipcRenderer.invoke(RECORD_IPC_CHANNELS.saveFeedback, id, input),
  clearFeedback: (id) => ipcRenderer.invoke(RECORD_IPC_CHANNELS.clearFeedback, id),
  remove: (id) => ipcRenderer.invoke(RECORD_IPC_CHANNELS.remove, id),
};

const materialApi: MaterialApi = {
  select: () => ipcRenderer.invoke(MATERIAL_IPC_CHANNELS.select),
  inspect: (sessionId) => ipcRenderer.invoke(MATERIAL_IPC_CHANNELS.inspect, sessionId),
  relocate: (sessionId) =>
    ipcRenderer.invoke(MATERIAL_IPC_CHANNELS.relocate, sessionId),
  release: (sessionId) => ipcRenderer.invoke(MATERIAL_IPC_CHANNELS.release, sessionId),
};

const modelApi: ModelApi = {
  getSettings: () => ipcRenderer.invoke(MODEL_IPC_CHANNELS.getSettings),
  saveConfiguration: (input) =>
    ipcRenderer.invoke(MODEL_IPC_CHANNELS.saveConfiguration, input),
  refreshModels: (id) =>
    ipcRenderer.invoke(MODEL_IPC_CHANNELS.refreshModels, id),
  testModel: (configurationId, modelId) =>
    ipcRenderer.invoke(MODEL_IPC_CHANNELS.testModel, configurationId, modelId),
  removeConfiguration: (id, expectedWriteVersion) =>
    ipcRenderer.invoke(
      MODEL_IPC_CHANNELS.removeConfiguration,
      id,
      expectedWriteVersion,
    ),
};

const subscribe = <T>(channel: string, listener: (payload: T) => void): (() => void) => {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const codexSubscriptionApi: CodexSubscriptionApi = {
  cancelLogin: (loginId) =>
    ipcRenderer.invoke(CODEX_SUBSCRIPTION_IPC_CHANNELS.cancelLogin, loginId),
  getRateLimits: () =>
    ipcRenderer.invoke(CODEX_SUBSCRIPTION_IPC_CHANNELS.getRateLimits),
  getState: () => ipcRenderer.invoke(CODEX_SUBSCRIPTION_IPC_CHANNELS.getState),
  logout: () => ipcRenderer.invoke(CODEX_SUBSCRIPTION_IPC_CHANNELS.logout),
  onLoginCompleted: (listener) => subscribe<CodexLoginCompletedEvent>(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.loginCompleted,
    listener,
  ),
  onRateLimitsChanged: (listener) => subscribe<CodexRateLimitsSummary>(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.rateLimitsChanged,
    listener,
  ),
  onStateChanged: (listener) => subscribe<CodexSubscriptionState>(
    CODEX_SUBSCRIPTION_IPC_CHANNELS.stateChanged,
    listener,
  ),
  openDeviceVerificationPage: () =>
    ipcRenderer.invoke(CODEX_SUBSCRIPTION_IPC_CHANNELS.openDeviceVerificationPage),
  refreshAccount: () =>
    ipcRenderer.invoke(CODEX_SUBSCRIPTION_IPC_CHANNELS.refreshAccount),
  refreshModels: () =>
    ipcRenderer.invoke(CODEX_SUBSCRIPTION_IPC_CHANNELS.refreshModels),
  selectModel: (modelId) =>
    ipcRenderer.invoke(CODEX_SUBSCRIPTION_IPC_CHANNELS.selectModel, modelId),
  startBrowserLogin: () =>
    ipcRenderer.invoke(CODEX_SUBSCRIPTION_IPC_CHANNELS.startBrowserLogin),
  startDeviceLogin: () =>
    ipcRenderer.invoke(CODEX_SUBSCRIPTION_IPC_CHANNELS.startDeviceLogin),
  testSelectedModel: () =>
    ipcRenderer.invoke(CODEX_SUBSCRIPTION_IPC_CHANNELS.testSelectedModel),
};

contextBridge.exposeInMainWorld('materialApi', {
  codexSubscription: codexSubscriptionApi,
  media: materialApi,
  models: modelApi,
  products: productApi,
  records: recordApi,
});
