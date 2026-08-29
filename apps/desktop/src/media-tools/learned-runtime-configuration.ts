import path from 'node:path';

import type { LocalLearnedRuntimeConfiguration } from './learned-runtime';
import { resolveLearnedRuntimeBundle } from './learned-runtime-bundle';

export interface LearnedRuntimeApplicationContext {
  appPath: string;
  arch: NodeJS.Architecture;
  cachePath: string;
  environment: NodeJS.ProcessEnv;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
}

const unavailable = (
  scriptPath: string,
  cachePath: string,
  detail: string,
): LocalLearnedRuntimeConfiguration => ({
  cachePath,
  ocrLanguage: 'ch',
  scriptPath,
  unavailableDetail: detail,
});

export const resolveLearnedRuntimeConfiguration = async (
  context: LearnedRuntimeApplicationContext,
): Promise<LocalLearnedRuntimeConfiguration> => {
  const sourceScript = context.isPackaged
    ? path.join(context.resourcesPath, 'runtime', 'media_runtime.py')
    : path.join(context.appPath, 'runtime', 'media_runtime.py');
  if (context.isPackaged) {
    try {
      return {
        ...await resolveLearnedRuntimeBundle({
          arch: context.arch,
          platform: context.platform,
          root: path.join(context.resourcesPath, 'learned-runtime'),
        }),
        cachePath: context.cachePath,
      };
    } catch {
      return unavailable(
        sourceScript,
        context.cachePath,
        '随应用安装的本地学习型媒体运行时缺失或校验失败',
      );
    }
  }
  const configuredBundle = context.environment.MATERIAL_LEARNED_RUNTIME_ROOT;
  if (configuredBundle) {
    try {
      return {
        ...await resolveLearnedRuntimeBundle({
          arch: context.arch,
          platform: context.platform,
          root: configuredBundle,
        }),
        cachePath: context.cachePath,
      };
    } catch {
      return unavailable(
        sourceScript,
        context.cachePath,
        '开发用本地学习型媒体运行时包校验失败',
      );
    }
  }
  return {
    asrModelPath: context.environment.MATERIAL_ASR_MODEL_PATH,
    audioEventModelPath: context.environment.MATERIAL_AUDIO_EVENT_MODEL_PATH,
    cachePath: context.cachePath,
    ocrLanguage: 'ch',
    ocrModelPath: context.environment.MATERIAL_OCR_MODEL_PATH,
    pythonPath: context.environment.MATERIAL_MEDIA_PYTHON,
    scriptPath: sourceScript,
  };
};
