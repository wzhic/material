import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FunctionToolAdapter,
  ScriptProcessAdapter,
  SkillToolAdapter,
  ToolAdapterError,
} from './adapters';
import { TemporaryArtifactManager } from './artifact-manager';
import { ToolBroker, ToolBrokerPolicy } from './broker';
import { ToolRegistry } from './registry';
import { validateValue } from './schema';
import { ToolManifest, ToolResourceLimits, ValueSchema } from './types';

const roots: string[] = [];

const limits: ToolResourceLimits = {
  maxArtifactBytes: 1024,
  maxArtifacts: 2,
  maxOutputBytes: 1024,
  timeoutMs: 250,
};

const objectSchema = (
  properties: Record<string, ValueSchema>,
  required: string[] = Object.keys(properties),
): ValueSchema => ({
  additionalProperties: false,
  properties,
  required,
  type: 'object',
});

const manifest = (
  overrides: Partial<ToolManifest> = {},
): ToolManifest => ({
  capabilityId: 'test.echo',
  cancellable: true,
  displayName: 'Test echo',
  failureMode: 'required',
  inputSchema: objectSchema({ value: { type: 'string' } }),
  kind: 'builtin',
  outputSchema: objectSchema({ echoed: { type: 'string' } }),
  permissions: [],
  resources: limits,
  schemaVersion: 1,
  version: '1.0.0',
  ...overrides,
});

const root = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'material-tooling-test-'));
  roots.push(directory);
  return directory;
};

const policy = (overrides: Partial<ToolBrokerPolicy> = {}): ToolBrokerPolicy => ({
  allowedCapabilities: ['test.echo'],
  allowedPermissions: [],
  maxConcurrentInvocations: 4,
  resourceCeilings: limits,
  ...overrides,
});

const brokerWith = async (
  toolManifest: ToolManifest,
  adapter: FunctionToolAdapter | ScriptProcessAdapter,
  brokerPolicy: ToolBrokerPolicy = policy({
    allowedCapabilities: [toolManifest.capabilityId],
    allowedPermissions: [...toolManifest.permissions],
  }),
): Promise<{ broker: ToolBroker; tempRoot: string }> => {
  const tempRoot = await root();
  const registry = new ToolRegistry();
  registry.register(toolManifest, adapter);
  return {
    broker: new ToolBroker(
      registry,
      new TemporaryArtifactManager(tempRoot),
      brokerPolicy,
    ),
    tempRoot,
  };
};

