import { ipcMain } from 'electron';

import { ModelServiceError, safeModelMessage } from './errors';
import { ModelService } from './service';
import {
  MODEL_IPC_CHANNELS,
  ModelApiErrorCode,
  ModelApiResult,
  SaveModelConfigurationInput,
} from './types';

const failure = (code: ModelApiErrorCode): ModelApiResult<never> => ({
  error: { code, message: safeModelMessage(code) },
  ok: false,
});

const safely = async <T>(operation: () => Promise<T>): Promise<ModelApiResult<T>> => {
  try {
    return { data: await operation(), ok: true };
  } catch (error) {
    if (error instanceof ModelServiceError) {
      return failure(error.code);
    }
    return failure('UNKNOWN');
  }
};

const validConfigurationId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

const validModelId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);

const clearHandlers = (): void => {
  Object.values(MODEL_IPC_CHANNELS).forEach((channel) => ipcMain.removeHandler(channel));
};

export const registerModelIpc = (
  service: ModelService,
  isTrustedSender: (webContentsId: number) => boolean,
): void => {
  clearHandlers();
  ipcMain.handle(MODEL_IPC_CHANNELS.getSettings, (event) =>
    isTrustedSender(event.sender.id)
      ? safely(() => service.getSettings())
      : failure('INVALID_INPUT'));
  ipcMain.handle(
    MODEL_IPC_CHANNELS.saveConfiguration,
    (event, input: SaveModelConfigurationInput) =>
      isTrustedSender(event.sender.id)
        ? safely(() => service.saveConfiguration(input))
        : failure('INVALID_INPUT'),
  );
  ipcMain.handle(MODEL_IPC_CHANNELS.refreshModels, (event, id: string) =>
    isTrustedSender(event.sender.id)
      ? safely(() => service.refreshModels(id))
      : failure('INVALID_INPUT'));
  ipcMain.handle(MODEL_IPC_CHANNELS.testModel, (
    event,
    configurationId: unknown,
    modelId: unknown,
  ) =>
    isTrustedSender(event.sender.id)
    && validConfigurationId(configurationId)
    && validModelId(modelId)
      ? safely(() => service.testModel(configurationId, modelId))
      : failure('INVALID_INPUT'));
  ipcMain.handle(MODEL_IPC_CHANNELS.removeConfiguration, (
    event,
    id: string,
    expectedWriteVersion: number,
  ) =>
    isTrustedSender(event.sender.id)
      ? safely(async () => {
        await service.removeConfiguration(id, expectedWriteVersion);
        return null;
      })
      : failure('INVALID_INPUT'));
};
