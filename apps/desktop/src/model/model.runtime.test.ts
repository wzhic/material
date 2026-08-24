import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createDeepSeekProvider, OpenAiCompatibleProvider } from './provider';
import { ModelCompletionRequest } from './types';

const LOCAL_API_KEY = 'unit_test_api_key_local_runtime';
const liveConfigPath = process.env.MATERIAL_DEEPSEEK_CONFIG_PATH;

const completionRequest = (modelId: string): ModelCompletionRequest => ({
  configurationId: 'runtime-test',
  format: 'json',
  maxTokens: 32,
  messages: [
    { content: 'Return a json object with one boolean field named ok.', role: 'user' },
  ],
  modelId,
  temperature: 0,
  thinking: 'disabled',
});

describe('OpenAI-compatible model runtime', () => {
  it('lists models and performs a structured completion over the HTTP contract', async () => {
    const receivedBodies: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      if (new Headers(init?.headers).get('Authorization') !== `Bearer ${LOCAL_API_KEY}`) {
        return new Response('{"error":"not returned to caller"}', {
          headers: { 'Content-Type': 'application/json' },
          status: 401,
        });
      }
      const url = String(input);
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({
          data: [
            { id: 'deepseek-runtime-pro', object: 'model', owned_by: 'deepseek' },
            { id: 'deepseek-runtime-flash', object: 'model', owned_by: 'deepseek' },
          ],
          object: 'list',
        }), { headers: { 'Content-Type': 'application/json' }, status: 200 });
      }
      if (url.endsWith('/chat/completions')) {
        receivedBodies.push(JSON.parse(String(init?.body)) as unknown);
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            index: 0,
            message: { content: '{"ok":true}', role: 'assistant' },
          }],
          model: 'deepseek-runtime-flash',
          object: 'chat.completion',
          system_fingerprint: 'runtime-fingerprint',
          usage: {
            completion_tokens: 4,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 12,
            prompt_tokens: 12,
            total_tokens: 16,
          },
        }), { headers: { 'Content-Type': 'application/json' }, status: 200 });
      }
      return new Response('', { status: 404 });
    };
    const provider = new OpenAiCompatibleProvider({
      adapterVersion: '1.0.0',
      baseUrl: 'https://runtime.example.invalid',
      capabilities: {
        dataDestination: 'Runtime Test',
        inputKinds: ['text'],
        maxInputCharacters: 250_000,
        maxMessages: 100,
        maxOutputTokens: 384_000,
        rawMediaUpload: false,
        structuredOutput: true,
        thinkingControl: true,
      },
      displayName: 'Runtime Test',
      id: 'runtime-test',
    }, fetcher);
    const models = await provider.listModels(LOCAL_API_KEY, new AbortController().signal);
    const completion = await provider.complete(
      LOCAL_API_KEY,
      completionRequest(models[0].id),
      new AbortController().signal,
    );

    expect(models.map((model) => model.id)).toEqual([
      'deepseek-runtime-flash',
      'deepseek-runtime-pro',
    ]);
    expect(JSON.parse(completion.content)).toEqual({ ok: true });
    expect(completion.usage.totalTokens).toBe(16);
    expect(receivedBodies).toEqual([expect.objectContaining({
      model: 'deepseek-runtime-flash',
      response_format: { type: 'json_object' },
      stream: false,
      thinking: { type: 'disabled' },
    })]);
  });

  it('maps authentication failures without returning provider bodies or keys', async () => {
    const fetcher: typeof fetch = async () => new Response(
      '{"error":"not returned to caller"}',
      { headers: { 'Content-Type': 'application/json' }, status: 401 },
    );
    const provider = new OpenAiCompatibleProvider({
      adapterVersion: '1.0.0',
      baseUrl: 'https://runtime.example.invalid',
      capabilities: {
        dataDestination: 'Runtime Test',
        inputKinds: ['text'],
        maxInputCharacters: 250_000,
        maxMessages: 100,
        maxOutputTokens: 384_000,
        rawMediaUpload: false,
        structuredOutput: true,
        thinkingControl: true,
      },
      displayName: 'Runtime Test',
      id: 'runtime-test',
    }, fetcher);

    await expect(
      provider.listModels('unit_test_api_key_wrong_runtime', new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      message: 'API Key 无效或已失效，请更新后重试',
    });
  });
});

describe.skipIf(!liveConfigPath)('DeepSeek live credential smoke test', () => {
  it('discovers current models and completes one minimal structured request', async () => {
    const config = Object.fromEntries(
      readFileSync(liveConfigPath as string, 'utf8')
        .split(/\r?\n/)
        .flatMap((line) => {
          const match = line.match(/^\s*([^:=：]+)\s*[:=：]\s*(.+)\s*$/);
          return match ? [[match[1].trim(), match[2].trim()]] : [];
        }),
    );
    const apiKey = config.KEY;
    if (!apiKey) throw new Error('live credential file has no KEY field');
    const provider = createDeepSeekProvider();
    const models = await provider.listModels(apiKey, new AbortController().signal);
    const preferred = models.find((model) => model.id.includes('flash')) ?? models[0];
    const completion = await provider.complete(
      apiKey,
      completionRequest(preferred.id),
      new AbortController().signal,
    );

    expect(models.length).toBeGreaterThan(0);
    expect(completion.providerId).toBe('deepseek');
    expect(() => JSON.parse(completion.content) as unknown).not.toThrow();
  }, 120_000);
});
