import { ModelServiceError } from './errors';
import {
  AvailableModel,
  ModelCompletion,
  ModelCompletionRequest,
  ModelProviderInfo,
  ModelUsage,
} from './types';

export interface ModelProviderAdapter {
  readonly info: ModelProviderInfo;
  listModels(apiKey: string, signal: AbortSignal): Promise<AvailableModel[]>;
  complete(
    apiKey: string,
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

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const baseUrl = new URL(info.baseUrl);
    if (
      (baseUrl.protocol !== 'https:' && baseUrl.hostname !== '127.0.0.1')
      || baseUrl.username
      || baseUrl.password
      || baseUrl.search
      || baseUrl.hash
      || (baseUrl.pathname !== '' && baseUrl.pathname !== '/')
    ) {
      throw new Error('model provider base URL must use HTTPS');
    }
    this.info = Object.freeze({ ...info, baseUrl: baseUrl.toString().replace(/\/$/, '') });
  }

  async listModels(apiKey: string, signal: AbortSignal): Promise<AvailableModel[]> {
    try {
      const response = await this.fetcher(`${this.info.baseUrl}/models`, {
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
    request: ModelCompletionRequest,
    signal: AbortSignal,
  ): Promise<ModelCompletion> {
    try {
      const response = await this.fetcher(`${this.info.baseUrl}/chat/completions`, {
        body: JSON.stringify({
          max_tokens: request.maxTokens,
          messages: request.messages,
          model: request.modelId,
          response_format: request.format === 'json' ? { type: 'json_object' } : undefined,
          stream: false,
          temperature: request.temperature,
          thinking: { type: request.thinking },
        }),
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

  private headers(apiKey: string): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }
}

export const createDeepSeekProvider = (baseUrl = 'https://api.deepseek.com'):
ModelProviderAdapter => new OpenAiCompatibleProvider({
  adapterVersion: '1.0.0',
  baseUrl,
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
});
