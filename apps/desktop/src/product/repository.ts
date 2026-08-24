import { randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import {
  buildProductSearchText,
  normalizeProductInput,
  normalizeSearchText,
  ProductValidationError,
} from './domain';
import {
  DuplicateCandidate,
  ProductBackupInfo,
  ProductBackupKind,
  ProductApiErrorCode,
  ProductContextSelection,
  ProductInput,
  ProductListPage,
  ProductListQuery,
  ProductRecord,
  ProductRestoreResult,
  ProductSnapshot,
  ProductStorageStatus,
} from './types';

interface ProductRow {
  id: string;
  industry: 'apparel' | 'game';
  name: string;
  apparel_category: string | null;
  details_json: string;
  write_version: number;
  created_at: string;
  updated_at: string;
}

interface DimensionRow {
  id: string;
  name: string;
  notes: string;
}

interface ContextRow {
  id: string;
  version_id: string | null;
  channel_id: string | null;
  notes: string;
}

interface VersionRow {
  user_version: number;
}

interface QuickCheckRow {
  quick_check: string;
}

interface CountRow {
  count: number;
}

interface BackupEntry extends ProductBackupInfo {
  filePath: string;
}

export class ProductRepositoryError extends Error {
  readonly code: ProductApiErrorCode;

  constructor(code: ProductApiErrorCode, message: string) {
    super(message);
    this.name = 'ProductRepositoryError';
    this.code = code;
  }
}

const asRows = <T>(rows: unknown[]): T[] => rows as T[];
const asRow = <T>(row: unknown): T | undefined => row as T | undefined;

const escapeLike = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

const BACKUP_PATTERN =
  /^product-(manual|pre-migration|pre-restore)-(\d{13})-([0-9a-f-]{36})\.sqlite3$/;
const RESTORE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ProductRepository {
  private database: DatabaseSync;
  private writable: boolean;
  private readonly databasePath: string;
  private readonly backupDirectory: string | null;
  private maintenance = false;

  constructor(databasePath: string, backupDirectory?: string) {
    this.databasePath = databasePath;
    this.backupDirectory =
      databasePath === ':memory:'
        ? null
        : backupDirectory ?? path.join(path.dirname(databasePath), 'product-backups');
    this.recoverInterruptedRestore();
    const opened = this.openDatabase(databasePath);
    this.database = opened.database;
    this.writable = opened.writable;
    try {
      this.initialize();
      if (databasePath !== ':memory:' && this.writable) {
        chmodSync(databasePath, 0o600);
      }
      this.cleanupRestoreFiles();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  list(query: ProductListQuery = {}): ProductListPage {
    this.ensureAvailable();
    const conditions: string[] = [];
    const parameters: Array<number | string> = [];
    if (query.industry) {
      conditions.push('p.industry = ?');
      parameters.push(query.industry);
    }
    const normalizedQuery = normalizeSearchText(query.query ?? '');
    if (normalizedQuery) {
      conditions.push("p.search_text LIKE ? ESCAPE '\\'");
      parameters.push(`%${escapeLike(normalizedQuery)}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(10_000, Math.max(1, Math.trunc(query.limit ?? 100)));
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const total =
      asRow<CountRow>(
        this.database
          .prepare(`SELECT COUNT(*) AS count FROM products p ${where}`)
          .get(...parameters),
      )?.count ?? 0;
    const rows = asRows<ProductRow & { version_count: number; channel_count: number }>(
      this.database
        .prepare(
          `SELECT p.*,
            (SELECT COUNT(*) FROM game_versions v WHERE v.product_id = p.id) AS version_count,
            (SELECT COUNT(*) FROM game_channels c WHERE c.product_id = p.id) AS channel_count
           FROM products p ${where}
           ORDER BY p.updated_at DESC, p.name COLLATE NOCASE ASC
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters, limit, offset),
    );
    const items = rows.map((row) => {
      const details = this.parseDetails(row.details_json);
      return {
        id: row.id,
        industry: row.industry,
        name: row.name,
        apparelCategory: row.apparel_category,
        summary:
          row.industry === 'apparel'
            ? row.apparel_category ?? '未填写服饰类别'
            : [
                details['游戏类型'],
                row.version_count ? `${row.version_count} 个版本` : '',
                row.channel_count ? `${row.channel_count} 个渠道` : '',
              ]
                .filter(Boolean)
                .join(' · ') || '基础游戏信息',
        versionCount: row.version_count,
        channelCount: row.channel_count,
        writeVersion: row.write_version,
        updatedAt: row.updated_at,
      };
    });
    return { items, total, limit, offset };
  }

  get(id: string): ProductRecord {
    this.ensureAvailable();
    const row = asRow<ProductRow>(
      this.database.prepare('SELECT * FROM products WHERE id = ?').get(id),
    );
    if (!row) {
      throw new ProductRepositoryError('NOT_FOUND', '产品不存在或已删除');
    }
    return this.hydrate(row);
  }

  findDuplicates(input: ProductInput, excludeId?: string): DuplicateCandidate[] {
    this.ensureAvailable();
    const normalized = normalizeProductInput(input);
    const parameters: string[] = [normalizeSearchText(normalized.name), normalized.industry];
    let exclusion = '';
    if (excludeId) {
      exclusion = 'AND id <> ?';
      parameters.push(excludeId);
    }
    const rows = asRows<ProductRow>(
      this.database
        .prepare(
          `SELECT * FROM products
           WHERE normalized_name = ? AND industry = ? ${exclusion}
           ORDER BY updated_at DESC`,
        )
        .all(...parameters),
    );

    return rows
      .filter((row) => {
        if (normalized.industry === 'game') {
          return true;
        }
        return (
          normalizeSearchText(row.apparel_category ?? '') ===
          normalizeSearchText(normalized.apparelCategory ?? '')
        );
      })
      .map((row) => ({
        id: row.id,
        name: row.name,
        industry: row.industry,
        reason:
          row.industry === 'game'
            ? '游戏名称相同，建议先查看已有版本和渠道'
            : '产品名称和服饰类别相同',
        updatedAt: row.updated_at,
      }));
  }

  create(input: ProductInput): ProductRecord {
    this.ensureAvailable();
    const normalized = normalizeProductInput(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO products (
             id, industry, name, normalized_name, apparel_category,
             details_json, search_text, write_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          normalized.industry,
          normalized.name,
          normalizeSearchText(normalized.name),
          normalized.apparelCategory,
          JSON.stringify(normalized.details),
          buildProductSearchText(normalized),
          now,
          now,
        );
      this.writeGameChildren(id, normalized);
    });
    return this.get(id);
  }

  update(id: string, expectedVersion: number, input: ProductInput): ProductRecord {
    this.ensureAvailable();
    const normalized = normalizeProductInput(input);
    const now = new Date().toISOString();
    this.transaction(() => {
      const existing = this.get(id);
      if (existing.industry !== normalized.industry) {
        throw new ProductRepositoryError('INVALID_INPUT', '产品保存后不能切换行业');
      }
      if (existing.writeVersion !== expectedVersion) {
        throw new ProductRepositoryError(
          'CONFLICT',
          '产品已在其他窗口更新，请刷新后重新编辑',
        );
      }
      const result = this.database
        .prepare(
          `UPDATE products SET
             name = ?, normalized_name = ?, apparel_category = ?, details_json = ?,
             search_text = ?, write_version = write_version + 1, updated_at = ?
           WHERE id = ? AND write_version = ?`,
        )
        .run(
          normalized.name,
          normalizeSearchText(normalized.name),
          normalized.apparelCategory,
          JSON.stringify(normalized.details),
          buildProductSearchText(normalized),
          now,
          id,
          expectedVersion,
        );
      if (Number(result.changes) !== 1) {
        throw new ProductRepositoryError(
          'CONFLICT',
          '产品已在其他窗口更新，请刷新后重新编辑',
        );
      }
      this.database.prepare('DELETE FROM game_contexts WHERE product_id = ?').run(id);
      this.database.prepare('DELETE FROM game_versions WHERE product_id = ?').run(id);
      this.database.prepare('DELETE FROM game_channels WHERE product_id = ?').run(id);
      this.writeGameChildren(id, normalized);
    });
    return this.get(id);
  }

  remove(id: string, expectedVersion: number): void {
    this.ensureAvailable();
    this.transaction(() => {
      const existing = this.get(id);
      if (existing.writeVersion !== expectedVersion) {
        throw new ProductRepositoryError(
          'CONFLICT',
          '产品已更新，请刷新后重新确认删除',
        );
      }
      const deletedAt = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO product_tombstones (id, industry, deleted_at, last_write_version)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             industry = excluded.industry,
             deleted_at = excluded.deleted_at,
             last_write_version = excluded.last_write_version`,
        )
        .run(id, existing.industry, deletedAt, existing.writeVersion);
      const result = this.database
        .prepare('DELETE FROM products WHERE id = ? AND write_version = ?')
        .run(id, expectedVersion);
      if (Number(result.changes) !== 1) {
        throw new ProductRepositoryError('CONFLICT', '产品删除失败，请刷新后重试');
      }
    });
  }

  snapshot(id: string, selection: ProductContextSelection = {}): ProductSnapshot {
    this.ensureAvailable();
    const product = this.get(id);
    if (product.industry === 'game') {
      this.validateSelection(product, selection);
    } else if (selection.versionId || selection.channelId || selection.contextId) {
      throw new ProductRepositoryError('INVALID_INPUT', '服饰产品不支持游戏上下文');
    }
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceStatus: 'active',
      productId: product.id,
      productWriteVersion: product.writeVersion,
      industry: product.industry,
      name: product.name,
      apparelCategory: product.apparelCategory,
      details: { ...product.details },
      game:
        product.industry === 'game'
          ? {
              versions: product.versions.map((item) => ({ ...item })),
              channels: product.channels.map((item) => ({ ...item })),
              contexts: product.contexts.map((item) => ({ ...item })),
              selection: { ...selection },
            }
          : null,
    };
  }

  storageStatus(): ProductStorageStatus {
    this.ensureAvailable();
    return this.storageStatusInternal();
  }

  listBackups(): ProductBackupInfo[] {
    this.ensureAvailable();
    return this.listBackupEntries().map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      createdAt: entry.createdAt,
      size: entry.size,
      schemaVersion: entry.schemaVersion,
      productCount: entry.productCount,
      integrity: entry.integrity,
    }));
  }

  async createBackup(): Promise<ProductBackupInfo> {
    this.ensureAvailable();
    this.maintenance = true;
    try {
      return await this.createBackupInternal('manual');
    } finally {
      this.maintenance = false;
    }
  }

  async restoreBackup(id: string): Promise<ProductRestoreResult> {
    this.ensureAvailable();
    this.requireBackupDirectory();
    if (!this.writable) {
      throw new ProductRepositoryError(
        'DATABASE_UNAVAILABLE',
        '产品库当前为只读，恢复写入权限后才能恢复备份',
      );
    }
    const entry = this.listBackupEntries().find((candidate) => candidate.id === id);
    if (!entry) {
      throw new ProductRepositoryError('NOT_FOUND', '备份不存在或已被移除');
    }
    if (entry.integrity !== 'ok' || entry.schemaVersion !== 1) {
      throw new ProductRepositoryError('INVALID_INPUT', '备份未通过完整性或版本校验');
    }

    this.maintenance = true;
    const restoreId = randomUUID();
    const stagingPath = `${this.databasePath}.restore-new-${restoreId}`;
    const oldPath = `${this.databasePath}.restore-old-${restoreId}`;
    try {
      const safetyBackup = await this.createBackupInternal('pre-restore');
      copyFileSync(entry.filePath, stagingPath, fsConstants.COPYFILE_EXCL);
      const staged = this.inspectDatabase(stagingPath);
      if (staged.integrity !== 'ok' || staged.schemaVersion !== 1) {
        throw new ProductRepositoryError('INVALID_INPUT', '备份副本复验失败，未修改当前产品库');
      }

      this.database.close();
      try {
        renameSync(this.databasePath, oldPath);
        renameSync(stagingPath, this.databasePath);
        const opened = this.openDatabase(this.databasePath);
        this.database = opened.database;
        this.writable = opened.writable;
        this.initialize();
        const status = this.storageStatusInternal();
        if (status.integrity !== 'ok') {
          throw new ProductRepositoryError('DATABASE_UNAVAILABLE', '恢复后的产品库复验失败');
        }
        if (existsSync(oldPath)) {
          unlinkSync(oldPath);
        }
        return { restoredBackupId: id, safetyBackup, status };
      } catch (error) {
        try {
          this.database.close();
        } catch {
          // The connection can already be closed when replacement failed early.
        }
        if (existsSync(this.databasePath) && existsSync(oldPath)) {
          unlinkSync(this.databasePath);
        }
        if (existsSync(oldPath)) {
          renameSync(oldPath, this.databasePath);
        }
        const reopened = this.openDatabase(this.databasePath);
        this.database = reopened.database;
        this.writable = reopened.writable;
        this.initialize();
        if (error instanceof ProductRepositoryError) {
          throw error;
        }
        throw new ProductRepositoryError(
          'DATABASE_UNAVAILABLE',
          '备份恢复失败，原产品库已恢复',
        );
      }
    } finally {
      if (existsSync(stagingPath)) {
        unlinkSync(stagingPath);
      }
      this.maintenance = false;
    }
  }

  private openDatabase(databasePath: string): {
    database: DatabaseSync;
    writable: boolean;
  } {
    try {
      return {
        database: new DatabaseSync(databasePath, {
          enableForeignKeyConstraints: true,
          timeout: 5_000,
        }),
        writable: true,
      };
    } catch {
      try {
        return {
          database: new DatabaseSync(databasePath, {
            enableForeignKeyConstraints: true,
            readOnly: true,
            timeout: 5_000,
          }),
          writable: false,
        };
      } catch {
        throw new ProductRepositoryError(
          'DATABASE_UNAVAILABLE',
          '产品库无法打开，请检查应用数据目录权限',
        );
      }
    }
  }

  private ensureAvailable(): void {
    if (this.maintenance) {
      throw new ProductRepositoryError(
        'CONFLICT',
        '产品库正在执行备份或恢复，请稍后重试',
      );
    }
  }

  private requireBackupDirectory(): string {
    if (!this.backupDirectory || this.databasePath === ':memory:') {
      throw new ProductRepositoryError(
        'DATABASE_UNAVAILABLE',
        '当前产品库不支持文件备份',
      );
    }
    return this.backupDirectory;
  }

  private storageStatusInternal(): ProductStorageStatus {
    const version = asRow<VersionRow>(
      this.database.prepare('PRAGMA user_version').get(),
    )?.user_version ?? 0;
    const integrity = this.quickCheck(this.database) ? 'ok' : 'failed';
    const productCount =
      asRow<CountRow>(
        this.database.prepare('SELECT COUNT(*) AS count FROM products').get(),
      )?.count ?? 0;
    return {
      schemaVersion: version,
      integrity,
      writable: this.writable,
      productCount,
      backupCount: this.listBackupEntries().length,
    };
  }

  private async createBackupInternal(kind: ProductBackupKind): Promise<ProductBackupInfo> {
    const backupDirectory = this.requireBackupDirectory();
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    chmodSync(backupDirectory, 0o700);
    const createdAt = Date.now();
    const id = randomUUID();
    const fileName = `product-${kind}-${createdAt}-${id}.sqlite3`;
    const destination = path.join(backupDirectory, fileName);
    try {
      await backup(this.database, destination, { rate: 128 });
      chmodSync(destination, 0o600);
      const inspection = this.inspectDatabase(destination);
      if (inspection.integrity !== 'ok' || inspection.schemaVersion !== 1) {
        throw new ProductRepositoryError(
          'DATABASE_UNAVAILABLE',
          '备份完整性校验失败，未保留该备份',
        );
      }
      return {
        id,
        kind,
        createdAt: new Date(createdAt).toISOString(),
        size: statSync(destination).size,
        schemaVersion: inspection.schemaVersion,
        productCount: inspection.productCount,
        integrity: 'ok',
      };
    } catch (error) {
      if (existsSync(destination)) {
        unlinkSync(destination);
      }
      if (error instanceof ProductRepositoryError) {
        throw error;
      }
      throw new ProductRepositoryError(
        'DATABASE_UNAVAILABLE',
        '产品库备份失败，请检查磁盘空间和目录权限',
      );
    }
  }

  private listBackupEntries(): BackupEntry[] {
    if (!this.backupDirectory || !existsSync(this.backupDirectory)) {
      return [];
    }
    return readdirSync(this.backupDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .flatMap((entry) => {
        const match = BACKUP_PATTERN.exec(entry.name);
        if (!match) {
          return [];
        }
        const kind = match[1] as ProductBackupKind;
        const createdAt = Number(match[2]);
        const id = match[3];
        const filePath = path.join(this.backupDirectory as string, entry.name);
        const inspection = this.inspectDatabase(filePath);
        return [
          {
            id,
            kind,
            createdAt: new Date(createdAt).toISOString(),
            size: statSync(filePath).size,
            schemaVersion: inspection.schemaVersion,
            productCount: inspection.productCount,
            integrity: inspection.integrity,
            filePath,
          },
        ];
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private inspectDatabase(databasePath: string): Pick<
    ProductBackupInfo,
    'integrity' | 'productCount' | 'schemaVersion'
  > {
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(databasePath, {
        enableForeignKeyConstraints: true,
        readOnly: true,
        timeout: 5_000,
      });
      const schemaVersion = asRow<VersionRow>(
        database.prepare('PRAGMA user_version').get(),
      )?.user_version ?? null;
      const productCount =
        schemaVersion === 1
          ? asRow<CountRow>(
              database.prepare('SELECT COUNT(*) AS count FROM products').get(),
            )?.count ?? null
          : null;
      return {
        schemaVersion,
        productCount,
        integrity: this.quickCheck(database) ? 'ok' : 'failed',
      };
    } catch {
      return { schemaVersion: null, productCount: null, integrity: 'failed' };
    } finally {
      database?.close();
    }
  }

  private quickCheck(database: DatabaseSync): boolean {
    const rows = asRows<QuickCheckRow>(database.prepare('PRAGMA quick_check').all());
    return rows.length > 0 && rows.every((row) => row.quick_check === 'ok');
  }

  private recoverInterruptedRestore(): void {
    if (this.databasePath === ':memory:' || existsSync(this.databasePath)) {
      return;
    }
    const directory = path.dirname(this.databasePath);
    if (!existsSync(directory)) {
      return;
    }
    const prefix = `${path.basename(this.databasePath)}.restore-old-`;
    const candidates = readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(prefix) &&
          RESTORE_ID_PATTERN.test(entry.name.slice(prefix.length)),
      )
      .map((entry) => ({
        name: entry.name,
        modifiedAt: statSync(path.join(directory, entry.name)).mtimeMs,
      }))
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    const newest = candidates[0];
    if (newest) {
      renameSync(path.join(directory, newest.name), this.databasePath);
    }
  }

  private cleanupRestoreFiles(): void {
    if (this.databasePath === ':memory:' || !this.quickCheck(this.database)) {
      return;
    }
    const directory = path.dirname(this.databasePath);
    const baseName = path.basename(this.databasePath);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const oldPrefix = `${baseName}.restore-old-`;
      const newPrefix = `${baseName}.restore-new-`;
      const suffix = entry.name.startsWith(oldPrefix)
        ? entry.name.slice(oldPrefix.length)
        : entry.name.startsWith(newPrefix)
          ? entry.name.slice(newPrefix.length)
          : '';
      if (entry.isFile() && RESTORE_ID_PATTERN.test(suffix)) {
        unlinkSync(path.join(directory, entry.name));
      }
    }
  }

  private initialize(): void {
    this.database.exec(
      this.writable
        ? 'PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;'
        : 'PRAGMA foreign_keys = ON;',
    );
    const version = asRow<VersionRow>(
      this.database.prepare('PRAGMA user_version').get(),
    )?.user_version;
    if (version === 0) {
      if (!this.writable) {
        throw new ProductRepositoryError(
          'DATABASE_UNAVAILABLE',
          '产品库尚未初始化且当前目录只读',
        );
      }
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE products (
          id TEXT PRIMARY KEY,
          industry TEXT NOT NULL CHECK (industry IN ('apparel', 'game')),
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          apparel_category TEXT,
          details_json TEXT NOT NULL,
          search_text TEXT NOT NULL,
          write_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX products_industry_updated_idx ON products(industry, updated_at DESC);
        CREATE INDEX products_normalized_name_idx ON products(industry, normalized_name);
        CREATE TABLE game_versions (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          notes TEXT NOT NULL,
          sort_order INTEGER NOT NULL
        );
        CREATE TABLE game_channels (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          notes TEXT NOT NULL,
          sort_order INTEGER NOT NULL
        );
        CREATE TABLE game_contexts (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          version_id TEXT REFERENCES game_versions(id) ON DELETE CASCADE,
          channel_id TEXT REFERENCES game_channels(id) ON DELETE CASCADE,
          notes TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          CHECK (version_id IS NOT NULL OR channel_id IS NOT NULL)
        );
        CREATE TABLE product_tombstones (
          id TEXT PRIMARY KEY,
          industry TEXT NOT NULL,
          deleted_at TEXT NOT NULL,
          last_write_version INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
        COMMIT;
      `);
      return;
    }
    if (version !== 1) {
      throw new ProductRepositoryError(
        'DATABASE_UNAVAILABLE',
        '产品库版本高于当前客户端，请升级客户端后重试',
      );
    }
  }

  private hydrate(row: ProductRow): ProductRecord {
    const versions = asRows<DimensionRow>(
      this.database
        .prepare('SELECT id, name, notes FROM game_versions WHERE product_id = ? ORDER BY sort_order')
        .all(row.id),
    ).map((item) => ({ ...item }));
    const channels = asRows<DimensionRow>(
      this.database
        .prepare('SELECT id, name, notes FROM game_channels WHERE product_id = ? ORDER BY sort_order')
        .all(row.id),
    ).map((item) => ({ ...item }));
    const contexts = asRows<ContextRow>(
      this.database
        .prepare(
          `SELECT id, version_id, channel_id, notes
           FROM game_contexts WHERE product_id = ? ORDER BY sort_order`,
        )
        .all(row.id),
    ).map((item) => ({
      id: item.id,
      versionId: item.version_id,
      channelId: item.channel_id,
      notes: item.notes,
    }));
    return {
      id: row.id,
      industry: row.industry,
      name: row.name,
      apparelCategory: row.apparel_category,
      details: this.parseDetails(row.details_json),
      versions,
      channels,
      contexts,
      writeVersion: row.write_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parseDetails(value: string): Record<string, string> {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      throw new ProductRepositoryError('DATABASE_UNAVAILABLE', '产品库数据无法读取');
    }
  }

  private writeGameChildren(productId: string, input: ProductInput): void {
    if (input.industry !== 'game') {
      return;
    }
    const versionStatement = this.database.prepare(
      'INSERT INTO game_versions (id, product_id, name, notes, sort_order) VALUES (?, ?, ?, ?, ?)',
    );
    input.versions.forEach((item, index) =>
      versionStatement.run(item.id, productId, item.name, item.notes, index),
    );
    const channelStatement = this.database.prepare(
      'INSERT INTO game_channels (id, product_id, name, notes, sort_order) VALUES (?, ?, ?, ?, ?)',
    );
    input.channels.forEach((item, index) =>
      channelStatement.run(item.id, productId, item.name, item.notes, index),
    );
    const contextStatement = this.database.prepare(
      `INSERT INTO game_contexts
       (id, product_id, version_id, channel_id, notes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    input.contexts.forEach((item, index) =>
      contextStatement.run(
        item.id,
        productId,
        item.versionId,
        item.channelId,
        item.notes,
        index,
      ),
    );
  }

  private validateSelection(product: ProductRecord, selection: ProductContextSelection): void {
    if (
      selection.versionId &&
      !product.versions.some((item) => item.id === selection.versionId)
    ) {
      throw new ProductRepositoryError('INVALID_INPUT', '所选游戏版本不存在');
    }
    if (
      selection.channelId &&
      !product.channels.some((item) => item.id === selection.channelId)
    ) {
      throw new ProductRepositoryError('INVALID_INPUT', '所选游戏渠道不存在');
    }
    if (
      selection.contextId &&
      !product.contexts.some((item) => item.id === selection.contextId)
    ) {
      throw new ProductRepositoryError('INVALID_INPUT', '所选版本渠道差异不存在');
    }
    const context = product.contexts.find((item) => item.id === selection.contextId);
    if (
      context &&
      ((selection.versionId && context.versionId !== selection.versionId) ||
        (selection.channelId && context.channelId !== selection.channelId))
    ) {
      throw new ProductRepositoryError(
        'INVALID_INPUT',
        '所选版本、渠道与组合差异不一致',
      );
    }
  }

  private transaction<T>(operation: () => T): T {
    if (!this.writable) {
      throw new ProductRepositoryError(
        'DATABASE_UNAVAILABLE',
        '产品库当前为只读，请恢复应用数据目录写入权限后重试',
      );
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof ProductRepositoryError || error instanceof ProductValidationError) {
        throw error;
      }
      throw new ProductRepositoryError('DATABASE_UNAVAILABLE', '产品库写入失败，请重试');
    }
  }
}
