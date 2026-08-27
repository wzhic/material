import {
  ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';

import { CodexSubscriptionError } from './errors';

export type JsonObject = Record<string, unknown>;

export interface CodexAppServerNotification {
  generation: number;
  method: string;
  params?: unknown;
}

export interface CodexAppServerRequest extends CodexAppServerNotification {
  generation: number;
  id: number | string;
}

export interface CodexAppServerRuntimeClosedEvent {
  code: 'PROTOCOL_ERROR' | 'RUNTIME_UNAVAILABLE';
  generation: number;
}

export interface CodexAppServerClientOptions {
  appVersion: string;
  codexHome: string;
  command: string;
  environment: NodeJS.ProcessEnv;
  maxLineBytes?: number;
  requestTimeoutMs?: number;
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
}

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const BODY_NOTIFICATION_OPT_OUTS = [
  'command/exec/outputDelta',
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'item/plan/delta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'process/outputDelta',
  'rawResponse/completed',
  'rawResponseItem/completed',
  'thread/realtime/itemAdded',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'turn/diff/updated',
  'turn/moderationMetadata',
  'turn/plan/updated',
] as const;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validMessageId = (value: unknown): value is number | string =>
  (typeof value === 'number' && Number.isSafeInteger(value))
  || (typeof value === 'string' && value.length > 0 && value.length <= 128);

export class CodexAppServerRequestError extends Error {
  readonly responseCode: number | null;

  constructor(responseCode: number | null) {
    super('Codex App Server request failed');
    this.name = 'CodexAppServerRequestError';
    this.responseCode = responseCode;
  }
}

/**
 * Minimal stable App Server JSONL client. The high-level Codex SDK deliberately
 * is not used here because it wraps `codex exec` and cannot create ephemeral
 * threads or expose the managed subscription/account APIs.
 */
export class CodexAppServerClient {
  private readonly notificationListeners = new Set<(
    notification: CodexAppServerNotification,
  ) => void>();

  private readonly serverRequestListeners = new Set<(
    request: CodexAppServerRequest,
  ) => void>();

  private readonly runtimeClosedListeners = new Set<(
    event: CodexAppServerRuntimeClosedEvent,
  ) => void>();

  private readonly pending = new Map<number | string, PendingRequest>();

  private readonly maxLineBytes: number;

  private readonly requestTimeoutMs: number;

  private child: ChildProcessWithoutNullStreams | null = null;

  private inputBuffer = Buffer.alloc(0);

  private nextRequestId = 1;

  private startPromise: Promise<void> | null = null;

  private closed = false;

  private generationCounter = 0;

  private activeGeneration: number | null = null;

  private readonly forceKillTimers = new Map<
    ChildProcessWithoutNullStreams,
    ReturnType<typeof setTimeout>
  >();

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  onNotification(
    listener: (notification: CodexAppServerNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: CodexAppServerRequest) => void): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onRuntimeClosed(
    listener: (event: CodexAppServerRuntimeClosedEvent) => void,
  ): () => void {
    this.runtimeClosedListeners.add(listener);
    return () => this.runtimeClosedListeners.delete(listener);
  }

  getGeneration(): number | null {
    return this.child && this.startPromise ? this.activeGeneration : null;
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    }
    if (!this.startPromise) {
      this.startPromise = this.startInternal().catch((error) => {
        this.startPromise = null;
        throw error;
      });
    }
    await this.startPromise;
  }

  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    await this.start();
    return this.sendRequest<T>(method, params, timeoutMs);
  }

  requestIfRunning<T>(
    generation: number,
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.child || !this.startPromise || this.activeGeneration !== generation) {
      return Promise.reject(new CodexSubscriptionError('RUNTIME_UNAVAILABLE'));
    }
    return this.sendRequest<T>(method, params, timeoutMs);
  }

  invalidateGeneration(
    generation: number,
    code: CodexAppServerRuntimeClosedEvent['code'] = 'RUNTIME_UNAVAILABLE',
  ): boolean {
    const child = this.child;
    if (!child || this.activeGeneration !== generation) return false;
    if (code === 'PROTOCOL_ERROR') {
      this.failProtocol(child, generation);
    } else {
      this.failRuntime(child, generation, false);
    }
    return true;
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new CodexSubscriptionError('RUNTIME_UNAVAILABLE'));
    const child = this.child;
    if (child) this.terminateChild(child);
    this.child = null;
    this.activeGeneration = null;
    this.inputBuffer = Buffer.alloc(0);
    this.startPromise = null;
  }

  private async startInternal(): Promise<void> {
    const spawnProcess = this.options.spawnProcess ?? nodeSpawn;
    try {
      this.child = spawnProcess(
        this.options.command,
        ['app-server', '--stdio', '--strict-config'],
        {
          cwd: this.options.codexHome,
          env: this.options.environment,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch {
      throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    }

    const child = this.child;
    this.generationCounter += 1;
    const generation = this.generationCounter;
    this.activeGeneration = generation;
    child.stdout.on('data', (chunk: Buffer | string) =>
      this.handleStdout(child, generation, chunk));
    child.stdin.on('error', () => this.failRuntime(child, generation, false));
    // Stderr can contain sensitive runtime context. It is intentionally discarded.
    child.stderr.on('data', () => undefined);
    child.on('error', () => this.failRuntime(child, generation, false));
    child.on('exit', () => this.failRuntime(child, generation, true));

    try {
      await this.sendRequest('initialize', {
        capabilities: {
          // Required by the locked runtime for model fallback denial plus empty
          // environment/capability fields used by the controlled analysis turn.
          experimentalApi: true,
          optOutNotificationMethods: [...BODY_NOTIFICATION_OPT_OUTS],
          requestAttestation: false,
        },
        clientInfo: {
          name: 'material_desktop',
          title: 'Material Desktop',
          version: this.options.appVersion,
        },
      }, 15_000);
      this.writeMessage({ method: 'initialized' });
    } catch (error) {
      // A rejected handshake is a protocol-terminal generation. Without this
      // guard, start() could spawn a replacement while the rejected child lives on.
      if (this.child === child && this.activeGeneration === generation) {
        this.failProtocol(child, generation);
      }
      if (error instanceof CodexSubscriptionError) throw error;
      throw new CodexSubscriptionError('PROTOCOL_ERROR');
    }
  }

  private sendRequest<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const child = this.child;
    const generation = this.activeGeneration;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (child && generation !== null
          && this.child === child
          && this.activeGeneration === generation) {
          this.failProtocol(child, generation);
          return;
        }
        this.pending.delete(id);
        reject(new CodexSubscriptionError('PROTOCOL_ERROR'));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, {
        reject,
        resolve: resolve as (value: unknown) => void,
        timeout,
      });
      try {
        this.writeMessage(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private writeMessage(message: JsonObject): void {
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new CodexSubscriptionError('RUNTIME_UNAVAILABLE');
    }
    const serialized = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > this.maxLineBytes) {
      throw new CodexSubscriptionError('PROTOCOL_ERROR');
    }
    this.child.stdin.write(serialized, 'utf8');
  }

  private handleStdout(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    chunk: Buffer | string,
  ): void {
    if (this.child !== child || this.activeGeneration !== generation) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.inputBuffer = Buffer.concat([this.inputBuffer, bytes]);
    if (this.inputBuffer.length > this.maxLineBytes
      && this.inputBuffer.indexOf(0x0a) === -1) {
      this.failProtocol(child, generation);
      return;
    }

    let newlineIndex = this.inputBuffer.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const line = this.inputBuffer.subarray(0, newlineIndex);
      this.inputBuffer = this.inputBuffer.subarray(newlineIndex + 1);
      if (line.length > this.maxLineBytes) {
        this.failProtocol(child, generation);
        return;
      }
      if (line.length > 0) this.handleLine(child, generation, line.toString('utf8'));
      newlineIndex = this.inputBuffer.indexOf(0x0a);
    }
  }

  private handleLine(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    line: string,
  ): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.failProtocol(child, generation);
      return;
    }
    if (!isRecord(message)) {
      this.failProtocol(child, generation);
      return;
    }

    if (validMessageId(message.id) && typeof message.method !== 'string') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if ('error' in message) {
        const error = isRecord(message.error) && typeof message.error.code === 'number'
          ? message.error.code
          : null;
        pending.reject(new CodexAppServerRequestError(error));
      } else if ('result' in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(new CodexSubscriptionError('PROTOCOL_ERROR'));
      }
      return;
    }

    if (typeof message.method !== 'string' || message.method.length > 160) {
      this.failProtocol(child, generation);
      return;
    }
    if (validMessageId(message.id)) {
      const request: CodexAppServerRequest = {
        generation,
        id: message.id,
        method: message.method,
        params: message.params,
      };
      this.serverRequestListeners.forEach((listener) => {
        try {
          listener(request);
        } catch {
          // One consumer cannot prevent the mandatory fail-closed response.
        }
      });
      try {
        this.writeMessage({
          error: { code: -32601, message: 'Unsupported client capability' },
          id: message.id,
        });
      } catch {
        this.failProtocol(child, generation);
      }
      return;
    }
    const notification: CodexAppServerNotification = {
      generation,
      method: message.method,
      params: message.params,
    };
    this.notificationListeners.forEach((listener) => {
      try {
        listener(notification);
      } catch {
        // Listener failures are isolated from the JSONL transport.
      }
    });
  }

  private failProtocol(
    child: ChildProcessWithoutNullStreams,
    generation: number,
  ): void {
    if (this.child !== child || this.activeGeneration !== generation) return;
    this.failAll(new CodexSubscriptionError('PROTOCOL_ERROR'));
    this.child = null;
    this.activeGeneration = null;
    this.startPromise = null;
    this.inputBuffer = Buffer.alloc(0);
    this.terminateChild(child);
    this.emitRuntimeClosed({ code: 'PROTOCOL_ERROR', generation });
  }

  private failRuntime(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    exited: boolean,
  ): void {
    if (exited) this.clearForceKillTimer(child);
    if (this.closed) return;
    if (this.child !== child || this.activeGeneration !== generation) return;
    if (!exited) this.terminateChild(child);
    this.child = null;
    this.activeGeneration = null;
    this.startPromise = null;
    this.inputBuffer = Buffer.alloc(0);
    this.failAll(new CodexSubscriptionError('RUNTIME_UNAVAILABLE'));
    this.emitRuntimeClosed({ code: 'RUNTIME_UNAVAILABLE', generation });
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (this.forceKillTimers.has(child)) return;
    const timer = setTimeout(() => {
      this.forceKillTimers.delete(child);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    timer.unref?.();
    this.forceKillTimers.set(child, timer);
    child.once('exit', () => this.clearForceKillTimer(child));
  }

  private clearForceKillTimer(child: ChildProcessWithoutNullStreams): void {
    const timer = this.forceKillTimers.get(child);
    if (timer) clearTimeout(timer);
    this.forceKillTimers.delete(child);
  }

  private emitRuntimeClosed(event: CodexAppServerRuntimeClosedEvent): void {
    this.runtimeClosedListeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        // Runtime lifecycle consumers are isolated from the transport.
      }
    });
  }

  private failAll(error: Error): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    this.pending.clear();
  }
}
