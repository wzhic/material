import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from './client';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();

  readonly stdout = new PassThrough();

  readonly stderr = new PassThrough();

  exitCode: number | null = null;

  signalCode: NodeJS.Signals | null = null;

  constructor(private readonly acknowledgeSignals = true) {
    super();
  }

  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (this.acknowledgeSignals && typeof signal === 'string') this.signalCode = signal;
    return true;
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const attachProtocol = (
  child: FakeChild,
  received: Array<Record<string, unknown>>,
  responseFor: (message: Record<string, unknown>) => unknown = () => ({}),
): void => {
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line) as Record<string, unknown>;
        received.push(message);
        if (typeof message.id === 'number') {
          child.stdout.write(`${JSON.stringify({
            id: message.id,
            result: responseFor(message),
          })}\n`);
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
};

const asChildProcess = (child: FakeChild): ChildProcessWithoutNullStreams =>
  child as unknown as ChildProcessWithoutNullStreams;

describe('Codex App Server JSONL client', () => {
  it('spawns the pinned executable directly with shell disabled and performs the handshake',
    async () => {
      const child = new FakeChild();
      const received: Array<Record<string, unknown>> = [];
      attachProtocol(child, received);
      const spawnProcess = vi.fn(() => asChildProcess(child));
      const client = new CodexAppServerClient({
        appVersion: '1.2.3',
        codexHome: '/app/codex-home',
        command: '/app/resources/codex',
        environment: { CODEX_HOME: '/app/codex-home', PATH: '/usr/bin' },
        spawnProcess,
      });

      await client.start();

      expect(spawnProcess).toHaveBeenCalledWith(
        '/app/resources/codex',
        ['app-server', '--stdio', '--strict-config'],
        expect.objectContaining({
          cwd: '/app/codex-home',
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
      expect(received[0]).toMatchObject({
        method: 'initialize',
        params: {
          capabilities: { experimentalApi: true, requestAttestation: false },
          clientInfo: { name: 'material_desktop', version: '1.2.3' },
        },
      });
      expect(received[1]).toEqual({ method: 'initialized' });
      client.stop();
    });

  it('correlates split JSONL responses and isolates listener failures', async () => {
    const child = new FakeChild();
    const received: Array<Record<string, unknown>> = [];
    attachProtocol(child, received, (message) =>
      message.method === 'account/read' ? { account: null } : {});
    const client = new CodexAppServerClient({
      appVersion: '1.0.0',
      codexHome: '/safe/home',
      command: '/safe/codex',
      environment: { CODEX_HOME: '/safe/home' },
      spawnProcess: () => asChildProcess(child),
    });
    client.onNotification(() => {
      throw new Error('listener failure');
    });
    const serverRequests: string[] = [];
    client.onServerRequest((request) => {
      serverRequests.push(request.method);
      throw new Error('listener failure');
    });

    await client.start();
    const requestPromise = client.request<{ account: null }>('account/read', {
      refreshToken: false,
    });
    await expect(requestPromise).resolves.toEqual({ account: null });

    const notification = '{"method":"account/updated","params":{"authMode":null}}\n';
    child.stdout.write(notification.slice(0, 17));
    child.stdout.write(notification.slice(17));
    child.stdout.write('{"method":"item/tool/requestUserInput","id":99,"params":{}}\n');
    await flush();

    expect(serverRequests).toEqual(['item/tool/requestUserInput']);
    expect(received).toContainEqual({
      error: { code: -32601, message: 'Unsupported client capability' },
      id: 99,
    });
    client.stop();
  });

  it('clears a malformed stream before a clean runtime restart', async () => {
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(() => {
      const child = new FakeChild();
      const received: Array<Record<string, unknown>> = [];
      attachProtocol(child, received, (message) =>
        message.method === 'account/read' ? { account: null } : {});
      children.push(child);
      return asChildProcess(child);
    });
    const client = new CodexAppServerClient({
      appVersion: '1.0.0',
      codexHome: '/safe/home',
      command: '/safe/codex',
      environment: { CODEX_HOME: '/safe/home' },
      spawnProcess,
    });
    const notifications: string[] = [];
    client.onNotification((notification) => notifications.push(notification.method));

    await client.start();
    children[0].stdout.write('not-json\npartial');
    await flush();
    await expect(client.request('account/read', { refreshToken: false }))
      .resolves.toEqual({ account: null });
    children[0].stdout.write('{"method":"account/updated","params":{}}\n');
    children[1].stdout.write('{"method":"account/updated","params":{}}\n');
    await flush();

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(notifications).toEqual(['account/updated']);
    client.stop();
  });

  it('invalidates and terminates a generation when a request times out', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(false);
      let buffer = '';
      child.stdin.on('data', (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        lines.filter(Boolean).forEach((line) => {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.method === 'initialize') {
            child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
          }
        });
      });
      const closed: unknown[] = [];
      const client = new CodexAppServerClient({
        appVersion: '1.0.0',
        codexHome: '/safe/home',
        command: '/safe/codex',
        environment: { CODEX_HOME: '/safe/home' },
        requestTimeoutMs: 5,
        spawnProcess: () => asChildProcess(child),
      });
      client.onRuntimeClosed((event) => closed.push(event));
      await client.start();

      const request = client.request('account/read', { refreshToken: false });
      const rejection = expect(request).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      child.emit('error', new Error('error before exit'));
      await vi.advanceTimersByTimeAsync(5000);

      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(closed).toEqual([{ code: 'PROTOCOL_ERROR', generation: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates a rejected initialize generation before a clean retry', async () => {
    vi.useFakeTimers();
    try {
      const children: FakeChild[] = [];
      const spawnProcess = vi.fn(() => {
        const child = new FakeChild(children.length > 0);
        const childIndex = children.length;
        let buffer = '';
        child.stdin.on('data', (chunk) => {
          buffer += String(chunk);
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          lines.filter(Boolean).forEach((line) => {
            const message = JSON.parse(line) as Record<string, unknown>;
            if (typeof message.id !== 'number') return;
            const response = childIndex === 0 && message.method === 'initialize'
              ? { error: { code: -32600, message: 'rejected' }, id: message.id }
              : { id: message.id, result: {} };
            child.stdout.write(`${JSON.stringify(response)}\n`);
          });
        });
        children.push(child);
        return asChildProcess(child);
      });
      const closed: unknown[] = [];
      const client = new CodexAppServerClient({
        appVersion: '1.0.0',
        codexHome: '/safe/home',
        command: '/safe/codex',
        environment: { CODEX_HOME: '/safe/home' },
        spawnProcess,
      });
      client.onRuntimeClosed((event) => closed.push(event));

      await expect(client.start()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
      expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
      await expect(client.requestIfRunning(1, 'account/read'))
        .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });

      await client.start();
      expect(spawnProcess).toHaveBeenCalledTimes(2);
      expect(client.getGeneration()).toBe(2);
      expect(client.invalidateGeneration(1)).toBe(false);
      await expect(client.requestIfRunning(2, 'account/read')).resolves.toEqual({});
      expect(client.invalidateGeneration(2)).toBe(true);
      await expect(client.requestIfRunning(2, 'account/read'))
        .rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });

      await vi.advanceTimersByTimeAsync(5000);
      expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
      expect(closed).toEqual([
        { code: 'PROTOCOL_ERROR', generation: 1 },
        { code: 'RUNTIME_UNAVAILABLE', generation: 2 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed if a server request arrives after stdin has closed', async () => {
    const child = new FakeChild();
    const received: Array<Record<string, unknown>> = [];
    attachProtocol(child, received);
    const client = new CodexAppServerClient({
      appVersion: '1.0.0',
      codexHome: '/safe/home',
      command: '/safe/codex',
      environment: { CODEX_HOME: '/safe/home' },
      spawnProcess: () => asChildProcess(child),
    });
    await client.start();
    child.stdin.destroy();

    expect(() => child.stdout.write(
      '{"method":"item/tool/requestUserInput","id":99,"params":{}}\n',
    )).not.toThrow();
    await flush();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
