import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MediaToolSource } from './contracts';
import { FfmpegMediaTools } from './ffmpeg';
import { LearnedMediaTools, LocalLearnedRuntime } from './learned-runtime';
import { MediaProcessRunner, ProcessRequest, ProcessResult } from './process';

class FakeLearnedRunner implements MediaProcessRunner {
  readonly requests: ProcessRequest[] = [];

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    const action = request.args[request.args.length - 1];
    if (request.args.includes('-version')) return this.result('media-runtime/test');
    if (request.args.includes('-show_format')) {
      return this.result({
        format: { duration: '2.000', format_name: 'matroska' },
        streams: [
          {
            avg_frame_rate: '25/1',
            codec_name: 'ffv1',
            codec_type: 'video',
            duration: '2.000',
            height: 240,
            index: 0,
            width: 320,
          },
          {
            channels: 1,
            codec_name: 'pcm_s16le',
            codec_type: 'audio',
            duration: '2.000',
            index: 1,
            sample_rate: '16000',
          },
        ],
      });
    }
    if (request.args.includes('--health')) {
      return this.result({
        available: true,
        detail: `${action} ready`,
        runtimeVersion: `${action}/test-1`,
      });
    }
    if (action === 'ocr') {
      return this.result({
        runtimeVersion: 'paddleocr/test',
        segments: [
          {
            confidence: 1.4,
            endMs: null,
            region: { height: 0.2, width: 0.5, x: 0.1, y: 0.7 },
            startMs: null,
            text: '  新品上新  ',
          },
          { confidence: 0.5, region: { height: 0, width: 0 }, text: 'invalid' },
        ],
      });
    }
    return this.result({
      detectedLanguage: 'zh',
      runtimeVersion: 'faster-whisper/test',
      segments: [
        {
          confidence: 0.8,
          endMs: 1200,
          speaker: null,
          startMs: 100,
          text: ' 看这里 ',
          words: [
            { confidence: 0.9, endMs: 500, startMs: 100, text: '看' },
          ],
        },
      ],
    });
  }

  private result(value: unknown): ProcessResult {
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify(value)) };
  }
}

const source: MediaToolSource = {
  filePath: '/private/material.jpg',
  modifiedAtMs: 1,
  summary: {
    fingerprintAlgorithm: 'sha256-full-v1',
    fingerprintSha256: 'b'.repeat(64),
    kind: 'image',
    mimeType: 'image/jpeg',
    name: 'material.jpg',
    size: 100,
  },
};

describe('local learned media runtime', () => {
  it('sanitizes OCR and ASR output and never returns the source path', async () => {
    const runner = new FakeLearnedRunner();
    const runtime = new LocalLearnedRuntime(
      {
        asrModelPath: '/models/whisper',
        audioEventModelPath: '/models/yamnet',
        cachePath: '/runtime-cache',
        ocrModelPath: '/models/paddleocr',
        pythonPath: process.platform === 'win32' ? 'C:\\Python\\python.exe' : '/usr/bin/python3',
        scriptPath: path.resolve('/runtime/media_runtime.py'),
      },
      runner,
    );
    const tools = new LearnedMediaTools(
      runtime,
      new FfmpegMediaTools({ ffmpegPath: process.execPath, ffprobePath: process.execPath }, runner),
    );
    const workspace = {
      adoptArtifact: async () => { throw new Error('unused'); },
      directory: '/tmp/workspace',
      invocationId: 'test',
      listArtifacts: () => [],
      writeArtifact: async () => { throw new Error('unused'); },
    };
    const ocr = await tools.ocr(source, { language: 'ch' }, workspace);
    expect(ocr.segments).toEqual([
      expect.objectContaining({ confidence: 1, text: '新品上新' }),
    ]);
    await expect(tools.asr(source, {})).resolves.toMatchObject({
      runtimeVersion: 'not-applicable',
      segments: [],
    });
    const asrSource = { ...source, summary: { ...source.summary, kind: 'video' as const } };
    const asr = await tools.asr(asrSource, { language: 'zh' });
    expect(asr.segments[0]).toMatchObject({ endMs: 1200, startMs: 100, text: '看这里' });
    expect(JSON.stringify({ asr, ocr })).not.toContain(source.filePath);
    await expect(tools.health()).resolves.toHaveLength(3);
    for (const request of runner.requests.filter((item) => item.args.includes('--run'))) {
      expect(request.env).toMatchObject({
        HF_HUB_OFFLINE: '1',
        PADDLE_PDX_CACHE_HOME: '/runtime-cache',
        PYTHONNOUSERSITE: '1',
        TRANSFORMERS_OFFLINE: '1',
      });
    }
  });

  it('reports a missing Python runtime as an unavailable optional capability', async () => {
    const runtime = new LocalLearnedRuntime({ scriptPath: '/runtime/media_runtime.py' });
    await expect(runtime.health('asr')).resolves.toMatchObject({
      available: false,
      capabilityId: 'media.asr',
    });
  });

  it('does not start the sidecar when a required local model is not configured', async () => {
    const runner = new FakeLearnedRunner();
    const runtime = new LocalLearnedRuntime(
      { pythonPath: process.execPath, scriptPath: '/runtime/media_runtime.py' },
      runner,
    );
    await expect(runtime.health('ocr')).resolves.toMatchObject({
      available: false,
      capabilityId: 'media.ocr',
    });
    expect(runner.requests).toHaveLength(0);
  });

  it('fails closed before execution when the bundle changes after startup', async () => {
    const runner = new FakeLearnedRunner();
    const verifyIntegrity = async (): Promise<void> => {
      throw new Error('tampered');
    };
    const runtime = new LocalLearnedRuntime(
      {
        asrModelPath: '/models/whisper',
        pythonPath: process.execPath,
        scriptPath: '/runtime/media_runtime.py',
        verifyIntegrity,
      },
      runner,
    );

    await expect(runtime.execute('asr', {})).rejects.toMatchObject({
      code: 'RUNTIME_MISSING',
      message: '本地学习型媒体运行时完整性校验失败',
    });
    expect(runner.requests).toHaveLength(0);
  });
});
