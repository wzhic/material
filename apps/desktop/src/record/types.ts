import { ProductSnapshot } from '../product/types';
import type { MaterialMismatch, MaterialSession } from '../media/types';

export type RecordIndustry = 'apparel' | 'game';
export type RecordMediaKind = 'image' | 'video';
export type MaterialSourceStatus = 'available' | 'mismatch' | 'needs_relocation';
export type RecordSort = 'confirmed_asc' | 'confirmed_desc';
export type RecordFeedbackState = 'rated' | 'unrated';

export interface MaterialReferenceSnapshot {
  schemaVersion: 1;
  displayName: string;
  mediaKind: RecordMediaKind;
  byteSize: number;
  fingerprintSha256: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  sourceStatus: MaterialSourceStatus;
}

export interface ReportEvidence {
  id: string;
  label: string;
  summary: string;
  startMs: number | null;
  endMs: number | null;
  source: 'fusion' | 'model' | 'tool';
}

export interface ReportTag {
  label: string;
  source: 'dynamic' | 'fixed';
  evidenceIds: string[];
}

export interface ReportDiagnosis {
  problem: string;
  suggestion: string;
  evidenceIds: string[];
}

export interface ReportScoreDimension {
  id: string;
  label: string;
  score: number | null;
  status?: 'insufficient_evidence' | 'not_applicable' | 'scored';
}

export interface ConfirmedReportSnapshot {
  schemaVersion: 1;
  title: string;
  summary: string;
  scriptStructure: string[];
  shotSummary: string[];
  visualSummary: string[];
  subtitleSummary: string[];
  voiceAndSoundSummary: string[];
  sellingPoints: string[];
  emotionSummary: string[];
  ctaSummary: string[];
  score: {
    total: number | null;
    dimensions: ReportScoreDimension[];
  };
  tags: ReportTag[];
  diagnoses: ReportDiagnosis[];
  limitations: string[];
  evidence: ReportEvidence[];
}

export interface RuleSnapshot {
  schemaVersion: 1;
  templateId: string;
  templateVersion: string;
  scoringRuleId: string;
  scoringRuleVersion: string;
  tagPackageVersion: string;
}

export interface AnalysisRunSnapshot {
  schemaVersion: 1;
  modelConfigurationName: string;
  modelId: string;
  capabilityVersion: string;
  completedAt: string;
}

export interface VisibleConversationItem {
  role: 'assistant' | 'user';
  text: string;
  timeReferenceMs: number | null;
}

export interface ConfirmedRecordInput {
  confirmationId: string | null;
  industry: RecordIndustry;
  material: MaterialReferenceSnapshot;
  productSnapshot: ProductSnapshot | null;
  report: ConfirmedReportSnapshot;
  rules: RuleSnapshot;
  run: AnalysisRunSnapshot;
  visibleConversation: VisibleConversationItem[];
  conversionContext: string;
  sourceRecordId: string | null;
}

export interface RecordFeedback {
  rating: number;
  reason: string;
  weightDirection: string;
  updatedAt: string;
}

export interface RecordFeedbackInput {
  rating: number;
  reason: string;
  weightDirection: string;
}

export interface AnalysisRecord extends ConfirmedRecordInput {
  id: string;
  confirmedAt: string;
  feedback: RecordFeedback | null;
  sourceRecordAvailable: boolean | null;
  subsequentRecords: Array<{
    id: string;
    materialDisplayName: string;
    confirmedAt: string;
    totalScore: number | null;
  }>;
}

export interface AnalysisRecordListItem {
  id: string;
  materialDisplayName: string;
  industry: RecordIndustry;
  mediaKind: RecordMediaKind;
  productDisplayName: string | null;
  totalScore: number | null;
  feedback: Pick<RecordFeedback, 'rating' | 'updatedAt'> | null;
  sourceStatus: MaterialSourceStatus;
  sourceRecordId: string | null;
  confirmedAt: string;
}

