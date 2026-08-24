import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProductRepository, ProductRepositoryError } from './repository';
import { ProductInput } from './types';

const apparel = (name = '轻薄通勤套装'): ProductInput => ({
  industry: 'apparel',
  name,
  apparelCategory: '套装',
  details: { 品牌: 'Material', 卖点: '通勤剪裁' },
  versions: [],
  channels: [],
  contexts: [],
});

const game = (): ProductInput => ({
  industry: 'game',
  name: '星际远征',
  apparelCategory: null,
  details: { 游戏类型: '角色扮演', 核心玩法: '小队探索' },
  versions: [{ id: 'version-2', name: '2.0', notes: '新增角色' }],
  channels: [{ id: 'channel-official', name: '官服', notes: '' }],
  contexts: [
    {
      id: 'context-official-2',
      versionId: 'version-2',
      channelId: 'channel-official',
      notes: '2.0 官服新增角色阿澜',
    },
  ],
});

describe('ProductRepository', () => {
  let repository: ProductRepository;

  beforeEach(() => {
    repository = new ProductRepository(':memory:');
  });

  afterEach(() => {
    repository.close();
  });

  it('creates, reads and searches apparel products locally', () => {
    const created = repository.create(apparel());
    expect(created.writeVersion).toBe(1);
    expect(repository.get(created.id).details['品牌']).toBe('Material');
    expect(repository.list({ query: '通勤' })).toHaveLength(1);
    expect(repository.list({ industry: 'game' })).toHaveLength(0);
  });

  it('persists game versions, channels and explicit contexts', () => {
    const created = repository.create(game());
    expect(created.versions.map((item) => item.name)).toEqual(['2.0']);
    expect(created.channels.map((item) => item.name)).toEqual(['官服']);
    expect(created.contexts[0].notes).toContain('阿澜');
  });

  it('returns duplicate candidates without enforcing uniqueness', () => {
    const first = repository.create(apparel());
    const duplicates = repository.findDuplicates(apparel('  轻薄通勤套装  '));
    expect(duplicates.map((item) => item.id)).toEqual([first.id]);

    const second = repository.create(apparel());
    expect(second.id).not.toBe(first.id);
    expect(repository.list()).toHaveLength(2);
  });

  it('uses optimistic write versions to reject stale edits', () => {
    const created = repository.create(apparel());
    const updated = repository.update(created.id, 1, {
      ...apparel(),
      details: { 卖点: '第一次修改' },
    });
    expect(updated.writeVersion).toBe(2);
    expect(() => repository.update(created.id, 1, apparel())).toThrowError(
      ProductRepositoryError,
    );
  });

  it('deletes product content and removes it from search', () => {
    const created = repository.create(game());
    repository.remove(created.id, created.writeVersion);
    expect(repository.list()).toEqual([]);
    expect(() => repository.get(created.id)).toThrow('不存在或已删除');
  });

  it('creates a versioned self-contained snapshot', () => {
    const created = repository.create(game());
    const snapshot = repository.snapshot(created.id, {
      versionId: 'version-2',
      channelId: 'channel-official',
      contextId: 'context-official-2',
    });
    repository.update(created.id, created.writeVersion, {
      ...game(),
      name: '星际远征：新名称',
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.name).toBe('星际远征');
    expect(snapshot.game?.contexts[0].notes).toContain('阿澜');
  });

  it('treats LIKE wildcard characters as literal search text', () => {
    repository.create(apparel('100% 通勤套装'));
    repository.create(apparel('普通套装'));
    expect(repository.list({ query: '100%' })).toHaveLength(1);
    expect(repository.list({ query: '_' })).toHaveLength(0);
  });
});
