import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MaterialSessionService } from '../media/session';
import { TemporaryArtifactManager } from '../tooling/artifact-manager';
import { FfmpegMediaTools } from './ffmpeg';
import { LocalLearnedRuntime } from './learned-runtime';
import { normalizeMediaEvidence } from './normalizer';
import { resolveExecutable, SpawnMediaProcessRunner } from './process';

interface MediaRuntimeDescriptor {
  ffmpegPath?: unknown;
  ffprobePath?: unknown;
}

const descriptorPaths = [
  process.env.MATERIAL_MEDIA_RUNTIME_DESCRIPTOR,
  path.join(tmpdir(), 'material-media-runtime-app0011', 'runtime.json'),
  path.join('/private/tmp', 'material-media-runtime-app0011', 'runtime.json'),
].filter((value): value is string => Boolean(value));

const readDescriptor = async (): Promise<MediaRuntimeDescriptor> => {
  for (const descriptorPath of descriptorPaths) {
    try {
      return JSON.parse(await readFile(descriptorPath, 'utf8')) as MediaRuntimeDescriptor;
    } catch {
      // Continue through explicit, platform-temporary and macOS temporary descriptors.
    }
  }
  return {};
};

const configuredRuntime = async (
  name: 'ffmpeg' | 'ffprobe',
  environmentValue: string | undefined,
): Promise<string> => {
  const descriptor = await readDescriptor();
  const described = name === 'ffmpeg' ? descriptor.ffmpegPath : descriptor.ffprobePath;
  const configured = environmentValue ?? (typeof described === 'string' ? described : undefined);
  const executable = await resolveExecutable(name, configured);
  if (!executable) {
    throw new Error(
      `${name} is required for the real media runtime test; configure the absolute path ` +
      `with MATERIAL_${name.toUpperCase()}_PATH or a runtime descriptor`,
    );
  }
  return executable;
};

const limits = {
  maxArtifactBytes: 128 * 1024 * 1024,
  maxArtifacts: 16,
  maxOutputBytes: 8 * 1024 * 1024,
  timeoutMs: 60_000,
};

