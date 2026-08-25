import { ipcMain, WebContents } from 'electron';

import { AnalysisRuntimeService } from './service';
import {
  ANALYSIS_RUNTIME_IPC_CHANNELS,
  AnalysisRuntimeRefineInput,
  AnalysisRuntimeResult,
  AnalysisRuntimeStartInput,
} from './types';

const invalid = (): AnalysisRuntimeResult => ({
  error: { code: 'INVALID_INPUT', message: '分析请求来源无效' },
  ok: false,
});

export const registerAnalysisRuntimeIpc = (
  service: AnalysisRuntimeService,
  isTrustedSender: (webContentsId: number) => boolean,
): void => {
  ipcMain.removeHandler(ANALYSIS_RUNTIME_IPC_CHANNELS.start);
  ipcMain.removeHandler(ANALYSIS_RUNTIME_IPC_CHANNELS.refine);
  ipcMain.removeHandler(ANALYSIS_RUNTIME_IPC_CHANNELS.cancel);
  ipcMain.handle(
    ANALYSIS_RUNTIME_IPC_CHANNELS.start,
    (event, input: AnalysisRuntimeStartInput) => {
      if (!isTrustedSender(event.sender.id)) return invalid();
      const sender: WebContents = event.sender;
      return service.run(input, (progress) => {
        if (!sender.isDestroyed()) {
          sender.send(ANALYSIS_RUNTIME_IPC_CHANNELS.progress, progress);
        }
      });
    },
  );
  ipcMain.handle(
    ANALYSIS_RUNTIME_IPC_CHANNELS.refine,
    (event, input: AnalysisRuntimeRefineInput) => {
      if (!isTrustedSender(event.sender.id)) return invalid();
      const sender: WebContents = event.sender;
      return service.refine(input, (progress) => {
        if (!sender.isDestroyed()) {
          sender.send(ANALYSIS_RUNTIME_IPC_CHANNELS.progress, progress);
        }
      });
    },
  );
  ipcMain.handle(
    ANALYSIS_RUNTIME_IPC_CHANNELS.cancel,
    (event, clientRunId: string) =>
      isTrustedSender(event.sender.id) && typeof clientRunId === 'string'
        ? service.cancel(clientRunId)
        : false,
  );
};
