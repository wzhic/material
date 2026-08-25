import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CodexAppServerClient } from './client';
import {
  buildCodexEnvironment,
  prepareCodexHome,
  resolveCodexRuntimePath,
  verifyCodexRuntimeVersion,
} from './runtime';

const removeWithRuntimeRetry = async (directory: string): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

describe('locked Codex App Server runtime compatibility', () => {
  it('starts with strict isolated config and reads a signed-out account without logging in',
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'material-codex-real-runtime-'));
      let client: CodexAppServerClient | null = null;
      try {
        const command = await resolveCodexRuntimePath({
          isPackaged: false,
          resourcesPath: process.resourcesPath,
        });
        const codexHome = await prepareCodexHome(
          path.join(directory, 'codex-subscription', 'codex-home'),
        );
        const environment = buildCodexEnvironment(codexHome, process.env);
        await verifyCodexRuntimeVersion({ codexHome, command, environment });
        client = new CodexAppServerClient({
          appVersion: '0.149.1-runtime-test',
          codexHome,
          command,
          environment,
        });

        await client.start();
        const response = await client.request<{
          account: unknown;
          requiresOpenaiAuth: unknown;
        }>('account/read', { refreshToken: false }, 30_000);

        expect(response).toEqual({ account: null, requiresOpenaiAuth: true });
      } finally {
        client?.stop();
        await removeWithRuntimeRetry(directory);
      }
    }, 30_000);
});
