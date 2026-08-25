import type {
  AnalysisIndustry,
  AnalysisMediaKind,
  AnalysisRuleSnapshot,
  DimensionAssessment,
  MaterialScoreResult,
  ReportTagResult,
} from '../analysis-rules';
import type { MediaEvidenceOutput, TimelineEntry } from '../media-tools';
import type {
  ModelApiErrorCode,
  ModelCompletionRequest,
  ModelInvocationAudit,
  ModelInvocationResult,
  ModelUsage,
} from '../model/types';
import type { StructuredEvidence } from '../tooling/evidence';
import type { ProductSnapshot } from '../product/types';

export type AnalysisGoalScene =
  | 'acquisition'
  | 'purchase_conversion'
  | 'reactivation'
  | 'unclear';

export interface AnalysisClaim {
  evidenceIds: string[];
  text: string;
}

export interface EmotionPoint extends AnalysisClaim {
  intensity: number | null;
  timeMs: number | null;
}

export interface AnalysisDiagnosis {
  evidenceIds: string[];
  impact: string;
  problem: string;
  relatedDimensionIds: string[];
  severity: 'high' | 'low' | 'medium';
}

export interface AnalysisRecommendation {
  action: string;
  diagnosisIndexes: number[];
  priority: 'next' | 'now' | 'test';
  rationale: string;
}

export interface ModelAnalysisOutput {
  cta: AnalysisClaim[];
  diagnoses: AnalysisDiagnosis[];
  dimensionAssessments: DimensionAssessment[];
  dynamicTags: Array<{
    evidenceIds: string[];
    facet: string;
    label: string;
  }>;
  emotion: EmotionPoint[];
  fixedTags: Array<{
    evidenceIds: string[];
    tagId: string;
  }>;
  goalScene: AnalysisGoalScene;
  limitations: string[];
  productOrGameplay: AnalysisClaim[];
  recommendations: AnalysisRecommendation[];
  schemaVersion: 1;
  scriptStructure: AnalysisClaim[];
  sellingPoints: AnalysisClaim[];
  shotBreakdown: AnalysisClaim[];
  subtitleContent: AnalysisClaim[];
  summary: string;
  title: string;
  visualContent: AnalysisClaim[];
  voiceAndSound: AnalysisClaim[];
}

export interface EvidencePacketItem {
  confidence: number;
  evidenceId: string;
  evidenceType: string;
  locator: StructuredEvidence['locator'];
  source: StructuredEvidence['source'];
  text: string;
}

export interface EvidencePacket {
  includedEvidenceIds: ReadonlySet<string>;
  items: EvidencePacketItem[];
  limitations: string[];
  omittedEvidenceCount: number;
  schemaVersion: 1;
  truncatedTextCount: number;
}

export interface AnalysisPromptPackage {
  id: string;
  schemaVersion: 1;
  systemInstruction: string;
  taskInstruction: string;
  version: string;
}

export interface AnalysisModelSelection {
  configurationDisplayName: string;
  configurationId: string;
  modelId: string;
}

export interface AnalysisRunInput {
  conversionContext?: string;
  industry: AnalysisIndustry;
  media: MediaEvidenceOutput;
  mediaKind: AnalysisMediaKind;
  model: AnalysisModelSelection;
  productSnapshot?: ProductSnapshot | null;
}

export type AnalysisRunStage =
  | 'awaiting_model'
  | 'cancelled'
  | 'failed'
  | 'fusing_report'
  | 'preparing_evidence'
  | 'succeeded'
  | 'validating_input'
  | 'validating_model_output';

export interface AnalysisRunEvent {
  at: string;
  progress: number;
  runId: string;
  stage: AnalysisRunStage;
}

export interface AnalysisReportDraft {
  capabilities: MediaEvidenceOutput['provenance'];
  createdAt: string;
  cta: AnalysisClaim[];
  diagnoses: AnalysisDiagnosis[];
  draftId: string;
  emotion: EmotionPoint[];
  evidence: StructuredEvidence[];
  goalScene: AnalysisGoalScene;
  industry: AnalysisIndustry;
  limitations: string[];
  mediaKind: AnalysisMediaKind;
  model: {
    adapterVersion: string;
    configurationDisplayName: string;
    configurationId: string;
    configurationVersion: number;
    modelId: string;
    providerId: string;
    usage: ModelUsage;
  };
  productOrGameplay: AnalysisClaim[];
  productSnapshot: ProductSnapshot | null;
  prompt: Pick<AnalysisPromptPackage, 'id' | 'version'>;
  recommendations: AnalysisRecommendation[];
  ruleSnapshot: AnalysisRuleSnapshot;
  runId: string;
  schemaVersion: 1;
  score: MaterialScoreResult;
  scriptStructure: AnalysisClaim[];
  sellingPoints: AnalysisClaim[];
  shotBreakdown: AnalysisClaim[];
  status: 'awaiting_confirmation';
  subtitleContent: AnalysisClaim[];
  summary: string;
  tags: ReportTagResult[];
  timeline: TimelineEntry[];
  title: string;
  visualContent: AnalysisClaim[];
  voiceAndSound: AnalysisClaim[];
}

export type AnalysisRunResult =
  | {
      events: AnalysisRunEvent[];
      modelAudit: ModelInvocationAudit;
      ok: true;
      report: AnalysisReportDraft;
      runId: string;
    }
  | {
      error: {
        code: import('./errors').AnalysisEngineErrorCode;
        message: string;
        modelErrorCode: ModelApiErrorCode | null;
      };
      events: AnalysisRunEvent[];
      modelAudit: ModelInvocationAudit | null;
      ok: false;
      runId: string;
    };

export interface ModelCompletionPort {
  complete(
    request: ModelCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ModelInvocationResult>;
}

export type AnalysisRunListener = (event: AnalysisRunEvent) => void;
