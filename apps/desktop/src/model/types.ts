export type ModelProviderId = string;

export interface ModelProviderInfo {
  id: ModelProviderId;
  displayName: string;
  baseUrl: string | null;
  customBaseUrl: boolean;
  requiresManualModelId: boolean;
  documentationUrl: string | null;
  adapterVersion: string;
  capabilities: {
    dataDestination: string;
    inputKinds: readonly ['text'];
    maxInputCharacters: number;
    maxMessages: number;
    maxOutputTokens: number;
    rawMediaUpload: false;
    structuredOutput: true;
    thinkingControl: boolean;
  };
}

export interface ModelProviderConnection {
  baseUrl: string | null;
}

export interface AvailableModel {
  id: string;
  ownedBy: string;
}

export type ModelConnectionStatus = 'error' | 'ready' | 'unchecked';

export interface ModelConfigurationSummary {
  id: string;
  providerId: ModelProviderId;
  providerName: string;
  displayName: string;
  baseUrl: string | null;
  manualModelId: string | null;
  availableModels: AvailableModel[];
  selectedModelId: string | null;
  connectionStatus: ModelConnectionStatus;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  writeVersion: number;
  hasCredential: true;
}

export interface SaveModelConfigurationInput {
  id?: string;
  providerId: ModelProviderId;
  displayName: string;
  apiKey?: string;
  baseUrl?: string | null;
  manualModelId?: string | null;
  selectedModelId?: string | null;
  expectedWriteVersion?: number;
}

export interface ModelMessage {
  role: 'assistant' | 'system' | 'user';
  content: string;
}

export interface ModelCompletionRequest {
  configurationId: string;
  modelId: string;
  messages: readonly ModelMessage[];
  format: 'json' | 'text';
  maxTokens: number;
  thinking: 'disabled' | 'enabled';
  temperature?: number;
}

export interface ModelUsage {
  completionTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  promptTokens: number;
  totalTokens: number;
}

export interface ModelCompletion {
  content: string;
  finishReason: string | null;
  modelId: string;
  providerId: ModelProviderId;
  systemFingerprint: string | null;
  usage: ModelUsage;
}

export interface ModelConnectivityTestResult {
  checkedAt: string;
  configurationId: string;
  durationMs: number;
  providerId: ModelProviderId;
  requestedModelId: string;
  returnedModelId: string;
}

export interface ModelInvocationAudit {
  adapterVersion: string;
  configurationId: string;
  configurationVersion: number;
  durationMs: number;
  errorCode: ModelApiErrorCode | null;
  finishedAt: string;
  modelId: string;
  providerId: ModelProviderId;
  startedAt: string;
  status: 'cancelled' | 'failed' | 'succeeded' | 'timed_out';
}

export type ModelInvocationResult =
  | {
      ok: true;
      audit: ModelInvocationAudit;
      completion: ModelCompletion;
    }
  | {
      ok: false;
      audit: ModelInvocationAudit;
      error: ModelApiError;
    };

export type ModelApiErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'BALANCE_INSUFFICIENT'
  | 'CANCELLED'
  | 'CONFIGURATION_CHANGED'
  | 'CONFIGURATION_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'MODEL_NOT_AVAILABLE'
  | 'NETWORK_UNAVAILABLE'
  | 'PROVIDER_NOT_SUPPORTED'
  | 'RATE_LIMITED'
  | 'RESPONSE_INVALID'
  | 'SECURE_STORAGE_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface ModelApiError {
  code: ModelApiErrorCode;
  message: string;
}

export type ModelApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ModelApiError };

export interface SecureStorageStatus {
  available: boolean;
  backend: 'keychain' | 'dpapi' | 'secret-service' | 'unavailable';
  message: string;
}

export interface ModelSettingsSnapshot {
  configurations: ModelConfigurationSummary[];
  providers: ModelProviderInfo[];
  secureStorage: SecureStorageStatus;
}

export interface ModelApi {
  getSettings: () => Promise<ModelApiResult<ModelSettingsSnapshot>>;
  saveConfiguration: (
    input: SaveModelConfigurationInput,
  ) => Promise<ModelApiResult<ModelConfigurationSummary>>;
  refreshModels: (
    id: string,
  ) => Promise<ModelApiResult<ModelConfigurationSummary>>;
  testModel: (
    configurationId: string,
    modelId: string,
  ) => Promise<ModelApiResult<ModelConnectivityTestResult>>;
  removeConfiguration: (
    id: string,
    expectedWriteVersion: number,
  ) => Promise<ModelApiResult<null>>;
}

export const MODEL_IPC_CHANNELS = {
  getSettings: 'material:models:get-settings',
  refreshModels: 'material:models:refresh-models',
  removeConfiguration: 'material:models:remove-configuration',
  saveConfiguration: 'material:models:save-configuration',
  testModel: 'material:models:test-model',
} as const;
