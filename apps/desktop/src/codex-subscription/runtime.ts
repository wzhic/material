import {
  ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { CodexSubscriptionError } from './errors';

export const EXPECTED_CODEX_RUNTIME_VERSION = '0.149.1' as const;

export interface CodexRuntimeTarget {
  packageName: string;
  triple: string;
}

const TARGETS: Record<string, CodexRuntimeTarget> = {
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

export const codexRuntimeTarget = (
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): CodexRuntimeTarget => {
  const target = TARGETS[`${platform}:${architecture}`];
  if (!target) {
    throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
  }
  return target;
};

export interface ResolveCodexRuntimeOptions {
  architecture?: NodeJS.Architecture;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  resourcesPath: string;
  resolvePackageJson?: (specifier: string) => string;
}

export const resolveCodexRuntimePath = async (
  options: ResolveCodexRuntimeOptions,
): Promise<string> => {
  const platform = options.platform ?? process.platform;
  const target = codexRuntimeTarget(platform, options.architecture ?? process.arch);
  const executableName = platform === 'win32' ? 'codex.exe' : 'codex';
  let vendorRoot: string;

  if (options.isPackaged) {
    const executablePath = path.join(options.resourcesPath, executableName);
    try {
      await access(executablePath, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    } catch {
      throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    }
    return executablePath;
  } else {
    const resolvePackageJson = options.resolvePackageJson ?? ((specifier: string) => {
      const runtimeRequire = createRequire(path.join(process.cwd(), 'package.json'));
      return runtimeRequire.resolve(specifier);
    });
    try {
      const packageJsonPath = resolvePackageJson(`${target.packageName}/package.json`);
      vendorRoot = path.join(path.dirname(packageJsonPath), 'vendor');
    } catch {
      throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    }
  }

  const executablePath = path.join(vendorRoot, target.triple, 'bin', executableName);
  try {
    await access(executablePath, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
  } catch {
    throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
  }
  return executablePath;
};

const ENVIRONMENT_ALLOWLIST = new Set([
  'ALL_PROXY',
  'APPDATA',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XDG_RUNTIME_DIR',
]);

export const buildCodexEnvironment = (
  codexHome: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  Object.entries(source).forEach(([name, value]) => {
    if (ENVIRONMENT_ALLOWLIST.has(name.toUpperCase()) && value !== undefined) {
      environment[name] = value;
    }
  });
  return environment;
};

export const CODEX_APP_SERVER_CONFIG = `# Managed by Material Desktop. App Server is the product integration interface.
forced_login_method = "chatgpt"
cli_auth_credentials_store = "keyring"
check_for_update_on_startup = false
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "read-only"
hide_agent_reasoning = true
project_doc_max_bytes = 0
project_doc_fallback_filenames = []

[history]
persistence = "none"

[memories]
generate_memories = false
use_memories = false

[features]
apps = false
hooks = false
multi_agent = false
remote_plugin = false
shell_snapshot = false
shell_tool = false
skill_mcp_dependency_install = false
unified_exec = false
view_image = false

[agents]
enabled = false

[feedback]
enabled = false

[analytics]
enabled = false
`;

const isRecordWithCode = (error: unknown): error is { code: string } =>
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && typeof error.code === 'string';

const isMissingPathError = (error: unknown): boolean =>
  isRecordWithCode(error) && error.code === 'ENOENT';

const assertRealDirectory = async (directoryPath: string): Promise<void> => {
  let metadata;
  try {
    metadata = await lstat(directoryPath);
  } catch (error) {
    if (isMissingPathError(error)) throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new CodexSubscriptionError('SECURITY_VIOLATION');
  }
  if (!metadata.isDirectory()) {
    throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
  }
};

const isDirectChild = (parent: string, child: string): boolean =>
  path.dirname(child) === parent && child !== parent;

/**
 * CODEX_HOME is canonicalized before the first App Server launch because the
 * official keyring account name is derived from that stable canonical path.
 * The dedicated root and leaf must be real directories: following a planted
 * symlink could overwrite a global Codex config and reuse its keyring account.
 */
export const prepareCodexHome = async (requestedPath: string): Promise<string> => {
  const absoluteHome = path.resolve(requestedPath);
  const scopedRoot = path.dirname(absoluteHome);
  if (path.basename(absoluteHome) === '' || absoluteHome === scopedRoot) {
    throw new CodexSubscriptionError('SECURITY_VIOLATION');
  }

  try {
    await mkdir(scopedRoot, { mode: 0o700, recursive: true });
    await assertRealDirectory(scopedRoot);
    await chmod(scopedRoot, 0o700);
    const canonicalRoot = await realpath(scopedRoot);

    try {
      const homeMetadata = await lstat(absoluteHome);
      if (homeMetadata.isSymbolicLink()) {
        throw new CodexSubscriptionError('SECURITY_VIOLATION');
      }
      if (!homeMetadata.isDirectory()) {
        throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      await mkdir(absoluteHome, { mode: 0o700 });
    }

    await assertRealDirectory(absoluteHome);
    await chmod(absoluteHome, 0o700);
    const canonicalHome = await realpath(absoluteHome);
    if (!isDirectChild(canonicalRoot, canonicalHome)) {
      throw new CodexSubscriptionError('SECURITY_VIOLATION');
    }

    const configPath = path.join(canonicalHome, 'config.toml');
    let configHandle;
    try {
      configHandle = await open(configPath, 'wx', 0o600);
      await configHandle.writeFile(CODEX_APP_SERVER_CONFIG, { encoding: 'utf8' });
      await configHandle.chmod(0o600);
    } catch (error) {
      if (!isMissingPathError(error)
        && (!isRecordWithCode(error) || error.code !== 'EEXIST')) throw error;
      if (isMissingPathError(error)) throw error;
      const configMetadata = await lstat(configPath);
      if (configMetadata.isSymbolicLink()
        || !configMetadata.isFile()
        || configMetadata.size > 16 * 1024) {
        throw new CodexSubscriptionError('SECURITY_VIOLATION');
      }
      const existingHandle = await open(configPath, 'r');
      try {
        const existingMetadata = await existingHandle.stat();
        const canonicalConfigPath = await realpath(configPath);
        if (!existingMetadata.isFile()
          || existingMetadata.size > 16 * 1024
          || path.resolve(canonicalConfigPath) !== path.resolve(configPath)) {
          throw new CodexSubscriptionError('SECURITY_VIOLATION');
        }
        const existingConfig = await existingHandle.readFile({ encoding: 'utf8' });
        if (existingConfig !== CODEX_APP_SERVER_CONFIG) {
          throw new CodexSubscriptionError('SECURITY_VIOLATION');
        }
      } finally {
        await existingHandle.close();
      }
    } finally {
      await configHandle?.close();
    }
    return canonicalHome;
  } catch (error) {
    if (error instanceof CodexSubscriptionError) throw error;
    throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
  }
};

export interface VerifyCodexRuntimeVersionOptions {
  command: string;
  codexHome: string;
  environment: NodeJS.ProcessEnv;
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
}

/** Verifies the exact locked sidecar before any App Server process is started. */
export const verifyCodexRuntimeVersion = async (
  options: VerifyCodexRuntimeVersionOptions,
): Promise<void> => new Promise<void>((resolve, reject) => {
  const spawnProcess = options.spawnProcess ?? nodeSpawn;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(options.command, ['--version'], {
      cwd: options.codexHome,
      env: options.environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    reject(new CodexSubscriptionError('RUNTIME_UNAVAILABLE'));
    return;
  }

  let settled = false;
  let stdout = Buffer.alloc(0);
  const finish = (error?: CodexSubscriptionError): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    if (error) reject(error);
    else resolve();
  };
  const fail = (): void => {
    child.kill('SIGTERM');
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1000);
    forceKill.unref?.();
    child.once('exit', () => clearTimeout(forceKill));
    finish(new CodexSubscriptionError('RUNTIME_UNAVAILABLE'));
  };
  const timeout = setTimeout(fail, options.timeoutMs ?? 5000);
  timeout.unref?.();

  child.stdin.end();
  child.stderr.on('data', () => undefined);
  child.stdout.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    if (stdout.length + bytes.length > 128) {
      fail();
      return;
    }
    stdout = Buffer.concat([stdout, bytes]);
  });
  child.once('error', fail);
  child.once('exit', (code) => {
    const expected = `codex-cli ${EXPECTED_CODEX_RUNTIME_VERSION}`;
    if (code !== 0 || stdout.toString('utf8').trim() !== expected) {
      finish(new CodexSubscriptionError('RUNTIME_UNAVAILABLE'));
      return;
    }
    finish();
  });
});
