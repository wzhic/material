import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  fromWebContents: vi.fn(() => null),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    electron.handlers.set(channel, handler);
  }),
  removeHandler: vi.fn((channel: string) => {
    electron.handlers.delete(channel);
  }),
  showOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: electron.fromWebContents,
  },
  dialog: {
    showOpenDialog: electron.showOpenDialog,
  },
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
  },
}));

import { registerRecordIpc } from './ipc';
import type { RecordPdfExporter } from './pdf-contract';
import type { RecordRepository } from './repository';
import type { RecordSourceAccessService } from './source-access';
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
    electron.showOpenDialog.mockReset();
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

  it('returns the repository read-back for a trusted renderer', async () => {
    const record = { id: 'record-1' } as AnalysisRecord;
    const confirmAndSave = vi.fn(() => record);
    const input = {} as ConfirmedRecordInput;
    registerRecordIpc({ confirmAndSave } as unknown as RecordRepository, (id) => id === 7);
    const handler = electron.handlers.get(RECORD_IPC_CHANNELS.confirm);

    const result = await handler?.(
      { sender: { id: 7 } },
      input,
    ) as RecordApiResult<AnalysisRecord>;

    expect(result).toEqual({ ok: true, data: record });
    expect(confirmAndSave).toHaveBeenCalledWith(input, undefined);
  });

  it('seals the current source session before saving a trusted confirmation', async () => {
    const record = { id: 'record-1' } as AnalysisRecord;
    const input = { material: { displayName: '素材.mp4' } } as ConfirmedRecordInput;
    const confirmAndSave = vi.fn(() => record);
    const sealSession = vi.fn(async () => 'c2VhbGVkLXNvdXJjZQ==');
    registerRecordIpc(
      { confirmAndSave } as unknown as RecordRepository,
      (id) => id === 7,
      undefined,
      { sealSession } as unknown as RecordSourceAccessService,
    );
    const handler = electron.handlers.get(RECORD_IPC_CHANNELS.confirm);

    const result = await handler?.({ sender: { id: 7 } }, input, 'session-1');

    expect(result).toEqual({ ok: true, data: record });
    expect(sealSession).toHaveBeenCalledWith('session-1', input.material);
    expect(confirmAndSave).toHaveBeenCalledWith(input, 'c2VhbGVkLXNvdXJjZQ==');
  });

  it('opens a persisted source in the main process and updates its live status', async () => {
    const record = { id: 'record-1' } as AnalysisRecord;
    const sourceReference = vi.fn(() => 'c2VhbGVkLXNvdXJjZQ==');
    const updateSourceStatus = vi.fn();
    const openEncrypted = vi.fn(async () => ({
      cancelled: false,
      mismatch: null,
      session: { sessionId: 'session-1' },
      sourceStatus: 'available',
    }));
    registerRecordIpc(
      {
        get: vi.fn(() => record),
        sourceReference,
        updateSourceStatus,
      } as unknown as RecordRepository,
      (id) => id === 7,
      undefined,
      { openEncrypted } as unknown as RecordSourceAccessService,
    );
    const handler = electron.handlers.get(RECORD_IPC_CHANNELS.openSource);

    const result = await handler?.({ sender: { id: 7 } }, 'record-1');

    expect(result).toMatchObject({ ok: true, data: { sourceStatus: 'available' } });
    expect(openEncrypted).toHaveBeenCalledWith(record, 'c2VhbGVkLXNvdXJjZQ==');
    expect(updateSourceStatus).toHaveBeenCalledWith('record-1', 'available');
  });

  it('replaces a record source only after a successful fingerprint relocation', async () => {
    const record = {
      id: 'record-1',
      material: { sourceStatus: 'needs_relocation' },
    } as AnalysisRecord;
    const session = { sessionId: 'session-2' };
    const replaceSourceReference = vi.fn();
    const relocate = vi.fn(async () => ({
      access: {
        cancelled: false,
        mismatch: null,
        session,
        sourceStatus: 'available',
      },
      encryptedPath: 'c2VhbGVkLW5ldy1zb3VyY2U=',
    }));
    electron.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/private/source.mp4'],
    });
    registerRecordIpc(
      {
        get: vi.fn(() => record),
        replaceSourceReference,
      } as unknown as RecordRepository,
      (id) => id === 7,
      undefined,
      { relocate } as unknown as RecordSourceAccessService,
    );
    const handler = electron.handlers.get(RECORD_IPC_CHANNELS.relocateSource);

    const result = await handler?.({ sender: { id: 7 } }, 'record-1');

    expect(result).toMatchObject({ ok: true, data: { sourceStatus: 'available' } });
    expect(relocate).toHaveBeenCalledWith(record, '/private/source.mp4');
    expect(replaceSourceReference).toHaveBeenCalledWith(
      'record-1',
      'c2VhbGVkLW5ldy1zb3VyY2U=',
    );
  });

  it('re-reads a trusted record in the main process before exporting it', async () => {
    const record = { id: 'record-1' } as AnalysisRecord;
    const get = vi.fn(() => record);
    const exportRecord = vi.fn(async () => ({
      byteSize: 128,
      cancelled: false,
      fileName: '报告.pdf',
    }));
    registerRecordIpc(
      { get } as unknown as RecordRepository,
      (id) => id === 7,
      { exportRecord } as RecordPdfExporter,
    );
    const handler = electron.handlers.get(RECORD_IPC_CHANNELS.exportPdf);

    const result = await handler?.({ sender: { id: 7 } }, 'record-1');

    expect(result).toEqual({
      data: { byteSize: 128, cancelled: false, fileName: '报告.pdf' },
      ok: true,
    });
    expect(get).toHaveBeenCalledWith('record-1');
    expect(exportRecord).toHaveBeenCalledWith(record);
  });

  it('rejects an untrusted PDF export before reading the record', async () => {
    const get = vi.fn();
    const exportRecord = vi.fn();
    registerRecordIpc(
      { get } as unknown as RecordRepository,
      () => false,
      { exportRecord } as unknown as RecordPdfExporter,
    );
    const handler = electron.handlers.get(RECORD_IPC_CHANNELS.exportPdf);

    const result = await handler?.({ sender: { id: 8 } }, 'record-1');

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(get).not.toHaveBeenCalled();
    expect(exportRecord).not.toHaveBeenCalled();
  });

  it('exposes storage status, backup creation and restore only to the trusted renderer', async () => {
    const storageStatus = vi.fn(() => ({
      backupCount: 1,
      feedbackCount: 1,
      integrity: 'ok' as const,
      recordCount: 2,
      schemaVersion: 3,
      sourceReferenceCount: 1,
      writable: true,
    }));
    const createBackup = vi.fn(async () => ({ id: 'backup-1' }));
    const restoreBackup = vi.fn(async () => ({ restoredBackupId: 'backup-1' }));
    registerRecordIpc(
      { createBackup, restoreBackup, storageStatus } as unknown as RecordRepository,
      (id) => id === 7,
    );

    const statusResult = await electron.handlers.get(RECORD_IPC_CHANNELS.storageStatus)?.({
      sender: { id: 7 },
    });
    const createResult = await electron.handlers.get(RECORD_IPC_CHANNELS.createBackup)?.({
      sender: { id: 7 },
    });
    const restoreResult = await electron.handlers.get(RECORD_IPC_CHANNELS.restoreBackup)?.(
      { sender: { id: 7 } },
      'backup-1',
    );
    const rejected = await electron.handlers.get(RECORD_IPC_CHANNELS.restoreBackup)?.(
      { sender: { id: 8 } },
      'backup-1',
    );

    expect(statusResult).toMatchObject({ ok: true, data: { recordCount: 2 } });
    expect(createResult).toEqual({ ok: true, data: { id: 'backup-1' } });
    expect(restoreResult).toEqual({
      ok: true,
      data: { restoredBackupId: 'backup-1' },
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(restoreBackup).toHaveBeenCalledTimes(1);
    expect(restoreBackup).toHaveBeenCalledWith('backup-1');
  });
});
