import { ipcMain } from 'electron';

import { ProductValidationError } from './domain';
import { ProductRepository, ProductRepositoryError } from './repository';
import {
  PRODUCT_IPC_CHANNELS,
  ProductApiErrorCode,
  ProductApiResult,
  ProductContextSelection,
  ProductInput,
  ProductListQuery,
} from './types';

const failure = (code: ProductApiErrorCode, message: string): ProductApiResult<never> => ({
  ok: false,
  error: { code, message },
});

const safely = <T>(operation: () => T): ProductApiResult<T> => {
  try {
    return { ok: true, data: operation() };
  } catch (error) {
    if (error instanceof ProductRepositoryError) {
      return failure(error.code, error.message);
    }
    if (error instanceof ProductValidationError) {
      return failure('INVALID_INPUT', error.message);
    }
    return failure('UNKNOWN', '产品库操作失败，请重试');
  }
};

const safelyAsync = async <T>(operation: () => Promise<T>): Promise<ProductApiResult<T>> => {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    if (error instanceof ProductRepositoryError) {
      return failure(error.code, error.message);
    }
    if (error instanceof ProductValidationError) {
      return failure('INVALID_INPUT', error.message);
    }
    return failure('UNKNOWN', '产品库操作失败，请重试');
  }
};

const clearProductHandlers = (): void => {
  Object.values(PRODUCT_IPC_CHANNELS).forEach((channel) => ipcMain.removeHandler(channel));
};

export const registerProductIpc = (repository: ProductRepository): void => {
  clearProductHandlers();

  ipcMain.handle(PRODUCT_IPC_CHANNELS.list, (_event, query?: ProductListQuery) =>
    safely(() => repository.list(query)),
  );
  ipcMain.handle(PRODUCT_IPC_CHANNELS.get, (_event, id: string) =>
    safely(() => repository.get(id)),
  );
  ipcMain.handle(
    PRODUCT_IPC_CHANNELS.findDuplicates,
    (_event, input: ProductInput, excludeId?: string) =>
      safely(() => repository.findDuplicates(input, excludeId)),
  );
  ipcMain.handle(PRODUCT_IPC_CHANNELS.create, (_event, input: ProductInput) =>
    safely(() => repository.create(input)),
  );
  ipcMain.handle(
    PRODUCT_IPC_CHANNELS.update,
    (_event, id: string, expectedVersion: number, input: ProductInput) =>
      safely(() => repository.update(id, expectedVersion, input)),
  );
  ipcMain.handle(
    PRODUCT_IPC_CHANNELS.remove,
    (_event, id: string, expectedVersion: number) =>
      safely(() => {
        repository.remove(id, expectedVersion);
        return null;
      }),
  );
  ipcMain.handle(
    PRODUCT_IPC_CHANNELS.snapshot,
    (_event, id: string, selection?: ProductContextSelection) =>
      safely(() => repository.snapshot(id, selection)),
  );
  ipcMain.handle(PRODUCT_IPC_CHANNELS.storageStatus, () =>
    safely(() => repository.storageStatus()),
  );
  ipcMain.handle(PRODUCT_IPC_CHANNELS.listBackups, () =>
    safely(() => repository.listBackups()),
  );
  ipcMain.handle(PRODUCT_IPC_CHANNELS.createBackup, () =>
    safelyAsync(() => repository.createBackup()),
  );
  ipcMain.handle(PRODUCT_IPC_CHANNELS.restoreBackup, (_event, id: string) =>
    safelyAsync(() => repository.restoreBackup(id)),
  );
};

export const registerUnavailableProductIpc = (message: string): void => {
  clearProductHandlers();
  Object.values(PRODUCT_IPC_CHANNELS).forEach((channel) => {
    ipcMain.handle(channel, () => failure('DATABASE_UNAVAILABLE', message));
  });
};
