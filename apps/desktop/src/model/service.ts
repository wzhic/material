import { ModelServiceError, safeModelMessage } from './errors';
import {
  normalizeModelId,
  normalizeOpenAiCompatibleBaseUrl,
} from './provider';
import { ModelProviderRegistry } from './registry';
import {
  AvailableModel,
  ModelCompletionRequest,
  ModelConfigurationSummary,
  ModelConnectivityTestResult,
  ModelInvocationAudit,
  ModelInvocationResult,
  ModelSettingsSnapshot,
  SaveModelConfigurationInput,
} from './types';
import { ModelCredentialVault, StoredModelConfiguration } from './vault';

const MAX_MESSAGE_CHARS = 250_000;
const MODEL_TIMEOUT_MS = 180_000;
const MODEL_LIST_TIMEOUT_MS = 30_000;
const MODEL_CONNECTIVITY_TEST_TIMEOUT_MS = 60_000;
const MODEL_CONNECTIVITY_TEST_PROMPT = 'Reply with exactly OK.';
const MAX_VISUAL_INPUTS = 8;
const MAX_VISUAL_INPUT_BYTES = 1024 * 1024;
const MAX_VISUAL_INPUT_TOTAL_BYTES = 6 * 1024 * 1024;
const VISUAL_EVIDENCE_ID = /^[a-z][a-z0-9-]{0,99}$/;

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
  let totalVisualBytes = 0;
  if (request.visualInputs !== undefined) {
    if (
      !Array.isArray(request.visualInputs)
      || request.visualInputs.length === 0
      || request.visualInputs.length > MAX_VISUAL_INPUTS
    ) {
      throw new ModelServiceError('INVALID_INPUT');
    }
    for (const visual of request.visualInputs) {
      if (
        visual.mediaType !== 'image/jpeg'
        || !VISUAL_EVIDENCE_ID.test(visual.evidenceId)
        || !Number.isSafeInteger(visual.width)
        || !Number.isSafeInteger(visual.height)
        || visual.width < 1
        || visual.height < 1
        || visual.width > 1_280
        || visual.height > 1_280
        || (visual.timeMs !== null
          && (!Number.isSafeInteger(visual.timeMs) || visual.timeMs < 0))
        || typeof visual.dataBase64 !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(visual.dataBase64)
      ) {
        throw new ModelServiceError('INVALID_INPUT');
      }
      const bytes = Buffer.from(visual.dataBase64, 'base64');
      if (
        bytes.length < 4
        || bytes.length > MAX_VISUAL_INPUT_BYTES
        || bytes.toString('base64') !== visual.dataBase64
        || bytes[0] !== 0xff
        || bytes[1] !== 0xd8
        || bytes[bytes.length - 2] !== 0xff
        || bytes[bytes.length - 1] !== 0xd9
      ) {
        throw new ModelServiceError('INVALID_INPUT');
      }
      totalVisualBytes += bytes.length;
    }
    if (totalVisualBytes > MAX_VISUAL_INPUT_TOTAL_BYTES) {
      throw new ModelServiceError('INVALID_INPUT');
    }
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
    const provider = this.registry.resolve(input.providerId);
    const existing = input.id
      ? (await this.vault.list()).find((item) => item.id === input.id)
      : undefined;
    if (input.id && !existing) {
      throw new ModelServiceError('CONFIGURATION_NOT_FOUND');
    }
    const rawBaseUrl = input.baseUrl === undefined ? existing?.baseUrl ?? null : input.baseUrl;
    const rawManualModelId = input.manualModelId === undefined
      ? existing?.manualModelId ?? null
      : input.manualModelId;
    let baseUrl: string | null = null;
    let manualModelId: string | null = null;
    if (provider.info.customBaseUrl) {
      if (typeof rawBaseUrl !== 'string' || typeof rawManualModelId !== 'string') {
        throw new ModelServiceError('INVALID_INPUT');
      }
      baseUrl = normalizeOpenAiCompatibleBaseUrl(rawBaseUrl);
      manualModelId = normalizeModelId(rawManualModelId);
    } else if (rawBaseUrl !== null || rawManualModelId !== null) {
      throw new ModelServiceError('INVALID_INPUT');
    }
    const visualInputEnabled = input.visualInputEnabled === undefined
      ? existing?.visualInputEnabled ?? false
      : input.visualInputEnabled;
    if (
      typeof visualInputEnabled !== 'boolean'
      || (visualInputEnabled && !provider.info.capabilities.inputKinds.includes('image'))
    ) {
      throw new ModelServiceError('INVALID_INPUT');
    }
    const saved = await this.vault.save({
      ...input,
      baseUrl,
      manualModelId,
      visualInputEnabled,
    });
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
        (signal) => provider.listModels(
          credential.apiKey,
          { baseUrl: credential.configuration.baseUrl },
          signal,
        ),
        MODEL_LIST_TIMEOUT_MS,
      );
      const availableModels = this.mergeModels(
        models,
        credential.configuration.manualModelId,
      );
      return this.toSummary(await this.vault.updateConnection(
        id,
        'ready',
        availableModels,
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

  async testModel(
    configurationId: string,
    modelId: string,
  ): Promise<ModelConnectivityTestResult> {
    if (
      typeof configurationId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        configurationId,
      )
      || typeof modelId !== 'string'
      || normalizeModelId(modelId) !== modelId
    ) {
      throw new ModelServiceError('INVALID_INPUT');
    }
    const startedAt = new Date();
    try {
      const credential = await this.vault.readCredential(configurationId);
      if (
        credential.configuration.connectionStatus !== 'ready'
        || credential.configuration.selectedModelId !== modelId
        || !credential.configuration.availableModels.some((model) => model.id === modelId)
      ) {
        throw new ModelServiceError('MODEL_NOT_AVAILABLE');
      }
      const provider = this.registry.resolve(credential.configuration.providerId);
      const completion = await this.withTimeout(
        (signal) => provider.complete(
          credential.apiKey,
          { baseUrl: credential.configuration.baseUrl },
          {
            configurationId,
            format: 'text',
            maxTokens: 128,
            messages: [{ content: MODEL_CONNECTIVITY_TEST_PROMPT, role: 'user' }],
            modelId,
            thinking: 'disabled',
          },
          signal,
        ),
        MODEL_CONNECTIVITY_TEST_TIMEOUT_MS,
      );
      if (completion.providerId !== credential.configuration.providerId) {
        throw new ModelServiceError('RESPONSE_INVALID');
      }
      let returnedModelId: string;
      try {
        returnedModelId = normalizeModelId(completion.modelId);
      } catch {
        throw new ModelServiceError('RESPONSE_INVALID');
      }
      if (returnedModelId !== completion.modelId) {
        throw new ModelServiceError('RESPONSE_INVALID');
      }
      const finishedAt = new Date();
      return {
        checkedAt: finishedAt.toISOString(),
        configurationId,
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        providerId: credential.configuration.providerId,
        requestedModelId: modelId,
        returnedModelId,
      };
    } catch (error) {
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
        credential.configuration.connectionStatus !== 'ready'
        || !credential.configuration.availableModels.some(
          (model) => model.id === request.modelId,
        )
      ) {
        throw new ModelServiceError('MODEL_NOT_AVAILABLE');
      }
      const provider = this.registry.resolve(providerId);
      adapterVersion = provider.info.adapterVersion;
      if (
        request.visualInputs?.length
        && (
          !credential.configuration.visualInputEnabled
          || !provider.info.capabilities.inputKinds.includes('image')
        )
      ) {
        throw new ModelServiceError('INVALID_INPUT');
      }
      if (request.thinking === 'enabled' && !provider.info.capabilities.thinkingControl) {
        throw new ModelServiceError('INVALID_INPUT');
      }
      const completion = await this.withTimeout(
        (operationSignal) => provider.complete(
          credential.apiKey,
          { baseUrl: credential.configuration.baseUrl },
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
          completion.modelId,
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
          null,
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

  private mergeModels(
    models: readonly AvailableModel[],
    manualModelId: string | null,
  ): AvailableModel[] {
    if (models.length === 0) {
      throw new ModelServiceError('RESPONSE_INVALID');
    }
    const merged = new Map(models.map((model) => [model.id, { ...model }]));
    if (manualModelId && !merged.has(manualModelId)) {
      merged.set(manualModelId, { id: manualModelId, ownedBy: 'user-declared' });
    }
    if (merged.size === 0 || merged.size > 200) {
      throw new ModelServiceError('RESPONSE_INVALID');
    }
    return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private audit(
    request: ModelCompletionRequest,
    providerId: string,
    adapterVersion: string,
    configurationVersion: number,
    startedAt: Date,
    status: ModelInvocationAudit['status'],
    errorCode: ModelInvocationAudit['errorCode'],
    providerReturnedModelId: string | null,
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
      providerReasoningEffort: null,
      providerRequestedModelId: request.modelId,
      providerReturnedModelId,
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
