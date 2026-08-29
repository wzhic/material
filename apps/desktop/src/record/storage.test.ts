import {
  mkdtempSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RecordRepository } from './repository';
import { confirmedInput } from './fixtures';

describe('analysis record storage governance', () => {
  let directory: string;
  let databasePath: string;
  let backupDirectory: string;
  let repository: RecordRepository | null;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'material-record-storage-'));
    databasePath = path.join(directory, 'records.sqlite3');
    backupDirectory = path.join(directory, 'backups');
    repository = new RecordRepository(databasePath, backupDirectory);
  });

  afterEach(() => {
    repository?.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it('creates and verifies an app-managed backup with record metadata', async () => {
    const encryptedSource = Buffer.from('sealed-source-reference', 'utf8').toString('base64');
    const record = repository?.confirmAndSave(
      confirmedInput('备份素材.mp4'),
      encryptedSource,
    );
    repository?.saveFeedback(record?.id ?? '', {
      rating: 4,
      reason: '结论可用',
      weightDirection: '加强情绪转化',
    });

    const created = await repository?.createBackup();
    const status = repository?.storageStatus();

    expect(created).toMatchObject({
      feedbackCount: 1,
      integrity: 'ok',
      kind: 'manual',
      recordCount: 1,
      schemaVersion: 3,
      sourceReferenceCount: 1,
    });
    expect(status).toMatchObject({
      backupCount: 1,
      feedbackCount: 1,
      integrity: 'ok',
      recordCount: 1,
      schemaVersion: 3,
      sourceReferenceCount: 1,
      writable: true,
    });
    expect(repository?.listBackups()).toEqual([
      expect.objectContaining({ id: created?.id, integrity: 'ok' }),
    ]);
  });

  it('does not copy source bytes, external exports or model credentials into a backup', async () => {
    const plainSourcePath = '/Users/private/source-material.mp4';
    const modelCredential = 'sk-private-model-credential';
    repository?.confirmAndSave(
      confirmedInput('只保存引用.mp4'),
      Buffer.from('safe-storage-ciphertext', 'utf8').toString('base64'),
    );

    const created = await repository?.createBackup();
    const backupFile = readdirSync(backupDirectory).find((name) => name.includes(created?.id ?? ''));
    const bytes = readFileSync(path.join(backupDirectory, backupFile as string)).toString('utf8');

    expect(bytes).not.toContain(plainSourcePath);
    expect(bytes).not.toContain(modelCredential);
    expect(readdirSync(backupDirectory)).toHaveLength(1);
  });

  it('marks a corrupted managed backup as failed without changing current records', async () => {
    const saved = repository?.confirmAndSave(confirmedInput('当前记录.mp4'));
    const created = await repository?.createBackup();
    const backupFile = readdirSync(backupDirectory).find((name) => name.includes(created?.id ?? ''));
    writeFileSync(path.join(backupDirectory, backupFile as string), 'not a sqlite database');

    expect(repository?.listBackups()).toEqual([
      expect.objectContaining({ id: created?.id, integrity: 'failed' }),
    ]);
    await expect(repository?.restoreBackup(created?.id ?? '')).rejects.toThrow('完整性');
    expect(repository?.get(saved?.id ?? '').material.displayName).toBe('当前记录.mp4');
  });

  it('restores a verified backup and preserves the replaced data in a safety backup', async () => {
    repository?.confirmAndSave(confirmedInput('备份内记录.mp4'));
    const created = await repository?.createBackup();
    repository?.confirmAndSave(confirmedInput('恢复后应隐藏.mp4'));

    const result = await repository?.restoreBackup(created?.id ?? '');

    expect(repository?.list().items.map((item) => item.materialDisplayName)).toEqual([
      '备份内记录.mp4',
    ]);
    expect(result?.status).toMatchObject({
      integrity: 'ok',
      recordCount: 1,
      schemaVersion: 3,
    });
    expect(result?.safetyBackup).toMatchObject({
      integrity: 'ok',
      kind: 'pre-restore',
      recordCount: 2,
    });
    expect(repository?.listBackups().some((item) => item.kind === 'pre-restore')).toBe(true);
  });

  it('rolls back the original database when a replaced old backup fails during migration', async () => {
    const current = repository?.confirmAndSave(confirmedInput('回滚后保留.mp4'));
    mkdirSync(backupDirectory, { recursive: true });
    const backupId = '00000000-0000-4000-8000-000000000002';
    const conflictingSourcePath = path.join(directory, 'conflicting-v2.sqlite3');
    const conflictingRepository = new RecordRepository(
      conflictingSourcePath,
      path.join(directory, 'conflicting-backups'),
    );
    conflictingRepository.confirmAndSave(confirmedInput('冲突旧记录.mp4'));
    conflictingRepository.close();
    const conflictingDatabase = new DatabaseSync(conflictingSourcePath);
    conflictingDatabase.exec('PRAGMA user_version = 2;');
    conflictingDatabase.close();
    const conflictingBackupPath = path.join(
      backupDirectory,
      `record-manual-0000000000001-${backupId}.sqlite3`,
    );
    copyFileSync(conflictingSourcePath, conflictingBackupPath);
    expect(repository?.listBackups()).toEqual([
      expect.objectContaining({ id: backupId, integrity: 'ok', schemaVersion: 2 }),
    ]);

    await expect(repository?.restoreBackup(backupId)).rejects.toThrow('升级失败');

    expect(repository?.get(current?.id ?? '').material.displayName).toBe('回滚后保留.mp4');
    expect(repository?.storageStatus()).toMatchObject({ integrity: 'ok', schemaVersion: 3 });
    expect(repository?.listBackups().some((item) => item.kind === 'pre-restore')).toBe(true);
  });

  it('blocks record operations while an online backup is in progress', async () => {
    repository?.confirmAndSave(confirmedInput('并发保护.mp4'));

    const backupPromise = repository?.createBackup();

    expect(() => repository?.list()).toThrow('正在执行备份或恢复');
    await backupPromise;
    expect(repository?.list().total).toBe(1);
  });

  it('recovers the original database after an interrupted replacement', () => {
    repository?.confirmAndSave(confirmedInput('中断前记录.mp4'));
    repository?.close();
    repository = null;
    renameSync(
      databasePath,
      `${databasePath}.restore-old-00000000-0000-4000-8000-000000000001`,
    );

    repository = new RecordRepository(databasePath, backupDirectory);

    expect(repository.list().items.map((item) => item.materialDisplayName)).toEqual([
      '中断前记录.mp4',
    ]);
    expect(readdirSync(directory).some((name) => name.includes('restore-old'))).toBe(false);
  });

  it('ignores files outside the exact app-managed backup naming contract', () => {
    mkdirSync(backupDirectory, { recursive: true });
    writeFileSync(path.join(backupDirectory, 'user-copy.sqlite3'), 'not managed');
    writeFileSync(
      path.join(
        backupDirectory,
        'record-manual-0000000000000-not-a-managed-identifier.sqlite3',
      ),
      'not managed',
    );
    writeFileSync(`${databasePath}.restore-old-not-app-owned`, 'do not remove');

    expect(repository?.listBackups()).toEqual([]);
    expect(readdirSync(directory)).toContain('records.sqlite3.restore-old-not-app-owned');
  });
});
