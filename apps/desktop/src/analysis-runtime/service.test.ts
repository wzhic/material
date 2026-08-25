import { describe, expect, it, vi } from 'vitest';

import { AnalysisRuntimeService } from './service';
import type { AnalysisRuntimeStartInput } from './types';
import type { AnalysisReportDraft, AnalysisRunResult } from '../analysis-engine';
import type { ProductSnapshot } from '../product/types';
import type {
  CapabilitySnapshot,
  JsonValue,
  ToolInvocationFailure,
  ToolInvocationSuccess,
} from '../tooling/types';

const material = {
  fingerprintAlgorithm: 'sha256-full-v1' as const,
  fingerprintSha256: 'a'.repeat(64),
  kind: 'video' as const,
  size: 1_024,
};

const input: AnalysisRuntimeStartInput = {
  clientRunId: 'client-run-1',
  configurationDisplayName: '主模型',
  configurationId: 'config-1',
  conversionContext: '重点关注开场',
  industry: 'apparel',
  modelId: 'deepseek-chat',
  productId: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000001',
};

const materialSession = {
  previewUrl: `material-local://session/${input.sessionId}`,
  sessionId: input.sessionId,
  sourceStatus: 'available' as const,
  summary: {
    ...material,
    mimeType: 'video/mp4',
    name: 'sample.mp4',
  },
};

const capability = (capabilityId: string): CapabilitySnapshot => ({
  capabilityId,
  cancellable: true,
  failureMode: capabilityId === 'media.ocr' || capabilityId === 'media.asr'
    || capabilityId === 'media.audio.event' ? 'optional' : 'required',
  kind: 'builtin',
  manifestHash: `sha256:${'b'.repeat(64)}`,
  permissions: [],
  resources: {
    maxArtifactBytes: 1,
    maxArtifacts: 1,
    maxOutputBytes: 1,
    timeoutMs: 1,
  },
  schemaVersion: 1,
  version: '1.0.0',
});

const success = (capabilityId: string, output: JsonValue): ToolInvocationSuccess => ({
  artifacts: [],
  audit: {
    capability: capability(capabilityId),
    durationMs: 1,
    errorCode: null,
    finishedAt: '2026-08-25T04:00:00.001Z',
    inputBytes: 1,
    invocationId: `invocation-${capabilityId}`,
    outputBytes: 1,
    startedAt: '2026-08-25T04:00:00.000Z',
    status: 'succeeded',
  },
  capability: capability(capabilityId),
  invocationId: `invocation-${capabilityId}`,
  ok: true,
  output,
});

const failure = (
  capabilityId: string,
  code: ToolInvocationFailure['error']['code'] = 'EXECUTION_FAILED',
): ToolInvocationFailure => ({
  artifacts: [],
  audit: {
    capability: capability(capabilityId),
    durationMs: 1,
    errorCode: code,
    finishedAt: '2026-08-25T04:00:00.001Z',
    inputBytes: 1,
    invocationId: `invocation-${capabilityId}`,
    outputBytes: 0,
    startedAt: '2026-08-25T04:00:00.000Z',
    status: code === 'CANCELLED' ? 'cancelled' : 'failed',
  },
  classification: capability(capabilityId).failureMode,
  error: { code, message: '工具执行失败' },
  invocationId: `invocation-${capabilityId}`,
  ok: false,
});

const probe = {
  bitRate: 1,
  durationMs: 5_000,
  formatNames: ['mp4'],
  hasAudio: true,
  hasVideo: true,
  material,
  mediaKind: 'video',
  probeVersion: 'ffprobe-test',
  schemaVersion: 1,
  startTimeMs: 0,
  streams: [{
    bitRate: 1,
    channels: null,
    codecName: 'h264',
    durationMs: 5_000,
    frameRate: 25,
    height: 1080,
    index: 0,
    kind: 'video',
    language: null,
    rotationDegrees: 0,
    sampleRate: null,
    timeBase: '1/1000',
    width: 1920,
  }],
} as const;

const toolOutputs: Record<string, JsonValue> = {
  'media.probe': probe as unknown as JsonValue,
  'media.frame.extract': {
    frames: [{
      artifactRelativePath: 'frame.jpg',
      frameId: 'frame-1',
      height: 720,
      purpose: 'representative',
      timeMs: 1_000,
      width: 1280,
    }],
    material,
    runtimeVersion: 'ffmpeg-test',
    schemaVersion: 1,
  } as unknown as JsonValue,
  'media.shot.detect': {
    algorithm: 'ffmpeg-scene-v1',
    material,
    runtimeVersion: 'ffmpeg-test',
    schemaVersion: 1,
    shots: [],
    threshold: 0.32,
  } as unknown as JsonValue,
  'media.audio.extract': {
    artifactRelativePath: 'audio.wav',
    channels: 1,
    hasAudio: true,
    integratedLoudnessLufs: null,
    material,
    maxVolumeDb: null,
    meanVolumeDb: null,
    runtimeVersion: 'ffmpeg-test',
    sampleRate: 16_000,
    schemaVersion: 1,
    silence: [],
    waveform: [],
  } as unknown as JsonValue,
  'media.evidence.normalize': {
    evidence: [{
      confidence: 1,
      evidenceId: 'probe-evidence',
      evidenceType: 'metadata.media',
      locator: { kind: 'video_time', startMs: 0 },
      mediaKind: 'video',
      schemaVersion: 1,
      source: { capabilityId: 'media.probe', kind: 'tool', version: '1.0.0' },
      text: '技术信息，不包含画面语义',
    }],
    limitations: [],
    material,
    provenance: [{ capabilityId: 'media.probe', runtimeVersion: 'test', schemaVersion: 1 }],
    schemaVersion: 1,
    timeline: [],
  } as unknown as JsonValue,
};

