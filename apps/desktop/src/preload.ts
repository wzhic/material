import { contextBridge, ipcRenderer } from 'electron';

import { MATERIAL_IPC_CHANNELS, MaterialApi } from './media/types';
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

contextBridge.exposeInMainWorld('materialApi', {
  media: materialApi,
  products: productApi,
  records: recordApi,
});
