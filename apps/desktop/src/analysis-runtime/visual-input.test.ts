import { describe, expect, it, vi } from 'vitest';

import { frameEvidenceId } from '../media-tools';
import type { FrameExtractionOutput } from '../media-tools';
import type { ToolInvocationSuccess } from '../tooling/types';
import { VisualInputPreparer, VISUAL_INPUT_LIMITS } from './visual-input';

const frames = (count = 1): FrameExtractionOutput => ({
  frames: Array.from({ length: count }, (_value, index) => ({
    artifactRelativePath: `frames/frame-${index}.png`,
    frameId: `frame-${index}`,
    height: 720,
    purpose: 'representative' as const,
    timeMs: index * 1_000,
    width: 1_280,
  })),
  material: {
    fingerprintAlgorithm: 'sha256-full-v1',
    fingerprintSha256: 'a'.repeat(64),
    kind: 'video',
    size: 1_024,
  },
  runtimeVersion: 'test',
  schemaVersion: 1,
});

const invocation = (count = 1): ToolInvocationSuccess => ({
  artifacts: Array.from({ length: count }, (_value, index) => ({
    artifactId: `artifact-${index}`,
    byteLength: 12,
    mediaType: 'image/png',
    relativePath: `frames/frame-${index}.png`,
    sha256: 'c'.repeat(64),
  })),
  audit: {
    capability: null,
    durationMs: 1,
    errorCode: null,
    finishedAt: '2026-08-26T00:00:00.001Z',
    inputBytes: 1,
    invocationId: '00000000-0000-4000-8000-000000000001',
    outputBytes: 1,
    startedAt: '2026-08-26T00:00:00.000Z',
    status: 'succeeded',
  },
  capability: {
    capabilityId: 'media.frame.extract',
    cancellable: true,
    failureMode: 'required',
    kind: 'builtin',
    manifestHash: `sha256:${'b'.repeat(64)}`,
    permissions: ['material:read', 'process:spawn', 'temp:write'],
    resources: {
      maxArtifactBytes: 1024,
      maxArtifacts: 8,
      maxOutputBytes: 1024,
      timeoutMs: 1000,
    },
    schemaVersion: 1,
    version: '1.0.0',
  },
  invocationId: '00000000-0000-4000-8000-000000000001',
  ok: true,
  output: {},
});

describe('visual input preparer', () => {
  it('reads registered frame artifacts and emits bounded JPEG evidence without paths', async () => {
    const artifactReader = {
      readArtifact: vi.fn(async () => Buffer.from('source-frame')),
    };
    let receivedOptions: { maxBytes: number; maxDimension: number; quality: number } | null = null;
    const codec = {
      encodeJpeg: vi.fn((
        _source: Uint8Array,
        options: { maxBytes: number; maxDimension: number; quality: number },
      ) => {
        receivedOptions = options;
        return {
        bytes: Buffer.from('bounded-jpeg'),
        height: 720,
        width: 1_280,
        };
      }),
    };
    const preparer = new VisualInputPreparer(artifactReader, codec);

    const result = await preparer.prepare(invocation(), frames(), 'video');

    expect(artifactReader.readArtifact).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'artifact-0',
    );
    expect(receivedOptions).toEqual({
      maxBytes: VISUAL_INPUT_LIMITS.maxImageBytes,
      maxDimension: 1_280,
      quality: 80,
    });
    expect(result).toEqual([{
      dataBase64: Buffer.from('bounded-jpeg').toString('base64'),
      evidenceId: frameEvidenceId('frame-0'),
      height: 720,
      mediaType: 'image/jpeg',
      timeMs: 0,
      width: 1_280,
    }]);
    expect(JSON.stringify(result)).not.toContain('frames/frame-0.png');
  });

  it('divides the total byte budget across eight frames', async () => {
    const receivedMaxBytes: number[] = [];
    const codec = {
      encodeJpeg: vi.fn((
        _source: Uint8Array,
        options: { maxBytes: number },
      ) => {
        receivedMaxBytes.push(options.maxBytes);
        return { bytes: Buffer.from('x'), height: 1, width: 1 };
      }),
    };
    const preparer = new VisualInputPreparer(
      { readArtifact: vi.fn(async () => Buffer.from('source-frame')) },
      codec,
    );

    await preparer.prepare(invocation(8), frames(8), 'video');

    expect(codec.encodeJpeg).toHaveBeenCalledTimes(8);
    expect(receivedMaxBytes).toEqual(Array(8).fill(
      Math.floor(VISUAL_INPUT_LIMITS.maxTotalBytes / 8),
    ));
  });

  it('fails closed for unregistered artifacts or oversized codec output', async () => {
    const artifactReader = { readArtifact: vi.fn(async () => Buffer.from('source-frame')) };
    await expect(new VisualInputPreparer(artifactReader, {
      encodeJpeg: vi.fn(),
    }).prepare({ ...invocation(), artifacts: [] }, frames(), 'video')).rejects.toThrow(
      /missing or ambiguous/,
    );

    await expect(new VisualInputPreparer(artifactReader, {
      encodeJpeg: vi.fn((_source: Uint8Array, options: { maxBytes: number }) => ({
        bytes: Buffer.alloc(options.maxBytes + 1),
        height: 720,
        width: 1_280,
      })),
    }).prepare(invocation(), frames(), 'video')).rejects.toThrow(/controlled limits/);
  });
});
