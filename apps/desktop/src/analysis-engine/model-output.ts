import { AnalysisEngineError } from './errors';
import type {
  EvidencePacketItem,
  AnalysisClaim,
  AnalysisDiagnosis,
  AnalysisGoalScene,
  AnalysisRecommendation,
  EmotionPoint,
  ModelAnalysisOutput,
} from './types';
import type {
  AnalysisIndustry,
  AnalysisMediaKind,
  AnalysisRulePackage,
  DimensionAssessment,
} from '../analysis-rules';
import { normalizeTagText } from '../analysis-rules';

const ROOT_KEYS = new Set([
  'cta', 'diagnoses', 'dimensionAssessments', 'dynamicTags', 'emotion',
  'fixedTags', 'goalScene', 'limitations', 'productOrGameplay',
  'recommendations', 'schemaVersion', 'scriptStructure', 'sellingPoints',
  'shotBreakdown', 'subtitleContent', 'summary', 'title', 'visualContent',
  'voiceAndSound',
]);
const CLAIM_KEYS = new Set(['evidenceIds', 'text']);
const EMOTION_KEYS = new Set(['evidenceIds', 'intensity', 'text', 'timeMs']);
const DIAGNOSIS_KEYS = new Set([
  'evidenceIds', 'impact', 'problem', 'relatedDimensionIds', 'severity',
]);
const RECOMMENDATION_KEYS = new Set([
  'action', 'diagnosisIndexes', 'priority', 'rationale',
]);
const FIXED_TAG_KEYS = new Set(['evidenceIds', 'tagId']);
const DYNAMIC_TAG_KEYS = new Set(['evidenceIds', 'facet', 'label']);
const DIMENSION_KEYS = new Set(['dimensionId', 'evidenceIds', 'score', 'status']);
const FACET_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const invalid = (message: string): never => {
  throw new AnalysisEngineError('MODEL_OUTPUT_INVALID', message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactRecord = (
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> => {
  if (
    !isRecord(value)
    || Object.keys(value).length !== keys.size
    || Object.keys(value).some((key) => !keys.has(key))
  ) {
    return invalid(`${label}字段合同无效`);
  }
  return value;
};

const text = (value: unknown, maximum: number, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    return invalid(`${label}文本无效`);
  }
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
};

const stringList = (
  value: unknown,
  maximumItems: number,
  maximumText: number,
  label: string,
  allowEmpty = true,
): string[] => {
  if (!Array.isArray(value) || value.length > maximumItems || (!allowEmpty && value.length === 0)) {
    return invalid(`${label}数量无效`);
  }
  const result = value.map((item) => text(item, maximumText, label));
  if (new Set(result).size !== result.length) return invalid(`${label}存在重复项`);
  return result;
};

const evidenceIds = (
  value: unknown,
  known: ReadonlySet<string>,
  label: string,
  allowEmpty = false,
): string[] => {
  const values = stringList(value, 64, 128, label, allowEmpty);
  if (values.some((id) => !known.has(id))) return invalid(`${label}引用了未发送的证据`);
  return values;
};

const objectList = (
  value: unknown,
  maximum: number,
  label: string,
): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) return invalid(`${label}数量无效`);
  return value;
};

const parseClaims = (
  value: unknown,
  known: ReadonlySet<string>,
  label: string,
): AnalysisClaim[] => objectList(value, 60, label).map((item) => {
  const record = exactRecord(item, CLAIM_KEYS, label);
  return {
    evidenceIds: evidenceIds(record.evidenceIds, known, label),
    text: text(record.text, 2_000, label),
  };
});

const parseEmotion = (
  value: unknown,
  known: ReadonlySet<string>,
  mediaKind: AnalysisMediaKind,
  maximumTimeMs: number,
): EmotionPoint[] => objectList(value, 100, '情绪变化').map((item) => {
  const record = exactRecord(item, EMOTION_KEYS, '情绪变化');
  const intensity = record.intensity;
  const timeMs = record.timeMs;
  if (
    intensity !== null
    && (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < -1 || intensity > 1)
  ) return invalid('情绪强度必须在 -1 到 1 之间或为 null');
  if (
    timeMs !== null
    && (typeof timeMs !== 'number' || !Number.isFinite(timeMs) || timeMs < 0)
  ) return invalid('情绪时间无效');
  if (mediaKind === 'image' && timeMs !== null) return invalid('图片情绪不能携带时间点');
  if (mediaKind === 'video' && typeof timeMs === 'number' && timeMs > maximumTimeMs) {
    return invalid('情绪时间超出当前证据时间范围');
  }
  return {
    evidenceIds: evidenceIds(record.evidenceIds, known, '情绪变化'),
    intensity: intensity as number | null,
    text: text(record.text, 2_000, '情绪变化'),
    timeMs: timeMs as number | null,
  };
});

