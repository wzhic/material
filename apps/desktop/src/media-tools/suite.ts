import path from 'node:path';

import { MaterialSessionService } from '../media/session';
import { FunctionToolAdapter, ToolAdapterError } from '../tooling/adapters';
import { ToolRegistry } from '../tooling/registry';
import type {
  CapabilitySnapshot,
  JsonValue,
  ToolManifest,
  ToolResourceLimits,
  ValueSchema,
} from '../tooling/types';
import {
  MediaNormalizationInput,
  MediaToolError,
  MediaToolSourceResolver,
  RuntimeCapabilityHealth,
} from './contracts';
import {
  FfmpegMediaTools,
  FfmpegRuntimeConfiguration,
  FrameExtractionRequest,
  ShotDetectionRequest,
} from './ffmpeg';
import {
  AsrRequest,
  AudioEventRequest,
  LearnedMediaTools,
  LocalLearnedRuntime,
  LocalLearnedRuntimeConfiguration,
  OcrRequest,
} from './learned-runtime';
import { normalizeMediaEvidence } from './normalizer';
import {
  asrOutputSchema,
  audioEventOutputSchema,
  audioOutputSchema,
  evidenceOutputSchema,
  frameOutputSchema,
  normalizeInputSchema,
  ocrOutputSchema,
  probeOutputSchema,
  sessionInputSchema,
  shotOutputSchema,
} from './schemas';

export interface DeterministicMediaSuiteConfiguration {
  ffmpeg?: FfmpegRuntimeConfiguration;
  learned?: Partial<LocalLearnedRuntimeConfiguration>;
}

export interface RegisteredMediaToolSuite {
  health(): Promise<readonly RuntimeCapabilityHealth[]>;
  snapshots: readonly CapabilitySnapshot[];
}

const resources: ToolResourceLimits = {
  maxArtifactBytes: 512 * 1024 * 1024,
  maxArtifacts: 40,
  maxOutputBytes: 32 * 1024 * 1024,
  timeoutMs: 20 * 60 * 1000,
};

const manifest = (
  capabilityId: ToolManifest['capabilityId'],
  displayName: string,
  inputSchema: ValueSchema,
  outputSchema: ValueSchema,
  options: Partial<Pick<ToolManifest, 'failureMode' | 'kind' | 'permissions'>> = {},
): ToolManifest => ({
  capabilityId,
  cancellable: true,
  displayName,
  failureMode: options.failureMode ?? 'required',
  inputSchema,
  kind: options.kind ?? 'builtin',
  outputSchema,
  permissions: options.permissions ?? ['material:read', 'process:spawn'],
  resources,
  schemaVersion: 1,
  version: '1.0.0',
});

const json = (value: unknown): JsonValue => structuredClone(value) as JsonValue;

const safeExecute = async (operation: () => Promise<unknown> | unknown): Promise<JsonValue> => {
  try {
    return json(await operation());
  } catch (error) {
    if (error instanceof MediaToolError) {
      throw new ToolAdapterError('EXECUTION_FAILED', error.code);
    }
    throw error;
  }
};

const sessionInput = (value: JsonValue): Record<string, unknown> =>
  value as Record<string, unknown>;

