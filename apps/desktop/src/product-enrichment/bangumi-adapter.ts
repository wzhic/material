import { GameEnrichmentError } from './errors';
import { GameEnrichmentCandidate } from './types';
import { sanitizeExternalText } from './validation';

const SEARCH_URL = 'https://api.bgm.tv/v0/search/subjects?limit=5&offset=0';
const MAX_RESPONSE_BYTES = 512 * 1024;
const USER_AGENT = 'MaterialDesktop/1.0 (wzhic/material; https://github.com/wzhic/material)';

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface BangumiSearchResponse {
  data?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const safeSubjectId = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return String(value);
};

const infoboxValues = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const safe = sanitizeExternalText(value, 120);
    return safe ? [safe] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') {
      const safe = sanitizeExternalText(item, 120);
      return safe ? [safe] : [];
    }
    if (!isRecord(item)) return [];
    const safe = sanitizeExternalText(item.v, 120);
    return safe ? [safe] : [];
  }).slice(0, 12);
};

const readInfobox = (value: unknown): Map<string, string[]> => {
  const result = new Map<string, string[]>();
  if (!Array.isArray(value)) return result;
  value.slice(0, 100).forEach((entry) => {
    if (!isRecord(entry)) return;
    const key = sanitizeExternalText(entry.key, 40);
    if (!key || !['发行日期', '发售日', '平台', '游戏类型'].includes(key)) return;
    const values = infoboxValues(entry.value);
    if (values.length) result.set(key, values);
  });
  return result;
};

const firstValue = (box: Map<string, string[]>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = box.get(key)?.[0];
    if (value) return value;
  }
  return null;
};

const candidateFromSubject = (
  value: unknown,
  fetchedAt: string,
): GameEnrichmentCandidate | null => {
  if (!isRecord(value) || value.type !== 4) return null;
  const subjectId = safeSubjectId(value.id);
  const name = sanitizeExternalText(value.name_cn, 160)
    ?? sanitizeExternalText(value.name, 160);
  if (!subjectId || !name) return null;
  const box = readInfobox(value.infobox);
  const platforms = [...new Set(box.get('平台') ?? [])].slice(0, 8);
  return {
    fetchedAt,
    gameType: firstValue(box, '游戏类型'),
    name,
    platforms,
    releaseDate: firstValue(box, '发行日期', '发售日')
      ?? sanitizeExternalText(value.date, 40),
    sourceId: `bangumi:${subjectId}`,
    sourceName: 'Bangumi 番组计划',
    summary: sanitizeExternalText(value.summary, 500),
  };
};

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw new GameEnrichmentError('INVALID_RESPONSE');
  }
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new GameEnrichmentError('INVALID_RESPONSE');
  }
  if (!response.body) throw new GameEnrichmentError('INVALID_RESPONSE');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reading = true;
  while (reading) {
    const { done, value } = await reader.read();
    if (done) {
      reading = false;
      continue;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new GameEnrichmentError('INVALID_RESPONSE');
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  });
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined)) as unknown;
  } catch {
    throw new GameEnrichmentError('INVALID_RESPONSE');
  }
};

export interface GameSearchAdapter {
  search(gameName: string, signal: AbortSignal): Promise<GameEnrichmentCandidate[]>;
}

export class BangumiGameSearchAdapter implements GameSearchAdapter {
  private readonly fetchImpl: FetchPort;
  private readonly now: () => Date;

  constructor(fetchImpl: FetchPort = fetch, now: () => Date = () => new Date()) {
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async search(gameName: string, signal: AbortSignal): Promise<GameEnrichmentCandidate[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(SEARCH_URL, {
        body: JSON.stringify({
          filter: { nsfw: false, type: [4] },
          keyword: gameName,
        }),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        method: 'POST',
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if ((error as { name?: unknown }).name === 'AbortError') throw error;
      throw new GameEnrichmentError('OFFLINE');
    }

    if (response.status === 429) throw new GameEnrichmentError('RATE_LIMITED');
    if (response.status >= 500) throw new GameEnrichmentError('PROVIDER_UNAVAILABLE');
    if (!response.ok) throw new GameEnrichmentError('INVALID_RESPONSE');

    const payload = await readBoundedJson(response) as BangumiSearchResponse;
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new GameEnrichmentError('INVALID_RESPONSE');
    }
    const fetchedAt = this.now().toISOString();
    return payload.data
      .slice(0, 5)
      .map((subject) => candidateFromSubject(subject, fetchedAt))
      .filter((candidate): candidate is GameEnrichmentCandidate => candidate !== null);
  }
}