describe('real deterministic media runtime', () => {
  let ffmpegPath: string;
  let ffprobePath: string;
  let root: string;
  let sampleImagePath: string;
  let samplePath: string;

  beforeAll(async () => {
    [ffmpegPath, ffprobePath] = await Promise.all([
      configuredRuntime('ffmpeg', process.env.MATERIAL_FFMPEG_PATH),
      configuredRuntime('ffprobe', process.env.MATERIAL_FFPROBE_PATH),
    ]);
    root = await mkdtemp(path.join(tmpdir(), 'material-real-media-'));
    samplePath = path.join(root, 'deterministic-sample.mkv');
    sampleImagePath = path.join(root, 'deterministic-image.png');
    const runner = new SpawnMediaProcessRunner();
    const generated = await runner.run({
      args: [
        '-hide_banner', '-nostdin', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=1',
        '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=25:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=0.8',
        '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=0.4',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000:duration=0.8',
        '-filter_complex',
        '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a][4:a]concat=n=3:v=0:a=1[a]',
        '-map', '[v]', '-map', '[a]', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', samplePath,
      ],
      executable: ffmpegPath,
      maxStderrBytes: 4 * 1024 * 1024,
      maxStdoutBytes: 256 * 1024,
    });
    if (generated.exitCode !== 0) {
      throw new Error(`failed to generate the deterministic sample (${generated.exitCode})`);
    }
    const generatedImage = await runner.run({
      args: [
        '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i',
        'color=c=red:s=200x300', '-frames:v', '1', sampleImagePath,
      ],
      executable: ffmpegPath,
      maxStderrBytes: 2 * 1024 * 1024,
      maxStdoutBytes: 256 * 1024,
    });
    if (generatedImage.exitCode !== 0) {
      throw new Error(`failed to generate the deterministic image (${generatedImage.exitCode})`);
    }
    await Promise.all([access(samplePath), access(sampleImagePath)]);
  }, 60_000);

  afterAll(async () => {
    if (root) await rm(root, { force: true, recursive: true });
  });

  it('executes M01, M02, M03, M05 and M08 against actual media bytes', async () => {
    const sessions = new MaterialSessionService();
    const session = await sessions.register(samplePath);
    const source = await sessions.resolveToolSource(session.sessionId);
    const tools = new FfmpegMediaTools({ ffmpegPath, ffprobePath });
    const artifacts = new TemporaryArtifactManager(path.join(root, 'artifacts'));

    const probe = await tools.probe(source);
    expect(probe).toMatchObject({ hasAudio: true, hasVideo: true, mediaKind: 'video' });
    expect(probe.durationMs).toBeGreaterThanOrEqual(1_900);
    expect(probe.material.fingerprintSha256).toBe(session.summary.fingerprintSha256);

    const frameWorkspace = await artifacts.createWorkspace(randomUUID(), limits);
    const frames = await tools.extractFrames(
      source,
      { count: 3, maxDimension: 320, mode: 'representative' },
      frameWorkspace,
    );
    expect(frames.frames).toHaveLength(3);
    expect(frames.frames.every((frame) => frame.width === 320 && frame.height === 240)).toBe(true);

    const shots = await tools.detectShots(source, { minimumShotMs: 300, threshold: 0.2 });
    expect(shots.shots.length).toBeGreaterThanOrEqual(2);
    expect(shots.shots.some((shot) => shot.startMs >= 900 && shot.startMs <= 1_100)).toBe(true);

    const audioWorkspace = await artifacts.createWorkspace(randomUUID(), limits);
    const audio = await tools.extractAudio(source, audioWorkspace);
    expect(audio).toMatchObject({ channels: 1, hasAudio: true, sampleRate: 16_000 });
    expect(audio.integratedLoudnessLufs).not.toBeNull();
    expect(audio.waveform.length).toBeGreaterThan(100);
    expect(audio.silence.some((interval) => interval.startMs < 1_100 && interval.endMs > 900)).toBe(true);

    const normalized = normalizeMediaEvidence({ audio, mediaKind: 'video', probe, shots });
    expect(normalized.material).toEqual(probe.material);
    expect(normalized.evidence.some((entry) => entry.evidenceType === 'audio.silence')).toBe(true);
    expect(normalized.timeline.map((entry) => entry.startMs)).toEqual(
      [...normalized.timeline.map((entry) => entry.startMs)].sort((left, right) => left - right),
    );

    const serialized = JSON.stringify({ audio, frames, normalized, probe, shots });
    expect(serialized).not.toContain(samplePath);
    expect(serialized).not.toContain(root);
  }, 60_000);

  it('handles an actual still image without inventing video or audio evidence', async () => {
    const sessions = new MaterialSessionService();
    const session = await sessions.register(sampleImagePath);
    const source = await sessions.resolveToolSource(session.sessionId);
    const tools = new FfmpegMediaTools({ ffmpegPath, ffprobePath });
    const artifacts = new TemporaryArtifactManager(path.join(root, 'image-artifacts'));
    const workspace = await artifacts.createWorkspace(randomUUID(), limits);

    const probe = await tools.probe(source);
    expect(probe).toMatchObject({
      durationMs: 0,
      hasAudio: false,
      hasVideo: true,
      mediaKind: 'image',
    });
    const frames = await tools.extractFrames(
      source,
      { maxDimension: 200, mode: 'thumbnail' },
      workspace,
    );
    expect(frames.frames).toHaveLength(1);
    expect(Math.max(frames.frames[0].width, frames.frames[0].height)).toBe(200);
    const audio = await tools.extractAudio(source, workspace);
    expect(audio).toMatchObject({ hasAudio: false, waveform: [] });
    const normalized = normalizeMediaEvidence({ mediaKind: 'image', probe });
    expect(normalized).toMatchObject({
      evidence: [],
      limitations: ['未提供 OCR 结果'],
      timeline: [],
    });
    expect(JSON.stringify({ audio, frames, normalized, probe })).not.toContain(root);
  }, 60_000);

  it('executes the local M04, M06 and M07 health contract without model downloads', async () => {
    const python =
      await resolveExecutable('python3') ??
      await resolveExecutable('python');
    if (!python) throw new Error('Python is required to validate the optional local runtime contract');
    const scriptPath = path.resolve(process.cwd(), 'runtime', 'media_runtime.py');
    const runtime = new LocalLearnedRuntime({
      asrModelPath: path.join(root, 'missing-asr-model'),
      audioEventModelPath: path.join(root, 'missing-audio-model'),
      ocrModelPath: path.join(root, 'missing-ocr-model'),
      pythonPath: python,
      scriptPath,
    });
    const health = await Promise.all([
      runtime.health('ocr'),
      runtime.health('asr'),
      runtime.health('audio_event'),
    ]);
    expect(health).toEqual([
      expect.objectContaining({ available: false, capabilityId: 'media.ocr' }),
      expect.objectContaining({ available: false, capabilityId: 'media.asr' }),
      expect.objectContaining({ available: false, capabilityId: 'media.audio.event' }),
    ]);
    expect(JSON.stringify(health)).not.toContain(root);
  });
});
