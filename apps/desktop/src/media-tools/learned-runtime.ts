import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ToolWorkspace } from '../tooling/types';
import {
  AsrOutput,
  AsrSegment,
  AudioEvent,
  AudioEventOutput,
  MediaToolError,
  MediaToolSource,
  OcrOutput,
  OcrSegment,
  RuntimeCapabilityHealth,
  mediaIdentity,
} from './contracts';
import { FfmpegMediaTools } from './ffmpeg';
import { MediaProcessRunner, SpawnMediaProcessRunner } from './process';

type LearnedAction = 'asr' | 'audio_event' | 'ocr';

interface RuntimeHealthPayload {
  available?: unknown;
  detail?: unknown;
  runtimeVersion?: unknown;
}

export interface LocalLearnedRuntimeConfiguration {
  asrModelPath?: string;
  audioEventModelPath?: string;
  cachePath?: string;
  ocrLanguage?: string;
  ocrModelPath?: string;
  pythonPath?: string;
  scriptPath: string;
  unavailableDetail?: string;
  verifyIntegrity?: () => Promise<void>;
}

export interface OcrRequest {
  language?: string;
  timestampsMs?: readonly number[];
}

export interface AsrRequest {
  language?: string;
  wordTimestamps?: boolean;
}

export interface AudioEventRequest {
  threshold?: number;
}

const CAPABILITIES: Record<LearnedAction, RuntimeCapabilityHealth['capabilityId']> = {
  asr: 'media.asr',
  audio_event: 'media.audio.event',
  ocr: 'media.ocr',
};

const OFFLINE_RUNTIME_ENVIRONMENT: Readonly<Record<string, string>> = {
  HF_HUB_OFFLINE: '1',
  PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONNOUSERSITE: '1',
  PYTHONUTF8: '1',
  TRANSFORMERS_OFFLINE: '1',
};

const boundedText = (value: unknown, maximum = 10_000): string =>
  typeof value === 'string' ? value.trim().slice(0, maximum) : '';

const finite = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const confidence = (value: unknown): number =>
  Math.min(1, Math.max(0, finite(value) ?? 0));