export interface AnalysisRecordQuery {
  query?: string;
  industry?: RecordIndustry | '';
  mediaKind?: RecordMediaKind | '';
  sourceStatus?: MaterialSourceStatus | '';
  feedbackState?: RecordFeedbackState | '';
  confirmedFrom?: string;
  confirmedTo?: string;
  sort?: RecordSort;
  limit?: number;
  offset?: number;
}

export interface AnalysisRecordPage {
  items: AnalysisRecordListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface RecordPdfExportResult {
  cancelled: boolean;
  fileName: string | null;
  byteSize: number | null;
}

export interface RecordSourceAccessResult {
  cancelled: boolean;
  mismatch: MaterialMismatch | null;
  session: MaterialSession | null;
  sourceStatus: MaterialSourceStatus;
}

export type RecordBackupKind = 'manual' | 'pre-migration' | 'pre-restore';

export interface RecordBackupInfo {
  id: string;
  kind: RecordBackupKind;
  createdAt: string;
  size: number;
  schemaVersion: number | null;
  recordCount: number | null;
  feedbackCount: number | null;
  sourceReferenceCount: number | null;
  integrity: 'failed' | 'ok';
}

export interface RecordStorageStatus {
  schemaVersion: number;
  integrity: 'failed' | 'ok';
  writable: boolean;
  recordCount: number;
  feedbackCount: number;
  sourceReferenceCount: number;
  backupCount: number;
}

export interface RecordRestoreResult {
  restoredBackupId: string;
  safetyBackup: RecordBackupInfo;
  status: RecordStorageStatus;
}

export type RecordApiErrorCode =
  | 'CONFLICT'
  | 'DATABASE_UNAVAILABLE'
  | 'EXPORT_FAILED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'SOURCE_UNAVAILABLE'
  | 'UNKNOWN';

export type RecordApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RecordApiErrorCode; message: string } };

export interface RecordApi {
  confirm: (
    input: ConfirmedRecordInput,
    materialSessionId?: string,
  ) => Promise<RecordApiResult<AnalysisRecord>>;
  list: (query?: AnalysisRecordQuery) => Promise<RecordApiResult<AnalysisRecordPage>>;
  get: (id: string) => Promise<RecordApiResult<AnalysisRecord>>;
  openSource: (id: string) => Promise<RecordApiResult<RecordSourceAccessResult>>;
  relocateSource: (id: string) => Promise<RecordApiResult<RecordSourceAccessResult>>;
  saveFeedback: (
    id: string,
    input: RecordFeedbackInput,
  ) => Promise<RecordApiResult<RecordFeedback>>;
  clearFeedback: (id: string) => Promise<RecordApiResult<null>>;
  exportPdf: (id: string) => Promise<RecordApiResult<RecordPdfExportResult>>;
  remove: (id: string) => Promise<RecordApiResult<null>>;
  storageStatus: () => Promise<RecordApiResult<RecordStorageStatus>>;
  listBackups: () => Promise<RecordApiResult<RecordBackupInfo[]>>;
  createBackup: () => Promise<RecordApiResult<RecordBackupInfo>>;
  restoreBackup: (id: string) => Promise<RecordApiResult<RecordRestoreResult>>;
}

export const RECORD_IPC_CHANNELS = {
  clearFeedback: 'material:records:clear-feedback',
  confirm: 'material:records:confirm',
  exportPdf: 'material:records:export-pdf',
  get: 'material:records:get',
  list: 'material:records:list',
  listBackups: 'material:records:list-backups',
  openSource: 'material:records:open-source',
  relocateSource: 'material:records:relocate-source',
  remove: 'material:records:remove',
  saveFeedback: 'material:records:save-feedback',
  storageStatus: 'material:records:storage-status',
  createBackup: 'material:records:create-backup',
  restoreBackup: 'material:records:restore-backup',
} as const;
