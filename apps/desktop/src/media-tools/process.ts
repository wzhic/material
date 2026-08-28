import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import { MediaToolError } from './contracts';

export interface ProcessRequest {
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  executable: string;
  maxStderrBytes: number;
  maxStdoutBytes: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface ProcessResult {
  exitCode: number;
  stderr: Buffer;
  stdout: Buffer;
}

export interface MediaProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

const stop = (child: ReturnType<typeof spawn>): void => {
  if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
};

export class SpawnMediaProcessRunner implements MediaProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    if (!path.isAbsolute(request.executable)) {
      throw new MediaToolError('RUNTIME_MISSING', '媒体工具可执行文件路径无效');
    }
    if (request.args.some((argument) => argument.includes('\0'))) {
      throw new MediaToolError('RUNTIME_OUTPUT_INVALID', '媒体工具参数无效');
    }
    if (request.signal?.aborted) throw new Error('aborted');
    const operatingSystemEnvironment = process.platform === 'win32'
      ? {
        SystemRoot: process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
        TEMP: process.env.TEMP ?? '',
        TMP: process.env.TMP ?? '',
        WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows',
      }
      : {};
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: {
        ...operatingSystemEnvironment,
        LANG: 'C',
        LC_ALL: 'C',
        ...request.env,
      },
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    const abort = (): void => stop(child);
    request.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > request.maxStdoutBytes) {
        exceeded = true;
        stop(child);
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > request.maxStderrBytes) {
        exceeded = true;
        stop(child);
      } else {
        stderr.push(chunk);
      }
    });
    if (request.stdin !== undefined) child.stdin.end(request.stdin);
    else child.stdin.end();
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? -1));
      });
      if (request.signal?.aborted) throw new Error('aborted');
      if (exceeded) {
        throw new MediaToolError(
          'RUNTIME_OUTPUT_INVALID',
          '媒体工具输出超过安全上限',
        );
      }
      return {
        exitCode,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      };
    } catch (error) {
      if (request.signal?.aborted) throw new Error('aborted');
      if (error instanceof MediaToolError) throw error;
      throw new MediaToolError('RUNTIME_MISSING', '媒体工具无法启动');
    } finally {
      request.signal?.removeEventListener('abort', abort);
      stop(child);
    }
  }
}

const executableCandidates = (name: string, pathValue: string): string[] => {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => path.join(directory, `${name}${extension}`)));
};

export const resolveExecutable = async (
  name: string,
  configuredPath?: string,
  pathValue: string = process.env.PATH ?? '',
): Promise<string | null> => {
  const candidates = configuredPath
    ? [configuredPath]
    : executableCandidates(name, pathValue);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the explicit PATH candidates without invoking a shell.
    }
  }
  return null;
};

export const firstVersionLine = (value: Buffer): string | null => {
  const line = value.toString('utf8').split(/\r?\n/, 1)[0]?.trim();
  return line || null;
};
