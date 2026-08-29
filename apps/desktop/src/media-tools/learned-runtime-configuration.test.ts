import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveLearnedRuntimeConfiguration } from './learned-runtime-configuration';

const manualEnvironment = {
  MATERIAL_ASR_MODEL_PATH: path.resolve('manual/asr'),
  MATERIAL_AUDIO_EVENT_MODEL_PATH: path.resolve('manual/yamnet'),
  MATERIAL_MEDIA_PYTHON: path.resolve('manual/python'),
  MATERIAL_OCR_MODEL_PATH: path.resolve('manual/ocr'),
};

describe('learned runtime application configuration', () => {
  it('never reads developer Python or model overrides in a packaged client', async () => {
    const configuration = await resolveLearnedRuntimeConfiguration({
      appPath: path.resolve('app'),
      arch: process.arch,
      cachePath: path.resolve('cache'),
      environment: manualEnvironment,
      isPackaged: true,
      platform: process.platform,
      resourcesPath: path.resolve('missing-packaged-resources'),
    });

    expect(configuration).toMatchObject({
      scriptPath: path.resolve('missing-packaged-resources', 'runtime', 'media_runtime.py'),
      unavailableDetail: expect.stringContaining('缺失或校验失败'),
    });
    expect(configuration.pythonPath).toBeUndefined();
    expect(configuration.asrModelPath).toBeUndefined();
  });

  it('retains explicit path overrides only for unbundled developer runs', async () => {
    const configuration = await resolveLearnedRuntimeConfiguration({
      appPath: path.resolve('app'),
      arch: process.arch,
      cachePath: path.resolve('cache'),
      environment: manualEnvironment,
      isPackaged: false,
      platform: process.platform,
      resourcesPath: path.resolve('resources'),
    });

    expect(configuration).toMatchObject({
      asrModelPath: manualEnvironment.MATERIAL_ASR_MODEL_PATH,
      audioEventModelPath: manualEnvironment.MATERIAL_AUDIO_EVENT_MODEL_PATH,
      ocrModelPath: manualEnvironment.MATERIAL_OCR_MODEL_PATH,
      pythonPath: manualEnvironment.MATERIAL_MEDIA_PYTHON,
    });
  });

  it('fails closed instead of falling back when an explicit developer bundle is invalid', async () => {
    const configuration = await resolveLearnedRuntimeConfiguration({
      appPath: path.resolve('app'),
      arch: process.arch,
      cachePath: path.resolve('cache'),
      environment: {
        ...manualEnvironment,
        MATERIAL_LEARNED_RUNTIME_ROOT: path.resolve('missing-bundle'),
      },
      isPackaged: false,
      platform: process.platform,
      resourcesPath: path.resolve('resources'),
    });

    expect(configuration.pythonPath).toBeUndefined();
    expect(configuration.unavailableDetail).toContain('校验失败');
  });
});
