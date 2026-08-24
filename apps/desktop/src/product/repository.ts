import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  buildProductSearchText,
  normalizeProductInput,
  normalizeSearchText,
  ProductValidationError,
} from './domain';
import {
  DuplicateCandidate,
  ProductApiErrorCode,
  ProductContextSelection,
  ProductInput,
  ProductListItem,
  ProductListQuery,
  ProductRecord,
  ProductSnapshot,
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

export class ProductRepository {
  private readonly database: DatabaseSync;
  private readonly writable: boolean;

  constructor(path: string) {
    try {
      this.database = new DatabaseSync(path, {
        enableForeignKeyConstraints: true,
        timeout: 5_000,
      });
      this.writable = true;
    } catch {
      try {
        this.database = new DatabaseSync(path, {
          enableForeignKeyConstraints: true,
          readOnly: true,
          timeout: 5_000,
        });
        this.writable = false;
      } catch {
        throw new ProductRepositoryError(
          'DATABASE_UNAVAILABLE',
          '产品库无法打开，请检查应用数据目录权限',
        );
      }
    }
    this.initialize();
  }

  close(): void {
    this.database.close();
  }

  list(query: ProductListQuery = {}): ProductListItem[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
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
    const rows = asRows<ProductRow & { version_count: number; channel_count: number }>(
      this.database
        .prepare(
          `SELECT p.*,
            (SELECT COUNT(*) FROM game_versions v WHERE v.product_id = p.id) AS version_count,
            (SELECT COUNT(*) FROM game_channels c WHERE c.product_id = p.id) AS channel_count
           FROM products p ${where}
           ORDER BY p.updated_at DESC, p.name COLLATE NOCASE ASC`,
        )
        .all(...parameters),
    );
    return rows.map((row) => {
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
  }

  get(id: string): ProductRecord {
    const row = asRow<ProductRow>(
      this.database.prepare('SELECT * FROM products WHERE id = ?').get(id),
    );
    if (!row) {
      throw new ProductRepositoryError('NOT_FOUND', '产品不存在或已删除');
    }
    return this.hydrate(row);
  }

  findDuplicates(input: ProductInput, excludeId?: string): DuplicateCandidate[] {
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
