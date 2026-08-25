import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProductRepository } from './repository';

const percentile95 = (samples: number[]): number => {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
};

const measure = (runs: number, operation: (index: number) => void): number[] =>
  Array.from({ length: runs }, (_, index) => {
    const startedAt = performance.now();
    operation(index);
    return Number((performance.now() - startedAt).toFixed(3));
  });

describe('product library 10,000 item performance baseline', () => {
  let directory: string;
  let databasePath: string;
  let repository: ProductRepository;

  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'material-product-performance-'));
    databasePath = path.join(directory, 'products.sqlite3');
    repository = new ProductRepository(databasePath, path.join(directory, 'backups'));
    repository.close();

    const database = new DatabaseSync(databasePath);
    const productStatement = database.prepare(
      `INSERT INTO products (
         id, industry, name, normalized_name, apparel_category, details_json,
         search_text, write_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    const versionStatement = database.prepare(
      'INSERT INTO game_versions (id, product_id, name, notes, sort_order) VALUES (?, ?, ?, ?, 0)',
    );
    const channelStatement = database.prepare(
      'INSERT INTO game_channels (id, product_id, name, notes, sort_order) VALUES (?, ?, ?, ?, 0)',
    );
    database.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 10_000; index += 1) {
      const id = `fixture-${index.toString().padStart(5, '0')}`;
      const isGame = index >= 5_000;
      const name = `${isGame ? '游戏' : '服饰'}产品 ${index.toString().padStart(5, '0')}`;
      const timestamp = new Date(1_700_000_000_000 + index).toISOString();
      productStatement.run(
        id,
        isGame ? 'game' : 'apparel',
        name,
        name.toLocaleLowerCase('zh-CN'),
        isGame ? null : index % 2 ? '套装' : '连衣裙',
        JSON.stringify(isGame ? { 游戏类型: '角色扮演' } : { 适用季节: '春秋' }),
        `${name.toLocaleLowerCase('zh-CN')} ${isGame ? '角色扮演' : '春秋成衣'}`,
        timestamp,
        timestamp,
      );
      if (isGame && index % 10 === 0) {
        versionStatement.run(`version-${id}`, id, '2.0', '新增内容');
        channelStatement.run(`channel-${id}`, id, '官服', '官方渠道');
      }
    }
    database.exec('COMMIT');
    database.close();
    repository = new ProductRepository(databasePath, path.join(directory, 'backups'));
  });

  afterAll(() => {
    repository.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('keeps list, search and local writes below the adjustable P95 baseline', () => {
    const listSamples = measure(10, () => {
      expect(repository.list({ limit: 10_000 }).items).toHaveLength(10_000);
    });
    repository.list({ query: '产品 05000' });
    const searchSamples = measure(30, (index) => {
      const suffix = (5_000 + index).toString().padStart(5, '0');
      expect(repository.list({ query: `产品 ${suffix}` }).items).toHaveLength(1);
    });
    const writeSamples = measure(30, (index) => {
      repository.create({
        industry: 'apparel',
        name: `性能写入 ${index}`,
        apparelCategory: '套装',
        details: {},
        versions: [],
        channels: [],
        contexts: [],
      });
    });

    const summary = {
      datasetSize: 10_000,
      listMs: listSamples,
      listP95Ms: percentile95(listSamples),
      searchMs: searchSamples,
      searchP95Ms: percentile95(searchSamples),
      writeMs: writeSamples,
      writeP95Ms: percentile95(writeSamples),
    };
    console.info(`[product-performance] ${JSON.stringify(summary)}`);

    expect(summary.listP95Ms).toBeLessThan(1_000);
    expect(summary.searchP95Ms).toBeLessThan(1_000);
    expect(summary.writeP95Ms).toBeLessThan(1_000);
  }, 15_000);
});
