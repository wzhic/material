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

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'material-model-service-'));
    completeCalls = 0;
    provider = {
      complete: async (_apiKey, input) => {
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
        displayName: 'DeepSeek Test',
        id: 'deepseek',
      },
      listModels: async () => [{ id: 'deepseek-test', ownedBy: 'deepseek' }],
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

  it('saves, checks and lists a configuration without returning the key', async () => {
    const saved = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    const refreshed = await service.refreshModels(saved.id);
    const settings = await service.getSettings();

    expect(refreshed.connectionStatus).toBe('ready');
    expect(refreshed.selectedModelId).toBe('deepseek-test');
    expect(JSON.stringify(settings)).not.toContain('unit_test_api_key_service_value');
    expect(settings.configurations[0].providerName).toBe('DeepSeek Test');
  });

  it('invokes exactly the explicitly selected provider and model', async () => {
    const saved = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    await service.refreshModels(saved.id);

    const result = await service.complete(request(saved.id));

    expect(result.ok).toBe(true);
    expect(completeCalls).toBe(1);
    expect(result.audit).toMatchObject({
      configurationId: saved.id,
      configurationVersion: saved.writeVersion + 1,
      modelId: 'deepseek-test',
      providerId: 'deepseek',
      status: 'succeeded',
    });
    expect(JSON.stringify(result.audit)).not.toContain('Return a JSON object');
  });

  it('rejects an unavailable model without calling or silently switching', async () => {
    const saved = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    await service.refreshModels(saved.id);

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
    const saved = await service.saveConfiguration({
      apiKey: 'unit_test_api_key_service_value',
      displayName: '主模型',
      providerId: 'deepseek',
    });
    await service.refreshModels(saved.id);

    const result = await service.complete(request(saved.id));

    expect(result.ok).toBe(false);
    expect(result.audit.errorCode).toBe('RATE_LIMITED');
    expect(completeCalls).toBe(1);
  });
});
