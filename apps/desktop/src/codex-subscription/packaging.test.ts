import path from 'node:path';

import type { ForgeArch, ForgePlatform, ResolvedForgeConfig } from '@electron-forge/shared-types';
import { describe, expect, it, vi } from 'vitest';

import {
  codexExtraResources,
  configureCodexResourcesForTarget,
  configureLearnedRuntimeResourcesForTarget,
} from '../../forge.config';

describe('Codex packaged resources', () => {
  it('ships only the App Server executable and the SDK Apache-2.0 license', () => {
    const resources = codexExtraResources(
      process.platform as ForgePlatform,
      process.arch as ForgeArch,
    );
    const basenames = resources.map((resource) => path.basename(resource));

    expect(basenames).toEqual([
      process.platform === 'win32' ? 'codex.exe' : 'codex',
      'LICENSE',
    ]);
    expect(resources.some((resource) => /code-mode-host|[/\\]rg(?:\.exe)?$/.test(resource)))
      .toBe(false);
  });

  it('selects resources from the requested target rather than the host architecture', () => {
    const resolveModule = vi.fn((specifier: string) => {
      if (specifier === '@openai/codex-darwin-x64/package.json') {
        return '/packages/codex-darwin-x64/package.json';
      }
      if (specifier === '@openai/codex-sdk') return '/packages/codex-sdk/dist/index.js';
      throw new Error('unexpected module');
    });

    const resources = codexExtraResources('darwin', 'x64', resolveModule);

    expect(resolveModule).toHaveBeenCalledWith('@openai/codex-darwin-x64/package.json');
    expect(resources[0]).toContain('x86_64-apple-darwin');
    expect(resources.map((resource) => path.basename(resource))).toEqual(['codex', 'LICENSE']);
  });

  it('fails closed for unsupported or missing target packages', () => {
    expect(() => codexExtraResources('darwin', 'universal', vi.fn()))
      .toThrow(/Unsupported Codex runtime target/);
    expect(() => codexExtraResources('win32', 'x64', () => {
      throw new Error('not installed');
    })).toThrow(/runtime package unavailable.*win32:x64/i);
  });

  it('mutates extraResource during the target-aware prePackage hook', async () => {
    const forgeConfig = {
      packagerConfig: { extraResource: [] as string[] },
    } as ResolvedForgeConfig;

    await configureCodexResourcesForTarget(
      forgeConfig,
      process.platform as ForgePlatform,
      process.arch as ForgeArch,
    );

    expect((forgeConfig.packagerConfig.extraResource as string[]).map((resource) =>
      path.basename(resource))).toEqual([
      process.platform === 'win32' ? 'codex.exe' : 'codex',
      'LICENSE',
    ]);
  });
});

describe('learned media packaged resources', () => {
  it('adds only a target-verified learned-runtime directory', async () => {
    const forgeConfig = {
      packagerConfig: { extraResource: [] as string[] },
    } as ResolvedForgeConfig;
    const bundle = path.resolve('fixtures', 'learned-runtime');
    const verify = vi.fn(async () => ({
      asrModelPath: path.join(bundle, 'models', 'asr'),
      audioEventModelPath: path.join(bundle, 'models', 'yamnet'),
      ocrModelPath: path.join(bundle, 'models', 'ocr'),
      pythonPath: path.join(bundle, 'runtime', 'python'),
      scriptPath: path.join(bundle, 'runtime', 'media_runtime.py'),
    }));

    await configureLearnedRuntimeResourcesForTarget(
      forgeConfig,
      'darwin',
      'arm64',
      { MATERIAL_LEARNED_RUNTIME_BUNDLE: bundle },
      verify,
    );

    expect(verify).toHaveBeenCalledWith({ arch: 'arm64', platform: 'darwin', root: bundle });
    expect(forgeConfig.packagerConfig.extraResource).toEqual([bundle]);
  });

  it('fails a release package when the verified runtime was not supplied', async () => {
    const forgeConfig = { packagerConfig: {} } as ResolvedForgeConfig;

    await expect(configureLearnedRuntimeResourcesForTarget(
      forgeConfig,
      'win32',
      'x64',
      { MATERIAL_REQUIRE_LEARNED_RUNTIME: '1' },
    )).rejects.toThrow(/verified learned runtime bundle is required/i);
  });

  it('rejects a runtime directory whose packaged destination would be ambiguous', async () => {
    const forgeConfig = { packagerConfig: {} } as ResolvedForgeConfig;

    await expect(configureLearnedRuntimeResourcesForTarget(
      forgeConfig,
      'darwin',
      'arm64',
      { MATERIAL_LEARNED_RUNTIME_BUNDLE: path.resolve('wrong-name') },
    )).rejects.toThrow(/absolute learned-runtime directory/i);
  });
});
