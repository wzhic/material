import { ModelServiceError, safeModelMessage } from './errors';
import { ModelProviderRegistry } from './registry';
import {
  ModelCompletionRequest,
  ModelConfigurationSummary,
  ModelInvocationAudit,
  ModelInvocationResult,
  ModelSettingsSnapshot,
  SaveModelConfigurationInput,
} from './types';
import { ModelCredentialVault, StoredModelConfiguration } from './vault';

const MAX_MESSAGE_CHARS = 250_000;
const MODEL_TIMEOUT_MS = 180_000;
const MODEL_LIST_TIMEOUT_MS = 30_000;

const toError = (error: unknown): ModelServiceError =>
  error instanceof ModelServiceError ? error : new ModelServiceError('UNKNOWN');

const validateRequest = (request: ModelCompletionRequest): void => {
  if (
    !request.configurationId
    || !request.modelId
    || !Array.isArray(request.messages)
    || request.messages.length === 0
    || request.messages.length > 100
    || !Number.isSafeInteger(request.maxTokens)
    || request.maxTokens < 1
    || request.maxTokens > 384_000
    || !['json', 'text'].includes(request.format)
    || !['disabled', 'enabled'].includes(request.thinking)
  ) {
    throw new ModelServiceError('INVALID_INPUT');
  }
  let totalChars = 0;
  for (const message of request.messages) {
    if (
      !['assistant', 'system', 'user'].includes(message.role)
      || typeof message.content !== 'string'
      || message.content.length === 0
    ) {
      throw new ModelServiceError('INVALID_INPUT');
    }
    totalChars += message.content.length;
  }
  if (
    totalChars > MAX_MESSAGE_CHARS
    || (request.temperature !== undefined
      && (!Number.isFinite(request.temperature)
        || request.temperature < 0
        || request.temperature > 2))
  ) {
    throw new ModelServiceError('INVALID_INPUT');
  }
};

export class ModelService {
  constructor(
    private readonly registry: ModelProviderRegistry,
    private readonly vault: ModelCredentialVault,
  ) {}

  async getSettings(): Promise<ModelSettingsSnapshot> {
    const [configurations, secureStorage] = await Promise.all([
      this.vault.list(),
      this.vault.secureStorageStatus(),
    ]);
    return {
      configurations: configurations.map((item) => this.toSummary(item)),
      providers: this.registry.list(),
      secureStorage,
    };
  }

  async saveConfiguration(
    input: SaveModelConfigurationInput,
  ): Promise<ModelConfigurationSummary> {
    this.registry.resolve(input.providerId);
    const saved = await this.vault.save(input);
    return this.toSummary(saved);
  }

  async removeConfiguration(id: string, expectedWriteVersion: number): Promise<void> {
    if (
      !id
      || id.length > 80
      || !Number.isSafeInteger(expectedWriteVersion)
      || expectedWriteVersion < 1
    ) {
      throw new ModelServiceError('INVALID_INPUT');
    }
    await this.vault.remove(id, expectedWriteVersion);
  }

  async refreshModels(id: string): Promise<ModelConfigurationSummary> {
    const credential = await this.vault.readCredential(id);
    const provider = this.registry.resolve(credential.configuration.providerId);
    try {
      const models = await this.withTimeout(
        (signal) => provider.listModels(credential.apiKey, signal),
        MODEL_LIST_TIMEOUT_MS,
      );
      return this.toSummary(await this.vault.updateConnection(
        id,
        'ready',
        models,
        credential.configuration.writeVersion,
      ));
    } catch (error) {
      try {
        await this.vault.updateConnection(
          id,
          'error',
          credential.configuration.availableModels,
          credential.configuration.writeVersion,
        );
      } catch (updateError) {
        throw toError(updateError);
      }
      throw toError(error);
    }
  }

  async complete(
    request: ModelCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ModelInvocationResult> {
    const startedAt = new Date();
    let providerId = 'unknown';
    let adapterVersion = 'unknown';
    let configurationVersion = 0;
    try {
      validateRequest(request);
      const credential = await this.vault.readCredential(request.configurationId);
      providerId = credential.configuration.providerId;
      configurationVersion = credential.configuration.writeVersion;
      if (
        !credential.configuration.availableModels.some(
          (model) => model.id === request.modelId,
        )
      ) {
        throw new ModelServiceError('MODEL_NOT_AVAILABLE');
      }
      const provider = this.registry.resolve(providerId);
      adapterVersion = provider.info.adapterVersion;
      const completion = await this.withTimeout(
        (operationSignal) => provider.complete(
          credential.apiKey,
          request,
          operationSignal,
        ),
        MODEL_TIMEOUT_MS,
        signal,
      );
      return {
        audit: this.audit(
          request,
          providerId,
          adapterVersion,
          configurationVersion,
          startedAt,
          'succeeded',
          null,
        ),
        completion,
        ok: true,
      };
    } catch (error) {
      const safeError = toError(error);
      const status = safeError.code === 'CANCELLED'
        ? 'cancelled'
        : safeError.code === 'TIMEOUT'
          ? 'timed_out'
          : 'failed';
      return {
        audit: this.audit(
          request,
          providerId,
          adapterVersion,
          configurationVersion,
          startedAt,
          status,
          safeError.code,
        ),
        error: { code: safeError.code, message: safeModelMessage(safeError.code) },
        ok: false,
      };
    }
  }

  private toSummary(item: StoredModelConfiguration): ModelConfigurationSummary {
    let providerName = item.providerId;
    try {
      providerName = this.registry.resolve(item.providerId).info.displayName;
    } catch {
      // Retain removable metadata even if a provider plugin is temporarily absent.
    }
    return {
      ...item,
      availableModels: item.availableModels.map((model) => ({ ...model })),
      hasCredential: true,
      providerName,
    };
  }

  private audit(
    request: ModelCompletionRequest,
    providerId: string,
    adapterVersion: string,
    configurationVersion: number,
    startedAt: Date,
    status: ModelInvocationAudit['status'],
    errorCode: ModelInvocationAudit['errorCode'],
  ): ModelInvocationAudit {
    const finishedAt = new Date();
    return {
      adapterVersion,
      configurationId: request.configurationId,
      configurationVersion,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      errorCode,
      finishedAt: finishedAt.toISOString(),
      modelId: request.modelId,
      providerId,
      startedAt: startedAt.toISOString(),
      status,
    };
  }

  private async withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (callerSignal?.aborted) {
      throw new ModelServiceError('CANCELLED');
    }
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = (): void => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (timedOut) {
        throw new ModelServiceError('TIMEOUT');
      }
      if (callerSignal?.aborted) {
        throw new ModelServiceError('CANCELLED');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}
