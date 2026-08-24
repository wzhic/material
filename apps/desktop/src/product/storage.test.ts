import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProductRepository } from './repository';
import { ProductInput } from './types';

const product = (name: string): ProductInput => ({
  industry: 'apparel',
  name,
  apparelCategory: '套装',
  details: {},
  versions: [],
  channels: [],
  contexts: [],
});

describe('product storage governance', () => {
  let directory: string;
  let databasePath: string;
  let backupDirectory: string;
  let repository: ProductRepository | null;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'material-product-storage-'));
    databasePath = path.join(directory, 'products.sqlite3');
    backupDirectory = path.join(directory, 'backups');
    repository = new ProductRepository(databasePath, backupDirectory);
  });

  afterEach(() => {
    repository?.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('creates and verifies an app-managed backup', async () => {
    repository?.create(product('备份前产品'));
    const backup = await repository?.createBackup();
    const status = repository?.storageStatus();

    expect(backup?.integrity).toBe('ok');
    expect(backup?.schemaVersion).toBe(1);
    expect(backup?.productCount).toBe(1);
    expect(status).toMatchObject({
      integrity: 'ok',
      productCount: 1,
      schemaVersion: 1,
      writable: true,
    });
    expect(repository?.listBackups()).toHaveLength(1);
  });

  it('restores a verified backup and creates a pre-restore safety backup', async () => {
    repository?.create(product('保留产品'));
    const backup = await repository?.createBackup();
    repository?.create(product('恢复后应消失'));

    const result = await repository?.restoreBackup(backup?.id ?? '');

    expect(repository?.list().items.map((item) => item.name)).toEqual(['保留产品']);
    expect(result?.status.productCount).toBe(1);
    expect(result?.safetyBackup.kind).toBe('pre-restore');
    expect(result?.safetyBackup.productCount).toBe(2);
    expect(repository?.listBackups().map((item) => item.kind)).toEqual([
      'pre-restore',
      'manual',
    ]);
  });

  it('rejects a backup that no longer passes integrity checks', async () => {
    repository?.create(product('原产品'));
    const backup = await repository?.createBackup();
    const backupFile = readdirSync(backupDirectory).find((name) => name.includes(backup?.id ?? ''));
    expect(backupFile).toBeTruthy();
    writeFileSync(path.join(backupDirectory, backupFile as string), 'not a sqlite database');

    expect(repository?.listBackups()[0].integrity).toBe('failed');
    await expect(repository?.restoreBackup(backup?.id ?? '')).rejects.toThrow('完整性');
    expect(repository?.list().items.map((item) => item.name)).toEqual(['原产品']);
  });

  it('recovers the original database after an interrupted replacement', () => {
    repository?.create(product('中断前产品'));
    repository?.close();
    repository = null;
    renameSync(
      databasePath,
      `${databasePath}.restore-old-00000000-0000-4000-8000-000000000001`,
    );

    repository = new ProductRepository(databasePath, backupDirectory);

    expect(repository.list().items.map((item) => item.name)).toEqual(['中断前产品']);
    expect(readdirSync(directory).some((name) => name.includes('restore-old'))).toBe(false);
  });

  it('ignores files outside the exact app-managed backup and restore naming contract', () => {
    repository?.create(product('边界产品'));
    repository?.close();
    repository = null;
    mkdirSync(backupDirectory, { recursive: true });
    writeFileSync(path.join(backupDirectory, 'user-copy.sqlite3'), 'not managed');
    writeFileSync(`${databasePath}.restore-old-not-app-owned`, 'do not remove');

    repository = new ProductRepository(databasePath, backupDirectory);

    expect(repository.listBackups()).toEqual([]);
    expect(readdirSync(directory)).toContain('products.sqlite3.restore-old-not-app-owned');
  });
});
