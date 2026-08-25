import { ModelServiceError } from './errors';
import {
  AvailableModel,
  ModelCompletion,
  ModelCompletionRequest,
  ModelProviderConnection,
  ModelProviderInfo,
  ModelUsage,
} from './types';

export interface ModelProviderAdapter {
  readonly info: ModelProviderInfo;
  listModels(
    apiKey: string,
    connection: ModelProviderConnection,
    signal: AbortSignal,
  ): Promise<AvailableModel[]>;
  complete(
    apiKey: string,
    connection: ModelProviderConnection,
    request: ModelCompletionRequest,
    signal: AbortSignal,
  ): Promise<ModelCompletion>;
}

interface OpenAiModelListResponse {
  data?: Array<{ id?: unknown; owned_by?: unknown }>;
}

interface OpenAiCompletionResponse {
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown };
  }>;
  model?: unknown;
  system_fingerprint?: unknown;
  usage?: {
    completion_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
    prompt_tokens?: unknown;
    total_tokens?: unknown;
  };
}

interface OpenAiResponsesResponse {
  error?: unknown;
  incomplete_details?: unknown;
  model?: unknown;
  output?: Array<{
    content?: Array<{
      text?: unknown;
      type?: unknown;
    }>;
  }>;
  output_text?: unknown;
  status?: unknown;
  system_fingerprint?: unknown;
  usage?: {
    input_tokens?: unknown;
    input_tokens_details?: {
      cached_tokens?: unknown;
    };
    output_tokens?: unknown;
    total_tokens?: unknown;
  };
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OFFICIAL_OPENAI_MAX_OUTPUT_TOKENS = 16_384;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const normalizeModelId = (value: string): string => {
  const normalized = value.trim();
  if (!MODEL_ID_PATTERN.test(normalized)) {
    throw new ModelServiceError('INVALID_INPUT');
  }
  return normalized;
};

export const normalizeOpenAiCompatibleBaseUrl = (value: string): string => {
  const normalizedInput = value.trim();
  if (
    !normalizedInput
    || normalizedInput.length > 2_048
    || normalizedInput.includes('?')
    || normalizedInput.includes('#')
  ) {
    throw new ModelServiceError('INVALID_INPUT');
  }
  let url: URL;
  try {
    url = new URL(normalizedInput);
  } catch {
    throw new ModelServiceError('INVALID_INPUT');
  }
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback))
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new ModelServiceError('INVALID_INPUT');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/chat/completions')) {
    pathname = pathname.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  }
  return `${url.origin}${pathname}`;
};

const integerOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

const mapStatus = (status: number): ModelServiceError => {
  if (status === 401 || status === 403) {
    return new ModelServiceError('AUTHENTICATION_FAILED');
  }
  if (status === 402) {
    return new ModelServiceError('BALANCE_INSUFFICIENT');
  }
  if (status === 429) {
    return new ModelServiceError('RATE_LIMITED');
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ModelServiceError('INVALID_INPUT');
  }
  return new ModelServiceError('SERVICE_UNAVAILABLE');
};

const parseJsonResponse = async (response: Response): Promise<unknown> => {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ModelServiceError('RESPONSE_INVALID');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ModelServiceError('RESPONSE_INVALID');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModelServiceError('RESPONSE_INVALID');
  }
};

const normalizeFetchError = (error: unknown, signal: AbortSignal): never => {
  if (error instanceof ModelServiceError) {
    throw error;
  }
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
    throw new ModelServiceError('CANCELLED');
  }
  throw new ModelServiceError('NETWORK_UNAVAILABLE');
};

export class OpenAiCompatibleProvider implements ModelProviderAdapter {
  readonly info: ModelProviderInfo;

  constructor(
    info: ModelProviderInfo,
    protected readonly fetcher: typeof fetch = fetch,
  ) {
    if ((info.customBaseUrl && info.baseUrl !== null) || (!info.customBaseUrl && !info.baseUrl)) {
      throw new Error('model provider base URL contract is invalid');
    }
    this.info = Object.freeze({
      ...info,
      baseUrl: info.baseUrl === null ? null : normalizeOpenAiCompatibleBaseUrl(info.baseUrl),
    });
  }

