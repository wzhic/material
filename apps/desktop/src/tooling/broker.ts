import { randomUUID } from 'node:crypto';

import { ToolAdapterError } from './adapters';
import { ArtifactLimitError, TemporaryArtifactManager } from './artifact-manager';
import { ToolRegistry } from './registry';
import { jsonByteLength, validateValue } from './schema';
import {
  CapabilitySnapshot,
  JsonValue,
  ToolErrorCode,
  ToolFailureMode,
  ToolInvocationAudit,
  ToolInvocationFailure,
  ToolInvocationResult,
  ToolPermission,
  ToolResourceLimits,
} from './types';

export interface ToolBrokerPolicy {
  allowedCapabilities: readonly string[];
  allowedPermissions: readonly ToolPermission[];
  maxConcurrentInvocations: number;
  resourceCeilings: ToolResourceLimits;
}

export interface ToolInvocationRequest {
  capabilityId: string;
  input: unknown;
  signal?: AbortSignal;
  version?: string;
}

class InvocationAbortError extends Error {}

const safeMessages: Record<ToolErrorCode, string> = {
  ARTIFACT_LIMIT: '工具产生的临时文件超出允许范围',
  CANCELLED: '工具执行已取消',
  CAPABILITY_NOT_FOUND: '当前未安装或未启用所需工具能力',
  EXECUTION_FAILED: '工具执行失败',
  INTERNAL_ERROR: '工具执行底座发生内部错误',
  INVALID_INPUT: '工具输入不符合能力合同',
  INVALID_OUTPUT: '工具输出不符合能力合同',
  OUTPUT_LIMIT: '工具输出超出允许大小',
  POLICY_DENIED: '当前安全策略不允许调用该工具',
  RESOURCE_BUSY: '工具执行并发已达到当前上限',
  TIMEOUT: '工具执行超时',
};

const effectiveLimits = (
  requested: ToolResourceLimits,
  ceilings: ToolResourceLimits,
): ToolResourceLimits => ({
  maxArtifactBytes: Math.min(requested.maxArtifactBytes, ceilings.maxArtifactBytes),
  maxArtifacts: Math.min(requested.maxArtifacts, ceilings.maxArtifacts),
  maxOutputBytes: Math.min(requested.maxOutputBytes, ceilings.maxOutputBytes),
  timeoutMs: Math.min(requested.timeoutMs, ceilings.timeoutMs),
});

const mapError = (
  error: unknown,
  timedOut: boolean,
  externallyCancelled: boolean,
): ToolErrorCode => {
  if (timedOut) return 'TIMEOUT';
  if (externallyCancelled || error instanceof InvocationAbortError) return 'CANCELLED';
  if (error instanceof ArtifactLimitError) return 'ARTIFACT_LIMIT';
  if (error instanceof ToolAdapterError) return error.code;
  return 'EXECUTION_FAILED';
};

export class ToolBroker {
  private readonly active = new Map<string, AbortController>();
  private readonly audits: ToolInvocationAudit[] = [];

