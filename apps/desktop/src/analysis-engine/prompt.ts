import promptInput from './prompts/fusion-analysis.v1.json';
import { AnalysisEngineError } from './errors';
import type {
  AnalysisPromptPackage,
  AnalysisRunInput,
  EvidencePacket,
} from './types';
import type { AnalysisRuleSnapshot } from '../analysis-rules';
import type { ModelCompletionRequest } from '../model/types';
import { buildAnalysisOutputSchema } from './output-schema';

const EXACT_PROMPT_KEYS = new Set([
  'id',
  'schemaVersion',
  'systemInstruction',
  'taskInstruction',
  'version',
]);
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const boundedString = (
  value: unknown,
  maximum: number,
  label: string,
): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new AnalysisEngineError('INPUT_INVALID', `${label}无效`);
  }
  return value.trim();
};

export const parsePromptPackage = (value: unknown): AnalysisPromptPackage => {
  if (
    !isRecord(value)
    || Object.keys(value).length !== EXACT_PROMPT_KEYS.size
    || Object.keys(value).some((key) => !EXACT_PROMPT_KEYS.has(key))
    || value.schemaVersion !== 1
  ) {
    throw new AnalysisEngineError('INPUT_INVALID', '分析提示词包合同无效');
  }
  const id = boundedString(value.id, 100, '提示词包标识');
  const version = boundedString(value.version, 40, '提示词包版本');
  if (!ID_PATTERN.test(id) || !VERSION_PATTERN.test(version)) {
    throw new AnalysisEngineError('INPUT_INVALID', '分析提示词包标识或版本无效');
  }
  return {
    id,
    schemaVersion: 1,
    systemInstruction: boundedString(value.systemInstruction, 8_000, '系统指令'),
    taskInstruction: boundedString(value.taskInstruction, 8_000, '任务指令'),
    version,
  };
};

export const loadBuiltinAnalysisPrompt = (): AnalysisPromptPackage =>
  parsePromptPackage(promptInput);

export const buildAnalysisModelRequest = (
  input: AnalysisRunInput,
  ruleSnapshot: AnalysisRuleSnapshot,
  packet: EvidencePacket,
  prompt: AnalysisPromptPackage,
): ModelCompletionRequest => {
  const rule = ruleSnapshot.package;
  const payload = {
    context: {
      conversionContext: input.conversionContext?.trim() || null,
      goal: rule.template.goal,
      industry: input.industry,
      mediaKind: input.mediaKind,
      productSnapshot: input.productSnapshot ?? null,
      visualEvidence: input.visualInputs?.map((visual) => ({
        evidenceId: visual.evidenceId,
        timeMs: visual.timeMs,
      })) ?? [],
    },
    evidencePacket: {
      items: packet.items,
      limitations: packet.limitations,
      omittedEvidenceCount: packet.omittedEvidenceCount,
      schemaVersion: packet.schemaVersion,
      truncatedTextCount: packet.truncatedTextCount,
    },
    outputContract: {
      claims: '每条 claim 使用 {text,evidenceIds}，且至少引用一个已发送 evidenceId',
      dimensions: '逐个返回 {dimensionId,status,score,evidenceIds}；未评分时 score 必须为 null',
      emotion: '使用 {text,evidenceIds,intensity,timeMs}；图片的 timeMs 必须为 null',
      goalScene: input.industry === 'apparel'
        ? 'purchase_conversion'
        : 'acquisition | reactivation | unclear',
      rootFields: [
        'schemaVersion', 'title', 'summary', 'goalScene', 'scriptStructure',
        'shotBreakdown', 'visualContent', 'subtitleContent', 'voiceAndSound',
        'productOrGameplay', 'sellingPoints', 'emotion', 'cta', 'fixedTags',
        'dynamicTags', 'dimensionAssessments', 'diagnoses', 'recommendations',
        'limitations',
      ],
      schemaVersion: 1,
    },
    rules: {
      fixedTags: rule.tags.fixedTags,
      scoring: rule.scoring,
      template: rule.template,
    },
    taskInstruction: prompt.taskInstruction,
  };
  return {
    configurationId: input.model.configurationId,
    format: 'json',
    maxTokens: 8_192,
    messages: [
      { content: prompt.systemInstruction, role: 'system' },
      { content: JSON.stringify(payload), role: 'user' },
    ],
    modelId: input.model.modelId,
    outputSchema: buildAnalysisOutputSchema(rule, input.industry, input.mediaKind),
    temperature: 0.2,
    thinking: 'disabled',
    ...(input.visualInputs?.length ? { visualInputs: input.visualInputs } : {}),
  };
};
