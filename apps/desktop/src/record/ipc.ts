import { ipcMain } from 'electron';

import { RecordValidationError } from './domain';
import { RecordRepository, RecordRepositoryError } from './repository';
import {
  AnalysisRecordQuery,
  ConfirmedRecordInput,
  RECORD_IPC_CHANNELS,
  RecordApiErrorCode,
  RecordApiResult,
  RecordFeedbackInput,
} from './types';

const failure = (code: RecordApiErrorCode, message: string): RecordApiResult<never> => ({
  ok: false,
  error: { code, message },
});

const safely = <T>(operation: () => T): RecordApiResult<T> => {
  try {
    return { ok: true, data: operation() };
  } catch (error) {
    if (error instanceof RecordRepositoryError) {
      return failure(error.code, error.message);
    }
    if (error instanceof RecordValidationError) {
      return failure('INVALID_INPUT', error.message);
    }
    return failure('UNKNOWN', '分析记录操作失败，请重试');
  }
};

const clearRecordHandlers = (): void => {
  Object.values(RECORD_IPC_CHANNELS).forEach((channel) => ipcMain.removeHandler(channel));
};

export const registerRecordIpc = (
  repository: RecordRepository,
  isTrustedSender: (webContentsId: number) => boolean,
): void => {
  clearRecordHandlers();
  ipcMain.handle(RECORD_IPC_CHANNELS.confirm, (event, input: ConfirmedRecordInput) =>
    isTrustedSender(event.sender.id)
      ? safely(() => repository.confirmAndSave(input))
      : failure('INVALID_INPUT', '分析记录请求来源无效'),
  );
  ipcMain.handle(RECORD_IPC_CHANNELS.list, (event, query?: AnalysisRecordQuery) =>
    isTrustedSender(event.sender.id)
      ? safely(() => repository.list(query))
      : failure('INVALID_INPUT', '分析记录请求来源无效'),
  );
  ipcMain.handle(RECORD_IPC_CHANNELS.get, (event, id: string) =>
    isTrustedSender(event.sender.id)
      ? safely(() => repository.get(id))
      : failure('INVALID_INPUT', '分析记录请求来源无效'),
  );
  ipcMain.handle(
    RECORD_IPC_CHANNELS.saveFeedback,
    (event, id: string, input: RecordFeedbackInput) =>
      isTrustedSender(event.sender.id)
        ? safely(() => repository.saveFeedback(id, input))
        : failure('INVALID_INPUT', '分析记录请求来源无效'),
  );
  ipcMain.handle(RECORD_IPC_CHANNELS.clearFeedback, (event, id: string) =>
    isTrustedSender(event.sender.id)
      ? safely(() => {
        repository.clearFeedback(id);
        return null;
      })
      : failure('INVALID_INPUT', '分析记录请求来源无效'),
  );
  ipcMain.handle(RECORD_IPC_CHANNELS.remove, (event, id: string) =>
    isTrustedSender(event.sender.id)
      ? safely(() => {
        repository.remove(id);
        return null;
      })
      : failure('INVALID_INPUT', '分析记录请求来源无效'),
  );
};

export const registerUnavailableRecordIpc = (message: string): void => {
  clearRecordHandlers();
  Object.values(RECORD_IPC_CHANNELS).forEach((channel) => {
    ipcMain.handle(channel, () => failure('DATABASE_UNAVAILABLE', message));
  });
};
