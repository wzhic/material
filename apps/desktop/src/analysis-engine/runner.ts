import { randomUUID } from 'node:crypto';

import { AnalysisEngineError } from './errors';
import { buildEvidencePacket } from './evidence-packet';
import { parseModelAnalysisOutput } from './model-output';
import {
  buildAnalysisModelRequest,
  loadBuiltinAnalysisPrompt,
  parsePromptPackage,
} from './prompt';
import { fuseAnalysisReport } from './report';
import type {
  AnalysisPromptPackage,
  AnalysisRunEvent,
  AnalysisRunInput,
  AnalysisRunListener,
  AnalysisRunResult,
  AnalysisRunStage,
  ModelCompletionPort,
} from './types';
import {
  AnalysisRuleError,
  AnalysisRuleRegistry,
  createBuiltinRuleRegistry,
} from '../analysis-rules';
import type { ModelInvocationAudit } from '../model/types';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export interface AnalysisEngineOptions {
  clock?: () => Date;
  idFactory?: () => string;
  prompt?: unknown;
  registry?: AnalysisRuleRegistry;
}

const maximumEvidenceTime = (input: AnalysisRunInput): number => {
  if (input.mediaKind === 'image') return 0;
  const evidenceTimes = input.media.evidence.flatMap((item) =>
    item.locator.kind === 'video_time'
      ? [item.locator.startMs, item.locator.endMs ?? item.locator.startMs]
      : [],
  );
  const timelineTimes = input.media.timeline.flatMap((item) =>
    [item.startMs, item.endMs ?? item.startMs],
  );
  return Math.max(0, ...evidenceTimes, ...timelineTimes);
};

const validateRunInput = (input: AnalysisRunInput): void => {
  if (
    !['apparel', 'game'].includes(input.industry)
    || !['image', 'video'].includes(input.mediaKind)
    || input.media.material.kind !== input.mediaKind
  ) {
    throw new AnalysisEngineError('INPUT_INVALID', '行业或媒体类型与当前素材不一致');
  }
  if (
    !ID_PATTERN.test(input.model.configurationId)
    || !ID_PATTERN.test(input.model.modelId)
    || !input.model.configurationDisplayName.trim()
    || input.model.configurationDisplayName.length > 100
  ) {
    throw new AnalysisEngineError('INPUT_INVALID', '显式选择的模型配置无效');
  }
  if (
    input.conversionContext !== undefined
    && input.conversionContext.trim().length > 2_000
  ) {
    throw new AnalysisEngineError('INPUT_INVALID', '补充转化信息超过 2000 字上限');
  }
  if (
    input.productSnapshot
    && (
      input.productSnapshot.schemaVersion !== 1
      || input.productSnapshot.industry !== input.industry
      || !input.productSnapshot.name.trim()
      || input.productSnapshot.name.length > 160
      || JSON.stringify(input.productSnapshot).length > 100_000
    )
  ) {
    throw new AnalysisEngineError('INPUT_INVALID', '产品快照与本次分析上下文不一致');
  }
};

const isCancelled = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

export class AnalysisEngine {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly prompt: AnalysisPromptPackage;
  private readonly registry: AnalysisRuleRegistry;

  constructor(
    private readonly model: ModelCompletionPort,
    options: AnalysisEngineOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.prompt = options.prompt === undefined
      ? loadBuiltinAnalysisPrompt()
      : parsePromptPackage(options.prompt);
    this.registry = options.registry ?? createBuiltinRuleRegistry();
  }

  async run(
    input: AnalysisRunInput,
    signal?: AbortSignal,
    listener?: AnalysisRunListener,
  ): Promise<AnalysisRunResult> {
    const runId = this.idFactory();
    const events: AnalysisRunEvent[] = [];
    let modelAudit: ModelInvocationAudit | null = null;
    let modelTerminalReceived = false;
    const emit = (stage: AnalysisRunStage, progress: number): void => {
      const event = {
        at: this.clock().toISOString(),
        progress,
        runId,
        stage,
      };
      events.push(event);
      try {
        listener?.(structuredClone(event));
      } catch {
        // 进度监听器不能改变分析结果或触发模型重试。
      }
    };
    const cancelled = (): never => {
      throw new AnalysisEngineError('CANCELLED', '分析已取消', 'CANCELLED');
    };

    try {
      emit('validating_input', 0.05);
      if (isCancelled(signal)) cancelled();
      validateRunInput(input);
      const ruleSnapshot = this.registry.snapshot(input.industry, input.mediaKind);

      emit('preparing_evidence', 0.2);
      const packet = buildEvidencePacket(input.media);
      if (isCancelled(signal)) cancelled();
      const request = buildAnalysisModelRequest(input, ruleSnapshot, packet, this.prompt);

      emit('awaiting_model', 0.4);
      const result = await this.model.complete(request, signal);
      modelTerminalReceived = true;
      modelAudit = result.audit;
      if (!result.ok) {
        if (result.error.code === 'CANCELLED') cancelled();
        throw new AnalysisEngineError(
          'MODEL_FAILED',
          `模型调用失败（${result.error.code}）`,
          result.error.code,
        );
      }
      if (
        result.audit.configurationId !== input.model.configurationId
        || result.audit.modelId !== input.model.modelId
        || result.completion.modelId !== input.model.modelId
        || result.completion.providerId !== result.audit.providerId
      ) {
        throw new AnalysisEngineError(
          'MODEL_FAILED',
          '模型调用结果与用户显式选择不一致',
          'UNKNOWN',
        );
      }

      emit('validating_model_output', 0.7);
      const modelOutput = parseModelAnalysisOutput(result.completion.content, {
        evidence: new Map(packet.items.map((item) => [item.evidenceId, item])),
        evidenceIds: packet.includedEvidenceIds,
        industry: input.industry,
        maximumTimeMs: maximumEvidenceTime(input),
        mediaKind: input.mediaKind,
        rule: ruleSnapshot.package,
      });
      emit('fusing_report', 0.85);
      const report = fuseAnalysisReport({
        audit: result.audit,
        createdAt: this.clock().toISOString(),
        draftId: this.idFactory(),
        modelOutput,
        prompt: this.prompt,
        ruleSnapshot,
        runId,
        runInput: input,
        usage: result.completion.usage,
        visibleLimitations: packet.limitations,
      });
      emit('succeeded', 1);
      return {
        events: structuredClone(events),
        modelAudit: structuredClone(result.audit),
        ok: true,
        report,
        runId,
      };
    } catch (error) {
      let normalized: AnalysisEngineError;
      if (!modelTerminalReceived && isCancelled(signal)) {
        normalized = new AnalysisEngineError('CANCELLED', '分析已取消', 'CANCELLED');
      } else if (error instanceof AnalysisEngineError) {
        normalized = error;
      } else if (error instanceof AnalysisRuleError) {
        normalized = new AnalysisEngineError('RULE_FAILED', '分析规则融合失败');
      } else {
        normalized = new AnalysisEngineError('MODEL_FAILED', '分析运行发生未预期错误');
      }
      emit(normalized.code === 'CANCELLED' ? 'cancelled' : 'failed', 1);
      return {
        error: {
          code: normalized.code,
          message: normalized.message,
          modelErrorCode: normalized.modelErrorCode,
        },
        events: structuredClone(events),
        modelAudit: modelAudit === null ? null : structuredClone(modelAudit),
        ok: false,
        runId,
      };
    }
  }
}
