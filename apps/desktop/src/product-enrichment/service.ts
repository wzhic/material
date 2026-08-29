import { GameSearchAdapter } from './bangumi-adapter';
import { GameEnrichmentConsentStore } from './consent-store';
import { GameEnrichmentError } from './errors';
import {
  GAME_ENRICHMENT_PROVIDER,
  GameEnrichmentConsentChoice,
  GameEnrichmentSearchInput,
  GameEnrichmentSearchResult,
  GameEnrichmentStatus,
} from './types';
import { normalizeGameName, validRequestId } from './validation';

interface PendingSearch {
  cancelled: boolean;
  controller: AbortController;
  timedOut: boolean;
}

export interface GameProductEnrichmentServiceOptions {
  adapter: GameSearchAdapter;
  consentStore: GameEnrichmentConsentStore;
  timeoutMs?: number;
}

const senderKey = (senderId: number, requestId: string): string =>
  `${senderId}:${requestId}`;

export class GameProductEnrichmentService {
  private readonly adapter: GameSearchAdapter;
  private readonly consentStore: GameEnrichmentConsentStore;
  private readonly declinedSenders = new Set<number>();
  private readonly onceSenders = new Set<number>();
  private readonly pending = new Map<string, PendingSearch>();
  private readonly timeoutMs: number;

  constructor(options: GameProductEnrichmentServiceOptions) {
    this.adapter = options.adapter;
    this.consentStore = options.consentStore;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async getStatus(senderId: number): Promise<GameEnrichmentStatus> {
    let consent: GameEnrichmentStatus['consent'] = 'required';
    if (this.declinedSenders.has(senderId)) consent = 'declined';
    else if (await this.consentStore.has(GAME_ENRICHMENT_PROVIDER)) consent = 'persistent';
    else if (this.onceSenders.has(senderId)) consent = 'once';
    return { consent, provider: GAME_ENRICHMENT_PROVIDER };
  }

  async setConsent(
    senderId: number,
    choice: GameEnrichmentConsentChoice,
  ): Promise<GameEnrichmentStatus> {
    if (!['declined', 'once', 'persistent'].includes(choice)) {
      throw new GameEnrichmentError('INVALID_INPUT');
    }
    this.onceSenders.delete(senderId);
    this.declinedSenders.delete(senderId);
    if (choice === 'once') this.onceSenders.add(senderId);
    if (choice === 'declined') this.declinedSenders.add(senderId);
    if (choice === 'persistent') {
      await this.consentStore.grant(GAME_ENRICHMENT_PROVIDER);
    }
    return this.getStatus(senderId);
  }

  async clearPersistentConsent(senderId: number): Promise<GameEnrichmentStatus> {
    await this.consentStore.clear();
    this.onceSenders.delete(senderId);
    this.declinedSenders.delete(senderId);
    this.cancelAllForSender(senderId);
    return this.getStatus(senderId);
  }

  async search(
    senderId: number,
    input: GameEnrichmentSearchInput,
  ): Promise<GameEnrichmentSearchResult> {
    const gameName = normalizeGameName(input?.gameName);
    if (!gameName || !validRequestId(input?.requestId)) {
      throw new GameEnrichmentError('INVALID_INPUT');
    }
    const status = await this.getStatus(senderId);
    if (status.consent !== 'once' && status.consent !== 'persistent') {
      throw new GameEnrichmentError('CONSENT_REQUIRED');
    }

    const key = senderKey(senderId, input.requestId);
    if (this.pending.has(key)) throw new GameEnrichmentError('INVALID_INPUT');
    if (status.consent === 'once') this.onceSenders.delete(senderId);

    const pending: PendingSearch = {
      cancelled: false,
      controller: new AbortController(),
      timedOut: false,
    };
    this.pending.set(key, pending);
    const timer = setTimeout(() => {
      pending.timedOut = true;
      pending.controller.abort();
    }, this.timeoutMs);
    try {
      const candidates = await this.adapter.search(gameName, pending.controller.signal);
      return { candidates, query: gameName, requestId: input.requestId };
    } catch (error) {
      if (pending.cancelled) throw new GameEnrichmentError('REQUEST_CANCELLED');
      if (pending.timedOut) throw new GameEnrichmentError('TIMEOUT');
      if (error instanceof GameEnrichmentError) throw error;
      throw new GameEnrichmentError('UNKNOWN');
    } finally {
      clearTimeout(timer);
      this.pending.delete(key);
    }
  }

  cancel(senderId: number, requestId: string): void {
    if (!validRequestId(requestId)) throw new GameEnrichmentError('INVALID_INPUT');
    const active = this.pending.get(senderKey(senderId, requestId));
    if (!active) return;
    active.cancelled = true;
    active.controller.abort();
  }

  disposeSender(senderId: number): void {
    this.onceSenders.delete(senderId);
    this.declinedSenders.delete(senderId);
    this.cancelAllForSender(senderId);
  }

  dispose(): void {
    [...this.pending.values()].forEach((active) => active.controller.abort());
    this.pending.clear();
    this.onceSenders.clear();
    this.declinedSenders.clear();
  }

  private cancelAllForSender(senderId: number): void {
    const prefix = `${senderId}:`;
    this.pending.forEach((active, key) => {
      if (!key.startsWith(prefix)) return;
      active.cancelled = true;
      active.controller.abort();
    });
  }
}
