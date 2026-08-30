import { BrowserWindow, dialog, ipcMain } from 'electron';

import { MaterialSessionError, MaterialSessionService } from './session';
import {
  MaterialApiErrorCode,
  MaterialApiResult,
  MaterialRelocation,
  MaterialSelection,
  MATERIAL_IPC_CHANNELS,
} from './types';

const FILE_FILTERS = [
  {
    name: '视频与图片',
    extensions: [
      'avi',
      'm4v',
      'mkv',
      'mov',
      'mp4',
      'webm',
      'avif',
      'bmp',
      'gif',
      'heic',
      'jpeg',
      'jpg',
      'png',
      'webp',
    ],
  },
];

const failure = <T>(
  code: MaterialApiErrorCode,
  message: string,
): MaterialApiResult<T> => ({ ok: false, error: { code, message } });

const run = async <T>(operation: () => Promise<T> | T): Promise<MaterialApiResult<T>> => {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    if (error instanceof MaterialSessionError) {
      return failure(error.code, error.message);
    }
    return failure('UNKNOWN', '本地素材操作失败，请重试');
  }
};

export const chooseMaterialFile = async (
  window: BrowserWindow | null,
): Promise<string | null> => {
  const options: Electron.OpenDialogOptions = {
    filters: FILE_FILTERS,
    message: '选择一个本地视频或图片',
    properties: ['openFile'],
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
};

export const registerMaterialIpc = (service: MaterialSessionService): void => {
  ipcMain.handle(MATERIAL_IPC_CHANNELS.select, async (event) =>
    run<MaterialSelection>(async () => {
      const filePath = await chooseMaterialFile(BrowserWindow.fromWebContents(event.sender));
      return filePath
        ? { cancelled: false, session: await service.register(filePath) }
        : { cancelled: true };
    }),
  );
  ipcMain.handle(MATERIAL_IPC_CHANNELS.inspect, (_event, sessionId: string) =>
    run(() => service.inspect(sessionId)),
  );
  ipcMain.handle(MATERIAL_IPC_CHANNELS.relocate, async (event, sessionId: string) =>
    run<MaterialRelocation>(async () => {
      const filePath = await chooseMaterialFile(BrowserWindow.fromWebContents(event.sender));
      if (!filePath) {
        return { cancelled: true };
      }
      const result = await service.relocate(sessionId, filePath);
      return { cancelled: false, ...result };
    }),
  );
  ipcMain.handle(MATERIAL_IPC_CHANNELS.release, (_event, sessionId: string) =>
    run(() => {
      service.release(sessionId);
      return null;
    }),
  );
};
