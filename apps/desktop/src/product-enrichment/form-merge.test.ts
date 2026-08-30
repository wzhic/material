import { describe, expect, it } from 'vitest';

import { ProductInput } from '../product/types';
import { mergeGameSuggestion } from './form-merge';
import { GameEnrichmentCandidate } from './types';

const candidate: GameEnrichmentCandidate = {
  fetchedAt: '2026-08-29T00:00:00.000Z',
  gameType: 'ARPG',
  name: '候选规范名',
  platforms: ['PC', 'iOS'],
  releaseDate: '2020-09-28',
  sourceId: 'bangumi:1',
  sourceName: 'Bangumi 番组计划',
  summary: '候选简介',
};

const gameInput = (): ProductInput => ({
  apparelCategory: null,
  channels: [],
  contexts: [],
  details: { 游戏类型: '用户已填写类型' },
  industry: 'game',
  name: '用户输入名称',
  versions: [],
});

describe('game enrichment form merge', () => {
  it('fills only empty allowlisted fields and never changes the product name', () => {
    const input = gameInput();
    const result = mergeGameSuggestion(input, candidate);

    expect(result.input.name).toBe('用户输入名称');
    expect(result.input.details).toEqual({
      发售日期: '2020-09-28',
      平台: 'PC、iOS',
      游戏简介: '候选简介',
      游戏类型: '用户已填写类型',
    });
    expect(result.appliedFields).toEqual(['发售日期', '游戏简介', '平台']);
    expect(input.details).toEqual({ 游戏类型: '用户已填写类型' });
  });

  it('does not apply a game suggestion to an apparel draft', () => {
    const input: ProductInput = { ...gameInput(), apparelCategory: '连衣裙', industry: 'apparel' };
    expect(mergeGameSuggestion(input, candidate)).toEqual({ appliedFields: [], input });
  });
});
