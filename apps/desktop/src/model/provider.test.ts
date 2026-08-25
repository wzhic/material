import { describe, expect, it } from 'vitest';

import {
  createCustomOpenAiCompatibleProvider,
  createDeepSeekProvider,
  createOpenAiProvider,
  normalizeOpenAiCompatibleBaseUrl,
} from './provider';
import { ModelCompletionRequest } from './types';

const completionRequest: ModelCompletionRequest = {
  configurationId: 'test-configuration',
  format: 'text',
  maxTokens: 16,
  messages: [{ content: 'hello', role: 'user' }],
  modelId: 'test-model',
  thinking: 'disabled',
};

describe('OpenAI-compatible endpoint security', () => {
  it.each([
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1'],
    [
      'https://api.example.com/openai/v1/chat/completions',
      'https://api.example.com/openai/v1',
    ],
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1'],
    ['http://localhost:8080/chat/completions', 'http://localhost:8080'],
    ['http://[::1]:11434/v1/chat/completions', 'http://[::1]:11434/v1'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeOpenAiCompatibleBaseUrl(input)).toBe(expected);
  });

  it.each([
    'http://api.example.com/v1',
    'http://127.0.0.2/v1',
    'ftp://localhost/v1',
    'https://user:password@api.example.com/v1',
    'https://api.example.com/v1?api_key=secret',
    'https://api.example.com/v1#fragment',
  ])('rejects unsafe endpoint %s', (input) => {
    expect(() => normalizeOpenAiCompatibleBaseUrl(input)).toThrow(expect.objectContaining({
      code: 'INVALID_INPUT',
    }));
  });

  it('uses the configuration endpoint only for the custom provider', async () => {
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        data: [{ id: 'listed-model', owned_by: 'remote' }],
      }), { status: 200 });
    };
    const provider = createCustomOpenAiCompatibleProvider(fetcher);

    expect(provider.info).toMatchObject({
      baseUrl: null,
      customBaseUrl: true,
      displayName: '自定义 OpenAI 兼容 API',
      documentationUrl: null,
      id: 'openai-compatible',
      requiresManualModelId: true,
    });

    await provider.listModels(
      'unit_test_api_key_provider_custom',
      { baseUrl: 'https://custom.example.com/v1/chat/completions' },
      new AbortController().signal,
    );

    expect(urls).toEqual(['https://custom.example.com/v1/models']);
  });

  it('rejects an empty discovered model list instead of promoting the manual declaration',
    async () => {
      const provider = createCustomOpenAiCompatibleProvider(
        async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      await expect(provider.listModels(
        'unit_test_api_key_provider_empty',
        { baseUrl: 'https://custom.example.com/v1' },
        new AbortController().signal,
      )).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
    });

  it('keeps the fixed DeepSeek endpoint and thinking contract', async () => {
    const calls: Array<{ body: Record<string, unknown>; url: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        url: String(input),
      });
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        model: 'test-model',
      }), { status: 200 });
    };
    const provider = createDeepSeekProvider('https://deepseek.example.com/v1', fetcher);

    await provider.complete(
      'unit_test_api_key_provider_deepseek',
      { baseUrl: 'https://untrusted.example.com/v1' },
      completionRequest,
      new AbortController().signal,
    );

    expect(calls).toEqual([{
      body: expect.objectContaining({ thinking: { type: 'disabled' } }),
      url: 'https://deepseek.example.com/v1/chat/completions',
    }]);
  });
});