  async listModels(
    apiKey: string,
    connection: ModelProviderConnection,
    signal: AbortSignal,
  ): Promise<AvailableModel[]> {
    try {
      const response = await this.fetcher(`${this.resolveBaseUrl(connection)}/models`, {
        headers: this.headers(apiKey),
        method: 'GET',
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        throw mapStatus(response.status);
      }
      const body = (await parseJsonResponse(response)) as OpenAiModelListResponse;
      if (!Array.isArray(body.data)) {
        throw new ModelServiceError('RESPONSE_INVALID');
      }
      const models = body.data.flatMap((item) => {
        if (typeof item.id !== 'string' || !MODEL_ID_PATTERN.test(item.id)) {
          return [];
        }
        return [{
          id: item.id,
          ownedBy: typeof item.owned_by === 'string' ? item.owned_by.slice(0, 120) : '',
        }];
      });
      const unique = [...new Map(models.map((model) => [model.id, model])).values()]
        .sort((left, right) => left.id.localeCompare(right.id));
      if (unique.length === 0 || unique.length > 200) {
        throw new ModelServiceError('RESPONSE_INVALID');
      }
      return unique;
    } catch (error) {
      return normalizeFetchError(error, signal);
    }
  }

  async complete(
    apiKey: string,
    connection: ModelProviderConnection,
    request: ModelCompletionRequest,
    signal: AbortSignal,
  ): Promise<ModelCompletion> {
    try {
      const requestBody: Record<string, unknown> = {
        max_tokens: request.maxTokens,
        messages: request.messages,
        model: request.modelId,
        response_format: request.format === 'json' ? { type: 'json_object' } : undefined,
        stream: false,
        temperature: request.temperature,
      };
      if (this.info.capabilities.thinkingControl) {
        requestBody.thinking = { type: request.thinking };
      }
      const response = await this.fetcher(`${this.resolveBaseUrl(connection)}/chat/completions`, {
        body: JSON.stringify(requestBody),
        headers: this.headers(apiKey),
        method: 'POST',
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        throw mapStatus(response.status);
      }
      const body = (await parseJsonResponse(response)) as OpenAiCompletionResponse;
      const choice = body.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string' || typeof body.model !== 'string') {
        throw new ModelServiceError('RESPONSE_INVALID');
      }
      const rawUsage = body.usage ?? {};
      const usage: ModelUsage = {
        completionTokens: integerOrZero(rawUsage.completion_tokens),
        promptCacheHitTokens: integerOrZero(rawUsage.prompt_cache_hit_tokens),
        promptCacheMissTokens: integerOrZero(rawUsage.prompt_cache_miss_tokens),
        promptTokens: integerOrZero(rawUsage.prompt_tokens),
        totalTokens: integerOrZero(rawUsage.total_tokens),
      };
      return {
        content,
        finishReason:
          typeof choice?.finish_reason === 'string' ? choice.finish_reason.slice(0, 80) : null,
        modelId: body.model,
        providerId: this.info.id,
        systemFingerprint:
          typeof body.system_fingerprint === 'string'
            ? body.system_fingerprint.slice(0, 160)
            : null,
        usage,
      };
    } catch (error) {
      return normalizeFetchError(error, signal);
    }
  }

  protected headers(apiKey: string): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  protected resolveBaseUrl(connection: ModelProviderConnection): string {
    if (this.info.customBaseUrl) {
      if (!connection.baseUrl) {
        throw new ModelServiceError('INVALID_INPUT');
      }
      return normalizeOpenAiCompatibleBaseUrl(connection.baseUrl);
    }
    if (!this.info.baseUrl) {
      throw new ModelServiceError('PROVIDER_NOT_SUPPORTED');
    }
    return this.info.baseUrl;
  }
}

export class OpenAiProvider extends OpenAiCompatibleProvider {
  constructor(fetcher: typeof fetch = fetch) {
    super({
      adapterVersion: '1.0.0',
      baseUrl: OFFICIAL_OPENAI_BASE_URL,
      capabilities: {
        dataDestination: 'OpenAI API',
        inputKinds: ['text'],
        maxInputCharacters: 250_000,
        maxMessages: 100,
        maxOutputTokens: OFFICIAL_OPENAI_MAX_OUTPUT_TOKENS,
        rawMediaUpload: false,
        structuredOutput: true,
        thinkingControl: false,
      },
      customBaseUrl: false,
      displayName: 'OpenAI',
      documentationUrl: 'https://developers.openai.com/api/docs/',
      id: 'openai',
      requiresManualModelId: false,
    }, fetcher);
  }