const parseDimensions = (
  value: unknown,
  known: ReadonlySet<string>,
  evidence: ReadonlyMap<string, EvidencePacketItem>,
  rule: AnalysisRulePackage,
): DimensionAssessment[] => {
  const dimensions = objectList(value, 50, '评分维度');
  if (dimensions.length !== rule.scoring.dimensions.length) {
    return invalid('必须逐个返回当前规则声明的评分维度');
  }
  const knownDimensions = new Set(rule.scoring.dimensions.map((item) => item.id));
  const seen = new Set<string>();
  return dimensions.map((item) => {
    const record = exactRecord(item, DIMENSION_KEYS, '评分维度');
    const dimensionId = text(record.dimensionId, 100, '评分维度标识');
    if (!knownDimensions.has(dimensionId) || seen.has(dimensionId)) {
      return invalid('评分维度未知或重复');
    }
    seen.add(dimensionId);
    const status = record.status;
    if (status === 'scored') {
      if (
        typeof record.score !== 'number'
        || !Number.isFinite(record.score)
        || record.score < 0
        || record.score > 100
      ) return invalid('已评分维度的分数无效');
      const referencedEvidence = evidenceIds(
        record.evidenceIds,
        known,
        `评分维度 ${dimensionId}`,
      );
      const definition = rule.scoring.dimensions.find((item) => item.id === dimensionId);
      const compatible = referencedEvidence.some((id) => {
        const item = evidence.get(id);
        return item !== undefined && definition?.evidenceKinds.some((kind) =>
          item.evidenceType.split('.').includes(kind)
          || (kind === 'timeline' && item.locator.kind === 'video_time')
          || (kind === 'region' && item.locator.kind === 'image_region'),
        );
      });
      if (!compatible) return invalid(`评分维度 ${dimensionId} 缺少兼容类型的证据`);
      return {
        dimensionId,
        evidenceIds: referencedEvidence,
        score: record.score,
        status,
      };
    }
    if (!['insufficient_evidence', 'not_applicable'].includes(String(status)) || record.score !== null) {
      return invalid('未评分维度必须使用受支持状态且 score 为 null');
    }
    return {
      dimensionId,
      evidenceIds: evidenceIds(
        record.evidenceIds,
        known,
        `评分维度 ${dimensionId}`,
        true,
      ),
      status: status as 'insufficient_evidence' | 'not_applicable',
    };
  });
};

const parseDiagnoses = (
  value: unknown,
  known: ReadonlySet<string>,
  rule: AnalysisRulePackage,
): AnalysisDiagnosis[] => {
  const knownDimensions = new Set(rule.scoring.dimensions.map((item) => item.id));
  return objectList(value, 30, '问题诊断').map((item) => {
    const record = exactRecord(item, DIAGNOSIS_KEYS, '问题诊断');
    const relatedDimensionIds = stringList(
      record.relatedDimensionIds,
      knownDimensions.size,
      100,
      '关联评分维度',
    );
    if (relatedDimensionIds.some((id) => !knownDimensions.has(id))) {
      return invalid('问题诊断引用了未知评分维度');
    }
    if (!['high', 'low', 'medium'].includes(String(record.severity))) {
      return invalid('问题严重度无效');
    }
    return {
      evidenceIds: evidenceIds(record.evidenceIds, known, '问题诊断'),
      impact: text(record.impact, 2_000, '问题影响'),
      problem: text(record.problem, 2_000, '问题描述'),
      relatedDimensionIds,
      severity: record.severity as AnalysisDiagnosis['severity'],
    };
  });
};

const parseRecommendations = (
  value: unknown,
  diagnosisCount: number,
): AnalysisRecommendation[] => objectList(value, 30, '优化建议').map((item) => {
  const record = exactRecord(item, RECOMMENDATION_KEYS, '优化建议');
  if (!['next', 'now', 'test'].includes(String(record.priority))) {
    return invalid('优化建议优先级无效');
  }
  if (
    !Array.isArray(record.diagnosisIndexes)
    || record.diagnosisIndexes.length === 0
    || record.diagnosisIndexes.length > diagnosisCount
    || record.diagnosisIndexes.some((index) =>
      !Number.isInteger(index) || index < 0 || index >= diagnosisCount,
    )
    || new Set(record.diagnosisIndexes).size !== record.diagnosisIndexes.length
  ) return invalid('优化建议必须引用有效的问题诊断序号');
  return {
    action: text(record.action, 2_000, '优化动作'),
    diagnosisIndexes: record.diagnosisIndexes as number[],
    priority: record.priority as AnalysisRecommendation['priority'],
    rationale: text(record.rationale, 2_000, '优化理由'),
  };
});

