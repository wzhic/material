import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    electron.handlers.set(channel, handler);
  }),
  removeHandler: vi.fn((channel: string) => {
    electron.handlers.delete(channel);
  }),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
  },
}));

import { registerRecordIpc } from './ipc';
import type { RecordRepository } from './repository';
import type {
  AnalysisRecord,
  ConfirmedRecordInput,
  RecordApiResult,
} from './types';
import { RECORD_IPC_CHANNELS } from './types';

describe('record IPC confirmation boundary', () => {
  beforeEach(() => {
    electron.handlers.clear();
    electron.handle.mockClear();
    electron.removeHandler.mockClear();
  });

  it('rejects an untrusted renderer before it reaches the repository', () => {
    const confirmAndSave = vi.fn();
    registerRecordIpc({ confirmAndSave } as unknown as RecordRepository, (id) => id === 7);
    const handler = electron.handlers.get(RECORD_IPC_CHANNELS.confirm);

    const result = handler?.(
      { sender: { id: 8 } },
      {} as ConfirmedRecordInput,
    ) as RecordApiResult<AnalysisRecord>;

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(confirmAndSave).not.toHaveBeenCalled();
  });

  it('returns the repository read-back for a trusted renderer', () => {
    const record = { id: 'record-1' } as AnalysisRecord;
    const confirmAndSave = vi.fn(() => record);
    const input = {} as ConfirmedRecordInput;
    registerRecordIpc({ confirmAndSave } as unknown as RecordRepository, (id) => id === 7);
    const handler = electron.handlers.get(RECORD_IPC_CHANNELS.confirm);

    const result = handler?.(
      { sender: { id: 7 } },
      input,
    ) as RecordApiResult<AnalysisRecord>;

    expect(result).toEqual({ ok: true, data: record });
    expect(confirmAndSave).toHaveBeenCalledWith(input);
  });
});
