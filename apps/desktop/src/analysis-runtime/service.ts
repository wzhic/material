import type {
  AnalysisEngine,
  AnalysisRunInput,
  AnalysisRunListener,
  AnalysisRunResult,
} from '../analysis-engine';
import type {
  AsrOutput,
  AudioEventOutput,
  AudioExtractionOutput,
  FrameExtractionOutput,
  MediaEvidenceOutput,
  MediaNormalizationInput,
  MediaProbeOutput,
  OcrOutput,
  ShotDetectionOutput,
} from '../media-tools';
import type { MaterialSessionService } from '../media/session';
import type { ProductSnapshot } from '../product/types';
import type {
  JsonValue,
  ToolInvocationResult,
  ToolInvocationSuccess,
} from '../tooling/types';
import type {
  AnalysisRuntimeErrorCode,
  AnalysisRuntimeProgress,
  AnalysisRuntimeRefineInput,
  AnalysisRuntimeResult,
  AnalysisRuntimeStage,
  AnalysisRuntimeStartInput,
} from './types';

interface ToolPort {
  invoke(request: {
    capabilityId: string;
    input: unknown;
    signal?: AbortSignal;
  }): Promise<ToolInvocationResult>;
  release(invocationId: string): Promise<void>;
}

interface MaterialPort {
  inspect(sessionId: string): ReturnType<MaterialSessionService['inspect']>;
}

interface ProductSnapshotPort {
  snapshot(id: string): ProductSnapshot;
}

interface EnginePort {
  run(
    input: AnalysisRunInput,
    signal?: AbortSignal,
    listener?: AnalysisRunListener,
  ): Promise<AnalysisRunResult>;
}

type ProgressListener = (progress: AnalysisRuntimeProgress) => void;

interface RefinementContext {
  input: AnalysisRuntimeStartInput;
  materialFingerprintSha256: string;
  media: MediaEvidenceOutput;
  mediaSummary: Extract<AnalysisRuntimeResult, { ok: true }>['data']['media'];
  productSnapshot: ProductSnapshot | null;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STAGE_MESSAGES: Record<AnalysisRuntimeStage, string> = {
  applying_guidance: '正在应用你补充的关注点并复用当前素材证据',
  cancelled: '分析已取消，当前设置仍然保留',
  extracting_structure: '正在拆解媒体结构与代表帧',
  failed: '分析未完成，可以保留设置后重试',
  generating_report: '正在使用所选模型生成融合报告',
  normalizing_evidence: '正在校验证据并对齐时间',
  probing_media: '正在读取素材技术信息',
  recognizing_content: '正在尝试识别字幕、口播和声音事件',
  report_ready: '待确认报告已经生成',
  validating_context: '正在核对素材、产品与模型选择',
};

const MAX_REFINEMENT_CONTEXTS = 8;

const TOOL_LABELS: Record<string, string> = {
  'media.asr': '口播识别',
  'media.audio.event': '声音事件识别',
  'media.ocr': '字幕与画面文字识别',
};

class AnalysisRuntimeError extends Error {
  constructor(readonly code: AnalysisRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'AnalysisRuntimeError';
  }
}

const validateInput = (input: AnalysisRuntimeStartInput): void => {
  if (
    !SAFE_ID.test(input.clientRunId)
    || !UUID.test(input.sessionId)
    || !['apparel', 'game'].includes(input.industry)
    || !SAFE_ID.test(input.configurationId)
    || !SAFE_ID.test(input.modelId)
    || !input.configurationDisplayName.trim()
    || input.configurationDisplayName.length > 100
    || (input.productId && !UUID.test(input.productId))
    || (input.conversionContext !== undefined && input.conversionContext.trim().length > 2_000)
  ) {
    throw new AnalysisRuntimeError('INVALID_INPUT', '分析输入无效，请返回配置页检查');
  }
};

const validateRefineInput = (input: AnalysisRuntimeRefineInput): void => {
  if (
    !SAFE_ID.test(input.clientRunId)
    || !SAFE_ID.test(input.sourceClientRunId)
    || input.clientRunId === input.sourceClientRunId
    || !input.guidance.trim()
    || input.guidance.trim().length > 2_000
    || (
      input.referenceTimeMs !== undefined
      && input.referenceTimeMs !== null
      && (!Number.isFinite(input.referenceTimeMs) || input.referenceTimeMs < 0)
    )
  ) {
    throw new AnalysisRuntimeError('INVALID_INPUT', '补充关注点无效，请检查后重试');
  }
};

const mergeGuidance = (
  conversionContext: string | undefined,
  guidance: string,
  referenceTimeMs: number | null | undefined,
): string => {
  const reference = referenceTimeMs === null || referenceTimeMs === undefined
    ? ''
    : `[参考时间 ${(referenceTimeMs / 1_000).toFixed(1)} 秒] `;
  const combined = [conversionContext?.trim(), `${reference}${guidance.trim()}`]
    .filter(Boolean)
    .join('\n');
  return combined.length <= 2_000 ? combined : combined.slice(combined.length - 2_000);
};

const toolOutput = <T>(result: ToolInvocationSuccess): T =>
  structuredClone(result.output) as unknown as T;

const visualDimensions = (
  probe: MediaProbeOutput,
): { height: number | null; width: number | null } => {
  const visual = probe.streams.find((stream) => stream.kind === 'video');
  return { height: visual?.height ?? null, width: visual?.width ?? null };
};

const engineStageMessage = (result: Parameters<AnalysisRunListener>[0]): string => {
  switch (result.stage) {
    case 'awaiting_model': return '正在等待所选模型返回内容理解结果';
    case 'validating_model_output': return '正在核对模型结论、评分与证据引用';
    case 'fusing_report': return '正在融合工具证据、标签与评分';
    default: return STAGE_MESSAGES.generating_report;
  }
};

export class AnalysisRuntimeService {
  private readonly active = new Map<string, AbortController>();
  private readonly refinementContexts = new Map<string, RefinementContext>();

