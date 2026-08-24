import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';

import { JsonValue, ToolAdapter, ToolAdapterContext, ToolKind } from './types';

export type ToolAdapterErrorCode =
  | 'CANCELLED'
  | 'EXECUTION_FAILED'
  | 'INVALID_OUTPUT'
  | 'OUTPUT_LIMIT';

export class ToolAdapterError extends Error {
  constructor(readonly code: ToolAdapterErrorCode, message: string) {
    super(message);
    this.name = 'ToolAdapterError';
  }
}

export type ToolExecutor = (context: ToolAdapterContext) => Promise<JsonValue>;

export class FunctionToolAdapter implements ToolAdapter {
  constructor(
    readonly kind: ToolKind,
    private readonly executor: ToolExecutor,
  ) {}

  execute(context: ToolAdapterContext): Promise<JsonValue> {
    return this.executor(context);
  }
}

export class SkillToolAdapter extends FunctionToolAdapter {
  constructor(executor: ToolExecutor) {
    super('skill', executor);
  }
}

interface ProcessArtifactDeclaration {
  mediaType: string;
  path: string;
}

interface ProcessEnvelope {
  artifacts?: ProcessArtifactDeclaration[];
  output: JsonValue;
}

export interface ScriptProcessConfiguration {
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  executable: string;
}

const isProcessEnvelope = (value: unknown): value is ProcessEnvelope => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.prototype.hasOwnProperty.call(value, 'output');
};

const stop = (child: ChildProcessWithoutNullStreams): void => {
  if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
};

export class ScriptProcessAdapter implements ToolAdapter {
  readonly kind = 'script' as const;

  constructor(private readonly configuration: ScriptProcessConfiguration) {
    if (!path.isAbsolute(configuration.executable)) {
      throw new Error('script executable must be an absolute path');
    }
    if (configuration.args?.some((argument) => argument.includes('\0'))) {
      throw new Error('script argument contains a null byte');
    }
  }

  async execute(context: ToolAdapterContext): Promise<JsonValue> {
    if (context.signal.aborted) {
      throw new ToolAdapterError('CANCELLED', 'tool execution was cancelled');
    }
    const child = spawn(
      this.configuration.executable,
      [...(this.configuration.args ?? [])],
      {
        cwd: context.workspace.directory,
        env: { ...(this.configuration.env ?? {}) },
        shell: false,
        windowsHide: true,
      },
    );
    const abort = (): void => stop(child);
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputLimitExceeded = false;
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > context.limits.maxOutputBytes) {
          outputLimitExceeded = true;
          stop(child);
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > context.limits.maxOutputBytes) {
          outputLimitExceeded = true;
          stop(child);
        }
      });
      child.stdin.end(JSON.stringify(context.input));
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      }).catch(() => {
        throw new ToolAdapterError('EXECUTION_FAILED', 'script process could not start');
      });
      if (context.signal.aborted) {
        throw new ToolAdapterError('CANCELLED', 'tool execution was cancelled');
      }
      if (outputLimitExceeded) {
        throw new ToolAdapterError('OUTPUT_LIMIT', 'script output exceeded its limit');
      }
      if (exitCode !== 0) {
        throw new ToolAdapterError('EXECUTION_FAILED', 'script process failed');
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(Buffer.concat(stdout).toString('utf8'));
      } catch {
        throw new ToolAdapterError('INVALID_OUTPUT', 'script did not return valid JSON');
      }
      if (!isProcessEnvelope(envelope)) {
        throw new ToolAdapterError('INVALID_OUTPUT', 'script output envelope is invalid');
      }
      if (envelope.artifacts) {
        for (const artifact of envelope.artifacts) {
          if (
            artifact === null ||
            typeof artifact !== 'object' ||
            typeof artifact.path !== 'string' ||
            typeof artifact.mediaType !== 'string'
          ) {
            throw new ToolAdapterError('INVALID_OUTPUT', 'script artifact declaration is invalid');
          }
          await context.workspace.adoptArtifact(artifact.path, artifact.mediaType);
        }
      }
      return envelope.output;
    } finally {
      context.signal.removeEventListener('abort', abort);
      stop(child);
    }
  }
}
