import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ModelServiceError } from './errors';
import { ModelCredentialVault, SecretCipher } from './vault';

class TestCipher implements SecretCipher {
  rotationPending = false;

  async status() {
    return {
      available: true,
      backend: 'keychain' as const,
      message: 'test keychain',
    };
  }

  async encrypt(plainText: string): Promise<Buffer> {
    return Buffer.from(`sealed:${plainText.split('').reverse().join('')}`, 'utf8');
  }

  async decrypt(ciphertext: Buffer): Promise<{
    plainText: string;
    shouldReEncrypt: boolean;
  }> {
    const sealed = ciphertext.toString('utf8');
    return {
      plainText: sealed.replace(/^sealed:/, '').split('').reverse().join(''),
      shouldReEncrypt: this.rotationPending,
    };
  }
}

describe('model credential vault', () => {
  let directory: string;
  let filePath: string;
  let cipher: TestCipher;
  let vault: ModelCredentialVault;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'material-model-vault-'));
    filePath = path.join(directory, 'model-credentials.secure.json');
    cipher = new TestCipher();
    vault = new ModelCredentialVault(filePath, cipher);
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it('persists only ciphertext and never returns the credential in summaries', async () => {
    const secret = 'unit_test_api_key_secret_value';
    const saved = await vault.save({
      apiKey: secret,
      displayName: '我的 DeepSeek',
      providerId: 'deepseek',
    });

    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(readFileSync(filePath, 'utf8')).not.toContain(secret);
    expect((await vault.readCredential(saved.id)).apiKey).toBe(secret);
    expect(await vault.list()).toHaveLength(1);
  });

  it('serializes concurrent writes without dropping configurations', async () => {
    await Promise.all([
      vault.save({
        apiKey: 'unit_test_api_key_first_value',
        displayName: '配置 A',
        providerId: 'deepseek',
      }),
      vault.save({
        apiKey: 'unit_test_api_key_second_value',
        displayName: '配置 B',
        providerId: 'deepseek',
      }),
    ]);

    expect((await vault.list()).map((item) => item.displayName).sort()).toEqual([
      '配置 A',
      '配置 B',
    ]);
  });

  it('retains the old credential on metadata edits and removes it explicitly', async () => {
    const saved = await vault.save({
      apiKey: 'unit_test_api_key_edit_value',
      displayName: '编辑前',
      providerId: 'deepseek',
    });
    const updated = await vault.save({
      displayName: '编辑后',
      expectedWriteVersion: saved.writeVersion,
      id: saved.id,
      providerId: 'deepseek',
    });

    expect(updated.displayName).toBe('编辑后');
    expect(updated.writeVersion).toBe(saved.writeVersion + 1);
    expect((await vault.readCredential(saved.id)).apiKey).toBe('unit_test_api_key_edit_value');
    await vault.remove(saved.id, updated.writeVersion);
    await expect(vault.readCredential(saved.id)).rejects.toMatchObject({
      code: 'CONFIGURATION_NOT_FOUND',
    });
  });

  it('rejects stale edits and removals instead of overwriting another window', async () => {
    const saved = await vault.save({
      apiKey: 'unit_test_api_key_version_value',
      displayName: '原配置',
      providerId: 'deepseek',
    });
    const updated = await vault.save({
      displayName: '新配置',
      expectedWriteVersion: saved.writeVersion,
      id: saved.id,
      providerId: 'deepseek',
    });

    await expect(vault.save({
      displayName: '过期编辑',
      expectedWriteVersion: saved.writeVersion,
      id: saved.id,
      providerId: 'deepseek',
    })).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' });
    await expect(vault.remove(saved.id, saved.writeVersion)).rejects.toMatchObject({
      code: 'CONFIGURATION_CHANGED',
    });
    expect((await vault.list())[0]).toMatchObject({
      displayName: '新配置',
      writeVersion: updated.writeVersion,
    });
  });

  it('fails closed for corrupted storage instead of replacing it', async () => {
    writeFileSync(filePath, '{"schemaVersion":1,"configurations":"broken"}');

    await expect(vault.list()).rejects.toBeInstanceOf(ModelServiceError);
    expect(readFileSync(filePath, 'utf8')).toContain('broken');
  });
});
