import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const destroy = vi.fn();
  const loadURL = vi.fn(async (url: string) => {
    void url;
  });
  const on = vi.fn();
  const printToPDF = vi.fn(async () => Buffer.from('%PDF-1.7\ntest'));
  const setWindowOpenHandler = vi.fn();
  const printWindow = {
    destroy,
    isDestroyed: vi.fn(() => false),
    loadURL,
    webContents: { on, printToPDF, setWindowOpenHandler },
  };
  const BrowserWindow = vi.fn(function BrowserWindowMock() {
    return printWindow;
  });
  return {
    BrowserWindow,
    destroy,
    loadURL,
    printToPDF,
    printWindow,
    setWindowOpenHandler,
    showSaveDialog: vi.fn(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: electron.BrowserWindow,
  dialog: { showSaveDialog: electron.showSaveDialog },
}));

import type { AnalysisRecord } from './types';
import { RecordPdfExportError } from './pdf-contract';
import { ElectronRecordPdfExporter } from './pdf-exporter';

const record = (): AnalysisRecord => ({
  confirmationId: 'confirmation-1',
  confirmedAt: '2026-08-25T08:00:00.000Z',
  conversionContext: '',
  feedback: null,
  id: '11111111-1111-4111-8111-111111111111',
  industry: 'game',
  material: {
    byteSize: 1_024,
    displayName: '游戏素材.mp4',
    durationMs: 5_000,
    fingerprintSha256: 'a'.repeat(64),
    height: 1080,
    mediaKind: 'video',
    schemaVersion: 1,
    sourceStatus: 'needs_relocation',
    width: 1920,
  },
  productSnapshot: null,
  report: {
    ctaSummary: [], diagnoses: [], emotionSummary: [], evidence: [], limitations: [],
    schemaVersion: 1,
    score: { dimensions: [], total: null },
    scriptStructure: [], sellingPoints: [], shotSummary: [], subtitleSummary: [],
    summary: '证据不足，保留未评分状态。', tags: [], title: '游戏视频素材分析',
    visualSummary: [], voiceAndSoundSummary: [],
  },
  rules: {
    schemaVersion: 1,
    scoringRuleId: 'scoring.game.video',
    scoringRuleVersion: '1.0.0',
    tagPackageVersion: '1.0.0',
    templateId: 'template.game.video',
    templateVersion: '1.0.0',
  },
  run: {
    capabilityVersion: 'broker-1',
    completedAt: '2026-08-25T07:59:00.000Z',
    modelConfigurationName: '用户模型',
    modelId: 'configured-model',
    schemaVersion: 1,
  },
  sourceRecordAvailable: null,
  sourceRecordId: null,
  subsequentRecords: [],
  visibleConversation: [],
});

describe('ElectronRecordPdfExporter', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'material-pdf-export-'));
    electron.BrowserWindow.mockClear();
    electron.destroy.mockClear();
    electron.loadURL.mockClear();
    electron.printToPDF.mockReset();
    electron.printToPDF.mockResolvedValue(Buffer.from('%PDF-1.7\ntest'));
    electron.setWindowOpenHandler.mockClear();
    electron.showSaveDialog.mockReset();
  });

  afterEach(() => rmSync(directory, { force: true, recursive: true }));

  it('cancels without creating a print window or a file', async () => {
    electron.showSaveDialog.mockResolvedValue({ canceled: true });

    const result = await new ElectronRecordPdfExporter().exportRecord(record());

    expect(result).toEqual({ byteSize: null, cancelled: true, fileName: null });
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
  });

  it('writes a complete PDF atomically and returns no absolute path', async () => {
    const target = path.join(directory, '报告.pdf');
    electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });

    const result = await new ElectronRecordPdfExporter().exportRecord(record());

    expect(readFileSync(target, 'utf8')).toBe('%PDF-1.7\ntest');
    expect(result).toEqual({ byteSize: 13, cancelled: false, fileName: '报告.pdf' });
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(electron.loadURL.mock.calls[0][0]).toContain('data:text/html');
    expect(electron.destroy).toHaveBeenCalledOnce();
  });

  it('does not leave a target file when PDF generation fails', async () => {
    const target = path.join(directory, '失败.pdf');
    electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    electron.printToPDF.mockRejectedValue(new Error('print failed'));

    await expect(new ElectronRecordPdfExporter().exportRecord(record()))
      .rejects.toBeInstanceOf(RecordPdfExportError);
    expect(existsSync(target)).toBe(false);
    expect(electron.destroy).toHaveBeenCalledOnce();
  });
});
