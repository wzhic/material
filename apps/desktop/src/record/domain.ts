import {
  ConfirmedRecordInput,
  MaterialReferenceSnapshot,
  RecordFeedbackInput,
} from './types';

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 20_000;
const MAX_SHORT_TEXT = 500;
const FORBIDDEN_KEYS = new Set([
  'absolutepath',
  'apikey',
  'filepath',
  'internalprompt',
  'password',
  'privatekey',
  'prompt',
  'rawreasoning',
  'reasoning',
  'secret',
  'systemprompt',
  'toollog',
  'toollogs',
]);

export class RecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordValidationError';
  }
}

const requireText = (value: string, label: string, limit = MAX_SHORT_TEXT): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new RecordValidationError(`${label}不能为空`);
  }
  if (normalized.length > limit) {
    throw new RecordValidationError(`${label}内容过长`);
  }
  return normalized;
};

const validateFiniteRange = (
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void => {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RecordValidationError(`${label}超出允许范围`);
  }
};

const scanKeys = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(scanKeys);
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    const normalizedKey = key.replace(/[_-]/g, '').toLocaleLowerCase('en-US');
    if (FORBIDDEN_KEYS.has(normalizedKey)) {
      throw new RecordValidationError('记录快照包含不允许持久化的内部或敏感字段');
    }
    scanKeys(child);
  });
};

const validateMaterial = (material: MaterialReferenceSnapshot): void => {
  if (material.schemaVersion !== 1) {
    throw new RecordValidationError('素材引用版本不受支持');
  }
  requireText(material.displayName, '素材名称');
  validateFiniteRange(material.byteSize, 0, Number.MAX_SAFE_INTEGER, '素材大小');
  [material.durationMs, material.width, material.height].forEach((value) => {
    if (value !== null) {
      validateFiniteRange(value, 0, Number.MAX_SAFE_INTEGER, '素材元数据');
    }
  });
  if (!['available', 'mismatch', 'needs_relocation'].includes(material.sourceStatus)) {
    throw new RecordValidationError('源素材状态不受支持');
  }
  if (
    material.fingerprintSha256 !== null &&
    !/^[0-9a-f]{64}$/i.test(material.fingerprintSha256)
  ) {
    throw new RecordValidationError('素材指纹格式不正确');
  }
};