const numberArray = (value: unknown): number[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number') : undefined;

export const materialSessionSourceResolver = (
  sessions: MaterialSessionService,
): MediaToolSourceResolver => ({
  resolve: (sessionId) => sessions.resolveToolSource(sessionId),
});

export const registerDeterministicMediaTools = (
  registry: ToolRegistry,
  resolver: MediaToolSourceResolver,
  configuration: DeterministicMediaSuiteConfiguration = {},
): RegisteredMediaToolSuite => {
  const ffmpeg = new FfmpegMediaTools(configuration.ffmpeg);
  const scriptPath = configuration.learned?.scriptPath ??
    path.resolve(process.cwd(), 'runtime', 'media_runtime.py');
  const runtime = new LocalLearnedRuntime({
    scriptPath,
    ...configuration.learned,
  });
  const learned = new LearnedMediaTools(runtime, ffmpeg);
  const snapshots: CapabilitySnapshot[] = [];
  snapshots.push(
    registry.register(
      manifest('media.probe', 'Media Probe', sessionInputSchema(), probeOutputSchema),
      new FunctionToolAdapter('builtin', async ({ input, signal }) => {
        const values = sessionInput(input);
        return safeExecute(async () =>
          ffmpeg.probe(await resolver.resolve(String(values.sessionId)), signal),
        );
      }),
    ),
  );
  snapshots.push(
    registry.register(
      manifest(
        'media.frame.extract',
        'Frame Extractor',
        sessionInputSchema(
          {
            count: { integer: true, maximum: 32, minimum: 1, type: 'number' },
            maxDimension: { integer: true, maximum: 4096, minimum: 64, type: 'number' },
            mode: { enum: ['representative', 'specified', 'thumbnail'], type: 'string' },
            timestampsMs: {
              items: { integer: true, minimum: 0, type: 'number' },
              maxItems: 32,
              type: 'array',
            },
          },
          ['mode'],
        ),
        frameOutputSchema,
        { permissions: ['material:read', 'process:spawn', 'temp:write'] },
      ),
      new FunctionToolAdapter('builtin', async ({ input, signal, workspace }) => {
        const values = sessionInput(input);
        const request: FrameExtractionRequest = {
          count: typeof values.count === 'number' ? values.count : undefined,
          maxDimension: typeof values.maxDimension === 'number' ? values.maxDimension : undefined,
          mode: values.mode as FrameExtractionRequest['mode'],
          timestampsMs: numberArray(values.timestampsMs),
        };
        return safeExecute(async () =>
          ffmpeg.extractFrames(
            await resolver.resolve(String(values.sessionId)),
            request,
            workspace,
            signal,
          ),
        );
      }),
    ),
  );
  snapshots.push(
    registry.register(
      manifest(
        'media.shot.detect',
        'Shot Detector',
        sessionInputSchema({
          minimumShotMs: { integer: true, maximum: 30_000, minimum: 100, type: 'number' },
          threshold: { maximum: 0.95, minimum: 0.05, type: 'number' },
        }),
        shotOutputSchema,
      ),
      new FunctionToolAdapter('builtin', async ({ input, signal }) => {
        const values = sessionInput(input);
        const request: ShotDetectionRequest = {
          minimumShotMs:
            typeof values.minimumShotMs === 'number' ? values.minimumShotMs : undefined,
          threshold: typeof values.threshold === 'number' ? values.threshold : undefined,
        };
        return safeExecute(async () =>
          ffmpeg.detectShots(await resolver.resolve(String(values.sessionId)), request, signal),
        );
      }),
    ),
  );
  snapshots.push(
    registry.register(
      manifest(
        'media.ocr',
        'OCR Tool',
        sessionInputSchema({
          language: { maxLength: 32, type: 'string' },
          timestampsMs: {
            items: { integer: true, minimum: 0, type: 'number' },
            maxItems: 256,
            type: 'array',
          },
        }),
        ocrOutputSchema,
        {
          failureMode: 'optional',
          kind: 'script',
          permissions: ['material:read', 'process:spawn', 'temp:write'],
        },
      ),
      new FunctionToolAdapter('script', async ({ input, signal, workspace }) => {
        const values = sessionInput(input);
        const request: OcrRequest = {
          language: typeof values.language === 'string' ? values.language : undefined,
          timestampsMs: numberArray(values.timestampsMs),
        };
        return safeExecute(async () =>
          learned.ocr(
            await resolver.resolve(String(values.sessionId)),
            request,
            workspace,
            signal,
          ),
        );
      }),
    ),
  );
  snapshots.push(
    registry.register(
      manifest(
        'media.audio.extract',
        'Audio Extractor',
        sessionInputSchema(),
        audioOutputSchema,
        { permissions: ['material:read', 'process:spawn', 'temp:write'] },
      ),
      new FunctionToolAdapter('builtin', async ({ input, signal, workspace }) => {
        const values = sessionInput(input);
        return safeExecute(async () =>
          ffmpeg.extractAudio(
            await resolver.resolve(String(values.sessionId)),
            workspace,
            signal,
          ),
        );
      }),
    ),
  );
  snapshots.push(
    registry.register(
      manifest(
        'media.asr',
        'ASR Tool',
        sessionInputSchema({
          language: { maxLength: 32, type: 'string' },
          wordTimestamps: { type: 'boolean' },
        }),
        asrOutputSchema,
        { failureMode: 'optional', kind: 'script' },
      ),
      new FunctionToolAdapter('script', async ({ input, signal }) => {
        const values = sessionInput(input);
        const request: AsrRequest = {
          language: typeof values.language === 'string' ? values.language : undefined,
          wordTimestamps:
            typeof values.wordTimestamps === 'boolean' ? values.wordTimestamps : undefined,
        };
        return safeExecute(async () =>
          learned.asr(await resolver.resolve(String(values.sessionId)), request, signal),
        );
      }),
    ),
  );
  snapshots.push(
    registry.register(
      manifest(
        'media.audio.event',
        'Audio Event Tool',
        sessionInputSchema({ threshold: { maximum: 1, minimum: 0.05, type: 'number' } }),
        audioEventOutputSchema,
        {
          failureMode: 'optional',
          kind: 'script',
          permissions: ['material:read', 'process:spawn', 'temp:write'],
        },
      ),
      new FunctionToolAdapter('script', async ({ input, signal, workspace }) => {
        const values = sessionInput(input);
        const request: AudioEventRequest = {
          threshold: typeof values.threshold === 'number' ? values.threshold : undefined,
        };
        return safeExecute(async () =>
          learned.audioEvents(
            await resolver.resolve(String(values.sessionId)),
            request,
            workspace,
            signal,
          ),
        );
      }),
    ),
  );
  snapshots.push(
    registry.register(
      manifest(
        'media.evidence.normalize',
        'Media Evidence Normalizer',
        normalizeInputSchema,
        evidenceOutputSchema,
        { permissions: [] },
      ),
      new FunctionToolAdapter('builtin', async ({ input }) =>
        safeExecute(() => normalizeMediaEvidence(input as unknown as MediaNormalizationInput)),
      ),
    ),
  );

  return {
    health: async () => [
      ...(await ffmpeg.health()),
      ...(await learned.health()),
      {
        available: true,
        capabilityId: 'media.evidence.normalize',
        detail: '内置证据归一化器可用',
        runtimeVersion: '1.0.0',
      },
    ],
    snapshots,
  };
};