afterEach(async () => {
  const manager = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((directory) => manager.rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe('schema and registry', () => {
  it('accepts bounded unions and rejects values outside every branch', () => {
    const schema: ValueSchema = {
      anyOf: [{ type: 'null' }, { maxLength: 8, type: 'string' }],
    };
    expect(validateValue(schema, null).ok).toBe(true);
    expect(validateValue(schema, 'runtime').ok).toBe(true);
    expect(validateValue(schema, 3).ok).toBe(false);
  });

  it('rejects unknown and prototype-pollution shaped input fields', () => {
    const schema = objectSchema({ safe: { type: 'string' } });
    expect(validateValue(schema, { extra: 'no', safe: 'yes' }).ok).toBe(false);
    const polluted = JSON.parse('{"safe":"yes","__proto__":{"admin":true}}');
    const result = validateValue(schema, polluted);
    expect(result.ok).toBe(false);
    expect(result.issues.some((entry) => entry.code === 'FORBIDDEN_KEY')).toBe(true);
  });

  it('keeps exact versions and immutable capability snapshots', () => {
    const registry = new ToolRegistry();
    const adapter = new FunctionToolAdapter('builtin', async ({ input }) => input);
    const first = registry.register(manifest(), adapter);
    registry.register(manifest({ version: '1.2.0' }), adapter);
    expect(registry.resolve('test.echo')?.snapshot.version).toBe('1.2.0');
    expect(registry.resolve('test.echo', '1.0.0')?.snapshot).toBe(first);
    expect(() => registry.register(manifest(), adapter)).toThrow(/already registered/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.resources)).toBe(true);
    expect(first.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects a manifest whose adapter kind or resource limits are invalid', () => {
    const registry = new ToolRegistry();
    const skill = new FunctionToolAdapter('skill', async () => ({ echoed: 'x' }));
    expect(() => registry.register(manifest(), skill)).toThrow(/kind/);
    expect(() =>
      registry.register(
        manifest({ resources: { ...limits, timeoutMs: 0 } }),
        new FunctionToolAdapter('builtin', async () => ({ echoed: 'x' })),
      ),
    ).toThrow(/positive/);
  });
});

describe('temporary artifact manager', () => {
  it('isolates artifacts, enforces quotas and cleans an exact workspace', async () => {
    const tempRoot = await root();
    const manager = new TemporaryArtifactManager(tempRoot);
    const workspace = await manager.createWorkspace(
      '00000000-0000-4000-8000-000000000001',
      { ...limits, maxArtifactBytes: 5 },
    );
    const artifact = await workspace.writeArtifact('evidence/a.txt', 'hello', 'text/plain');
    expect(artifact.byteLength).toBe(5);
    await expect(workspace.writeArtifact('../escape.txt', 'x', 'text/plain')).rejects.toThrow(
      /safe relative path/,
    );
    await expect(workspace.writeArtifact('too-big.txt', '123456', 'text/plain')).rejects.toThrow(
      /artifact bytes/,
    );
    expect(await readFile(path.join(workspace.directory, artifact.relativePath), 'utf8')).toBe(
      'hello',
    );
    await manager.cleanup(workspace.invocationId);
    await expect(stat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('rejects an artifact reached through a symlink', async () => {
    const tempRoot = await root();
    const outside = await root();
    await writeFile(path.join(outside, 'stolen.txt'), 'no');
    const manager = new TemporaryArtifactManager(tempRoot);
    const workspace = await manager.createWorkspace(
      '00000000-0000-4000-8000-000000000002',
      limits,
    );
    await symlink(outside, path.join(workspace.directory, 'link'));
    await expect(workspace.adoptArtifact('link/stolen.txt', 'text/plain')).rejects.toThrow(
      /outside/,
    );
  });
});

describe('tool broker and adapters', () => {
  it('allows exact registered artifact reads until explicit release', async () => {
    const { broker, tempRoot } = await brokerWith(
      manifest(),
      new FunctionToolAdapter('builtin', async ({ input, workspace }) => {
        await workspace.writeArtifact('visual/frame.jpg', 'jpeg-bytes', 'image/jpeg');
        return { echoed: (input as { value: string }).value };
      }),
    );
    const result = await broker.invoke({ capabilityId: 'test.echo', input: { value: 'ok' } });
    if (!result.ok) throw new Error('tool invocation failed');
    expect(result.artifacts).toHaveLength(1);
    await expect(broker.readArtifact(
      result.invocationId,
      result.artifacts[0].artifactId,
    )).resolves.toEqual(Buffer.from('jpeg-bytes'));
    await expect(broker.readArtifact(result.invocationId, 'not-registered')).rejects.toThrow(
      /not registered/,
    );
    await writeFile(path.join(
      tempRoot,
      `material-tool-run-${result.invocationId}`,
      result.artifacts[0].relativePath,
    ), 'changed-after-registration');
    await expect(broker.readArtifact(
      result.invocationId,
      result.artifacts[0].artifactId,
    )).rejects.toThrow(/changed/);
    await broker.release(result.invocationId);
    await expect(broker.readArtifact(
      result.invocationId,
      result.artifacts[0].artifactId,
    )).rejects.toThrow(/not registered/);
  });

  it('validates input and output while keeping audit metadata free of raw values', async () => {
    const { broker } = await brokerWith(
      manifest(),
      new FunctionToolAdapter('builtin', async ({ input }) => ({
        echoed: (input as { value: string }).value,
      })),
    );
    const invalid = await broker.invoke({ capabilityId: 'test.echo', input: { wrong: 1 } });
    expect(invalid).toMatchObject({ error: { code: 'INVALID_INPUT' }, ok: false });
    const result = await broker.invoke({
      capabilityId: 'test.echo',
      input: { value: 'super-secret-value' },
    });
    expect(result).toMatchObject({ ok: true, output: { echoed: 'super-secret-value' } });
    expect(JSON.stringify(broker.auditTrail())).not.toContain('super-secret-value');
    if (result.ok) await broker.release(result.invocationId);

    const invalidOutputBroker = await brokerWith(
      manifest(),
      new FunctionToolAdapter('builtin', async () => ({ unexpected: true })),
    );
    await expect(
      invalidOutputBroker.broker.invoke({
        capabilityId: 'test.echo',
        input: { value: 'x' },
      }),
    ).resolves.toMatchObject({ error: { code: 'INVALID_OUTPUT' }, ok: false });
  });

  it('runs a Skill through the same narrow context and contract', async () => {
    const toolManifest = manifest({ kind: 'skill' });
    const { broker } = await brokerWith(
      toolManifest,
      new SkillToolAdapter(async ({ input, signal, workspace }) => {
        expect(signal.aborted).toBe(false);
        expect(workspace.invocationId).toMatch(/^[0-9a-f-]{36}$/);
        return { echoed: (input as { value: string }).value };
      }),
    );
    const result = await broker.invoke({
      capabilityId: 'test.echo',
      input: { value: 'skill-value' },
    });
    expect(result).toMatchObject({ ok: true, output: { echoed: 'skill-value' } });
    if (result.ok) await broker.release(result.invocationId);
  });

  it('denies an undeclared permission before executing the adapter', async () => {
    let executed = false;
    const toolManifest = manifest({ permissions: ['network:access'] });
    const { broker } = await brokerWith(
      toolManifest,
      new FunctionToolAdapter('builtin', async () => {
        executed = true;
        return { echoed: 'no' };
      }),
      policy({ allowedCapabilities: ['test.echo'], allowedPermissions: [] }),
    );
    const result = await broker.invoke({ capabilityId: 'test.echo', input: { value: 'x' } });
    expect(result).toMatchObject({ error: { code: 'POLICY_DENIED' }, ok: false });
    expect(executed).toBe(false);
  });

  it('fails closed when direct broker concurrency reaches its policy limit', async () => {
    const gate: { finish?: () => void } = {};
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { broker } = await brokerWith(
      manifest(),
      new FunctionToolAdapter(
        'builtin',
        ({ input }) =>
          new Promise((resolve) => {
            gate.finish = () => resolve({ echoed: (input as { value: string }).value });
            markStarted?.();
          }),
      ),
      policy({ maxConcurrentInvocations: 1 }),
    );
    const first = broker.invoke({ capabilityId: 'test.echo', input: { value: 'first' } });
    await started;
    const second = await broker.invoke({
      capabilityId: 'test.echo',
      input: { value: 'second' },
    });
    expect(second).toMatchObject({ error: { code: 'RESOURCE_BUSY' }, ok: false });
    if (!gate.finish) throw new Error('first invocation did not start');
    gate.finish();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
    if (firstResult.ok) await broker.release(firstResult.invocationId);
  });

  it('reports timeout and caller cancellation without leaking adapter errors', async () => {
    const waitForAbort = new FunctionToolAdapter('builtin', ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new ToolAdapterError('CANCELLED', 'raw private adapter detail')),
          { once: true },
        );
      }),
    );
    const timeoutTool = manifest({ resources: { ...limits, timeoutMs: 15 } });
    const { broker } = await brokerWith(timeoutTool, waitForAbort);
    const timeoutResult = await broker.invoke({
      capabilityId: 'test.echo',
      input: { value: 'x' },
    });
    expect(timeoutResult).toMatchObject({ error: { code: 'TIMEOUT' }, ok: false });
    expect(JSON.stringify(timeoutResult)).not.toContain('raw private adapter detail');

    const cancellation = new AbortController();
    const pending = broker.invoke({
      capabilityId: 'test.echo',
      input: { value: 'x' },
      signal: cancellation.signal,
    });
    cancellation.abort();
    await expect(pending).resolves.toMatchObject({ error: { code: 'CANCELLED' }, ok: false });
  });

  it('runs a fixed script process without a shell and adopts declared artifacts', async () => {
    const code = [
      "const fs=require('node:fs')",
      "let body=''",
      "process.stdin.on('data',c=>body+=c)",
      "process.stdin.on('end',()=>{const input=JSON.parse(body);fs.writeFileSync('result.txt',input.value);process.stdout.write(JSON.stringify({output:{echoed:input.value},artifacts:[{path:'result.txt',mediaType:'text/plain'}]}))})",
    ].join(';');
    const toolManifest = manifest({
      kind: 'script',
      permissions: ['process:spawn', 'temp:write'],
    });
    const { broker } = await brokerWith(
      toolManifest,
      new ScriptProcessAdapter({ args: ['-e', code], executable: process.execPath }),
    );
    const result = await broker.invoke({
      capabilityId: 'test.echo',
      input: { value: 'script-value' },
    });
    expect(result).toMatchObject({ ok: true, output: { echoed: 'script-value' } });
    if (!result.ok) throw new Error('script invocation did not succeed');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      byteLength: 12,
      mediaType: 'text/plain',
      relativePath: 'result.txt',
    });
    await broker.release(result.invocationId);
  });

  it('rejects a relative script executable instead of searching PATH', () => {
    expect(() => new ScriptProcessAdapter({ executable: 'node' })).toThrow(/absolute path/);
  });

  it('rejects script stdout over the output ceiling', async () => {
    const toolManifest = manifest({
      kind: 'script',
      permissions: ['process:spawn'],
      resources: { ...limits, maxOutputBytes: 32 },
    });
    const { broker } = await brokerWith(
      toolManifest,
      new ScriptProcessAdapter({
        args: ['-e', "process.stdout.write('x'.repeat(1000))"],
        executable: process.execPath,
      }),
    );
    const result = await broker.invoke({ capabilityId: 'test.echo', input: { value: 'x' } });
    expect(result).toMatchObject({ error: { code: 'OUTPUT_LIMIT' }, ok: false });
  });
});
