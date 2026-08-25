import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerModelIpc } from './ipc';
import { ModelService } from './service';
import { MODEL_IPC_CHANNELS, ModelApiResult, ModelConnectivityTestResult } from './types';

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: unknown) => ipcState.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel),
  },
}));

type TestModelHandler = (
  event: { sender: { id: number } },
  configurationId: unknown,
  modelId: unknown,
) => Promise<ModelApiResult<ModelConnectivityTestResult>>;

describe('model IPC test operation', () => {
  const configurationId = '00000000-0000-4000-8000-000000000000';
  let service: ModelService;
  let testModel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ipcState.handlers.clear();
    testModel = vi.fn().mockResolvedValue({
      checkedAt: '2026-08-25T00:00:00.000Z',
      configurationId,
      durationMs: 12,
      providerId: 'openai',
      requestedModelId: 'gpt-5-mini',
      returnedModelId: 'gpt-5-mini-2026-08-07',
    });
    service = {
      getSettings: vi.fn(),
      refreshModels: vi.fn(),
      removeConfiguration: vi.fn(),
      saveConfiguration: vi.fn(),
      testModel,
    } as unknown as ModelService;
    registerModelIpc(service, (webContentsId) => webContentsId === 7);
  });

  it('forwards only validated configuration and model identifiers from a trusted sender',
    async () => {
      const handler = ipcState.handlers.get(MODEL_IPC_CHANNELS.testModel) as TestModelHandler;

      const result = await handler(
        { sender: { id: 7 } },
        configurationId,
        'gpt-5-mini',
      );

      expect(result).toMatchObject({
        data: {
          configurationId,
          providerId: 'openai',
          requestedModelId: 'gpt-5-mini',
          returnedModelId: 'gpt-5-mini-2026-08-07',
        },
        ok: true,
      });
      expect(testModel).toHaveBeenCalledOnce();
      expect(testModel).toHaveBeenCalledWith(configurationId, 'gpt-5-mini');
    });

  it.each([
    [{ sender: { id: 8 } }, configurationId, 'gpt-5-mini'],
    [{ sender: { id: 7 } }, 'not-a-configuration-id', 'gpt-5-mini'],
    [{ sender: { id: 7 } }, configurationId, 'gpt-5-mini with prompt'],
  ])('rejects an untrusted sender or malformed identifier before the service call',
    async (event, candidateConfigurationId, candidateModelId) => {
      const handler = ipcState.handlers.get(MODEL_IPC_CHANNELS.testModel) as TestModelHandler;

      const result = await handler(event, candidateConfigurationId, candidateModelId);

      expect(result).toMatchObject({ error: { code: 'INVALID_INPUT' }, ok: false });
      expect(testModel).not.toHaveBeenCalled();
    });
});
