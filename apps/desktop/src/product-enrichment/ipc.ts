import { ipcMain } from 'electron';

import { GameEnrichmentError } from './errors';
import { GameProductEnrichmentService } from './service';
import {
  GAME_ENRICHMENT_IPC_CHANNELS,
  GameEnrichmentApiResult,
  GameEnrichmentConsentChoice,
  GameEnrichmentErrorCode,
  GameEnrichmentSearchInput,
} from './types';

const failure = (
  code: GameEnrichmentErrorCode,
  message: string,
): GameEnrichmentApiResult<never> => ({ error: { code, message }, ok: false });

const safely = async <T>(operation: () => Promise<T>): Promise<GameEnrichmentApiResult<T>> => {
  try {
    return { data: await operation(), ok: true };
  } catch (error) {
    if (error instanceof GameEnrichmentError) {
      return failure(error.code, error.message);
    }
    return failure('UNKNOWN', '联网补全失败，可重试或继续手工填写');
  }
};

const clearHandlers = (): void => {
  Object.values(GAME_ENRICHMENT_IPC_CHANNELS).forEach((channel) =>
    ipcMain.removeHandler(channel));
};

const validChoice = (value: unknown): value is GameEnrichmentConsentChoice =>
  value === 'declined' || value === 'once' || value === 'persistent';

export const registerGameEnrichmentIpc = (
  service: GameProductEnrichmentService,
  isTrustedSender: (webContentsId: number) => boolean,
): (() => void) => {
  clearHandlers();
  const trackedSenders = new Set<number>();
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean => {
    const senderId = event.sender.id;
    if (!isTrustedSender(senderId)) return false;
    if (!trackedSenders.has(senderId)) {
      trackedSenders.add(senderId);
      event.sender.once('destroyed', () => {
        trackedSenders.delete(senderId);
        service.disposeSender(senderId);
      });
    }
    return true;
  };

  ipcMain.handle(GAME_ENRICHMENT_IPC_CHANNELS.getStatus, (event) =>
    trusted(event)
      ? safely(() => service.getStatus(event.sender.id))
      : failure('INVALID_INPUT', '请求来源无效'));
  ipcMain.handle(
    GAME_ENRICHMENT_IPC_CHANNELS.setConsent,
    (event, choice: unknown) => trusted(event) && validChoice(choice)
      ? safely(() => service.setConsent(event.sender.id, choice))
      : failure('INVALID_INPUT', '授权选项无效'),
  );
  ipcMain.handle(GAME_ENRICHMENT_IPC_CHANNELS.clearPersistentConsent, (event) =>
    trusted(event)
      ? safely(() => service.clearPersistentConsent(event.sender.id))
      : failure('INVALID_INPUT', '请求来源无效'));
  ipcMain.handle(
    GAME_ENRICHMENT_IPC_CHANNELS.search,
    (event, input: GameEnrichmentSearchInput) => trusted(event)
      ? safely(() => service.search(event.sender.id, input))
      : failure('INVALID_INPUT', '请求来源无效'),
  );
  ipcMain.handle(GAME_ENRICHMENT_IPC_CHANNELS.cancel, (event, requestId: string) =>
    trusted(event)
      ? safely(async () => {
          service.cancel(event.sender.id, requestId);
          return null;
        })
      : failure('INVALID_INPUT', '请求来源无效'));

  return () => {
    clearHandlers();
    trackedSenders.forEach((senderId) => service.disposeSender(senderId));
    trackedSenders.clear();
  };
};
