import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
      });

      expect(saved).toMatchObject({
        baseUrl: 'https://custom.example.invalid/v1',
        connectionStatus: 'unchecked',
        manualModelId: 'declared/model',
        selectedModelId: null,
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

      const result = await service.complete(request(refreshed.id, 'declared/model'));
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
