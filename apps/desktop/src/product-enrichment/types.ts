export type GameEnrichmentConsentChoice = 'declined' | 'once' | 'persistent';

export type GameEnrichmentConsentStatus =
  | 'declined'
  | 'once'
  | 'persistent'
  | 'required';

export interface GameEnrichmentProviderContract {
  id: string;
  name: string;
  sentFields: readonly ['gameName'];
  version: string;
}

export interface GameEnrichmentStatus {
  consent: GameEnrichmentConsentStatus;
  provider: GameEnrichmentProviderContract;
}

export interface GameEnrichmentSearchInput {
  gameName: string;
  requestId: string;
}

export interface GameEnrichmentCandidate {
  fetchedAt: string;
  gameType: string | null;
  name: string;
  platforms: string[];
  releaseDate: string | null;
  sourceId: string;
  sourceName: string;
  summary: string | null;
}

export interface GameEnrichmentSearchResult {
  candidates: GameEnrichmentCandidate[];
  query: string;
  requestId: string;
}

export type GameEnrichmentErrorCode =
  | 'CONSENT_REQUIRED'
  | 'INVALID_INPUT'
  | 'INVALID_RESPONSE'
  | 'OFFLINE'
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'REQUEST_CANCELLED'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface GameEnrichmentApiError {
  code: GameEnrichmentErrorCode;
  message: string;
}

export type GameEnrichmentApiResult<T> =
  | { data: T; ok: true }
  | { error: GameEnrichmentApiError; ok: false };

export interface GameEnrichmentApi {
  cancel: (requestId: string) => Promise<GameEnrichmentApiResult<null>>;
  clearPersistentConsent: () => Promise<GameEnrichmentApiResult<GameEnrichmentStatus>>;
  getStatus: () => Promise<GameEnrichmentApiResult<GameEnrichmentStatus>>;
  search: (
    input: GameEnrichmentSearchInput,
  ) => Promise<GameEnrichmentApiResult<GameEnrichmentSearchResult>>;
  setConsent: (
    choice: GameEnrichmentConsentChoice,
  ) => Promise<GameEnrichmentApiResult<GameEnrichmentStatus>>;
}

export const GAME_ENRICHMENT_PROVIDER: GameEnrichmentProviderContract = {
  id: 'bangumi-public-v0',
  name: 'Bangumi 番组计划',
  sentFields: ['gameName'],
  version: 'search-subjects-v0-2026-08-29',
};

export const GAME_ENRICHMENT_IPC_CHANNELS = {
  cancel: 'material:products:enrichment:cancel',
  clearPersistentConsent: 'material:products:enrichment:clear-persistent-consent',
  getStatus: 'material:products:enrichment:get-status',
  search: 'material:products:enrichment:search',
  setConsent: 'material:products:enrichment:set-consent',
} as const;