export interface ModelOutputValidationContext {
  evidence: ReadonlyMap<string, EvidencePacketItem>;
  evidenceIds: ReadonlySet<string>;
  industry: AnalysisIndustry;
  maximumTimeMs: number;
  mediaKind: AnalysisMediaKind;
  rule: AnalysisRulePackage;
}

export const parseModelAnalysisOutput = (
  content: string,
  context: ModelOutputValidationContext,
): ModelAnalysisOutput => {
  if (!content.trim() || content.length > 1_000_000) return invalid('模型输出为空或超过上限');
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return invalid('模型输出不是严格 JSON');
  }
  const root = exactRecord(value, ROOT_KEYS, '模型输出');
  if (root.schemaVersion !== 1) return invalid('模型输出版本无效');
  const goalScene = root.goalScene;
  const allowedGoals: AnalysisGoalScene[] = context.industry === 'apparel'
    ? ['purchase_conversion']
    : ['acquisition', 'reactivation', 'unclear'];
  if (!allowedGoals.includes(goalScene as AnalysisGoalScene)) return invalid('分析目标场景无效');
  const voiceAndSound = parseClaims(root.voiceAndSound, context.evidenceIds, '口播与声音');
  if (context.mediaKind === 'image' && voiceAndSound.length > 0) {
    return invalid('图片报告不能生成口播与声音结论');
  }
  const diagnoses = parseDiagnoses(root.diagnoses, context.evidenceIds, context.rule);
  const knownFixedTags = new Map(
    context.rule.tags.fixedTags.map((tag) => [tag.id, tag]),
  );
  const seenFixedTags = new Set<string>();
  const fixedTags = objectList(
    root.fixedTags,
    context.rule.tags.fixedTags.length,
    '固定标签',
  ).map((item) => {
    const record = exactRecord(item, FIXED_TAG_KEYS, '固定标签');
    const tagId = text(record.tagId, 100, '固定标签标识');
    if (!knownFixedTags.has(tagId) || seenFixedTags.has(tagId)) {
      return invalid('固定标签未知或重复');
    }
    seenFixedTags.add(tagId);
    return {
      evidenceIds: evidenceIds(record.evidenceIds, context.evidenceIds, '固定标签'),
      tagId,
    };
  });
  const fixedLabels = new Set(
    context.rule.tags.fixedTags.map((tag) => normalizeTagText(tag.label)),
  );
  const fixedIds = new Set(
    context.rule.tags.fixedTags.map((tag) => normalizeTagText(tag.id)),
  );
  const seenDynamicTags = new Set<string>();
  const dynamicTags = objectList(root.dynamicTags, 24, '动态标签').map((item) => {
    const record = exactRecord(item, DYNAMIC_TAG_KEYS, '动态标签');
    const facet = text(record.facet, 100, '动态标签分面');
    if (!FACET_PATTERN.test(facet)) return invalid('动态标签分面无效');
    const label = text(record.label, 40, '动态标签');
    const normalizedLabel = normalizeTagText(label);
    const key = `${facet}:${normalizedLabel}`;
    if (
      fixedLabels.has(normalizedLabel)
      || fixedIds.has(normalizedLabel)
      || seenDynamicTags.has(key)
    ) return invalid('动态标签重复或覆盖固定标签');
    seenDynamicTags.add(key);
    return {
      evidenceIds: evidenceIds(record.evidenceIds, context.evidenceIds, '动态标签'),
      facet,
      label,
    };
  });
  return {
    cta: parseClaims(root.cta, context.evidenceIds, 'CTA'),
    diagnoses,
    dimensionAssessments: parseDimensions(
      root.dimensionAssessments,
      context.evidenceIds,
      context.evidence,
      context.rule,
    ),
    dynamicTags,
    emotion: parseEmotion(
      root.emotion,
      context.evidenceIds,
      context.mediaKind,
      context.maximumTimeMs,
    ),
    fixedTags,
    goalScene: goalScene as AnalysisGoalScene,
    limitations: stringList(root.limitations, 30, 1_000, '模型局限说明'),
    productOrGameplay: parseClaims(
      root.productOrGameplay,
      context.evidenceIds,
      '商品或玩法',
    ),
    recommendations: parseRecommendations(root.recommendations, diagnoses.length),
    schemaVersion: 1,
    scriptStructure: parseClaims(root.scriptStructure, context.evidenceIds, '脚本结构'),
    sellingPoints: parseClaims(root.sellingPoints, context.evidenceIds, '卖点'),
    shotBreakdown: parseClaims(root.shotBreakdown, context.evidenceIds, '镜头拆解'),
    subtitleContent: parseClaims(root.subtitleContent, context.evidenceIds, '字幕'),
    summary: text(root.summary, 4_000, '报告摘要'),
    title: text(root.title, 200, '报告标题'),
    visualContent: parseClaims(root.visualContent, context.evidenceIds, '画面内容'),
    voiceAndSound,
  };
};
