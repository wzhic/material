import type { AnalysisReportDraft, AnalysisRunEvent } from '../analysis-engine';

export type AnalysisRuntimeStage =
  | 'applying_guidance'
  | 'cancelled'
  | 'extracting_structure'
  | 'failed'
  | 'generating_report'
  | 'normalizing_evidence'
  | 'probing_media'
  | 'recognizing_content'
  | 'report_ready'
  | 'validating_context';

export interface AnalysisRuntimeProgress {
  clientRunId: string;
  message: string;
  stage: AnalysisRuntimeStage;
}

export interface AnalysisRuntimeStartInput {
  clientRunId: string;
  configurationDisplayName: string;
  configurationId: string;
  conversionContext?: string;
  industry: 'apparel' | 'game';
  modelId: string;
  productId?: string | null;
  sessionId: string;
  visualInputEnabled: boolean;
}

export interface AnalysisRuntimeRefineInput {
  clientRunId: string;
  guidance: string;
  referenceTimeMs?: number | null;
  sourceClientRunId: string;
}

export type AnalysisRuntimeErrorCode =
  | 'ALREADY_RUNNING'
  | 'CANCELLED'
  | 'INVALID_INPUT'
  | 'MATERIAL_UNAVAILABLE'
  | 'MODEL_FAILED'
  | 'PRODUCT_UNAVAILABLE'
  | 'REQUIRED_TOOL_FAILED'
  | 'UNKNOWN';

export type AnalysisRuntimeResult =
  | {
      data: {
        engineEvents: AnalysisRunEvent[];
        media: {
          durationMs: number;
          hasAudio: boolean;
          height: number | null;
          width: number | null;
        };
        report: AnalysisReportDraft;
      };
      ok: true;
    }
  | {
      error: {
        code: AnalysisRuntimeErrorCode;
        message: string;
      };
      ok: false;
    };

export interface AnalysisRuntimeApi {
  cancel(clientRunId: string): Promise<boolean>;
  onProgress(listener: (progress: AnalysisRuntimeProgress) => void): () => void;
  refine(input: AnalysisRuntimeRefineInput): Promise<AnalysisRuntimeResult>;
  start(input: AnalysisRuntimeStartInput): Promise<AnalysisRuntimeResult>;
}

export const ANALYSIS_RUNTIME_IPC_CHANNELS = {
  cancel: 'material:analysis:cancel',
  progress: 'material:analysis:progress',
  refine: 'material:analysis:refine',
  start: 'material:analysis:start',
} as const;