const snapshot: ProductSnapshot = {
  apparelCategory: '连衣裙',
  details: {},
  game: null,
  generatedAt: '2026-08-25T04:00:00.000Z',
  industry: 'apparel',
  name: '通勤连衣裙',
  productId: input.productId as string,
  productWriteVersion: 2,
  schemaVersion: 1,
  sourceStatus: 'active',
};

const report = { productSnapshot: snapshot } as AnalysisReportDraft;

describe('analysis runtime service', () => {
  it('runs required tools, keeps optional failures visible, and forwards the product snapshot', async () => {
    const tools = {
      invoke: vi.fn(async ({ capabilityId }: { capabilityId: string }) =>
        capabilityId === 'media.ocr' || capabilityId === 'media.asr'
          || capabilityId === 'media.audio.event'
          ? failure(capabilityId)
          : success(capabilityId, toolOutputs[capabilityId])),
      release: vi.fn(async () => undefined),
    };
    const engine = {
      run: vi.fn(async (runInput): Promise<AnalysisRunResult> => ({
        events: [],
        modelAudit: {} as never,
        ok: true,
        report: { ...report, productSnapshot: runInput.productSnapshot ?? null },
        runId: 'engine-run-1',
      })),
    };
    const service = new AnalysisRuntimeService(
      tools,
      { inspect: vi.fn(async () => materialSession) },
      engine,
      { snapshot: vi.fn(() => snapshot) },
    );
    const progress = vi.fn();

    const result = await service.run(input, progress);

    expect(result.ok).toBe(true);
    expect(engine.run).toHaveBeenCalledTimes(1);
    expect(engine.run.mock.calls[0][0].productSnapshot).toEqual(snapshot);
    expect(engine.run.mock.calls[0][0].media.limitations).toEqual(expect.arrayContaining([
      expect.stringContaining('字幕与画面文字识别不可用'),
      expect.stringContaining('口播识别不可用'),
      expect.stringContaining('声音事件识别不可用'),
    ]));
    expect(progress.mock.calls[progress.mock.calls.length - 1]?.[0])
      .toMatchObject({ stage: 'report_ready' });
    expect(tools.release).toHaveBeenCalledTimes(8);
  });

  it('stops before the model when a required tool fails', async () => {
    const tools = {
      invoke: vi.fn(async ({ capabilityId }: { capabilityId: string }) =>
        capabilityId === 'media.frame.extract'
          ? failure(capabilityId)
          : success(capabilityId, toolOutputs[capabilityId])),
      release: vi.fn(async () => undefined),
    };
    const engine = { run: vi.fn() };
    const service = new AnalysisRuntimeService(
      tools,
      { inspect: vi.fn(async () => materialSession) },
      engine,
      { snapshot: vi.fn(() => snapshot) },
    );

    const result = await service.run(input);

    expect(result).toMatchObject({ error: { code: 'REQUIRED_TOOL_FAILED' }, ok: false });
    expect(engine.run).not.toHaveBeenCalled();
    expect(tools.release).toHaveBeenCalledTimes(4);
  });

  it('cancels the active tool request without retrying', async () => {
    const tools = {
      invoke: vi.fn(({ capabilityId, signal }: { capabilityId: string; signal?: AbortSignal }) =>
        new Promise<ToolInvocationFailure>((resolve) => {
          signal?.addEventListener('abort', () => resolve(failure(capabilityId, 'CANCELLED')), {
            once: true,
          });
        })),
      release: vi.fn(async () => undefined),
    };
    const engine = { run: vi.fn() };
    const service = new AnalysisRuntimeService(
      tools,
      { inspect: vi.fn(async () => materialSession) },
      engine,
      null,
    );
    const pending = service.run({ ...input, productId: null });
    await vi.waitFor(() => expect(tools.invoke).toHaveBeenCalledTimes(1));

    expect(service.cancel(input.clientRunId)).toBe(true);
    await expect(pending).resolves.toMatchObject({ error: { code: 'CANCELLED' }, ok: false });
    expect(engine.run).not.toHaveBeenCalled();
    expect(tools.release).toHaveBeenCalledTimes(1);
  });
});
