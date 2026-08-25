import { BrowserWindow, ipcMain } from 'electron';

import { chooseMaterialFile } from '../media/ipc';
import { MaterialSessionError } from '../media/session';
import { RecordValidationError } from './domain';
import { RecordPdfExportError, type RecordPdfExporter } from './pdf-contract';
import { RecordRepository, RecordRepositoryError } from './repository';
import {
  RecordSourceAccessError,
  type RecordSourceAccessService,
} from './source-access';
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

const safelyAsync = async <T>(operation: () => Promise<T>): Promise<RecordApiResult<T>> => {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    if (error instanceof RecordRepositoryError) {
      return failure(error.code, error.message);
    }
    if (error instanceof RecordValidationError) {
      return failure('INVALID_INPUT', error.message);
    }
    if (error instanceof RecordPdfExportError) {
      return failure('EXPORT_FAILED', error.message);
    }
    return failure('EXPORT_FAILED', 'PDF 导出失败，请重试');
  }
};

const safelySource = async <T>(operation: () => Promise<T>): Promise<RecordApiResult<T>> => {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    if (error instanceof RecordRepositoryError) {
      return failure(error.code, error.message);
    }
    if (error instanceof RecordValidationError) {
      return failure('INVALID_INPUT', error.message);
    }
    if (error instanceof RecordSourceAccessError) {
      return failure(error.code, error.message);
    }
    if (error instanceof MaterialSessionError) {
      return failure(
        error.code === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'SOURCE_UNAVAILABLE',
        error.message,
      );
    }
    return failure('SOURCE_UNAVAILABLE', '源素材访问失败，请重新定位后重试');
  }
};

const clearRecordHandlers = (): void => {
  Object.values(RECORD_IPC_CHANNELS).forEach((channel) => ipcMain.removeHandler(channel));
};

export const registerRecordIpc = (
  repository: RecordRepository,
  isTrustedSender: (webContentsId: number) => boolean,
  pdfExporter?: RecordPdfExporter,
  sourceAccess?: RecordSourceAccessService,
): void => {
  clearRecordHandlers();
  ipcMain.handle(
    RECORD_IPC_CHANNELS.confirm,
    (event, input: ConfirmedRecordInput, materialSessionId?: string) => {
      if (!isTrustedSender(event.sender.id)) {
        return failure('INVALID_INPUT', '分析记录请求来源无效');
      }
      return safelySource(async () => {
        let encryptedSourcePath: string | undefined;
        if (sourceAccess && materialSessionId) {
          try {
            encryptedSourcePath = await sourceAccess.sealSession(
              materialSessionId,
              input.material,
            );
          } catch (error) {
            if (
              !(error instanceof RecordSourceAccessError)
              || error.code !== 'SOURCE_UNAVAILABLE'
            ) {
              throw error;
            }
          }
        }
        return repository.confirmAndSave(input, encryptedSourcePath);
      });
    },
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
  ipcMain.handle(RECORD_IPC_CHANNELS.openSource, (event, id: string) => {
    if (!isTrustedSender(event.sender.id)) {
      return failure('INVALID_INPUT', '分析记录请求来源无效');
    }
    if (!sourceAccess) {
      return failure('SOURCE_UNAVAILABLE', '源素材恢复能力当前不可用，请重启应用后重试');
    }
    return safelySource(async () => {
      const record = repository.get(id);
      const encryptedPath = repository.sourceReference(id);
      if (!encryptedPath) {
        repository.updateSourceStatus(id, 'needs_relocation');
        return {
          cancelled: false,
          mismatch: null,
          session: null,
          sourceStatus: 'needs_relocation' as const,
        };
      }
      const result = await sourceAccess.openEncrypted(record, encryptedPath);
      repository.updateSourceStatus(id, result.sourceStatus);
      return result;
    });
  });
  ipcMain.handle(RECORD_IPC_CHANNELS.relocateSource, (event, id: string) => {
    if (!isTrustedSender(event.sender.id)) {
      return failure('INVALID_INPUT', '分析记录请求来源无效');
    }
    if (!sourceAccess) {
      return failure('SOURCE_UNAVAILABLE', '源素材恢复能力当前不可用，请重启应用后重试');
    }
    return safelySource(async () => {
      const record = repository.get(id);
      const filePath = await chooseMaterialFile(BrowserWindow.fromWebContents(event.sender));
      if (!filePath) {
        return {
          cancelled: true,
          mismatch: null,
          session: null,
          sourceStatus: record.material.sourceStatus,
        };
      }
      const relocated = await sourceAccess.relocate(record, filePath);
      if (relocated.encryptedPath && relocated.access.session) {
        try {
          repository.replaceSourceReference(id, relocated.encryptedPath);
        } catch (error) {
          sourceAccess.releaseSession(relocated.access.session.sessionId);
          throw error;
        }
      } else {
        repository.updateSourceStatus(id, relocated.access.sourceStatus);
      }
      return relocated.access;
    });
  });
  ipcMain.handle(RECORD_IPC_CHANNELS.exportPdf, (event, id: string) => {
    if (!isTrustedSender(event.sender.id)) {
      return failure('INVALID_INPUT', '分析记录请求来源无效');
    }
    if (!pdfExporter) {
      return failure('EXPORT_FAILED', 'PDF 导出能力当前不可用，请重启应用后重试');
    }
    return safelyAsync(async () => pdfExporter.exportRecord(repository.get(id)));
  });
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
