import type { AnalysisRuntimeResult } from '../analysis-runtime/types';
import type { MaterialSession } from '../media/types';
import type {
  ConfirmedRecordInput,
  ReportDiagnosis,
  VisibleConversationItem,
} from './types';

type ReportData = Extract<AnalysisRuntimeResult, { ok: true }>['data'];

interface ConfirmationContext {
  sourceRecordId?: string | null;
  visibleConversation?: VisibleConversationItem[];
}

const recommendationFor = (
  data: ReportData,
  diagnosisIndex: number,
): string => {
  const recommendations = data.report.recommendations.filter((item) =>
    item.diagnosisIndexes.includes(diagnosisIndex));
  if (!recommendations.length) {
    return '当前报告未生成与该问题直接对应的优化动作。';
  }
  return recommendations
    .map((item) => `${item.action}${item.rationale ? `：${item.rationale}` : ''}`)
    .join('；');
};

const diagnoses = (data: ReportData): ReportDiagnosis[] =>
  data.report.diagnoses.map((item, index) => ({
    evidenceIds: [...item.evidenceIds],
    problem: item.problem,
    suggestion: recommendationFor(data, index),
  }));

const capabilityVersion = (data: ReportData): string => {
  const values = data.report.capabilities
    .map((item) => `${item.capabilityId}@${item.runtimeVersion}`)
    .sort();
  return values.length ? values.join(',').slice(0, 500) : 'media-evidence-v1';
};

export const createConfirmedRecordInput = (
  data: ReportData,
  material: MaterialSession,
  conversionContext: string,
  context: ConfirmationContext = {},
): ConfirmedRecordInput => {
  const { report } = data;
  const rule = report.ruleSnapshot.package;
  return {
    confirmationId: report.draftId,
    conversionContext: conversionContext.trim(),
    industry: report.industry,
    material: {
      byteSize: material.summary.size,
      displayName: material.summary.name,
      durationMs: report.mediaKind === 'video' ? data.media.durationMs : null,
      fingerprintSha256: material.summary.fingerprintSha256,
      height: data.media.height,
      mediaKind: report.mediaKind,
      schemaVersion: 1,
      sourceStatus: material.sourceStatus === 'available'
        ? 'needs_relocation'
        : material.sourceStatus,
      width: data.media.width,
    },
    productSnapshot: report.productSnapshot ? structuredClone(report.productSnapshot) : null,
    report: {
      ctaSummary: report.cta.map((item) => item.text),
      diagnoses: diagnoses(data),
      emotionSummary: report.emotion.map((item) => item.text),
      evidence: report.evidence.map((item) => ({
        endMs: item.locator.kind === 'video_time' ? item.locator.endMs ?? null : null,
        id: item.evidenceId,
        label: item.evidenceType,
        source: item.source.kind,
        startMs: item.locator.kind === 'video_time' ? item.locator.startMs : null,
        summary: item.text,
      })),
      limitations: [...report.limitations],
      score: {
        dimensions: report.score.dimensions.map((item) => ({
          id: item.dimensionId,
          label: item.label,
          score: item.score,
          status: item.status,
        })),
        total: report.score.total,
      },
      schemaVersion: 1,
      scriptStructure: report.scriptStructure.map((item) => item.text),
      sellingPoints: report.sellingPoints.map((item) => item.text),
      shotSummary: report.shotBreakdown.map((item) => item.text),
      subtitleSummary: report.subtitleContent.map((item) => item.text),
      summary: report.summary,
      tags: report.tags.map((item) => ({
        evidenceIds: [...item.evidenceIds],
        label: item.label,
        source: item.kind,
      })),
      title: report.title,
      visualSummary: report.visualContent.map((item) => item.text),
      voiceAndSoundSummary: report.voiceAndSound.map((item) => item.text),
    },
    rules: {
      schemaVersion: 1,
      scoringRuleId: rule.scoring.id,
      scoringRuleVersion: rule.scoring.version,
      tagPackageVersion: rule.tags.version,
      templateId: rule.template.id,
      templateVersion: rule.template.version,
    },
    run: {
      capabilityVersion: capabilityVersion(data),
      completedAt: report.createdAt,
      modelConfigurationName: report.model.configurationDisplayName,
      modelId: report.model.modelId,
      schemaVersion: 1,
    },
    sourceRecordId: context.sourceRecordId ?? null,
    visibleConversation: structuredClone(context.visibleConversation ?? []),
  };
};