const milliseconds = (value: unknown): number =>
  Math.max(0, Math.round(finite(value) ?? 0));

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stableId = (prefix: string, value: string): string =>
  `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;

const requiredAbsolute = (value: string | undefined, label: string): string => {
  if (!value || !path.isAbsolute(value)) {
    throw new MediaToolError('RUNTIME_MISSING', `${label}尚未配置`);
  }
  return value;
};

const safeRuntimeVersion = (value: unknown): string =>
  boundedText(value, 120) || 'unknown-local-runtime';

export class LocalLearnedRuntime {
  private readonly healthCache = new Map<LearnedAction, RuntimeCapabilityHealth>();

  constructor(
    private readonly configuration: LocalLearnedRuntimeConfiguration,
    private readonly runner: MediaProcessRunner = new SpawnMediaProcessRunner(),
  ) {
    if (!path.isAbsolute(configuration.scriptPath)) {
      throw new Error('local learned runtime script path must be absolute');
    }
    if (configuration.cachePath && !path.isAbsolute(configuration.cachePath)) {
      throw new Error('local learned runtime cache path must be absolute');
    }
  }

  private processEnvironment(): Readonly<Record<string, string>> {
    return {
      ...OFFLINE_RUNTIME_ENVIRONMENT,
      ...(this.configuration.cachePath
        ? { PADDLE_PDX_CACHE_HOME: this.configuration.cachePath }
        : {}),
    };
  }

  async health(action: LearnedAction): Promise<RuntimeCapabilityHealth> {
    const cached = this.healthCache.get(action);
    if (cached) return cached;
    const python = this.configuration.pythonPath;
    if (!python || !path.isAbsolute(python)) {
      const missing = {
        available: false,
        capabilityId: CAPABILITIES[action],
        detail: this.configuration.unavailableDetail ?? '未配置本地 Python 运行时',
        runtimeVersion: null,
      };
      this.healthCache.set(action, missing);
      return missing;
    }
    const configuredModel = {
      asr: this.configuration.asrModelPath,
      audio_event: this.configuration.audioEventModelPath,
      ocr: this.configuration.ocrModelPath,
    }[action];
    if (!configuredModel || !path.isAbsolute(configuredModel)) {
      const missing = {
        available: false,
        capabilityId: CAPABILITIES[action],
        detail: '未配置对应的本地模型目录',
        runtimeVersion: null,
      };
      this.healthCache.set(action, missing);
      return missing;
    }
    try {
      const result = await this.runner.run({
        args: [this.configuration.scriptPath, '--health', action],
        env: this.processEnvironment(),
        executable: python,
        maxStderrBytes: 256 * 1024,
        maxStdoutBytes: 256 * 1024,
        stdin: JSON.stringify({
          asrModelPath: this.configuration.asrModelPath ?? null,
          audioEventModelPath: this.configuration.audioEventModelPath ?? null,
          ocrModelPath: this.configuration.ocrModelPath ?? null,
        }),
      });
      if (result.exitCode !== 0) throw new Error('unavailable');
      const payload = JSON.parse(result.stdout.toString('utf8')) as RuntimeHealthPayload;
      const health = {
        available: payload.available === true,
        capabilityId: CAPABILITIES[action],
        detail: boundedText(payload.detail, 240) || '本地运行时未提供状态',
        runtimeVersion:
          payload.available === true ? safeRuntimeVersion(payload.runtimeVersion) : null,
      };
      this.healthCache.set(action, health);
      return health;
    } catch {
      const failed = {
        available: false,
        capabilityId: CAPABILITIES[action],
        detail: '本地能力运行时不可用',
        runtimeVersion: null,
      };
      this.healthCache.set(action, failed);
      return failed;
    }
  }

  async execute(
    action: LearnedAction,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (this.configuration.verifyIntegrity) {
      try {
        await this.configuration.verifyIntegrity();
      } catch {
        throw new MediaToolError('RUNTIME_MISSING', '本地学习型媒体运行时完整性校验失败');
      }
    }
    const health = await this.health(action);
    if (!health.available) {
      throw new MediaToolError('RUNTIME_MISSING', health.detail);
    }
    const python = requiredAbsolute(this.configuration.pythonPath, '本地 Python 运行时');
    const result = await this.runner.run({
      args: [this.configuration.scriptPath, '--run', action],
      env: this.processEnvironment(),
      executable: python,
      maxStderrBytes: 1024 * 1024,
      maxStdoutBytes: 16 * 1024 * 1024,
      signal,
      stdin: JSON.stringify(payload),
    });
    if (result.exitCode !== 0) {
      throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '本地媒体能力执行失败');
    }
    try {
      const parsed = JSON.parse(result.stdout.toString('utf8'));
      const output = record(parsed);
      if (!output) throw new Error('not an object');
      return output;
    } catch {
      throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '本地媒体能力返回了无效结果');
    }
  }

  configuredAsrModel(): string {
    return requiredAbsolute(this.configuration.asrModelPath, 'ASR 模型');
  }

  configuredAudioEventModel(): string {
    return requiredAbsolute(this.configuration.audioEventModelPath, '声音事件模型');
  }

  configuredOcrModel(): string {
    return requiredAbsolute(this.configuration.ocrModelPath, 'OCR 模型');
  }

  defaultOcrLanguage(): string {
    return boundedText(this.configuration.ocrLanguage, 32) || 'ch';
  }
}

export class LearnedMediaTools {
  constructor(
    private readonly runtime: LocalLearnedRuntime,
    private readonly ffmpeg: FfmpegMediaTools,
  ) {}

  async health(): Promise<readonly RuntimeCapabilityHealth[]> {
    return Promise.all([
      this.runtime.health('ocr'),
      this.runtime.health('asr'),
      this.runtime.health('audio_event'),
    ]);
  }

  async ocr(
    source: MediaToolSource,
    request: OcrRequest,
    workspace: ToolWorkspace,
    signal?: AbortSignal,
  ): Promise<OcrOutput> {
    const language = boundedText(request.language, 32) || this.runtime.defaultOcrLanguage();
    const health = await this.runtime.health('ocr');
    if (!health.available) throw new MediaToolError('RUNTIME_MISSING', health.detail);
    let items: Array<{ path: string; timeMs: number | null }>;
    if (source.summary.kind === 'image') {
      items = [{ path: source.filePath, timeMs: null }];
    } else {
      const explicitTimestamps = request.timestampsMs?.length
        ? request.timestampsMs
        : null;
      const extracted = await this.ffmpeg.extractFrames(
        source,
        explicitTimestamps
          ? { mode: 'specified', timestampsMs: explicitTimestamps }
          : { count: 8, mode: 'representative' },
        workspace,
        signal,
      );
      items = extracted.frames.map((frame) => ({
        path: path.join(workspace.directory, frame.artifactRelativePath),
        timeMs: frame.timeMs,
      }));
    }
    const raw = await this.runtime.execute('ocr', {
      items,
      language,
      modelPath: this.runtime.configuredOcrModel(),
    }, signal);
    const values = Array.isArray(raw.segments) ? raw.segments : [];
    const segments: OcrSegment[] = [];
    for (const [index, value] of values.entries()) {
      const item = record(value);
      const region = record(item?.region);
      const text = boundedText(item?.text);
      if (!item || !region || !text) continue;
      const x = confidence(region.x);
      const y = confidence(region.y);
      const width = Math.min(1 - x, confidence(region.width));
      const height = Math.min(1 - y, confidence(region.height));
      if (width <= 0 || height <= 0) continue;
      const startMs = item.startMs === null ? null : milliseconds(item.startMs);
      const endMs = item.endMs === null ? null : Math.max(startMs ?? 0, milliseconds(item.endMs));
      segments.push({
        confidence: confidence(item.confidence),
        endMs,
        region: { height, width, x, y },
        segmentId: stableId('ocr', `${index}:${startMs}:${text}:${x}:${y}`),
        startMs,
        text,
      });
    }
    return {
      language,
      material: mediaIdentity(source),
      runtimeVersion: safeRuntimeVersion(raw.runtimeVersion),
      schemaVersion: 1,
      segments,
    };
  }

  async asr(
    source: MediaToolSource,
    request: AsrRequest,
    signal?: AbortSignal,
  ): Promise<AsrOutput> {
    if (source.summary.kind === 'image') {
      return {
        detectedLanguage: null,
        material: mediaIdentity(source),
        runtimeVersion: 'not-applicable',
        schemaVersion: 1,
        segments: [],
      };
    }
    const probe = await this.ffmpeg.probe(source, signal);
    if (!probe.hasAudio) {
      return {
        detectedLanguage: null,
        material: mediaIdentity(source),
        runtimeVersion: 'not-applicable',
        schemaVersion: 1,
        segments: [],
      };
    }
    const raw = await this.runtime.execute(
      'asr',
      {
        language: boundedText(request.language, 32) || null,
        modelPath: this.runtime.configuredAsrModel(),
        sourcePath: source.filePath,
        wordTimestamps: request.wordTimestamps !== false,
      },
      signal,
    );
    const values = Array.isArray(raw.segments) ? raw.segments : [];
    const segments: AsrSegment[] = [];
    for (const [index, value] of values.entries()) {
      const item = record(value);
      const text = boundedText(item?.text);
      if (!item || !text) continue;
      const startMs = milliseconds(item.startMs);
      const endMs = Math.max(startMs + 1, milliseconds(item.endMs));
      const words = (Array.isArray(item.words) ? item.words : [])
        .map((wordValue) => {
          const word = record(wordValue);
          const wordText = boundedText(word?.text, 500);
          if (!word || !wordText) return null;
          const wordStart = milliseconds(word.startMs);
          return {
            confidence: confidence(word.confidence),
            endMs: Math.max(wordStart + 1, milliseconds(word.endMs)),
            startMs: wordStart,
            text: wordText,
          };
        })
        .filter((word): word is NonNullable<typeof word> => word !== null);
      segments.push({
        confidence: confidence(item.confidence),
        endMs,
        segmentId: stableId('asr', `${index}:${startMs}:${endMs}:${text}`),
        speaker: boundedText(item.speaker, 80) || null,
        startMs,
        text,
        words,
      });
    }
    return {
      detectedLanguage: boundedText(raw.detectedLanguage, 32) || null,
      material: mediaIdentity(source),
      runtimeVersion: safeRuntimeVersion(raw.runtimeVersion),
      schemaVersion: 1,
      segments,
    };
  }

  async audioEvents(
    source: MediaToolSource,
    request: AudioEventRequest,
    workspace: ToolWorkspace,
    signal?: AbortSignal,
  ): Promise<AudioEventOutput> {
    const audio = await this.ffmpeg.extractAudio(source, workspace, signal);
    const health = await this.runtime.health('audio_event');
    if (!audio.hasAudio || !audio.artifactRelativePath) {
      return {
        events: [],
        limitations: [],
        material: mediaIdentity(source),
        modelVersion: 'not-applicable',
        runtimeVersion: health.runtimeVersion ?? 'unavailable',
        schemaVersion: 1,
      };
    }
    const threshold = Math.min(1, Math.max(0.05, request.threshold ?? 0.25));
    const raw = await this.runtime.execute(
      'audio_event',
      {
        audioPath: path.join(workspace.directory, audio.artifactRelativePath),
        modelPath: this.runtime.configuredAudioEventModel(),
        threshold,
      },
      signal,
    );
    const values = Array.isArray(raw.events) ? raw.events : [];
    const events: AudioEvent[] = [];
    for (const [index, value] of values.entries()) {
      const item = record(value);
      const label = boundedText(item?.label, 240);
      if (!item || !label) continue;
      const startMs = milliseconds(item.startMs);
      const endMs = Math.max(startMs + 1, milliseconds(item.endMs));
      const eventType = ['effect', 'music', 'other', 'speech'].includes(String(item.eventType))
        ? (item.eventType as AudioEvent['eventType'])
        : 'other';
      events.push({
        confidence: confidence(item.confidence),
        endMs,
        eventId: stableId('audio', `${index}:${startMs}:${endMs}:${eventType}:${label}`),
        eventType,
        label,
        startMs,
      });
    }
    return {
      events,
      limitations: (Array.isArray(raw.limitations) ? raw.limitations : [])
        .map((value) => boundedText(value, 500))
        .filter(Boolean)
        .slice(0, 32),
      material: mediaIdentity(source),
      modelVersion: boundedText(raw.modelVersion, 120) || 'unknown-model',
      runtimeVersion: safeRuntimeVersion(raw.runtimeVersion),
      schemaVersion: 1,
    };
  }
}