  constructor(
    private readonly tools: ToolPort,
    private readonly materials: MaterialPort,
    private readonly engine: EnginePort,
    private readonly products: ProductSnapshotPort | null,
  ) {}

  async run(
    input: AnalysisRuntimeStartInput,
    listener?: ProgressListener,
  ): Promise<AnalysisRuntimeResult> {
    try {
      validateInput(input);
      if (this.active.has(input.clientRunId)) {
        throw new AnalysisRuntimeError('ALREADY_RUNNING', '当前分析请求已经在运行');
      }
    } catch (error) {
      return this.failure(error);
    }

    const controller = new AbortController();
    const invocationIds: string[] = [];
    this.active.set(input.clientRunId, controller);
    const emit = (stage: AnalysisRuntimeStage, message = STAGE_MESSAGES[stage]): void => {
      try {
        listener?.({ clientRunId: input.clientRunId, message, stage });
      } catch {
        // UI progress listeners cannot change tool or model results.
      }
    };

    const invoke = async <T>(
      capabilityId: string,
      toolInput: JsonValue,
      required: boolean,
      limitations: string[],
    ): Promise<T | null> => {
      const result = await this.tools.invoke({
        capabilityId,
        input: toolInput,
        signal: controller.signal,
      });
      invocationIds.push(result.invocationId);
      if (result.ok) return toolOutput<T>(result);
      if (result.error.code === 'CANCELLED') {
        throw new AnalysisRuntimeError('CANCELLED', '分析已取消');
      }
      if (required) {
        throw new AnalysisRuntimeError(
          'REQUIRED_TOOL_FAILED',
          `必要媒体能力未完成：${result.error.message}`,
        );
      }
      limitations.push(`${TOOL_LABELS[capabilityId] ?? capabilityId}不可用：${result.error.message}`);
      return null;
    };

    try {
      emit('validating_context');
      const material = await this.materials.inspect(input.sessionId);
      if (material.sourceStatus !== 'available') {
        throw new AnalysisRuntimeError(
          'MATERIAL_UNAVAILABLE',
          '本地素材已移动、变化或失去权限，请重新定位后重试',
        );
      }
      let productSnapshot: ProductSnapshot | null = null;
      if (input.productId) {
        if (!this.products) {
          throw new AnalysisRuntimeError('PRODUCT_UNAVAILABLE', '产品库当前不可用，请取消绑定或稍后重试');
        }
        try {
          productSnapshot = this.products.snapshot(input.productId);
        } catch {
          throw new AnalysisRuntimeError('PRODUCT_UNAVAILABLE', '所选产品已变化或不可用，请重新选择');
        }
        if (productSnapshot.industry !== input.industry) {
          throw new AnalysisRuntimeError('PRODUCT_UNAVAILABLE', '所选产品与当前行业不一致');
        }
      }
      if (controller.signal.aborted) {
        throw new AnalysisRuntimeError('CANCELLED', '分析已取消');
      }

      emit('probing_media');
      const limitations: string[] = [];
      const probe = await invoke<MediaProbeOutput>(
        'media.probe',
        { sessionId: input.sessionId },
        true,
        limitations,
      );
      if (!probe || probe.mediaKind !== material.summary.kind) {
        throw new AnalysisRuntimeError('REQUIRED_TOOL_FAILED', '素材探测结果与当前文件不一致');
      }

      emit('extracting_structure');
      const required = [
        invoke<FrameExtractionOutput>(
          'media.frame.extract',
          {
            count: material.summary.kind === 'video' ? 8 : 1,
            maxDimension: 1280,
            mode: 'representative',
            sessionId: input.sessionId,
          },
          true,
          limitations,
        ),
        material.summary.kind === 'video'
          ? invoke<ShotDetectionOutput>(
            'media.shot.detect',
            { minimumShotMs: 400, sessionId: input.sessionId, threshold: 0.32 },
            true,
            limitations,
          )
          : Promise.resolve(null),
        material.summary.kind === 'video'
          ? invoke<AudioExtractionOutput>(
            'media.audio.extract',
            { sessionId: input.sessionId },
            true,
            limitations,
          )
          : Promise.resolve(null),
      ] as const;
      const requiredResults = await Promise.allSettled(required);
      const requiredFailure = requiredResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (requiredFailure) throw requiredFailure.reason;
      const frames = requiredResults[0].status === 'fulfilled' ? requiredResults[0].value : null;
      const shots = requiredResults[1].status === 'fulfilled' ? requiredResults[1].value : null;
      const audio = requiredResults[2].status === 'fulfilled' ? requiredResults[2].value : null;

      emit('recognizing_content');
      const optional = [
        invoke<OcrOutput>(
          'media.ocr',
          { language: 'ch', sessionId: input.sessionId },
          false,
          limitations,
        ),
        material.summary.kind === 'video' && probe.hasAudio
          ? invoke<AsrOutput>(
            'media.asr',
            { language: 'zh', sessionId: input.sessionId, wordTimestamps: true },
            false,
            limitations,
          )
          : Promise.resolve(null),
        material.summary.kind === 'video' && probe.hasAudio
          ? invoke<AudioEventOutput>(
            'media.audio.event',
            { sessionId: input.sessionId, threshold: 0.2 },
            false,
            limitations,
          )
          : Promise.resolve(null),
      ] as const;
      const optionalResults = await Promise.allSettled(optional);
      const optionalFailure = optionalResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (optionalFailure) throw optionalFailure.reason;
      const ocr = optionalResults[0].status === 'fulfilled' ? optionalResults[0].value : null;
      const asr = optionalResults[1].status === 'fulfilled' ? optionalResults[1].value : null;
      const audioEvents = optionalResults[2].status === 'fulfilled' ? optionalResults[2].value : null;

      emit('normalizing_evidence');
      const normalizationInput: MediaNormalizationInput = {
        ...(audio ? { audio } : {}),
        ...(audioEvents ? { audioEvents } : {}),
        ...(asr ? { asr } : {}),
        ...(frames ? { frames } : {}),
        mediaKind: material.summary.kind,
        ...(ocr ? { ocr } : {}),
        probe,
        ...(shots ? { shots } : {}),
      };
      const normalized = await invoke<MediaEvidenceOutput>(
        'media.evidence.normalize',
        normalizationInput as unknown as JsonValue,
        true,
        limitations,
      );
      if (!normalized) {
        throw new AnalysisRuntimeError('REQUIRED_TOOL_FAILED', '媒体证据归一化未完成');
      }
      const reinspected = await this.materials.inspect(input.sessionId);
      if (reinspected.sourceStatus !== 'available') {
        throw new AnalysisRuntimeError(
          'MATERIAL_UNAVAILABLE',
          '素材在分析期间发生变化，请重新定位或重新开始',
        );
      }
      const media: MediaEvidenceOutput = {
        ...normalized,
        limitations: [...new Set([...normalized.limitations, ...limitations])],
      };

      emit('generating_report');
      const engineResult = await this.engine.run({
        conversionContext: input.conversionContext,
        industry: input.industry,
        media,
        mediaKind: material.summary.kind,
        model: {
          configurationDisplayName: input.configurationDisplayName,
          configurationId: input.configurationId,
          modelId: input.modelId,
        },
        productSnapshot,
      }, controller.signal, (event) => emit('generating_report', engineStageMessage(event)));
      if (!engineResult.ok) {
        if (engineResult.error.code === 'CANCELLED') {
          throw new AnalysisRuntimeError('CANCELLED', '分析已取消');
        }
        throw new AnalysisRuntimeError('MODEL_FAILED', engineResult.error.message);
      }
      const mediaSummary = {
        durationMs: probe.durationMs,
        hasAudio: probe.hasAudio,
        ...visualDimensions(probe),
      };
      this.rememberContext(input.clientRunId, {
        input: structuredClone(input),
        materialFingerprintSha256: material.summary.fingerprintSha256,
        media: structuredClone(media),
        mediaSummary,
        productSnapshot: productSnapshot ? structuredClone(productSnapshot) : null,
      });
      emit('report_ready');
      return {
        data: {
          engineEvents: engineResult.events,
          media: mediaSummary,
          report: engineResult.report,
        },
        ok: true,
      };
    } catch (error) {
      emit(
        error instanceof AnalysisRuntimeError && error.code === 'CANCELLED'
          ? 'cancelled'
          : 'failed',
      );
      return this.failure(error);
    } finally {
      this.active.delete(input.clientRunId);
      await Promise.allSettled(invocationIds.map((id) => this.tools.release(id)));
    }
  }

