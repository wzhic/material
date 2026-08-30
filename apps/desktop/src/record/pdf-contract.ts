import type { AnalysisRecord, RecordPdfExportResult } from './types';

export interface RecordPdfExporter {
  exportRecord(record: AnalysisRecord): Promise<RecordPdfExportResult>;
}

export class RecordPdfExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordPdfExportError';
  }
}
