import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelServiceError } from './errors';
import { ModelProviderAdapter } from './provider';
import { ModelProviderRegistry } from './registry';
import { ModelService } from './service';
import { ModelCompletionRequest } from './types';
import { ModelCredentialVault, SecretCipher } from './vault';

class MemoryCipher implements SecretCipher {
  async status() {
    return { available: true, backend: 'keychain' as const, message: 'available' };
  }

  async encrypt(plainText: string): Promise<Buffer> {
    return Buffer.from(plainText, 'utf8');
  }

  async decrypt(ciphertext: Buffer) {
    return { plainText: ciphertext.toString('utf8'), shouldReEncrypt: false };
  }
}

const request = (configurationId: string, modelId = 'deepseek-test'):
ModelCompletionRequest => ({
  configurationId,
  format: 'json',
  maxTokens: 64,
  messages: [{ content: 'Return a JSON object.', role: 'user' }],
  modelId,
  thinking: 'disabled',
});

const visualInput = {
  dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
  evidenceId: 'frame-1234567890abcdef1234',
  height: 720,
  mediaType: 'image/jpeg' as const,
  timeMs: 1_000,
  width: 1_280,
};

describe('model service', () => {
  let directory: string;
  let service: ModelService;
  let provider: ModelProviderAdapter;
  let completeCalls: number;
  let listCalls: number;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'material-model-service-'));
    completeCalls = 0;
    listCalls = 0;
    provider = {
      complete: async (_apiKey, _connection, input) => {
        completeCalls += 1;
        return {
          content: '{"ok":true}',
          finishReason: 'stop',
          modelId: input.modelId,
          providerId: 'deepseek',
          systemFingerprint: 'test-fingerprint',
          usage: {
            available: true,
            completionTokens: 4,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 5,
            promptTokens: 5,
            totalTokens: 9,
          },
        };
      },
      info: {
        adapterVersion: '1.0.0',
        baseUrl: 'https://api.example.invalid',
        capabilities: {
          dataDestination: 'Test API',
          inputKinds: ['text'],
          maxInputCharacters: 250_000,
          maxMessages: 100,
          maxOutputTokens: 384_000,
          rawMediaUpload: false,
          structuredOutput: true,
          thinkingControl: true,
        },
        customBaseUrl: false,
        displayName: 'DeepSeek Test',
        documentationUrl: 'https://example.invalid/docs',
        id: 'deepseek',
        requiresManualModelId: false,
      },
      listModels: async () => {
        listCalls += 1;
        return [{ id: 'deepseek-test', ownedBy: 'deepseek' }];
      },
    };
    const registry = new ModelProviderRegistry();
    registry.register(provider);
    service = new ModelService(
      registry,
      new ModelCredentialVault(
        path.join(directory, 'vault.json'),
        new MemoryCipher(),
      ),
    );
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it('saves locally, then checks and lists without returning the key', async () => {
    const unchecked = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    expect(unchecked.connectionStatus).toBe('unchecked');
    expect(unchecked.selectedModelId).toBeNull();
    expect(listCalls).toBe(0);

    const saved = await service.refreshModels(unchecked.id);
    const settings = await service.getSettings();

    expect(saved.connectionStatus).toBe('ready');
    expect(saved.selectedModelId).toBe('deepseek-test');
    expect(listCalls).toBe(1);
    expect(JSON.stringify(settings)).not.toContain('unit_test_api_key_service_value');
    expect(settings.configurations[0].providerName).toBe('DeepSeek Test');
  });

  it('invokes exactly the explicitly selected provider and model', async () => {
    const unchecked = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    const saved = await service.refreshModels(unchecked.id);
    const result = await service.complete(request(saved.id));

    expect(result.ok).toBe(true);
    expect(completeCalls).toBe(1);
    expect(result.audit).toMatchObject({
      configurationId: saved.id,
      configurationVersion: saved.writeVersion,
      modelId: 'deepseek-test',
      providerId: 'deepseek',
      status: 'succeeded',
    });
    expect(JSON.stringify(result.audit)).not.toContain('Return a JSON object');
  });

  it('runs one explicit connectivity test with a fixed non-business prompt', async () => {
    let observedRequest: ModelCompletionRequest | null = null;
    provider.complete = async (_apiKey, _connection, input) => {
      completeCalls += 1;
      observedRequest = input;
      return {
        content: 'OK',
        finishReason: 'stop',
        modelId: input.modelId,
        providerId: 'deepseek',
        systemFingerprint: null,
        usage: {
          available: true,
          completionTokens: 1,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 0,
          promptTokens: 5,
          totalTokens: 6,
        },
      };
    };
    const unchecked = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    const saved = await service.refreshModels(unchecked.id);

    const result = await service.testModel(saved.id, 'deepseek-test');

    expect(completeCalls).toBe(1);
    expect(observedRequest).toEqual({
      configurationId: saved.id,
      format: 'text',
      maxTokens: 128,
      messages: [{ content: 'Reply with exactly OK.', role: 'user' }],
      modelId: 'deepseek-test',
      thinking: 'disabled',
    });
    expect(result).toEqual({
      checkedAt: expect.any(String),
      configurationId: saved.id,
      durationMs: expect.any(Number),
      providerId: 'deepseek',
      requestedModelId: 'deepseek-test',
      returnedModelId: 'deepseek-test',
    });
    expect(result).not.toHaveProperty('content');
    expect(result).not.toHaveProperty('usage');
  });

  it('requires the ready configuration\'s explicitly selected model for connectivity tests',
    async () => {
      provider.listModels = async () => {
        listCalls += 1;
        return [
          { id: 'deepseek-test', ownedBy: 'deepseek' },
          { id: 'deepseek-z', ownedBy: 'deepseek' },
        ];
      };
      const unchecked = await service.saveConfiguration({
        apiKey: 'unit_test_api_key_service_value',
        displayName: '主模型',
        providerId: 'deepseek',
      });

      await expect(service.testModel(unchecked.id, 'deepseek-test')).rejects.toMatchObject({
        code: 'MODEL_NOT_AVAILABLE',
      });
      const ready = await service.refreshModels(unchecked.id);
      await expect(service.testModel(ready.id, 'deepseek-z')).rejects.toMatchObject({
        code: 'MODEL_NOT_AVAILABLE',
      });

      expect(completeCalls).toBe(0);
    });

  it('does not retry or expose a provider failure from a connectivity test', async () => {
    provider.complete = async () => {
      completeCalls += 1;
      throw new ModelServiceError('RATE_LIMITED');
    };
    const unchecked = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    const ready = await service.refreshModels(unchecked.id);

    await expect(service.testModel(ready.id, 'deepseek-test')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(completeCalls).toBe(1);
  });

  it('reports both requested and provider-returned model IDs without hiding alias resolution',
    async () => {
    provider.complete = async (_apiKey, _connection, input) => {
      completeCalls += 1;
      return {
        content: 'OK',
        finishReason: 'stop',
        modelId: `${input.modelId}-2026-08-25`,
        providerId: 'deepseek',
        systemFingerprint: null,
        usage: {
          available: true,
          completionTokens: 1,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 0,
          promptTokens: 5,
          totalTokens: 6,
        },
      };
    };
    const unchecked = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    const ready = await service.refreshModels(unchecked.id);

    await expect(service.testModel(ready.id, 'deepseek-test')).resolves.toMatchObject({
      providerId: 'deepseek',
      requestedModelId: 'deepseek-test',
      returnedModelId: 'deepseek-test-2026-08-25',
    });
    expect(completeCalls).toBe(1);
  });

  it('times out a connectivity test after its bounded one-minute window', async () => {
    vi.useFakeTimers();
    provider.complete = async (_apiKey, _connection, _input, signal) => {
      completeCalls += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new ModelServiceError('CANCELLED'));
        }, { once: true });
      });
    };
    try {
      const unchecked = await service.saveConfiguration({
        apiKey: 'unit_test_api_key_service_value',
        displayName: '主模型',
        providerId: 'deepseek',
      });
      const ready = await service.refreshModels(unchecked.id);
      const result = service.testModel(ready.id, 'deepseek-test').catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(60_000);

      await expect(result).resolves.toMatchObject({ code: 'TIMEOUT' });
      expect(completeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an unavailable model without calling or silently switching', async () => {
    const unchecked = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    const saved = await service.refreshModels(unchecked.id);
    const result = await service.complete(request(saved.id, 'another-model'));

    expect(result.ok).toBe(false);
    expect(result.audit.errorCode).toBe('MODEL_NOT_AVAILABLE');
    expect(completeCalls).toBe(0);
  });

  it('rejects visual data unless both provider and saved configuration explicitly allow it',
    async () => {
      await expect(service.saveConfiguration({
        apiKey: 'unit_test_api_key_service_vision',
        displayName: '文本模型',
        providerId: 'deepseek',
        visualInputEnabled: true,
      })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      const unchecked = await service.saveConfiguration({
        apiKey: 'unit_test_api_key_service_value',
        displayName: '主模型',
        providerId: 'deepseek',
      });
      const saved = await service.refreshModels(unchecked.id);
      const result = await service.complete({
        ...request(saved.id),
        visualInputs: [visualInput],
      });

      expect(result).toMatchObject({
        audit: { errorCode: 'INVALID_INPUT' },
        ok: false,
      });
      expect(completeCalls).toBe(0);
    });

  it('does not retry provider failures', async () => {
    provider.complete = async () => {
      completeCalls += 1;
      throw new ModelServiceError('RATE_LIMITED');
    };
    const unchecked = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    const saved = await service.refreshModels(unchecked.id);
    const result = await service.complete(request(saved.id));

    expect(result.ok).toBe(false);
    expect(result.audit.errorCode).toBe('RATE_LIMITED');
    expect(completeCalls).toBe(1);
  });

  it('passes the normalized custom endpoint, merges the declared model and never completes on save',
    async () => {
      const connections: Array<string | null> = [];
      const customProvider: ModelProviderAdapter = {
        complete: async (_apiKey, connection, input) => {
          completeCalls += 1;
          connections.push(connection.baseUrl);
          return {
            content: 'ok',
            finishReason: 'stop',
            modelId: input.modelId,
            providerId: 'openai-compatible',
            systemFingerprint: null,
            usage: {
              available: true,
              completionTokens: 1,
              promptCacheHitTokens: 0,
              promptCacheMissTokens: 0,
              promptTokens: 1,
              totalTokens: 2,
            },
          };
        },
        info: {
          adapterVersion: '1.0.0',
          baseUrl: null,
          capabilities: {
            dataDestination: 'Custom API',
            inputKinds: ['text', 'image'],
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
        },
        listModels: async (_apiKey, connection) => {
          listCalls += 1;
          connections.push(connection.baseUrl);
          return [{ id: 'listed-model', ownedBy: 'remote' }];
        },
      };
      const registry = new ModelProviderRegistry();
      registry.register(customProvider);
      service = new ModelService(
        registry,
        new ModelCredentialVault(path.join(directory, 'custom-vault.json'), new MemoryCipher()),
      );

      const saved = await service.saveConfiguration({
        apiKey: 'unit_test_api_key_custom_service',
        baseUrl: 'https://custom.example.invalid/v1/chat/completions',
        displayName: '自定义模型',
        manualModelId: 'declared/model',
        providerId: 'openai-compatible',
        visualInputEnabled: true,
      });

      expect(saved).toMatchObject({
        baseUrl: 'https://custom.example.invalid/v1',
        connectionStatus: 'unchecked',
        manualModelId: 'declared/model',
        selectedModelId: null,
        visualInputEnabled: true,
      });
      expect(saved.availableModels).toEqual([]);
      expect(listCalls).toBe(0);
      expect(completeCalls).toBe(0);
      expect(connections).toEqual([]);

      const refreshed = await service.refreshModels(saved.id);
      expect(refreshed).toMatchObject({
        connectionStatus: 'ready',
        selectedModelId: 'declared/model',
      });
      expect(refreshed.availableModels.map((model) => model.id)).toEqual([
        'declared/model',
        'listed-model',
      ]);
      expect(listCalls).toBe(1);
      expect(completeCalls).toBe(0);
      expect(connections).toEqual(['https://custom.example.invalid/v1']);

      const result = await service.complete({
        ...request(refreshed.id, 'declared/model'),
        visualInputs: [visualInput],
      });
      expect(result.ok).toBe(true);
      expect(completeCalls).toBe(1);
      expect(connections).toEqual([
        'https://custom.example.invalid/v1',
        'https://custom.example.invalid/v1',
      ]);
    });

  it('updates local metadata without revalidating a ready configuration', async () => {
    const unchecked = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    const ready = await service.refreshModels(unchecked.id);

    const updated = await service.saveConfiguration({
      displayName: '主模型（默认）',
      expectedWriteVersion: ready.writeVersion,
      id: ready.id,
      providerId: ready.providerId,
      selectedModelId: 'deepseek-test',
    });

    expect(updated).toMatchObject({
      connectionStatus: 'ready',
      displayName: '主模型（默认）',
      selectedModelId: 'deepseek-test',
    });
    expect(listCalls).toBe(1);
    expect(completeCalls).toBe(0);
  });

  it('blocks completion after a connection refresh fails', async () => {
    const unchecked = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    const ready = await service.refreshModels(unchecked.id);
    provider.listModels = async () => {
      listCalls += 1;
      throw new ModelServiceError('NETWORK_UNAVAILABLE');
    };

    await expect(service.refreshModels(ready.id)).rejects.toMatchObject({
      code: 'NETWORK_UNAVAILABLE',
    });
    const result = await service.complete(request(ready.id));

    expect(result.ok).toBe(false);
    expect(result.audit.errorCode).toBe('MODEL_NOT_AVAILABLE');
    expect(completeCalls).toBe(0);
  });
});
