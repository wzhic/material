import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FunctionToolAdapter, ToolAdapterError } from './adapters';
import { TemporaryArtifactManager } from './artifact-manager';
import { ToolBroker } from './broker';
import { AnalysisOrchestrator } from './orchestrator';
import { ToolRegistry } from './registry';
import { ToolFailureMode, ToolManifest } from './types';

const roots: string[] = [];
const resources = {
  maxArtifactBytes: 1024,
  maxArtifacts: 2,
  maxOutputBytes: 1024,
  timeoutMs: 500,
};

const manifest = (
  capabilityId: string,
  failureMode: ToolFailureMode = 'required',
): ToolManifest => ({
  capabilityId,
  cancellable: true,
  displayName: capabilityId,
  failureMode,
  inputSchema: {
    additionalProperties: false,
    properties: { value: { type: 'string' } },
    required: ['value'],
    type: 'object',
  },
  kind: 'builtin',
  outputSchema: {
    additionalProperties: false,
    properties: { value: { type: 'string' } },
    required: ['value'],
    type: 'object',
  },
  permissions: [],
  resources,
  schemaVersion: 1,
  version: '1.0.0',
});

const setup = async (): Promise<{
  broker: ToolBroker;
  orchestrator: AnalysisOrchestrator;
  registry: ToolRegistry;
}> => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'material-orchestrator-test-'));
  roots.push(tempRoot);
  const registry = new ToolRegistry();
  const broker = new ToolBroker(registry, new TemporaryArtifactManager(tempRoot), {
    allowedCapabilities: ['tool.work', 'tool.fail', 'tool.optional'],
    allowedPermissions: [],
    maxConcurrentInvocations: 2,
    resourceCeilings: resources,
  });
  return { broker, orchestrator: new AnalysisOrchestrator(broker, 2), registry };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe('analysis orchestrator', () => {
  it('runs independent nodes in parallel and passes dependency output forward', async () => {
    const { orchestrator, registry } = await setup();
    let active = 0;
    let peak = 0;
    registry.register(
      manifest('tool.work'),
      new FunctionToolAdapter('builtin', async ({ input }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return input;
      }),
    );
    const result = await orchestrator.run({
      nodes: [
        { capabilityId: 'tool.work', id: 'left', input: { value: 'L' } },
        { capabilityId: 'tool.work', id: 'right', input: { value: 'R' } },
        {
          capabilityId: 'tool.work',
          dependencies: ['left', 'right'],
          id: 'join',
          input: (outputs) => ({
            value: `${(outputs.left as { value: string }).value}${
              (outputs.right as { value: string }).value
            }`,
          }),
        },
      ],
    });
    expect(result.status).toBe('succeeded');
    expect(peak).toBe(2);
    expect(result.nodes[2]).toMatchObject({
      invocation: { ok: true, output: { value: 'LR' } },
      nodeId: 'join',
    });
    await orchestrator.cleanup(result);
  });

  it('marks optional failure as degraded and skips only its dependent node', async () => {
    const { orchestrator, registry } = await setup();
    registry.register(
      manifest('tool.work'),
      new FunctionToolAdapter('builtin', async ({ input }) => input),
    );
    registry.register(
      manifest('tool.optional', 'optional'),
      new FunctionToolAdapter('builtin', async () => {
        throw new ToolAdapterError('EXECUTION_FAILED', 'not exposed');
      }),
    );
    const result = await orchestrator.run({
      nodes: [
        { capabilityId: 'tool.optional', id: 'optional', input: { value: 'x' } },
        {
          capabilityId: 'tool.work',
          dependencies: ['optional'],
          id: 'dependent',
          input: { value: 'never' },
        },
        { capabilityId: 'tool.work', id: 'independent', input: { value: 'ok' } },
      ],
    });
    expect(result.status).toBe('failed');
    expect(result.nodes[0]).toMatchObject({
      invocation: { classification: 'optional', ok: false },
    });
    expect(result.nodes[1]).toMatchObject({
      classification: 'required',
      reason: 'dependency_failed',
      status: 'skipped',
    });
    expect(result.nodes[2]).toMatchObject({ invocation: { ok: true } });
    await orchestrator.cleanup(result);
  });

  it('returns degraded when an optional node fails without required dependents', async () => {
    const { orchestrator, registry } = await setup();
    registry.register(
      manifest('tool.optional', 'optional'),
      new FunctionToolAdapter('builtin', async () => {
        throw new Error('failure');
      }),
    );
    const result = await orchestrator.run({
      nodes: [{ capabilityId: 'tool.optional', id: 'optional', input: { value: 'x' } }],
    });
    expect(result.status).toBe('degraded');
    await orchestrator.cleanup(result);
  });

  it('cancels running nodes and refuses cyclic plans', async () => {
    const { orchestrator, registry } = await setup();
    registry.register(
      manifest('tool.work'),
      new FunctionToolAdapter('builtin', ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new ToolAdapterError('CANCELLED', 'cancelled')),
            { once: true },
          );
        }),
      ),
    );
    const controller = new AbortController();
    const pending = orchestrator.run(
      { nodes: [{ capabilityId: 'tool.work', id: 'one', input: { value: 'x' } }] },
      controller.signal,
    );
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    await expect(
      orchestrator.run({
        nodes: [
          {
            capabilityId: 'tool.work',
            dependencies: ['two'],
            id: 'one',
            input: { value: 'x' },
          },
          {
            capabilityId: 'tool.work',
            dependencies: ['one'],
            id: 'two',
            input: { value: 'x' },
          },
        ],
      }),
    ).rejects.toThrow(/cycle/);
  });
});