  override async complete(
    apiKey: string,
    connection: ModelProviderConnection,
    request: ModelCompletionRequest,
    signal: AbortSignal,
  ): Promise<ModelCompletion> {
    try {
      const requestBody: Record<string, unknown> = {
        input: request.messages,
        max_output_tokens: Math.min(request.maxTokens, OFFICIAL_OPENAI_MAX_OUTPUT_TOKENS),
        model: request.modelId,
        store: false,
        stream: false,
      };
      if (request.format === 'json') {
        requestBody.text = { format: { type: 'json_object' } };
      }
      if (request.temperature !== undefined) {
        requestBody.temperature = request.temperature;
      }
      const response = await this.fetcher(`${this.resolveBaseUrl(connection)}/responses`, {
        body: JSON.stringify(requestBody),
        headers: this.headers(apiKey),
        method: 'POST',
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        throw mapStatus(response.status);
      }
      const body = (await parseJsonResponse(response)) as OpenAiResponsesResponse;
      const hasError = body.error !== undefined && body.error !== null;
      const isIncomplete = body.incomplete_details !== undefined
        && body.incomplete_details !== null;
      if (hasError || body.status === 'failed') {
        throw new ModelServiceError('SERVICE_UNAVAILABLE');
      }
      if (
        isIncomplete
        || body.status !== 'completed'
        || typeof body.model !== 'string'
      ) {
        throw new ModelServiceError('RESPONSE_INVALID');
      }
      const nestedOutputText = body.output
        ?.flatMap((item) => item.content ?? [])
        .flatMap((content) => (
          content.type === 'output_text' && typeof content.text === 'string'
            ? [content.text]
            : []
        ))
        .join('');
      const content = nestedOutputText
        || (typeof body.output_text === 'string' ? body.output_text : null);
      if (content === null || content.trim().length === 0) {
        throw new ModelServiceError('RESPONSE_INVALID');
      }
      const rawUsage = body.usage ?? {};
      const promptTokens = integerOrZero(rawUsage.input_tokens);
      const completionTokens = integerOrZero(rawUsage.output_tokens);
      const promptCacheHitTokens = Math.min(
        promptTokens,
        integerOrZero(rawUsage.input_tokens_details?.cached_tokens),
      );
      const usage: ModelUsage = {
        completionTokens,
        promptCacheHitTokens,
        promptCacheMissTokens: promptTokens - promptCacheHitTokens,
        promptTokens,
        totalTokens: integerOrZero(rawUsage.total_tokens),
      };
      return {
        content,
        finishReason: typeof body.status === 'string' ? body.status.slice(0, 80) : null,
        modelId: body.model,
        providerId: this.info.id,
        systemFingerprint:
          typeof body.system_fingerprint === 'string'
            ? body.system_fingerprint.slice(0, 160)
            : null,
        usage,
      };
    } catch (error) {
      return normalizeFetchError(error, signal);
    }
  }
}

export const createOpenAiProvider = (
  fetcher: typeof fetch = fetch,
): ModelProviderAdapter => new OpenAiProvider(fetcher);

export const createDeepSeekProvider = (
  baseUrl = 'https://api.deepseek.com',
  fetcher: typeof fetch = fetch,
): ModelProviderAdapter => new OpenAiCompatibleProvider({
  adapterVersion: '1.0.0',
  baseUrl,
  customBaseUrl: false,
  documentationUrl: 'https://api-docs.deepseek.com/',
  requiresManualModelId: false,
  capabilities: {
    dataDestination: 'DeepSeek API',
    inputKinds: ['text'],
    maxInputCharacters: 250_000,
    maxMessages: 100,
    maxOutputTokens: 384_000,
    rawMediaUpload: false,
    structuredOutput: true,
    thinkingControl: true,
  },
  displayName: 'DeepSeek',
  id: 'deepseek',
}, fetcher);

export const createCustomOpenAiCompatibleProvider = (
  fetcher: typeof fetch = fetch,
): ModelProviderAdapter => new OpenAiCompatibleProvider({
  adapterVersion: '1.0.0',
  baseUrl: null,
  capabilities: {
    dataDestination: '用户配置的 OpenAI 兼容 API',
    inputKinds: ['text'],
    maxInputCharacters: 250_000,
    maxMessages: 100,
    maxOutputTokens: 384_000,
    rawMediaUpload: false,
    structuredOutput: true,
    thinkingControl: false,
  },
  customBaseUrl: true,
  displayName: '自定义 OpenAI 兼容 API',
  documentationUrl: null,
  id: 'openai-compatible',
  requiresManualModelId: true,
}, fetcher);
