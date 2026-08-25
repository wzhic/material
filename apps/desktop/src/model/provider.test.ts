import { describe, expect, it } from 'vitest';

import {
  createCustomOpenAiCompatibleProvider,
  createDeepSeekProvider,
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