  async refine(
    input: AnalysisRuntimeRefineInput,
    listener?: ProgressListener,
  ): Promise<AnalysisRuntimeResult> {
    try {
      validateRefineInput(input);
      if (this.active.has(input.clientRunId)) {
        throw new AnalysisRuntimeError('ALREADY_RUNNING', '当前重新分析请求已经在运行');
      }
    } catch (error) {
      return this.failure(error);
    }

    const source = this.refinementContexts.get(input.sourceClientRunId);
    if (!source) {
      return this.failure(new AnalysisRuntimeError(
        'INVALID_INPUT',
        '原分析会话已不可用于增量处理，请从当前配置重新开始',
      ));
    }
    if (
      input.referenceTimeMs !== null
      && input.referenceTimeMs !== undefined
      && input.referenceTimeMs > source.mediaSummary.durationMs
    ) {
      return this.failure(new AnalysisRuntimeError('INVALID_INPUT', '引用时间超出素材时长'));
    }

    const controller = new AbortController();
    this.active.set(input.clientRunId, controller);
    const emit = (stage: AnalysisRuntimeStage, message = STAGE_MESSAGES[stage]): void => {
      try {
        listener?.({ clientRunId: input.clientRunId, message, stage });
      } catch {
        // UI progress listeners cannot change model results.
      }
    };

    try {
      emit('validating_context');
      const material = await this.materials.inspect(source.input.sessionId);
      if (
        material.sourceStatus !== 'available'
        || material.summary.fingerprintSha256 !== source.materialFingerprintSha256
      ) {
        throw new AnalysisRuntimeError(
          'MATERIAL_UNAVAILABLE',
          '原素材已移动、变化或失去权限，请重新定位后再分析',
        );
      }
      if (controller.signal.aborted) {
        throw new AnalysisRuntimeError('CANCELLED', '重新分析已取消');
      }

      const conversionContext = mergeGuidance(
        source.input.conversionContext,
        input.guidance,
        input.referenceTimeMs,
      );
      emit('applying_guidance');
      const engineInput: AnalysisRunInput = {
        conversionContext,
        industry: source.input.industry,
        media: structuredClone(source.media),
        mediaKind: material.summary.kind,
        model: {
          configurationDisplayName: source.input.configurationDisplayName,
          configurationId: source.input.configurationId,
          modelId: source.input.modelId,
        },
        productSnapshot: source.productSnapshot
          ? structuredClone(source.productSnapshot)
          : null,
      };
      emit('generating_report');
      const engineResult = await this.engine.run(
        engineInput,
        controller.signal,
        (event) => emit('generating_report', engineStageMessage(event)),
      );
      if (!engineResult.ok) {
        if (engineResult.error.code === 'CANCELLED') {
          throw new AnalysisRuntimeError('CANCELLED', '重新分析已取消');
        }
        throw new AnalysisRuntimeError('MODEL_FAILED', engineResult.error.message);
      }
      const nextStartInput: AnalysisRuntimeStartInput = {
        ...structuredClone(source.input),
        clientRunId: input.clientRunId,
        conversionContext,
      };
      this.rememberContext(input.clientRunId, {
        input: nextStartInput,
        materialFingerprintSha256: source.materialFingerprintSha256,
        media: structuredClone(source.media),
        mediaSummary: structuredClone(source.mediaSummary),
        productSnapshot: source.productSnapshot ? structuredClone(source.productSnapshot) : null,
      });
      emit('report_ready');
      return {
        data: {
          engineEvents: engineResult.events,
          media: structuredClone(source.mediaSummary),
          report: engineResult.report,
        },
        ok: true,
      };
    } catch (error) {
      emit(
        error instanceof AnalysisRuntimeError && error.code === 'CANCELLED'
          ? 'cancelled'
          : 'failed',
      );
      return this.failure(error);
    } finally {
      this.active.delete(input.clientRunId);
    }
  }

  cancel(clientRunId: string): boolean {
    const controller = this.active.get(clientRunId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  cancelAll(): void {
    for (const controller of this.active.values()) controller.abort();
  }

  private rememberContext(clientRunId: string, context: RefinementContext): void {
    this.refinementContexts.delete(clientRunId);
    this.refinementContexts.set(clientRunId, context);
    while (this.refinementContexts.size > MAX_REFINEMENT_CONTEXTS) {
      const oldest = this.refinementContexts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.refinementContexts.delete(oldest);
    }
  }

  private failure(error: unknown): AnalysisRuntimeResult {
    if (error instanceof AnalysisRuntimeError) {
      return { error: { code: error.code, message: error.message }, ok: false };
    }
    return { error: { code: 'UNKNOWN', message: '分析运行发生未知错误，请重试' }, ok: false };
  }
}

export const createAnalysisRuntimeService = (
  tools: ToolPort,
  materials: MaterialPort,
  engine: AnalysisEngine,
  products: ProductSnapshotPort | null,
): AnalysisRuntimeService => new AnalysisRuntimeService(tools, materials, engine, products);
