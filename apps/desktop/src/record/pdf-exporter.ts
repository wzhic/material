import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BrowserWindow, dialog } from 'electron';

import { RecordPdfExportError, type RecordPdfExporter } from './pdf-contract';
import { buildRecordPdfHtml, createPdfFilename } from './pdf-document';
import type { AnalysisRecord, RecordPdfExportResult } from './types';

const normalizePdfPath = (filePath: string): string =>
  filePath.toLocaleLowerCase('en-US').endsWith('.pdf') ? filePath : `${filePath}.pdf`;

const writeAtomically = async (targetPath: string, content: Buffer): Promise<void> => {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.partial`,
  );
  try {
    await writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const renderPdf = async (html: string): Promise<Buffer> => {
  const printWindow = new BrowserWindow({
    height: 900,
    show: false,
    width: 794,
    webPreferences: {
      contextIsolation: true,
      javascript: false,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    printWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    const buffer = await printWindow.webContents.printToPDF({
      displayHeaderFooter: true,
      footerTemplate: '<div style="width:100%;font-size:8px;color:#87909e;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      headerTemplate: '<span></span>',
      pageSize: 'A4',
      preferCSSPageSize: true,
      printBackground: true,
    });
    if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new RecordPdfExportError('PDF 生成结果不完整，请重试');
    }
    return buffer;
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
};

export class ElectronRecordPdfExporter implements RecordPdfExporter {
  private readonly lastTargets = new Map<string, string>();

  async exportRecord(record: AnalysisRecord): Promise<RecordPdfExportResult> {
    let selectedPath: string;
    try {
      const selection = await dialog.showSaveDialog({
        defaultPath: this.lastTargets.get(record.id) ?? createPdfFilename(record.material.displayName),
        filters: [{ extensions: ['pdf'], name: 'PDF 报告' }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
        title: '导出已确认分析报告',
      });
      if (selection.canceled || !selection.filePath) {
        return { byteSize: null, cancelled: true, fileName: null };
      }
      selectedPath = normalizePdfPath(selection.filePath);
      this.lastTargets.set(record.id, selectedPath);
    } catch {
      throw new RecordPdfExportError('无法打开系统保存窗口，请重试');
    }

    try {
      const buffer = await renderPdf(buildRecordPdfHtml(record));
      await writeAtomically(selectedPath, buffer);
      return {
        byteSize: buffer.length,
        cancelled: false,
        fileName: path.basename(selectedPath),
      };
    } catch (error) {
      if (error instanceof RecordPdfExportError) throw error;
      throw new RecordPdfExportError('PDF 导出失败，请检查保存位置、权限和可用空间后重试');
    }
  }
}
