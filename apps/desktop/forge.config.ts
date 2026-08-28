import type {
  ForgeArch,
  ForgeConfig,
  ForgePlatform,
  ResolvedForgeConfig,
} from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import electronChecksums from 'electron/checksums.json';
import { createRequire } from 'node:module';
import path from 'node:path';

import { resolveLearnedRuntimeBundle } from './src/media-tools/learned-runtime-bundle';
import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const forgeRequire = createRequire(__filename);

const codexPackageForTarget = (
  platform: ForgePlatform,
  arch: ForgeArch,
): { packageName: string; triple: string } => {
  const key = `${platform}:${arch}`;
  const targets: Record<string, { packageName: string; triple: string }> = {
    'darwin:arm64': {
      packageName: '@openai/codex-darwin-arm64',
      triple: 'aarch64-apple-darwin',
    },
    'darwin:x64': {
      packageName: '@openai/codex-darwin-x64',
      triple: 'x86_64-apple-darwin',
    },
    'linux:arm64': {
      packageName: '@openai/codex-linux-arm64',
      triple: 'aarch64-unknown-linux-musl',
    },
    'linux:x64': {
      packageName: '@openai/codex-linux-x64',
      triple: 'x86_64-unknown-linux-musl',
    },
    'win32:arm64': {
      packageName: '@openai/codex-win32-arm64',
      triple: 'aarch64-pc-windows-msvc',
    },
    'win32:x64': {
      packageName: '@openai/codex-win32-x64',
      triple: 'x86_64-pc-windows-msvc',
    },
  };
  const target = targets[key];
  if (!target) throw new Error(`Unsupported Codex runtime target: ${key}`);
  return target;
};

export const codexExtraResources = (
  platform: ForgePlatform,
  arch: ForgeArch,
  resolveModule: (specifier: string) => string = (specifier) =>
    forgeRequire.resolve(specifier),
): string[] => {
  const target = codexPackageForTarget(platform, arch);
  let packageJsonPath: string;
  try {
    packageJsonPath = resolveModule(`${target.packageName}/package.json`);
  } catch {
    throw new Error(`Codex runtime package unavailable for target: ${platform}:${arch}`);
  }
  const executableName = platform === 'win32' ? 'codex.exe' : 'codex';
  const executablePath = path.join(
    path.dirname(packageJsonPath),
    'vendor',
    target.triple,
    'bin',
    executableName,
  );
  const sdkLicense = path.resolve(
    path.dirname(packageJsonPath),
    '..',
    'codex-sdk',
    'LICENSE',
  );
  return [executablePath, sdkLicense];
};

export const configureCodexResourcesForTarget = async (
  forgeConfig: ResolvedForgeConfig,
  platform: ForgePlatform,
  arch: ForgeArch,
): Promise<void> => {
  const existing = forgeConfig.packagerConfig.extraResource;
  const existingResources = Array.isArray(existing)
    ? existing
    : existing ? [existing] : [];
  forgeConfig.packagerConfig.extraResource = [
    ...existingResources,
    ...codexExtraResources(platform, arch),
  ];
};

type LearnedRuntimeVerifier = typeof resolveLearnedRuntimeBundle;

export const configureLearnedRuntimeResourcesForTarget = async (
  forgeConfig: ResolvedForgeConfig,
  platform: ForgePlatform,
  arch: ForgeArch,
  environment: NodeJS.ProcessEnv = process.env,
  verify: LearnedRuntimeVerifier = resolveLearnedRuntimeBundle,
): Promise<void> => {
  const configuredRoot = environment.MATERIAL_LEARNED_RUNTIME_BUNDLE;
  if (!configuredRoot) {
    if (environment.MATERIAL_REQUIRE_LEARNED_RUNTIME === '1') {
      throw new Error('A verified learned runtime bundle is required for this package');
    }
    return;
  }
  if (!path.isAbsolute(configuredRoot) || path.basename(configuredRoot) !== 'learned-runtime') {
    throw new Error('Learned runtime bundle must be an absolute learned-runtime directory');
  }
  await verify({
    arch: arch as NodeJS.Architecture,
    platform: platform as NodeJS.Platform,
    root: configuredRoot,
  });
  const existing = forgeConfig.packagerConfig.extraResource;
  const existingResources = Array.isArray(existing)
    ? existing
    : existing ? [existing] : [];
  forgeConfig.packagerConfig.extraResource = [...existingResources, configuredRoot];
};

export const configurePackageResourcesForTarget = async (
  forgeConfig: ResolvedForgeConfig,
  platform: ForgePlatform,
  arch: ForgeArch,
): Promise<void> => {
  await configureCodexResourcesForTarget(forgeConfig, platform, arch);
  await configureLearnedRuntimeResourcesForTarget(forgeConfig, platform, arch);
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: [],
    // The Electron npm package ships release checksums. Passing them here keeps
    // cached packaging verifiable without fetching SHASUMS256.txt on every run.
    download: {
      cacheRoot: `${__dirname}/.electron-cache`,
      checksums: electronChecksums,
    },
  },
  hooks: {
    prePackage: configurePackageResourcesForTarget,
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
        ],
      },
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
