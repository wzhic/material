import path from 'node:path';

import type { ForgeArch, ForgePlatform, ResolvedForgeConfig } from '@electron-forge/shared-types';
import { describe, expect, it, vi } from 'vitest';

import {
  codexExtraResources,
  configureCodexResourcesForTarget,
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
      packagerConfig: { extraResource: ['./runtime'] },
    } as ResolvedForgeConfig;

    await configureCodexResourcesForTarget(
      forgeConfig,
      process.platform as ForgePlatform,
      process.arch as ForgeArch,
    );

    expect((forgeConfig.packagerConfig.extraResource as string[]).map((resource) =>
      path.basename(resource))).toEqual([
      'runtime',
      process.platform === 'win32' ? 'codex.exe' : 'codex',
      'LICENSE',
    ]);
  });
});
