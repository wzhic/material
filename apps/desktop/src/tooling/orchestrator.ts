import {
  JsonValue,
  ToolFailureMode,
  ToolInvocationResult,
  ToolInvocationSuccess,
} from './types';
import { ToolBroker } from './broker';

export type ToolInputFactory = (
  dependencyOutputs: Readonly<Record<string, JsonValue>>,
) => JsonValue;

export interface OrchestrationNode {
  capabilityId: string;
  dependencies?: readonly string[];
  id: string;
  input: JsonValue | ToolInputFactory;
  version?: string;
}

export interface OrchestrationPlan {
  nodes: readonly OrchestrationNode[];
}

export interface SkippedNodeResult {
  classification: ToolFailureMode;
  nodeId: string;
  reason: 'dependency_failed' | 'input_build_failed' | 'run_cancelled';
  status: 'skipped';
}

export interface InvokedNodeResult {
  invocation: ToolInvocationResult;
  nodeId: string;
  status: 'invoked';
}

interface SuccessfulNodeResult extends InvokedNodeResult {
  invocation: ToolInvocationSuccess;
}

export type OrchestrationNodeResult = InvokedNodeResult | SkippedNodeResult;

export interface OrchestrationResult {
  nodes: readonly OrchestrationNodeResult[];
  status: 'cancelled' | 'degraded' | 'failed' | 'succeeded';
}

const validatePlan = (plan: OrchestrationPlan): void => {
  const nodes = new Map<string, OrchestrationNode>();
  for (const node of plan.nodes) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(node.id)) {
      throw new Error(`invalid orchestration node id: ${node.id}`);
    }
    if (nodes.has(node.id)) throw new Error(`duplicate orchestration node: ${node.id}`);
    nodes.set(node.id, node);
  }
  for (const node of plan.nodes) {
    for (const dependency of node.dependencies ?? []) {
      if (!nodes.has(dependency)) throw new Error(`missing dependency: ${dependency}`);
      if (dependency === node.id) throw new Error(`node cannot depend on itself: ${node.id}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new Error('orchestration plan contains a cycle');
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    const node = nodes.get(nodeId) as OrchestrationNode;
    for (const dependency of node.dependencies ?? []) visit(dependency);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of plan.nodes) visit(node.id);
};

const succeeded = (result: OrchestrationNodeResult): result is SuccessfulNodeResult =>
  result.status === 'invoked' && result.invocation.ok;

export class AnalysisOrchestrator {
  constructor(
    private readonly broker: ToolBroker,
    private readonly maxConcurrency: number,
  ) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) {
      throw new Error('maxConcurrency must be between 1 and 32');
    }
  }

  async run(
    plan: OrchestrationPlan,
    signal?: AbortSignal,
  ): Promise<OrchestrationResult> {
    validatePlan(plan);
    const orderedIds = plan.nodes.map((node) => node.id);
    const pending = new Map(plan.nodes.map((node) => [node.id, node]));
    const results = new Map<string, OrchestrationNodeResult>();
    const running = new Map<string, Promise<InvokedNodeResult>>();

    while (pending.size > 0 || running.size > 0) {
      let changed = false;
      for (const [nodeId, node] of [...pending]) {
        if (signal?.aborted) {
          results.set(nodeId, {
            classification: this.classification(node),
            nodeId,
            reason: 'run_cancelled',
            status: 'skipped',
          });
          pending.delete(nodeId);
          changed = true;
          continue;
        }
        const dependencies = node.dependencies ?? [];
        if (!dependencies.every((dependency) => results.has(dependency))) continue;
        const dependencyResults = dependencies.map(
          (dependency) => results.get(dependency) as OrchestrationNodeResult,
        );
        if (dependencyResults.some((result) => !succeeded(result))) {
          results.set(nodeId, {
            classification: this.classification(node),
            nodeId,
            reason: 'dependency_failed',
            status: 'skipped',
          });
          pending.delete(nodeId);
          changed = true;
          continue;
        }
        if (running.size >= this.maxConcurrency) continue;
        const dependencyOutputs = Object.fromEntries(
          dependencyResults.map((result, index) => [
            dependencies[index],
            (result as SuccessfulNodeResult).invocation.output,
          ]),
        ) as Record<string, JsonValue>;
        let input: JsonValue;
        try {
          input =
            typeof node.input === 'function'
              ? node.input(dependencyOutputs)
              : node.input;
        } catch {
          results.set(nodeId, {
            classification: this.classification(node),
            nodeId,
            reason: 'input_build_failed',
            status: 'skipped',
          });
          pending.delete(nodeId);
          changed = true;
          continue;
        }
        const invocation = this.broker
          .invoke({
            capabilityId: node.capabilityId,
            input,
            signal,
            version: node.version,
          })
          .then((result) => ({ invocation: result, nodeId, status: 'invoked' as const }));
        running.set(nodeId, invocation);
        pending.delete(nodeId);
        changed = true;
      }

      if (running.size > 0) {
        const finished = await Promise.race(running.values());
        running.delete(finished.nodeId);
        results.set(finished.nodeId, finished);
        continue;
      }
      if (!changed && pending.size > 0) {
        throw new Error('orchestration scheduler could not make progress');
      }
    }

    const nodes = orderedIds.map((nodeId) => results.get(nodeId) as OrchestrationNodeResult);
    return { nodes, status: this.resultStatus(nodes, Boolean(signal?.aborted)) };
  }

  async cleanup(result: OrchestrationResult): Promise<void> {
    await Promise.all(
      result.nodes
        .filter((node): node is InvokedNodeResult => node.status === 'invoked')
        .map((node) => this.broker.release(node.invocation.invocationId)),
    );
  }

  private classification(node: OrchestrationNode): ToolFailureMode {
    return this.broker.describe(node.capabilityId, node.version)?.failureMode ?? 'required';
  }

  private resultStatus(
    nodes: readonly OrchestrationNodeResult[],
    aborted: boolean,
  ): OrchestrationResult['status'] {
    if (aborted) return 'cancelled';
    let hasFailure = false;
    for (const node of nodes) {
      if (node.status === 'skipped') {
        hasFailure = true;
        if (node.classification === 'required') return 'failed';
      } else if (!node.invocation.ok) {
        hasFailure = true;
        if (node.invocation.classification === 'required') return 'failed';
      }
    }
    if (hasFailure) return 'degraded';
    return 'succeeded';
  }
}