  constructor(
    private readonly registry: ToolRegistry,
    private readonly artifacts: TemporaryArtifactManager,
    private readonly policy: ToolBrokerPolicy,
  ) {
    if (
      !Number.isSafeInteger(policy.maxConcurrentInvocations) ||
      policy.maxConcurrentInvocations < 1 ||
      policy.maxConcurrentInvocations > 64
    ) {
      throw new Error('maxConcurrentInvocations must be between 1 and 64');
    }
    for (const value of Object.values(policy.resourceCeilings)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error('broker resource ceilings must be positive safe integers');
      }
    }
  }

  describe(capabilityId: string, version?: string): CapabilitySnapshot | null {
    return this.registry.resolve(capabilityId, version)?.snapshot ?? null;
  }

  async invoke(request: ToolInvocationRequest): Promise<ToolInvocationResult> {
    const invocationId = randomUUID();
    const startedAt = new Date();
    const registration = this.registry.resolve(request.capabilityId, request.version);
    if (!registration) {
      return this.failure(
        invocationId,
        startedAt,
        null,
        'CAPABILITY_NOT_FOUND',
        'required',
        0,
        0,
      );
    }
    const { manifest, snapshot } = registration;
    let inputBytes = 0;
    try {
      inputBytes = jsonByteLength(request.input);
    } catch {
      return this.failure(
        invocationId,
        startedAt,
        snapshot,
        'INVALID_INPUT',
        manifest.failureMode,
        0,
        0,
      );
    }
    if (
      !this.policy.allowedCapabilities.includes(manifest.capabilityId) ||
      manifest.permissions.some(
        (permission) => !this.policy.allowedPermissions.includes(permission),
      )
    ) {
      return this.failure(
        invocationId,
        startedAt,
        snapshot,
        'POLICY_DENIED',
        manifest.failureMode,
        inputBytes,
        0,
      );
    }
    if (!validateValue(manifest.inputSchema, request.input).ok) {
      return this.failure(
        invocationId,
        startedAt,
        snapshot,
        'INVALID_INPUT',
        manifest.failureMode,
        inputBytes,
        0,
      );
    }
    if (request.signal?.aborted) {
      return this.failure(
        invocationId,
        startedAt,
        snapshot,
        'CANCELLED',
        manifest.failureMode,
        inputBytes,
        0,
      );
    }
    if (this.active.size >= this.policy.maxConcurrentInvocations) {
      return this.failure(
        invocationId,
        startedAt,
        snapshot,
        'RESOURCE_BUSY',
        manifest.failureMode,
        inputBytes,
        0,
      );
    }

    const limits = effectiveLimits(manifest.resources, this.policy.resourceCeilings);
    const controller = new AbortController();
    this.active.set(invocationId, controller);
    let timedOut = false;
    let externallyCancelled = false;
    const externalAbort = (): void => {
      externallyCancelled = true;
      controller.abort();
    };
    request.signal?.addEventListener('abort', externalAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.timeoutMs);
    let deferredCleanup = false;

    try {
      const workspace = await this.artifacts.createWorkspace(invocationId, limits);
      if (controller.signal.aborted) throw new InvocationAbortError();
      const execution = registration.adapter.execute({
        input: request.input as JsonValue,
        invocationId,
        limits,
        signal: controller.signal,
        workspace,
      });
      const cancelled = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new InvocationAbortError()),
          { once: true },
        );
      });
      let output: JsonValue;
      try {
        output = await Promise.race([execution, cancelled]);
      } catch (error) {
        deferredCleanup = true;
        void execution.finally(() => this.artifacts.cleanup(invocationId)).catch(() => undefined);
        throw error;
      }
      let outputBytes = 0;
      try {
        outputBytes = jsonByteLength(output);
      } catch {
        await this.artifacts.cleanup(invocationId);
        return this.failure(
          invocationId,
          startedAt,
          snapshot,
          'INVALID_OUTPUT',
          manifest.failureMode,
          inputBytes,
          0,
        );
      }
      if (outputBytes > limits.maxOutputBytes) {
        await this.artifacts.cleanup(invocationId);
        return this.failure(
          invocationId,
          startedAt,
          snapshot,
          'OUTPUT_LIMIT',
          manifest.failureMode,
          inputBytes,
          outputBytes,
        );
      }
      if (!validateValue(manifest.outputSchema, output).ok) {
        await this.artifacts.cleanup(invocationId);
        return this.failure(
          invocationId,
          startedAt,
          snapshot,
          'INVALID_OUTPUT',
          manifest.failureMode,
          inputBytes,
          outputBytes,
        );
      }
      const audit = this.audit(
        invocationId,
        startedAt,
        snapshot,
        'succeeded',
        null,
        inputBytes,
        outputBytes,
      );
      return {
        artifacts: workspace.listArtifacts(),
        audit,
        capability: snapshot,
        invocationId,
        ok: true,
        output,
      };
    } catch (error) {
      if (!deferredCleanup) {
        await this.artifacts.cleanup(invocationId).catch(() => undefined);
      }
      const code = mapError(error, timedOut, externallyCancelled);
      return this.failure(
        invocationId,
        startedAt,
        snapshot,
        code,
        manifest.failureMode,
        inputBytes,
        0,
      );
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', externalAbort);
      this.active.delete(invocationId);
    }
  }

  cancel(invocationId: string): boolean {
    const controller = this.active.get(invocationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async release(invocationId: string): Promise<void> {
    if (this.active.has(invocationId)) {
      throw new Error('cannot release artifacts while invocation is active');
    }
    await this.artifacts.cleanup(invocationId);
  }

  auditTrail(): readonly ToolInvocationAudit[] {
    return this.audits.map((entry) => ({
      ...entry,
      capability: entry.capability ? { ...entry.capability } : null,
    }));
  }

  private failure(
    invocationId: string,
    startedAt: Date,
    capability: CapabilitySnapshot | null,
    code: ToolErrorCode,
    classification: ToolFailureMode,
    inputBytes: number,
    outputBytes: number,
  ): ToolInvocationFailure {
    const status =
      code === 'TIMEOUT' ? 'timed_out' : code === 'CANCELLED' ? 'cancelled' : 'failed';
    const audit = this.audit(
      invocationId,
      startedAt,
      capability,
      status,
      code,
      inputBytes,
      outputBytes,
    );
    return {
      artifacts: [],
      audit,
      classification,
      error: { code, message: safeMessages[code] },
      invocationId,
      ok: false,
    };
  }

  private audit(
    invocationId: string,
    startedAt: Date,
    capability: CapabilitySnapshot | null,
    status: ToolInvocationAudit['status'],
    errorCode: ToolErrorCode | null,
    inputBytes: number,
    outputBytes: number,
  ): ToolInvocationAudit {
    const finishedAt = new Date();
    const entry: ToolInvocationAudit = Object.freeze({
      capability,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      errorCode,
      finishedAt: finishedAt.toISOString(),
      inputBytes,
      invocationId,
      outputBytes,
      startedAt: startedAt.toISOString(),
      status,
    });
    this.audits.push(entry);
    return entry;
  }
}
