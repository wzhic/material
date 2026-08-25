import { ProductSnapshot } from '../product/types';

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

export type RecordApiErrorCode =
  | 'CONFLICT'
  | 'DATABASE_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'UNKNOWN';

export type RecordApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RecordApiErrorCode; message: string } };

export interface RecordApi {
  confirm: (input: ConfirmedRecordInput) => Promise<RecordApiResult<AnalysisRecord>>;
  list: (query?: AnalysisRecordQuery) => Promise<RecordApiResult<AnalysisRecordPage>>;
  get: (id: string) => Promise<RecordApiResult<AnalysisRecord>>;
  saveFeedback: (
    id: string,
    input: RecordFeedbackInput,
  ) => Promise<RecordApiResult<RecordFeedback>>;
  clearFeedback: (id: string) => Promise<RecordApiResult<null>>;
  remove: (id: string) => Promise<RecordApiResult<null>>;
}

export const RECORD_IPC_CHANNELS = {
  clearFeedback: 'material:records:clear-feedback',
  confirm: 'material:records:confirm',
  get: 'material:records:get',
  list: 'material:records:list',
  remove: 'material:records:remove',
  saveFeedback: 'material:records:save-feedback',
} as const;
