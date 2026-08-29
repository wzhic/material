import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GameSearchAdapter } from './bangumi-adapter';
import { GameEnrichmentConsentStore } from './consent-store';
import { GameProductEnrichmentService } from './service';
import { GameEnrichmentCandidate } from './types';

describe('game product enrichment service', () => {
  const directories: string[] = [];

  afterEach(() => {
    directories.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
  });

  const createService = (
    adapter: GameSearchAdapter,
    timeoutMs = 10_000,
    filePath?: string,
  ): { filePath: string; service: GameProductEnrichmentService } => {
    const consentPath = filePath ?? (() => {
      const directory = mkdtempSync(path.join(tmpdir(), 'material-game-service-'));
      directories.push(directory);
      return path.join(directory, 'consent.json');
    })();
    return {
      filePath: consentPath,
      service: new GameProductEnrichmentService({
        adapter,
        consentStore: new GameEnrichmentConsentStore(consentPath),
        timeoutMs,
      }),
    };
  };

  it('fails closed before consent and consumes one-time consent for one outbound request', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const { service } = createService({ search });

    await expect(service.search(7, { gameName: '原神', requestId: 'request-1' }))
      .rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(search).not.toHaveBeenCalled();

    await service.setConsent(7, 'once');
    await service.search(7, { gameName: ' 原神 ', requestId: 'request-1' });
    expect(search).toHaveBeenCalledWith('原神', expect.any(AbortSignal));
    await expect(service.search(7, { gameName: '原神', requestId: 'request-2' }))
      .rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });

  it('persists continuous consent for the current OS user and supports clearing it', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const first = createService({ search });
    await first.service.setConsent(7, 'persistent');

    const second = createService({ search }, 10_000, first.filePath).service;
    expect((await second.getStatus(8)).consent).toBe('persistent');
    await second.search(8, { gameName: '原神', requestId: 'request-1' });
    expect(search).toHaveBeenCalledOnce();

    expect((await second.clearPersistentConsent(8)).consent).toBe('required');
    await expect(second.search(8, { gameName: '原神', requestId: 'request-2' }))
      .rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });

  it('separates one-time consent and cancellation by renderer sender', async () => {
    const observed: { signal: AbortSignal | null } = { signal: null };
    const adapter: GameSearchAdapter = {
      search: vi.fn((_query: string, signal: AbortSignal) =>
        new Promise<GameEnrichmentCandidate[]>((_resolve, reject) => {
          observed.signal = signal;
          signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')));
        })),
    };
    const { service } = createService(adapter);
    await service.setConsent(7, 'once');
    const pending = service.search(7, { gameName: '原神', requestId: 'request-1' });
    await vi.waitFor(() => expect(observed.signal).not.toBeNull());

    service.cancel(8, 'request-1');
    expect(observed.signal?.aborted).toBe(false);
    service.cancel(7, 'request-1');
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('turns a stalled provider into a stable timeout error', async () => {
    const adapter: GameSearchAdapter = {
      search: (_query, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    };
    const { service } = createService(adapter, 5);
    await service.setConsent(7, 'once');

    await expect(service.search(7, { gameName: '原神', requestId: 'request-1' }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects malformed names and request identifiers before the adapter call', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const { service } = createService({ search });
    await service.setConsent(7, 'persistent');

    await expect(service.search(7, { gameName: 'x', requestId: 'request-1' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.search(7, { gameName: '原神', requestId: 'bad request id' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(search).not.toHaveBeenCalled();
  });
});
