import { ipcMain } from 'electron';

import { RecordValidationError } from './domain';
import { RecordRepository, RecordRepositoryError } from './repository';
import {
  AnalysisRecordQuery,
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

export const registerRecordIpc = (repository: RecordRepository): void => {
  clearRecordHandlers();
  ipcMain.handle(RECORD_IPC_CHANNELS.list, (_event, query?: AnalysisRecordQuery) =>
    safely(() => repository.list(query)),
  );
  ipcMain.handle(RECORD_IPC_CHANNELS.get, (_event, id: string) =>
    safely(() => repository.get(id)),
  );
  ipcMain.handle(
    RECORD_IPC_CHANNELS.saveFeedback,
    (_event, id: string, input: RecordFeedbackInput) =>
      safely(() => repository.saveFeedback(id, input)),
  );
  ipcMain.handle(RECORD_IPC_CHANNELS.clearFeedback, (_event, id: string) =>
    safely(() => {
      repository.clearFeedback(id);
      return null;
    }),
  );
  ipcMain.handle(RECORD_IPC_CHANNELS.remove, (_event, id: string) =>
    safely(() => {
      repository.remove(id);
      return null;
    }),
  );
};

export const registerUnavailableRecordIpc = (message: string): void => {
  clearRecordHandlers();
  Object.values(RECORD_IPC_CHANNELS).forEach((channel) => {
    ipcMain.handle(channel, () => failure('DATABASE_UNAVAILABLE', message));
  });
};
