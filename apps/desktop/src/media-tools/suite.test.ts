import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TemporaryArtifactManager } from '../tooling/artifact-manager';
import { ToolBroker } from '../tooling/broker';
import { ToolRegistry } from '../tooling/registry';
import { registerDeterministicMediaTools } from './suite';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('deterministic media tool suite', () => {
  it('registers M01 through M08 as independent versioned capabilities', () => {
    const registry = new ToolRegistry();
    const suite = registerDeterministicMediaTools(
      registry,
      { resolve: async () => { throw new Error('unused'); } },
      { learned: { scriptPath: '/runtime/media_runtime.py' } },
    );
    expect(suite.snapshots.map((snapshot) => snapshot.capabilityId)).toEqual([
      'media.probe',
      'media.frame.extract',
      'media.shot.detect',
      'media.ocr',
      'media.audio.extract',
      'media.asr',
      'media.audio.event',
      'media.evidence.normalize',
    ]);
    expect(suite.snapshots.every((snapshot) => snapshot.version === '1.0.0')).toBe(true);
    expect(registry.resolve('media.evidence.normalize')?.manifest.permissions).toEqual([]);
    expect(registry.resolve('media.asr')?.manifest.failureMode).toBe('optional');
    expect(registry.resolve('media.ocr')?.manifest.kind).toBe('script');
    expect(registry.resolve('media.audio.extract')?.manifest.kind).toBe('builtin');
  });

  it('runs M08 through the Broker input and output contracts', async () => {
    const registry = new ToolRegistry();
    registerDeterministicMediaTools(
      registry,
      { resolve: async () => { throw new Error('unused'); } },
      { learned: { scriptPath: '/runtime/media_runtime.py' } },
    );
    const root = await mkdtemp(path.join(tmpdir(), 'material-media-suite-'));
    roots.push(root);
    const broker = new ToolBroker(
      registry,
      new TemporaryArtifactManager(root),
      {
        allowedCapabilities: ['media.evidence.normalize'],
        allowedPermissions: [],
        maxConcurrentInvocations: 1,
        resourceCeilings: {
          maxArtifactBytes: 512 * 1024 * 1024,
          maxArtifacts: 40,
          maxOutputBytes: 32 * 1024 * 1024,
          timeoutMs: 20 * 60 * 1000,
        },
      },
    );
    const material = {
      fingerprintAlgorithm: 'sha256-full-v1',
      fingerprintSha256: 'c'.repeat(64),
      kind: 'image',
      size: 42,
    };
    const result = await broker.invoke({
      capabilityId: 'media.evidence.normalize',
      input: {
        mediaKind: 'image',
        probe: {
          bitRate: null,
          durationMs: 0,
          formatNames: ['png_pipe'],
          hasAudio: false,
          hasVideo: true,
          material,
          mediaKind: 'image',
          probeVersion: 'ffprobe version test',
          schemaVersion: 1,
          startTimeMs: 0,
          streams: [],
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      output: {
        evidence: [{
          evidenceType: 'metadata.media',
          source: { capabilityId: 'media.probe' },
          text: expect.stringContaining('不包含画面语义'),
        }],
        limitations: ['未提供 OCR 结果'],
        material,
        schemaVersion: 1,
        timeline: [],
      },
    });
    if (result.ok) await broker.release(result.invocationId);
  });
});
