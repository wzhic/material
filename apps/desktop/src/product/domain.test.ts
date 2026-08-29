import { describe, expect, it } from 'vitest';

import {
  normalizeProductInput,
  normalizeSearchText,
  ProductValidationError,
} from './domain';
import { ProductInput } from './types';

const apparel = (overrides: Partial<ProductInput> = {}): ProductInput => ({
  industry: 'apparel',
  name: '轻薄通勤套装',
  apparelCategory: '套装',
  details: {},
  versions: [],
  channels: [],
  contexts: [],
  ...overrides,
});

describe('product domain', () => {
  it('normalizes equivalent search text consistently', () => {
    expect(normalizeSearchText('  ＡＢＣ  游戏  ')).toBe('abc 游戏');
  });

  it('requires only name and category for apparel', () => {
    expect(normalizeProductInput(apparel()).name).toBe('轻薄通勤套装');
    expect(() => normalizeProductInput(apparel({ apparelCategory: '' }))).toThrow(
      ProductValidationError,
    );
  });

  it('requires only the game name when contexts are absent', () => {
    const normalized = normalizeProductInput({
      industry: 'game',
      name: '星际远征',
      apparelCategory: null,
      details: {},
      versions: [],
      channels: [],
      contexts: [],
    });
    expect(normalized.industry).toBe('game');
  });

  it('rejects context references to missing dimensions', () => {
    expect(() =>
      normalizeProductInput({
        industry: 'game',
        name: '星际远征',
        apparelCategory: null,
        details: {},
        versions: [],
        channels: [],
        contexts: [
          {
            id: 'context-1',
            versionId: 'missing-version',
            channelId: null,
            notes: '新增角色',
          },
        ],
      }),
    ).toThrow('不存在的版本');
  });

  it('does not preserve game children on apparel input', () => {
    const normalized = normalizeProductInput(
      apparel({
        versions: [{ id: 'v1', name: '1.0', notes: '' }],
      }),
    );
    expect(normalized.versions).toEqual([]);
  });
});
