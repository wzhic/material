import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerGameEnrichmentIpc } from './ipc';
import { GameProductEnrichmentService } from './service';
import { GAME_ENRICHMENT_IPC_CHANNELS, GameEnrichmentApiResult } from './types';

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: unknown) => ipcState.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel),
  },
}));

interface TestSender {
  id: number;
  once: ReturnType<typeof vi.fn>;
}

type TestHandler<T> = (
  event: { sender: TestSender },
  value?: unknown,
) => Promise<GameEnrichmentApiResult<T>>;

describe('game enrichment IPC boundary', () => {
  let destroyedListener: (() => void) | null;
  let sender: TestSender;
  let service: GameProductEnrichmentService;
  let search: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ipcState.handlers.clear();
    destroyedListener = null;
    sender = {
      id: 7,
      once: vi.fn((_event: string, listener: () => void) => {
        destroyedListener = listener;
      }),
    };
    search = vi.fn().mockResolvedValue({ candidates: [], query: '原神', requestId: 'request-1' });
    service = {
      cancel: vi.fn(),
      clearPersistentConsent: vi.fn().mockResolvedValue({ consent: 'required', provider: {} }),
      disposeSender: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({ consent: 'required', provider: {} }),
      search,
      setConsent: vi.fn().mockResolvedValue({ consent: 'once', provider: {} }),
    } as unknown as GameProductEnrichmentService;
    registerGameEnrichmentIpc(service, (id) => id === 7);
  });

  it('forwards a search only from the trusted renderer and disposes sender-local state', async () => {
    const handler = ipcState.handlers.get(
      GAME_ENRICHMENT_IPC_CHANNELS.search,
    ) as TestHandler<unknown>;
    const input = { gameName: '原神', requestId: 'request-1' };

    const result = await handler({ sender }, input);

    expect(result).toMatchObject({ ok: true });
    expect(search).toHaveBeenCalledWith(7, input);
    expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
    destroyedListener?.();
    expect(service.disposeSender).toHaveBeenCalledWith(7);
  });

  it('rejects untrusted senders and malformed consent choices before service calls', async () => {
    const statusHandler = ipcState.handlers.get(
      GAME_ENRICHMENT_IPC_CHANNELS.getStatus,
    ) as TestHandler<unknown>;
    const consentHandler = ipcState.handlers.get(
      GAME_ENRICHMENT_IPC_CHANNELS.setConsent,
    ) as TestHandler<unknown>;

    const untrusted = await statusHandler({ sender: { ...sender, id: 8 } });
    const malformed = await consentHandler({ sender }, 'always-without-contract');

    expect(untrusted).toMatchObject({ error: { code: 'INVALID_INPUT' }, ok: false });
    expect(malformed).toMatchObject({ error: { code: 'INVALID_INPUT' }, ok: false });
    expect(service.getStatus).not.toHaveBeenCalled();
    expect(service.setConsent).not.toHaveBeenCalled();
  });
});
