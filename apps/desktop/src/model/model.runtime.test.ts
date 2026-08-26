import { readFileSync } from 'node:fs';
import { createServer, IncomingMessage, Server } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  createCustomOpenAiCompatibleProvider,
  createDeepSeekProvider,
  createOpenAiProvider,
} from './provider';
import { ModelCompletionRequest } from './types';

const LOCAL_API_KEY = 'unit_test_api_key_local_runtime';
const liveConfigPath = process.env.MATERIAL_DEEPSEEK_CONFIG_PATH;
const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
const openAiModelId = process.env.MATERIAL_OPENAI_MODEL_ID?.trim();

const listenOnLoopback = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('loopback test server has no TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
};

const readRequestBody = async (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

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
    const receivedUrls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      if (new Headers(init?.headers).get('Authorization') !== `Bearer ${LOCAL_API_KEY}`) {
        return new Response('{"error":"not returned to caller"}', {
          headers: { 'Content-Type': 'application/json' },
          status: 401,
        });
      }
      const url = String(input);
      receivedUrls.push(url);
      expect(init?.redirect).toBe('error');
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
    const provider = createCustomOpenAiCompatibleProvider(fetcher);
    const connection = { baseUrl: 'https://runtime.example.invalid/v1' };
    const models = await provider.listModels(
      LOCAL_API_KEY,
      connection,
      new AbortController().signal,
    );
    const completion = await provider.complete(
      LOCAL_API_KEY,
      connection,
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
    })]);
    expect(receivedBodies[0]).not.toHaveProperty('thinking');
    expect(receivedUrls).toEqual([
      'https://runtime.example.invalid/v1/models',
      'https://runtime.example.invalid/v1/chat/completions',
    ]);
  });

  it('maps authentication failures without returning provider bodies or keys', async () => {
    const fetcher: typeof fetch = async () => new Response(
      '{"error":"not returned to caller"}',
      { headers: { 'Content-Type': 'application/json' }, status: 401 },
    );
    const provider = createCustomOpenAiCompatibleProvider(fetcher);

    await expect(
      provider.listModels(
        'unit_test_api_key_wrong_runtime',
        { baseUrl: 'https://runtime.example.invalid/v1' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      message: '模型账户凭据无效或已失效，请重新认证后重试',
    });
  });
});

describe('official OpenAI HTTP contract runtime', () => {
  it('uses real loopback HTTP for model discovery and the Responses request contract', async () => {
    const received: Array<{
      authorization: string | undefined;
      body: unknown;
      method: string | undefined;
      path: string | undefined;
    }> = [];
    let serverFailure: Error | null = null;
    const server = createServer(async (request, response) => {
      try {
        const rawBody = await readRequestBody(request);
        received.push({
          authorization: request.headers.authorization,
          body: rawBody ? JSON.parse(rawBody) as unknown : null,
          method: request.method,
          path: request.url,
        });
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/models' && request.method === 'GET') {
          response.end(JSON.stringify({
            data: [{ id: 'gpt-runtime-test', owned_by: 'openai' }],
            object: 'list',
          }));
          return;
        }
        if (request.url === '/v1/responses' && request.method === 'POST') {
          response.end(JSON.stringify({
            model: 'gpt-runtime-test',
            object: 'response',
            output: [{
              content: [{ text: 'OK', type: 'output_text' }],
              role: 'assistant',
              type: 'message',
            }],
            status: 'completed',
            usage: {
              input_tokens: 9,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 1,
              total_tokens: 10,
            },
          }));
          return;
        }
        response.statusCode = 404;
        response.end('{"error":"unexpected path"}');
      } catch (error) {
        serverFailure = error instanceof Error ? error : new Error(String(error));
        response.statusCode = 500;
        response.end('{"error":"test server failure"}');
      }
    });
    const loopbackBaseUrl = await listenOnLoopback(server);
    try {
      const transport: typeof fetch = async (input, init) => {
        const officialUrl = new URL(String(input));
        expect(officialUrl.origin).toBe('https://api.openai.com');
        return fetch(`${loopbackBaseUrl}${officialUrl.pathname}`, init);
      };
      const provider = createOpenAiProvider(transport);
      const connection = { baseUrl: null };
      const models = await provider.listModels(
        LOCAL_API_KEY,
        connection,
        new AbortController().signal,
      );
      const completion = await provider.complete(
        LOCAL_API_KEY,
        connection,
        { ...completionRequest(models[0].id), format: 'text', temperature: undefined },
        new AbortController().signal,
      );

      if (serverFailure) throw serverFailure;
      expect(models).toEqual([{ id: 'gpt-runtime-test', ownedBy: 'openai' }]);
      expect(completion).toMatchObject({
        content: 'OK',
        modelId: 'gpt-runtime-test',
        providerId: 'openai',
        usage: {
          completionTokens: 1,
          promptTokens: 9,
          totalTokens: 10,
        },
      });
      expect(received).toEqual([
        {
          authorization: `Bearer ${LOCAL_API_KEY}`,
          body: null,
          method: 'GET',
          path: '/v1/models',
        },
        {
          authorization: `Bearer ${LOCAL_API_KEY}`,
          body: {
            input: completionRequest('gpt-runtime-test').messages,
            max_output_tokens: 32,
            model: 'gpt-runtime-test',
            store: false,
            stream: false,
          },
          method: 'POST',
          path: '/v1/responses',
        },
      ]);
    } finally {
      await closeServer(server);
    }
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
    const connection = { baseUrl: null };
    const models = await provider.listModels(
      apiKey,
      connection,
      new AbortController().signal,
    );
    const preferred = models.find((model) => model.id.includes('flash')) ?? models[0];
    const completion = await provider.complete(
      apiKey,
      connection,
      completionRequest(preferred.id),
      new AbortController().signal,
    );

    expect(models.length).toBeGreaterThan(0);
    expect(completion.providerId).toBe('deepseek');
    expect(() => JSON.parse(completion.content) as unknown).not.toThrow();
  }, 120_000);
});

describe.skipIf(!openAiApiKey || !openAiModelId)('OpenAI live credential smoke test', () => {
  it('discovers the configured model and completes one minimal Responses request', async () => {
    const provider = createOpenAiProvider();
    const connection = { baseUrl: null };
    const models = await provider.listModels(
      openAiApiKey as string,
      connection,
      new AbortController().signal,
    );

    expect(models.some((model) => model.id === openAiModelId)).toBe(true);

    const completion = await provider.complete(
      openAiApiKey as string,
      connection,
      {
        ...completionRequest(openAiModelId as string),
        format: 'text',
        maxTokens: 64,
        messages: [{ content: 'Reply with exactly OK.', role: 'user' }],
        temperature: undefined,
      },
      new AbortController().signal,
    );

    expect(completion.providerId).toBe('openai');
    expect(completion.modelId.length).toBeGreaterThan(0);
    expect(completion.content.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
