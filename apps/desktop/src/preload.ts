import { contextBridge, ipcRenderer } from 'electron';

import {
  ANALYSIS_RUNTIME_IPC_CHANNELS,
  AnalysisRuntimeApi,
  AnalysisRuntimeProgress,
} from './analysis-runtime/types';
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
  confirm: (input) => ipcRenderer.invoke(RECORD_IPC_CHANNELS.confirm, input),
  list: (query) => ipcRenderer.invoke(RECORD_IPC_CHANNELS.list, query),
  get: (id) => ipcRenderer.invoke(RECORD_IPC_CHANNELS.get, id),
  exportPdf: (id) => ipcRenderer.invoke(RECORD_IPC_CHANNELS.exportPdf, id),
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
  removeConfiguration: (id, expectedWriteVersion) =>
    ipcRenderer.invoke(
      MODEL_IPC_CHANNELS.removeConfiguration,
      id,
      expectedWriteVersion,
    ),
};

const analysisApi: AnalysisRuntimeApi = {
  start: (input) => ipcRenderer.invoke(ANALYSIS_RUNTIME_IPC_CHANNELS.start, input),
  refine: (input) => ipcRenderer.invoke(ANALYSIS_RUNTIME_IPC_CHANNELS.refine, input),
  cancel: (clientRunId) =>
    ipcRenderer.invoke(ANALYSIS_RUNTIME_IPC_CHANNELS.cancel, clientRunId),
  onProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: AnalysisRuntimeProgress): void =>
      listener(progress);
    ipcRenderer.on(ANALYSIS_RUNTIME_IPC_CHANNELS.progress, handler);
    return () => ipcRenderer.removeListener(ANALYSIS_RUNTIME_IPC_CHANNELS.progress, handler);
  },
};

contextBridge.exposeInMainWorld('materialApi', {
  analysis: analysisApi,
  media: materialApi,
  models: modelApi,
  products: productApi,
  records: recordApi,
});