export const validateConfirmedRecord = (input: ConfirmedRecordInput): void => {
  if (
    input.confirmationId !== null
    && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.confirmationId)
  ) {
    throw new RecordValidationError('报告确认标识格式不正确');
  }
  validateMaterial(input.material);
  if (input.material.mediaKind !== 'image' && input.material.mediaKind !== 'video') {
    throw new RecordValidationError('媒体类型不受支持');
  }
  if (input.industry !== 'apparel' && input.industry !== 'game') {
    throw new RecordValidationError('行业不受支持');
  }
  if (input.productSnapshot && input.productSnapshot.industry !== input.industry) {
    throw new RecordValidationError('产品快照行业与分析行业不一致');
  }
  if (input.report.schemaVersion !== 1 || input.rules.schemaVersion !== 1) {
    throw new RecordValidationError('报告或规则快照版本不受支持');
  }
  if (input.run.schemaVersion !== 1) {
    throw new RecordValidationError('分析运行快照版本不受支持');
  }
  requireText(input.report.title, '报告标题');
  requireText(input.report.summary, '报告摘要', MAX_TEXT);
  requireText(input.rules.templateId, '模板标识');
  requireText(input.rules.templateVersion, '模板版本');
  requireText(input.rules.scoringRuleId, '评分规则标识');
  requireText(input.rules.scoringRuleVersion, '评分规则版本');
  requireText(input.run.modelConfigurationName, '模型配置显示名');
  requireText(input.run.modelId, '模型标识');
  requireText(input.run.capabilityVersion, '能力版本');
  if (input.run.adapterVersion !== undefined) {
    requireText(input.run.adapterVersion, '模型适配器版本');
  }
  if (input.run.modelConfigurationId !== undefined) {
    requireText(input.run.modelConfigurationId, '模型配置标识');
  }
  if (input.run.providerId !== undefined) {
    requireText(input.run.providerId, '模型提供方标识');
  }
  if (input.run.providerRequestedModelId !== undefined
    && input.run.providerRequestedModelId !== null) {
    requireText(input.run.providerRequestedModelId, '提供方请求模型标识');
  }
  if (input.run.providerReturnedModelId !== undefined
    && input.run.providerReturnedModelId !== null) {
    requireText(input.run.providerReturnedModelId, '实际返回模型标识');
  }
  if (input.run.providerReasoningEffort !== undefined
    && input.run.providerReasoningEffort !== null) {
    requireText(input.run.providerReasoningEffort, '提供方推理强度');
  }
  if (input.run.modelConfigurationVersion !== undefined) {
    validateFiniteRange(
      input.run.modelConfigurationVersion,
      0,
      Number.MAX_SAFE_INTEGER,
      '模型配置版本',
    );
  }
  if (input.run.usageAvailable !== undefined
    && typeof input.run.usageAvailable !== 'boolean') {
    throw new RecordValidationError('模型用量可用状态格式不正确');
  }
  if (input.run.usageAvailable === true
    && (!input.run.usage || input.run.usage.available !== true)) {
    throw new RecordValidationError('模型用量可用状态与数据不一致');
  }
  if (input.run.usageAvailable === undefined && input.run.usage !== undefined) {
    throw new RecordValidationError('模型用量缺少可用状态');
  }
  if (input.run.usageAvailable === false && input.run.usage !== undefined) {
    throw new RecordValidationError('未知模型用量不得伪造计数');
  }
  if (input.run.usage !== undefined) {
    if (typeof input.run.usage.available !== 'boolean') {
      throw new RecordValidationError('模型用量可用状态格式不正确');
    }
    [
      input.run.usage.completionTokens,
      input.run.usage.promptCacheHitTokens,
      input.run.usage.promptCacheMissTokens,
      input.run.usage.promptTokens,
      input.run.usage.totalTokens,
    ].forEach((value) => validateFiniteRange(
      value,
      0,
      Number.MAX_SAFE_INTEGER,
      '模型用量',
    ));
    if (input.run.usageAvailable !== undefined
      && input.run.usageAvailable !== input.run.usage.available) {
      throw new RecordValidationError('模型用量可用状态不一致');
    }
    if (input.run.usage.promptCacheHitTokens
        + input.run.usage.promptCacheMissTokens !== input.run.usage.promptTokens
      || input.run.usage.promptTokens
        + input.run.usage.completionTokens !== input.run.usage.totalTokens) {
      throw new RecordValidationError('模型用量计数不一致');
    }
  }
  if (Number.isNaN(new Date(input.run.completedAt).getTime())) {
    throw new RecordValidationError('分析完成时间格式不正确');
  }
  if (input.report.score.total !== null) {
    validateFiniteRange(input.report.score.total, 0, 100, '素材总评分');
  }
  input.report.score.dimensions.forEach((dimension) => {
    requireText(dimension.id, '评分维度标识');
    requireText(dimension.label, '评分维度名称');
    if (dimension.score !== null) {
      validateFiniteRange(dimension.score, 0, 100, '评分维度分数');
    }
    if (
      dimension.status !== undefined
      && !['insufficient_evidence', 'not_applicable', 'scored'].includes(dimension.status)
    ) {
      throw new RecordValidationError('评分维度状态不受支持');
    }
    if (
      (dimension.status === 'scored' && dimension.score === null)
      || (
        dimension.status !== undefined
        && dimension.status !== 'scored'
        && dimension.score !== null
      )
    ) {
      throw new RecordValidationError('评分维度状态与分数不一致');
    }
  });
  const evidenceIds = new Set(input.report.evidence.map((evidence) => evidence.id));
  if (evidenceIds.size !== input.report.evidence.length) {
    throw new RecordValidationError('报告证据标识不能重复');
  }
  input.report.evidence.forEach((evidence) => {
    requireText(evidence.id, '证据标识');
    requireText(evidence.label, '证据名称');
    if (
      evidence.startMs !== null &&
      evidence.endMs !== null &&
      evidence.endMs < evidence.startMs
    ) {
      throw new RecordValidationError('证据结束时间不能早于开始时间');
    }
  });
  [...input.report.tags, ...input.report.diagnoses].forEach((item) => {
    item.evidenceIds.forEach((id) => {
      if (!evidenceIds.has(id)) {
        throw new RecordValidationError('报告引用了不存在的证据');
      }
    });
  });
  if (typeof input.conversionContext !== 'string' || input.conversionContext.length > 2_000) {
    throw new RecordValidationError('转化依据内容过长');
  }
  if (input.sourceRecordId && !/^[0-9a-f-]{36}$/i.test(input.sourceRecordId)) {
    throw new RecordValidationError('来源分析记录标识格式不正确');
  }
  if (!Array.isArray(input.visibleConversation)) {
    throw new RecordValidationError('可见对话格式不正确');
  }
  if (input.visibleConversation.length > 100) {
    throw new RecordValidationError('可见对话条目过多');
  }
  input.visibleConversation.forEach((item) => {
    if (!['assistant', 'user'].includes(item.role)) {
      throw new RecordValidationError('可见对话角色不受支持');
    }
    requireText(item.text, '可见对话', 2_000);
    if (item.timeReferenceMs !== null) {
      validateFiniteRange(
        item.timeReferenceMs,
        0,
        input.material.durationMs ?? Number.MAX_SAFE_INTEGER,
        '可见对话时间引用',
      );
    }
  });
  scanKeys(input);
  const encoded = Buffer.byteLength(JSON.stringify(input), 'utf8');
  if (encoded > MAX_RECORD_BYTES) {
    throw new RecordValidationError('单条分析记录超过本地安全上限');
  }
};

export const normalizeFeedback = (input: RecordFeedbackInput): RecordFeedbackInput => {
  validateFiniteRange(input.rating, 1, 5, '可信程度');
  if (input.reason.length > 2_000 || input.weightDirection.length > 2_000) {
    throw new RecordValidationError('反馈内容过长');
  }
  return {
    rating: input.rating,
    reason: input.reason.trim(),
    weightDirection: input.weightDirection.trim(),
  };
};

export const normalizeRecordSearch = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN');
