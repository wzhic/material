import { describe, expect, it, vi } from 'vitest';

import { BangumiGameSearchAdapter } from './bangumi-adapter';
import { GameEnrichmentError } from './errors';

const jsonResponse = (body: unknown, status = 200): Response => new Response(
  JSON.stringify(body),
  { headers: { 'content-type': 'application/json' }, status },
);

describe('Bangumi game search adapter', () => {
  it('uses the fixed game-only endpoint and maps bounded allowlisted fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [{
        date: '2020-09-28',
        id: 123,
        images: { large: 'https://untrusted.example/cover.jpg' },
        infobox: [
          { key: '游戏类型', value: '<b>ARPG</b>\u202e' },
          { key: '平台', value: [{ v: 'PC' }, { v: 'iOS' }, { v: 'PC' }] },
          { key: '发行日期', value: '2020-09-28' },
          { key: '官网', value: 'https://untrusted.example/' },
        ],
        name: 'Genshin Impact',
        name_cn: '原神',
        summary: '<script>bad()</script> 开放世界游戏',
        tags: [{ name: '用户标签' }],
        type: 4,
      }, {
        id: 456,
        name: '不是游戏',
        type: 2,
      }],
    }));
    const adapter = new BangumiGameSearchAdapter(
      fetchImpl,
      () => new Date('2026-08-29T00:00:00.000Z'),
    );

    const candidates = await adapter.search('原神', new AbortController().signal);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.bgm.tv/v0/search/subjects?limit=5&offset=0');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(init.body))).toEqual({
      filter: { nsfw: false, type: [4] },
      keyword: '原神',
    });
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.stringify(init)).not.toMatch(/authorization|api[_-]?key|token/i);
    expect(candidates).toEqual([{
      fetchedAt: '2026-08-29T00:00:00.000Z',
      gameType: 'ARPG',
      name: '原神',
      platforms: ['PC', 'iOS'],
      releaseDate: '2020-09-28',
      sourceId: 'bangumi:123',
      sourceName: 'Bangumi 番组计划',
      summary: 'bad() 开放世界游戏',
    }]);
    expect(JSON.stringify(candidates)).not.toContain('untrusted.example');
    expect(JSON.stringify(candidates)).not.toContain('用户标签');
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [401, 'INVALID_RESPONSE'],
  ] as const)('maps HTTP %s to a stable public error', async (status, code) => {
    const adapter = new BangumiGameSearchAdapter(
      vi.fn().mockResolvedValue(jsonResponse({}, status)),
    );
    await expect(adapter.search('原神', new AbortController().signal))
      .rejects.toMatchObject({ code } satisfies Partial<GameEnrichmentError>);
  });

  it('rejects non-JSON, malformed and oversized responses', async () => {
    const invalidResponses = [
      new Response('html', { headers: { 'content-type': 'text/html' } }),
      jsonResponse({ data: 'not-an-array' }),
      new Response(JSON.stringify({ data: [], padding: 'x'.repeat(513 * 1024) }), {
        headers: { 'content-type': 'application/json' },
      }),
    ];
    for (const response of invalidResponses) {
      const adapter = new BangumiGameSearchAdapter(vi.fn().mockResolvedValue(response));
      await expect(adapter.search('原神', new AbortController().signal))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it('maps network failures without exposing the original message', async () => {
    const adapter = new BangumiGameSearchAdapter(
      vi.fn().mockRejectedValue(new TypeError('secret proxy path /Users/example')),
    );
    await expect(adapter.search('原神', new AbortController().signal)).rejects.toEqual(
      expect.objectContaining({ code: 'OFFLINE', message: expect.not.stringContaining('/Users/') }),
    );
  });
});
