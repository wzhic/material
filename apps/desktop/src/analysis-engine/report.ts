import type {
  AnalysisPromptPackage,
  AnalysisReportDraft,
  AnalysisRunInput,
  ModelAnalysisOutput,
} from './types';
import {
  calculateMaterialScore,
  validateReportTags,
} from '../analysis-rules';
import type { AnalysisRuleSnapshot } from '../analysis-rules';
import type { ModelInvocationAudit, ModelUsage } from '../model/types';

const uniqueLimitations = (values: readonly string[]): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
};

export interface FuseAnalysisReportInput {
  audit: ModelInvocationAudit;
  createdAt: string;
  draftId: string;
  modelOutput: ModelAnalysisOutput;
  prompt: AnalysisPromptPackage;
  ruleSnapshot: AnalysisRuleSnapshot;
  runId: string;
  runInput: AnalysisRunInput;
  usage: ModelUsage;
  visibleLimitations: readonly string[];
}

export const fuseAnalysisReport = (
  input: FuseAnalysisReportInput,
): AnalysisReportDraft => {
  const rule = input.ruleSnapshot.package;
  const knownEvidenceIds = new Set(
    input.runInput.media.evidence.map((item) => item.evidenceId),
  );
  const score = calculateMaterialScore(
    rule.scoring,
    input.modelOutput.dimensionAssessments,
  );
  const tags = validateReportTags(rule.tags, {
    dynamicTags: input.modelOutput.dynamicTags.map((tag) => ({
      ...tag,
      origin: 'model' as const,
    })),
    evidenceIds: knownEvidenceIds,
    fixedTags: input.modelOutput.fixedTags,
  });
  return {
    capabilities: structuredClone(input.runInput.media.provenance),
    createdAt: input.createdAt,
    cta: structuredClone(input.modelOutput.cta),
    diagnoses: structuredClone(input.modelOutput.diagnoses),
    draftId: input.draftId,
    emotion: structuredClone(input.modelOutput.emotion),
    evidence: structuredClone([...input.runInput.media.evidence]),
    goalScene: input.modelOutput.goalScene,
    industry: input.runInput.industry,
    limitations: uniqueLimitations([
      ...input.runInput.media.limitations,
      ...input.visibleLimitations,
      ...input.modelOutput.limitations,
      ...score.limitations,
    ]),
    mediaKind: input.runInput.mediaKind,
    model: {
      adapterVersion: input.audit.adapterVersion,
      configurationDisplayName: input.runInput.model.configurationDisplayName,
      configurationId: input.audit.configurationId,
      configurationVersion: input.audit.configurationVersion,
      modelId: input.audit.modelId,
      providerId: input.audit.providerId,
      usage: structuredClone(input.usage),
    },
    productOrGameplay: structuredClone(input.modelOutput.productOrGameplay),
    productSnapshot: input.runInput.productSnapshot
      ? structuredClone(input.runInput.productSnapshot)
      : null,
    prompt: { id: input.prompt.id, version: input.prompt.version },
    recommendations: structuredClone(input.modelOutput.recommendations),
    ruleSnapshot: input.ruleSnapshot,
    runId: input.runId,
    schemaVersion: 1,
    score,
    scriptStructure: structuredClone(input.modelOutput.scriptStructure),
    sellingPoints: structuredClone(input.modelOutput.sellingPoints),
    shotBreakdown: structuredClone(input.modelOutput.shotBreakdown),
    status: 'awaiting_confirmation',
    subtitleContent: structuredClone(input.modelOutput.subtitleContent),
    summary: input.modelOutput.summary,
    tags,
    timeline: structuredClone([...input.runInput.media.timeline]),
    title: input.modelOutput.title,
    visualContent: structuredClone(input.modelOutput.visualContent),
    voiceAndSound: structuredClone(input.modelOutput.voiceAndSound),
  };
};
