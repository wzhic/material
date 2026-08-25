import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCodexEnvironment,
  CODEX_APP_SERVER_CONFIG,
  codexRuntimeTarget,
  prepareCodexHome,
  resolveCodexRuntimePath,
  verifyCodexRuntimeVersion,
} from './runtime';

const directories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'material-codex-runtime-test-'));
  directories.push(directory);
  return directory;
};

class FakeVersionChild extends EventEmitter {
  readonly stdin = new PassThrough();

  readonly stdout = new PassThrough();

  readonly stderr = new PassThrough();

  exitCode: number | null = null;

  signalCode: NodeJS.Signals | null = null;

  readonly kill = vi.fn(() => true);
}

const asChildProcess = (child: FakeVersionChild): ChildProcessWithoutNullStreams =>
  child as unknown as ChildProcessWithoutNullStreams;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

describe('Codex sidecar runtime', () => {
  it('maps every supported Electron platform target to the locked optional package', () => {
    expect(codexRuntimeTarget('darwin', 'arm64')).toEqual({
      packageName: '@openai/codex-darwin-arm64',
      triple: 'aarch64-apple-darwin',
    });
    expect(codexRuntimeTarget('linux', 'x64').triple).toBe('x86_64-unknown-linux-musl');
    expect(codexRuntimeTarget('win32', 'arm64').triple).toBe('aarch64-pc-windows-msvc');
  });

  it('resolves the packaged single-file sidecar without consulting PATH or a global install',
    async () => {
      const resourcesPath = await temporaryDirectory();
      const executablePath = path.join(resourcesPath, 'codex');
      await writeFile(executablePath, 'test', { mode: 0o700 });
      await chmod(executablePath, 0o700);

      await expect(resolveCodexRuntimePath({
        architecture: 'arm64',
        isPackaged: true,
        platform: 'darwin',
        resourcesPath,
        resolvePackageJson: () => {
          throw new Error('must not resolve packages');
        },
      })).resolves.toBe(executablePath);
    });

  it('resolves development runtime only from the version-locked platform package', async () => {
    const packageRoot = await temporaryDirectory();
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const executablePath = path.join(
      packageRoot,
      'vendor',
      'aarch64-apple-darwin',
      'bin',
      'codex',
    );
    await mkdir(path.dirname(executablePath), { recursive: true });
    await writeFile(packageJsonPath, '{}');
    await writeFile(executablePath, 'test', { mode: 0o700 });
    await chmod(executablePath, 0o700);

    await expect(resolveCodexRuntimePath({
      architecture: 'arm64',
      isPackaged: false,
      platform: 'darwin',
      resourcesPath: '/ignored',
      resolvePackageJson: (specifier) => {
        expect(specifier).toBe('@openai/codex-darwin-arm64/package.json');
        return packageJsonPath;
      },
    })).resolves.toBe(executablePath);
  });

  it('creates a stable canonical CODEX_HOME with the fail-closed managed config', async () => {
    const parent = await temporaryDirectory();
    const requestedHome = path.join(parent, 'codex-home');
    const canonicalHome = await prepareCodexHome(requestedHome);
    const configPath = path.join(canonicalHome, 'config.toml');
    const [config, metadata] = await Promise.all([readFile(configPath, 'utf8'), stat(configPath)]);

    expect(config).toBe(CODEX_APP_SERVER_CONFIG);
    expect(config).toContain('forced_login_method = "chatgpt"');
    expect(config).toContain('cli_auth_credentials_store = "keyring"');
    expect(config).toContain('persistence = "none"');
    expect(config).toContain('generate_memories = false');
    expect(config).toContain('use_memories = false');
    expect(config).toContain('project_doc_max_bytes = 0');
    expect(config).toContain('project_doc_fallback_filenames = []');
    expect(config).toContain('shell_tool = false');
    expect(config).toContain('view_image = false');
    expect(metadata.mode & 0o777).toBe(0o600);
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    expect((await stat(canonicalHome)).mode & 0o777).toBe(0o700);
  });

  it('rejects planted symlinks for the app root, CODEX_HOME, and managed config', async () => {
    const base = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const linkedRoot = path.join(base, 'linked-root');
    await symlink(outside, linkedRoot, 'dir');
    await expect(prepareCodexHome(path.join(linkedRoot, 'codex-home')))
      .rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });

    const realRoot = path.join(base, 'real-root');
    await mkdir(realRoot);
    const linkedHome = path.join(realRoot, 'codex-home');
    await symlink(outside, linkedHome, 'dir');
    await expect(prepareCodexHome(linkedHome))
      .rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });

    const safeHome = path.join(base, 'safe-root', 'codex-home');
    await mkdir(safeHome, { recursive: true });
    const outsideConfig = path.join(outside, 'config.toml');
    await writeFile(outsideConfig, 'do-not-overwrite');
    await symlink(outsideConfig, path.join(safeHome, 'config.toml'));
    await expect(prepareCodexHome(safeHome))
      .rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
    expect(await readFile(outsideConfig, 'utf8')).toBe('do-not-overwrite');
  });

  it('passes only the explicit environment allowlist and app-scoped CODEX_HOME', () => {
    const environment = buildCodexEnvironment('/app/codex-home', {
      CODEX_HOME: '/global/codex-home',
      HOME: '/users/test',
      OPENAI_API_KEY: 'must-not-leak',
      PATH: '/usr/bin',
      RANDOM_APPLICATION_SECRET: 'must-not-leak',
    });

    expect(environment).toEqual({
      CODEX_HOME: '/app/codex-home',
      HOME: '/users/test',
      PATH: '/usr/bin',
    });
    expect(JSON.stringify(environment)).not.toContain('must-not-leak');
  });

  it('executes the fixed binary directly and accepts only exact 0.149.1 output', async () => {
    const child = new FakeVersionChild();
    const spawnProcess = vi.fn(() => asChildProcess(child));
    setImmediate(() => {
      child.stdout.write('codex-cli 0.149.1\n');
      child.exitCode = 0;
      child.emit('exit', 0);
    });

    await verifyCodexRuntimeVersion({
      codexHome: '/app/codex-home',
      command: '/app/resources/codex',
      environment: { CODEX_HOME: '/app/codex-home' },
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      '/app/resources/codex',
      ['--version'],
      expect.objectContaining({ cwd: '/app/codex-home', shell: false }),
    );
  });

  it('fails closed on a mismatched or non-responsive runtime version', async () => {
    const mismatched = new FakeVersionChild();
    setImmediate(() => {
      mismatched.stdout.write('codex-cli 0.149.2\n');
      mismatched.exitCode = 0;
      mismatched.emit('exit', 0);
    });
    await expect(verifyCodexRuntimeVersion({
      codexHome: '/app/codex-home',
      command: '/app/resources/codex',
      environment: { CODEX_HOME: '/app/codex-home' },
      spawnProcess: () => asChildProcess(mismatched),
    })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });

    const hanging = new FakeVersionChild();
    await expect(verifyCodexRuntimeVersion({
      codexHome: '/app/codex-home',
      command: '/app/resources/codex',
      environment: { CODEX_HOME: '/app/codex-home' },
      spawnProcess: () => asChildProcess(hanging),
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(hanging.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
