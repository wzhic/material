import { AnalysisRuleError } from './errors';
import {
  DimensionAssessment,
  MaterialScoreResult,
  ScoredDimension,
  ScoringRuleDefinition,
} from './types';

const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const validateEvidenceIds = (ids: readonly string[], path: string): string[] => {
  if (
    ids.length > 64
    || new Set(ids).size !== ids.length
    || ids.some((id) => !EVIDENCE_ID_PATTERN.test(id))
  ) {
    throw new AnalysisRuleError('ASSESSMENT_INVALID', `${path} 的证据引用无效`);
  }
  return [...ids];
};

export const calculateMaterialScore = (
  rule: ScoringRuleDefinition,
  assessments: readonly DimensionAssessment[],
): MaterialScoreResult => {
  const definitions = new Map(rule.dimensions.map((dimension) => [dimension.id, dimension]));
  const assessmentMap = new Map<string, DimensionAssessment>();
  for (const assessment of assessments) {
    if (!definitions.has(assessment.dimensionId) || assessmentMap.has(assessment.dimensionId)) {
      throw new AnalysisRuleError('ASSESSMENT_INVALID', '评分包含未知或重复维度');
    }
    validateEvidenceIds(assessment.evidenceIds, assessment.dimensionId);
    if (assessment.status === 'scored') {
      if (
        !Number.isFinite(assessment.score)
        || assessment.score < 0
        || assessment.score > 100
        || assessment.evidenceIds.length === 0
      ) {
        throw new AnalysisRuleError(
          'ASSESSMENT_INVALID',
          `${assessment.dimensionId} 的分数或证据不完整`,
        );
      }
    } else if (assessment.score !== undefined) {
      throw new AnalysisRuleError('ASSESSMENT_INVALID', '未评分维度不能携带分数');
    }
    assessmentMap.set(assessment.dimensionId, assessment);
  }
  if (assessmentMap.size !== definitions.size) {
    throw new AnalysisRuleError('ASSESSMENT_INVALID', '必须显式声明每个评分维度的状态');
  }

  const applicableWeight = rule.dimensions.reduce((sum, dimension) => {
    const assessment = assessmentMap.get(dimension.id) as DimensionAssessment;
    return assessment.status === 'not_applicable' ? sum : sum + dimension.weight;
  }, 0);
  const scoredWeight = rule.dimensions.reduce((sum, dimension) => {
    const assessment = assessmentMap.get(dimension.id) as DimensionAssessment;
    return assessment.status === 'scored' ? sum + dimension.weight : sum;
  }, 0);
  const coverage = applicableWeight > 0 ? round(scoredWeight / applicableWeight, 4) : 0;
  const canScore = scoredWeight > 0 && coverage >= rule.minimumCoverage;

  const dimensions: ScoredDimension[] = rule.dimensions.map((definition) => {
    const assessment = assessmentMap.get(definition.id) as DimensionAssessment;
    const normalizedWeight = assessment.status === 'scored' && canScore
      ? definition.weight / scoredWeight
      : null;
    const score = assessment.status === 'scored' ? assessment.score : null;
    return {
      contribution: score !== null && normalizedWeight !== null
        ? round(score * normalizedWeight, 4)
        : null,
      dimensionId: definition.id,
      evidenceIds: [...assessment.evidenceIds],
      label: definition.label,
      normalizedWeight: normalizedWeight === null ? null : round(normalizedWeight, 6),
      score,
      status: assessment.status,
      weight: definition.weight,
    };
  });
  const total = canScore
    ? round(dimensions.reduce((sum, dimension) => sum + (dimension.contribution ?? 0), 0), 1)
    : null;
  const insufficient = dimensions
    .filter((dimension) => dimension.status === 'insufficient_evidence')
    .map((dimension) => dimension.label);
  const limitations = insufficient.map((label) => `${label}证据不足，未按 0 分计入`);
  if (!canScore) {
    limitations.push(
      `有效证据权重覆盖率 ${round(coverage * 100, 1)}%，低于规则门槛 ${round(rule.minimumCoverage * 100, 1)}%`,
    );
  }
  return {
    coverage,
    dimensions,
    limitations,
    scoringRuleId: rule.id,
    scoringRuleVersion: rule.version,
    status: canScore ? 'scored' : 'insufficient_evidence',
    total,
  };
};