describe('official OpenAI Responses provider', () => {
  it('uses fixed OpenAI endpoints, Bearer auth, and the exact Responses request contract',
    async () => {
      const calls: Array<{
        body: unknown;
        headers: Headers;
        method: string | undefined;
        redirect: RequestRedirect | undefined;
        url: string;
      }> = [];
      const fetcher: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          calls.push({
            body: null,
            headers: new Headers(init?.headers),
            method: init?.method,
            redirect: init?.redirect,
            url,
          });
          return new Response(JSON.stringify({
            data: [{ id: 'gpt-test', owned_by: 'openai' }],
          }), { status: 200 });
        }
        calls.push({
          body: JSON.parse(String(init?.body)) as unknown,
          headers: new Headers(init?.headers),
          method: init?.method,
          redirect: init?.redirect,
          url,
        });
        return new Response(JSON.stringify({
          model: 'gpt-test',
          output: [{
            content: [
              { text: '{"ok":true}', type: 'output_text' },
              { refusal: null, type: 'refusal' },
            ],
            type: 'message',
          }],
          status: 'completed',
          system_fingerprint: 'openai-fingerprint',
          usage: {
            input_tokens: 20,
            input_tokens_details: { cached_tokens: 6 },
            output_tokens: 4,
            total_tokens: 24,
          },
        }), { status: 200 });
      };
      const provider = createOpenAiProvider(fetcher);
      const connection = { baseUrl: 'https://untrusted.example.com/v1' };

      const models = await provider.listModels(
        'unit_test_api_key_official_openai',
        connection,
        new AbortController().signal,
      );
      const completion = await provider.complete(
        'unit_test_api_key_official_openai',
        connection,
        { ...completionRequest, format: 'json', modelId: models[0].id },
        new AbortController().signal,
      );

      expect(provider.info).toMatchObject({
        baseUrl: 'https://api.openai.com/v1',
        customBaseUrl: false,
        displayName: 'OpenAI',
        id: 'openai',
        requiresManualModelId: false,
      });
      expect(calls.map((call) => call.url)).toEqual([
        'https://api.openai.com/v1/models',
        'https://api.openai.com/v1/responses',
      ]);
      expect(calls[0]).toMatchObject({ body: null, method: 'GET', redirect: 'error' });
      expect(calls[1]).toMatchObject({
        body: {
          input: completionRequest.messages,
          max_output_tokens: 16,
          model: 'gpt-test',
          store: false,
          stream: false,
          text: { format: { type: 'json_object' } },
        },
        method: 'POST',
        redirect: 'error',
      });
      expect(calls[1].body).not.toHaveProperty('temperature');
      expect(calls.every((call) => (
        call.headers.get('Authorization') === 'Bearer unit_test_api_key_official_openai'
      ))).toBe(true);
      expect(completion).toEqual({
        content: '{"ok":true}',
        finishReason: 'completed',
        modelId: 'gpt-test',
        providerId: 'openai',
        systemFingerprint: 'openai-fingerprint',
        usage: {
          completionTokens: 4,
          promptCacheHitTokens: 6,
          promptCacheMissTokens: 14,
          promptTokens: 20,
          totalTokens: 24,
        },
      });
    });

  it('accepts a top-level output_text compatibility field and sends an explicit temperature',
    async () => {
      let receivedBody: Record<string, unknown> | undefined;
      const provider = createOpenAiProvider(async (_input, init) => {
        receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          model: 'gpt-test',
          output_text: 'OK',
          status: 'completed',
        }), { status: 200 });
      });

      const completion = await provider.complete(
        'unit_test_api_key_official_fallback',
        { baseUrl: null },
        { ...completionRequest, temperature: 0 },
        new AbortController().signal,
      );

      expect(receivedBody).toMatchObject({ temperature: 0 });
      expect(completion.content).toBe('OK');
    });

  it('maps provider errors and rejects incomplete or invalid Responses payloads', async () => {
    const rateLimited = createOpenAiProvider(
      async () => new Response('{"error":"must stay private"}', { status: 429 }),
    );
    const invalidResponse = createOpenAiProvider(
      async () => new Response(JSON.stringify({
        model: 'gpt-test',
        output: [{ content: [{ type: 'refusal' }] }],
        status: 'completed',
      }), { status: 200 }),
    );
    const incompleteResponse = createOpenAiProvider(
      async () => new Response(JSON.stringify({
        incomplete_details: { reason: 'max_output_tokens' },
        model: 'gpt-test',
        output: [{ content: [{ text: 'partial', type: 'output_text' }] }],
        status: 'incomplete',
      }), { status: 200 }),
    );
    const failedResponse = createOpenAiProvider(
      async () => new Response(JSON.stringify({
        error: { code: 'server_error', message: 'must stay private' },
        model: 'gpt-test',
        output: [{ content: [{ text: 'must not count', type: 'output_text' }] }],
        status: 'failed',
      }), { status: 200 }),
    );

    await expect(rateLimited.complete(
      'unit_test_api_key_official_rate_limit',
      { baseUrl: null },
      completionRequest,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: '模型服务请求过多，请稍后由你决定是否重试',
    });
    await expect(invalidResponse.complete(
      'unit_test_api_key_official_invalid_response',
      { baseUrl: null },
      completionRequest,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
    await expect(incompleteResponse.complete(
      'unit_test_api_key_official_incomplete_response',
      { baseUrl: null },
      completionRequest,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'RESPONSE_INVALID' });
    await expect(failedResponse.complete(
      'unit_test_api_key_official_failed_response',
      { baseUrl: null },
      completionRequest,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
