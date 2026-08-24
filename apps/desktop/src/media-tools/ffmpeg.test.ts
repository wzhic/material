import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TemporaryArtifactManager } from '../tooling/artifact-manager';
import { MediaToolSource } from './contracts';
import { FfmpegMediaTools } from './ffmpeg';
import { MediaProcessRunner, ProcessRequest, ProcessResult } from './process';

const roots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'material-media-tools-'));
  roots.push(directory);
  return directory;
};

const wav = (sampleCount = 32_000): Buffer => {
  const dataLength = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(index % 20 < 10 ? 16_000 : -16_000, 44 + index * 2);
  }
  return buffer;
};

class FakeFfmpegRunner implements MediaProcessRunner {
  readonly requests: ProcessRequest[] = [];

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    if (request.args.includes('-version')) {
      return this.result(`${path.basename(request.executable)} version 7.1-test\n`);
    }
    if (path.basename(request.executable).startsWith('ffprobe')) {
      return this.result(JSON.stringify({
        format: {
          bit_rate: '800000',
          duration: '4.000',
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          start_time: '0.000',
        },
        streams: [
          {
            avg_frame_rate: '30/1',
            codec_name: 'h264',
            codec_type: 'video',
            duration: '4.000',
            height: 1080,
            index: 0,
            time_base: '1/15360',
            width: 1920,
          },
          {
            channels: 2,
            codec_name: 'aac',
            codec_type: 'audio',
            duration: '4.000',
            index: 1,
            sample_rate: '48000',
            time_base: '1/48000',
          },
        ],
      }));
    }
    if (request.args.some((argument) => argument.includes('lavfi.scene_score'))) {
      return this.result('', [
        'frame:0 pts:15360 pts_time:1.000',
        'lavfi.scene_score=0.612000',
        'frame:1 pts:46080 pts_time:3.000',
        'lavfi.scene_score=0.730000',
      ].join('\n'));
    }
    if (request.args.some((argument) => argument.includes('silencedetect'))) {
      return this.result('', [
        'silence_start: 1.2',
        'silence_end: 1.8 | silence_duration: 0.6',
        'mean_volume: -18.5 dB',
        'max_volume: -2.1 dB',
        'I: -16.2 LUFS',
      ].join('\n'));
    }
    const outputPath = request.args[request.args.length - 1];
    if (outputPath.endsWith('.wav')) await writeFile(outputPath, wav());
    else if (outputPath.endsWith('.png')) await writeFile(outputPath, Buffer.from('png'));
    return this.result('');
  }

  private result(stdout: string, stderr = ''): ProcessResult {
    return {
      exitCode: 0,
      stderr: Buffer.from(stderr),
      stdout: Buffer.from(stdout),
    };
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe('FFmpeg deterministic media tools', () => {
  it('probes, extracts frames, detects shots and builds bounded audio evidence', async () => {
    const root = await tempRoot();
    const ffmpegPath = path.join(root, 'ffmpeg');
    const ffprobePath = path.join(root, 'ffprobe');
    await Promise.all([
      writeFile(ffmpegPath, ''),
      writeFile(ffprobePath, ''),
    ]);
    await Promise.all([chmod(ffmpegPath, 0o755), chmod(ffprobePath, 0o755)]);
    const runner = new FakeFfmpegRunner();
    const tools = new FfmpegMediaTools({ ffmpegPath, ffprobePath }, runner);
    const source: MediaToolSource = {
      filePath: path.join(root, 'private-source.mp4'),
      modifiedAtMs: 1,
      summary: {
        fingerprintAlgorithm: 'sha256-full-v1',
        fingerprintSha256: 'a'.repeat(64),
        kind: 'video',
        mimeType: 'video/mp4',
        name: 'source.mp4',
        size: 123,
      },
    };
    const manager = new TemporaryArtifactManager(path.join(root, 'artifacts'));
    const limits = {
      maxArtifactBytes: 10 * 1024 * 1024,
      maxArtifacts: 20,
      maxOutputBytes: 1024 * 1024,
      timeoutMs: 10_000,
    };
    const frameWorkspace = await manager.createWorkspace(
      '00000000-0000-4000-8000-000000000011',
      limits,
    );
    const probe = await tools.probe(source);
    expect(probe).toMatchObject({ durationMs: 4000, hasAudio: true, mediaKind: 'video' });
    const frames = await tools.extractFrames(
      source,
      { count: 3, maxDimension: 720, mode: 'representative' },
      frameWorkspace,
    );
    expect(frames.frames.map((frame) => frame.timeMs)).toEqual([0, 1975, 3950]);
    expect(frames.frames).toHaveLength(3);
    expect(JSON.stringify(frames)).not.toContain(source.filePath);
    const shots = await tools.detectShots(source, { minimumShotMs: 300, threshold: 0.32 });
    expect(shots.shots.map((shot) => [shot.startMs, shot.endMs])).toEqual([
      [0, 1000],
      [1000, 3000],
      [3000, 4000],
    ]);
    const audioWorkspace = await manager.createWorkspace(
      '00000000-0000-4000-8000-000000000012',
      limits,
    );
    const audio = await tools.extractAudio(source, audioWorkspace);
    expect(audio).toMatchObject({
      hasAudio: true,
      integratedLoudnessLufs: -16.2,
      maxVolumeDb: -2.1,
      meanVolumeDb: -18.5,
      silence: [{ endMs: 1800, startMs: 1200 }],
    });
    expect(audio.waveform.length).toBeGreaterThan(10);
    expect(Math.max(...audio.waveform.map((point) => point.peak))).toBeLessThanOrEqual(1);
    expect(runner.requests.every((request) => request.args.every((value) => !value.includes('\0')))).toBe(true);
  });

  it('reports missing runtimes without attempting media parsing', async () => {
    const tools = new FfmpegMediaTools({
      ffmpegPath: '/definitely/missing/ffmpeg',
      ffprobePath: '/definitely/missing/ffprobe',
    });
    await expect(tools.health()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ available: false, capabilityId: 'media.probe' }),
      ]),
    );
  });
});
