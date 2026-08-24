import { contextBridge, ipcRenderer } from 'electron';

import { PRODUCT_IPC_CHANNELS, ProductApi } from './product/types';

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

contextBridge.exposeInMainWorld('materialApi', {
  products: productApi,
});
