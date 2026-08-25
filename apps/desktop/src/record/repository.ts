import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  normalizeFeedback,
  normalizeRecordSearch,
  RecordValidationError,
  validateConfirmedRecord,
} from './domain';
import {
  AnalysisRecord,
  AnalysisRecordListItem,
  AnalysisRecordPage,
  AnalysisRecordQuery,
  ConfirmedRecordInput,
  RecordApiErrorCode,
  RecordFeedback,
  RecordFeedbackInput,
} from './types';

interface VersionRow {
  user_version: number;
}

interface QuickCheckRow {
  quick_check: string;
}

interface CountRow {
  count: number;
}

interface RecordRow {
  id: string;
  industry: 'apparel' | 'game';
  media_kind: 'image' | 'video';
  material_display_name: string;
  product_display_name: string | null;
  total_score: number | null;
  source_status: 'available' | 'mismatch' | 'needs_relocation';
  source_record_id: string | null;
  confirmed_at: string;
  record_json: string;
}

interface FeedbackRow {
  rating: number;
  reason: string;
  weight_direction: string;
  updated_at: string;
}

interface ListRow extends RecordRow {
  feedback_rating: number | null;
  feedback_updated_at: string | null;
}

interface SubsequentRow {
  id: string;
  material_display_name: string;
  confirmed_at: string;
  total_score: number | null;
}

interface ConfirmationRow {
  id: string;
  record_json: string;
}

const asRow = <T>(value: unknown): T | undefined => value as T | undefined;
const asRows = <T>(value: unknown[]): T[] => value as T[];

const escapeLike = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

export class RecordRepositoryError extends Error {
  readonly code: RecordApiErrorCode;

  constructor(code: RecordApiErrorCode, message: string) {
    super(message);
    this.name = 'RecordRepositoryError';
    this.code = code;
  }
}

export class RecordRepository {
  private readonly database: DatabaseSync;
  private readonly writable: boolean;

  constructor(databasePath: string) {
    const opened = this.openDatabase(databasePath);
    this.database = opened.database;
    this.writable = opened.writable;
    try {
      this.initialize();
      if (databasePath !== ':memory:' && this.writable) {
        chmodSync(databasePath, 0o600);
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  list(query: AnalysisRecordQuery = {}): AnalysisRecordPage {
    const conditions: string[] = [];
    const parameters: Array<number | string> = [];
    const normalizedQuery = normalizeRecordSearch(query.query ?? '');
    if (normalizedQuery) {
      conditions.push("r.search_text LIKE ? ESCAPE '\\'");
      parameters.push(`%${escapeLike(normalizedQuery)}%`);
    }
    if (query.industry) {
      conditions.push('r.industry = ?');
      parameters.push(query.industry);
    }
    if (query.mediaKind) {
      conditions.push('r.media_kind = ?');
      parameters.push(query.mediaKind);
    }
    if (query.sourceStatus) {
      conditions.push('r.source_status = ?');
      parameters.push(query.sourceStatus);
    }
    if (query.feedbackState === 'rated') {
      conditions.push('f.record_id IS NOT NULL');
    } else if (query.feedbackState === 'unrated') {
      conditions.push('f.record_id IS NULL');
    }
    if (query.confirmedFrom) {
      conditions.push('r.confirmed_at >= ?');
      parameters.push(this.normalizeDateBoundary(query.confirmedFrom, false));
    }
    if (query.confirmedTo) {
      conditions.push('r.confirmed_at <= ?');
      parameters.push(this.normalizeDateBoundary(query.confirmedTo, true));
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const order = query.sort === 'confirmed_asc' ? 'ASC' : 'DESC';
    const total =
      asRow<CountRow>(
        this.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM analysis_records r
             LEFT JOIN analysis_record_feedback f ON f.record_id = r.id
             ${where}`,
          )
          .get(...parameters),
      )?.count ?? 0;
    const rows = asRows<ListRow>(
      this.database
        .prepare(
          `SELECT r.*, f.rating AS feedback_rating, f.updated_at AS feedback_updated_at
           FROM analysis_records r
           LEFT JOIN analysis_record_feedback f ON f.record_id = r.id
           ${where}
           ORDER BY r.confirmed_at ${order}, r.id ${order}
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters, limit, offset),
    );
    return {
      items: rows.map((row) => this.toListItem(row)),
      total,
      limit,
      offset,
    };
  }

  get(id: string): AnalysisRecord {
    const row = asRow<RecordRow>(
      this.database.prepare('SELECT * FROM analysis_records WHERE id = ?').get(id),
    );
    if (!row) {
      throw new RecordRepositoryError('NOT_FOUND', '分析记录不存在或已删除');
    }
    const feedbackRow = asRow<FeedbackRow>(
      this.database
        .prepare(
          `SELECT rating, reason, weight_direction, updated_at
           FROM analysis_record_feedback WHERE record_id = ?`,
        )
        .get(id),
    );
    const subsequentRows = asRows<SubsequentRow>(
      this.database
        .prepare(
          `SELECT id, material_display_name, confirmed_at, total_score
           FROM analysis_records WHERE source_record_id = ?
           ORDER BY confirmed_at DESC, id DESC`,
        )
        .all(id),
    );
    const input = this.parseRecord(row.record_json);
    const sourceRecordAvailable = row.source_record_id
      ? Boolean(
          asRow<CountRow>(
            this.database
              .prepare('SELECT COUNT(*) AS count FROM analysis_records WHERE id = ?')
              .get(row.source_record_id),
          )?.count,
        )
      : null;
    return {
      ...input,
      id: row.id,
      confirmedAt: row.confirmed_at,
      sourceRecordId: row.source_record_id,
      sourceRecordAvailable,
      feedback: feedbackRow
        ? {
            rating: feedbackRow.rating,
            reason: feedbackRow.reason,
            weightDirection: feedbackRow.weight_direction,
            updatedAt: feedbackRow.updated_at,
          }
        : null,
      subsequentRecords: subsequentRows.map((subsequent) => ({
        id: subsequent.id,
        materialDisplayName: subsequent.material_display_name,
        confirmedAt: subsequent.confirmed_at,
        totalScore: subsequent.total_score,
      })),
    };
  }

  confirmAndSave(input: ConfirmedRecordInput): AnalysisRecord {
    validateConfirmedRecord(input);
    if (!input.confirmationId) {
      throw new RecordRepositoryError('INVALID_INPUT', '报告确认标识不能为空');
    }
    const recordJson = JSON.stringify(input);
    return this.transaction(() => {
      const existing = asRow<ConfirmationRow>(
        this.database
          .prepare('SELECT id, record_json FROM analysis_records WHERE confirmation_id = ?')
          .get(input.confirmationId),
      );
      if (existing) {
        if (existing.record_json !== recordJson) {
          throw new RecordRepositoryError('CONFLICT', '该报告预览已用不同内容确认');
        }
        return this.get(existing.id);
      }
      if (input.sourceRecordId) {
        const source = asRow<CountRow>(
          this.database
            .prepare('SELECT COUNT(*) AS count FROM analysis_records WHERE id = ?')
            .get(input.sourceRecordId),
        );
        if (!source?.count) {
          throw new RecordRepositoryError('INVALID_INPUT', '来源分析记录不存在');
        }
      }
      const id = randomUUID();
      const confirmedAt = new Date().toISOString();
      const productDisplayName = input.productSnapshot?.name ?? null;
      const searchText = normalizeRecordSearch(
        `${input.material.displayName} ${productDisplayName ?? ''}`,
      );
      this.database
        .prepare(
          `INSERT INTO analysis_records (
             id, industry, media_kind, material_display_name, product_display_name,
             total_score, source_status, source_record_id, confirmed_at,
             search_text, record_json, confirmation_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.industry,
          input.material.mediaKind,
          input.material.displayName.trim(),
          productDisplayName,
          input.report.score.total,
          input.material.sourceStatus,
          input.sourceRecordId,
          confirmedAt,
          searchText,
          recordJson,
          input.confirmationId,
        );
      return this.get(id);
    });
  }

  saveFeedback(id: string, input: RecordFeedbackInput): RecordFeedback {
    const normalized = normalizeFeedback(input);
    const updatedAt = new Date().toISOString();
    this.transaction(() => {
      this.requireRecord(id);
      this.database
        .prepare(
          `INSERT INTO analysis_record_feedback
           (record_id, rating, reason, weight_direction, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(record_id) DO UPDATE SET
             rating = excluded.rating,
             reason = excluded.reason,
             weight_direction = excluded.weight_direction,
             updated_at = excluded.updated_at`,
        )
        .run(id, normalized.rating, normalized.reason, normalized.weightDirection, updatedAt);
    });
    return { ...normalized, updatedAt };
  }

  clearFeedback(id: string): void {
    this.transaction(() => {
      this.requireRecord(id);
      this.database.prepare('DELETE FROM analysis_record_feedback WHERE record_id = ?').run(id);
    });
  }

  remove(id: string): void {
    this.transaction(() => {
      this.requireRecord(id);
      const result = this.database.prepare('DELETE FROM analysis_records WHERE id = ?').run(id);
      if (Number(result.changes) !== 1) {
        throw new RecordRepositoryError('CONFLICT', '分析记录删除失败，请重试');
      }
    });
  }

  private openDatabase(databasePath: string): { database: DatabaseSync; writable: boolean } {
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
        throw new RecordRepositoryError(
          'DATABASE_UNAVAILABLE',
          '分析记录无法打开，请检查应用数据目录权限',
        );
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
        throw new RecordRepositoryError(
          'DATABASE_UNAVAILABLE',
          '分析记录库尚未初始化且当前目录只读',
        );
      }
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE analysis_records (
          id TEXT PRIMARY KEY,
          industry TEXT NOT NULL CHECK (industry IN ('apparel', 'game')),
          media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
          material_display_name TEXT NOT NULL,
          product_display_name TEXT,
          total_score REAL CHECK (total_score IS NULL OR (total_score >= 0 AND total_score <= 100)),
          source_status TEXT NOT NULL CHECK (source_status IN ('available', 'mismatch', 'needs_relocation')),
          source_record_id TEXT,
          confirmed_at TEXT NOT NULL,
          search_text TEXT NOT NULL,
          record_json TEXT NOT NULL,
          confirmation_id TEXT UNIQUE
        );
        CREATE INDEX analysis_records_confirmed_idx ON analysis_records(confirmed_at DESC);
        CREATE INDEX analysis_records_industry_media_idx ON analysis_records(industry, media_kind);
        CREATE INDEX analysis_records_source_idx ON analysis_records(source_record_id);
        CREATE TABLE analysis_record_feedback (
          record_id TEXT PRIMARY KEY REFERENCES analysis_records(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
          reason TEXT NOT NULL,
          weight_direction TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 2;
        COMMIT;
      `);
    } else if (version === 1 && this.writable) {
      this.migrateV1ToV2();
    } else if (version !== 1 && version !== 2) {
      throw new RecordRepositoryError(
        'DATABASE_UNAVAILABLE',
        '分析记录版本高于当前客户端，请升级客户端后重试',
      );
    }
    const integrityRows = asRows<QuickCheckRow>(
      this.database.prepare('PRAGMA quick_check(1)').all(),
    );
    if (!integrityRows.length || integrityRows.some((row) => row.quick_check !== 'ok')) {
      throw new RecordRepositoryError(
        'DATABASE_UNAVAILABLE',
        '分析记录完整性检查失败，已停止写入',
      );
    }
  }

  private migrateV1ToV2(): void {
    this.database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
    try {
      this.database.exec(`
        CREATE TABLE analysis_records_v2 (
          id TEXT PRIMARY KEY,
          industry TEXT NOT NULL CHECK (industry IN ('apparel', 'game')),
          media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
          material_display_name TEXT NOT NULL,
          product_display_name TEXT,
          total_score REAL CHECK (total_score IS NULL OR (total_score >= 0 AND total_score <= 100)),
          source_status TEXT NOT NULL CHECK (source_status IN ('available', 'mismatch', 'needs_relocation')),
          source_record_id TEXT,
          confirmed_at TEXT NOT NULL,
          search_text TEXT NOT NULL,
          record_json TEXT NOT NULL,
          confirmation_id TEXT UNIQUE
        );
        INSERT INTO analysis_records_v2 (
          id, industry, media_kind, material_display_name, product_display_name,
          total_score, source_status, source_record_id, confirmed_at, search_text,
          record_json, confirmation_id
        ) SELECT
          id, industry, media_kind, material_display_name, product_display_name,
          total_score, source_status, source_record_id, confirmed_at, search_text,
          record_json, NULL
        FROM analysis_records;
        CREATE TABLE analysis_record_feedback_v2 (
          record_id TEXT PRIMARY KEY REFERENCES analysis_records_v2(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
          reason TEXT NOT NULL,
          weight_direction TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO analysis_record_feedback_v2
          (record_id, rating, reason, weight_direction, updated_at)
        SELECT record_id, rating, reason, weight_direction, updated_at
        FROM analysis_record_feedback;
        DROP TABLE analysis_record_feedback;
        DROP TABLE analysis_records;
        ALTER TABLE analysis_records_v2 RENAME TO analysis_records;
        ALTER TABLE analysis_record_feedback_v2 RENAME TO analysis_record_feedback;
        CREATE INDEX analysis_records_confirmed_idx ON analysis_records(confirmed_at DESC);
        CREATE INDEX analysis_records_industry_media_idx ON analysis_records(industry, media_kind);
        CREATE INDEX analysis_records_source_idx ON analysis_records(source_record_id);
        PRAGMA user_version = 2;
      `);
      const foreignKeyIssues = this.database.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeyIssues.length) {
        throw new RecordRepositoryError(
          'DATABASE_UNAVAILABLE',
          '分析记录升级后关系检查失败，原数据保持不变',
        );
      }
      this.database.exec('COMMIT;');
    } catch {
      this.database.exec('ROLLBACK;');
      throw new RecordRepositoryError(
        'DATABASE_UNAVAILABLE',
        '分析记录升级失败，原数据保持不变',
      );
    } finally {
      this.database.exec('PRAGMA foreign_keys = ON;');
    }
  }

  private requireRecord(id: string): void {
    const count = asRow<CountRow>(
      this.database.prepare('SELECT COUNT(*) AS count FROM analysis_records WHERE id = ?').get(id),
    )?.count;
    if (!count) {
      throw new RecordRepositoryError('NOT_FOUND', '分析记录不存在或已删除');
    }
  }

  private parseRecord(value: string): ConfirmedRecordInput {
    try {
      const stored = JSON.parse(value) as Partial<ConfirmedRecordInput>;
      const parsed = {
        ...stored,
        confirmationId: stored.confirmationId ?? null,
      } as ConfirmedRecordInput;
      validateConfirmedRecord(parsed);
      return parsed;
    } catch (error) {
      if (error instanceof RecordValidationError) {
        throw new RecordRepositoryError('DATABASE_UNAVAILABLE', '分析记录数据无法读取');
      }
      throw new RecordRepositoryError('DATABASE_UNAVAILABLE', '分析记录数据无法读取');
    }
  }

  private toListItem(row: ListRow): AnalysisRecordListItem {
    return {
      id: row.id,
      materialDisplayName: row.material_display_name,
      industry: row.industry,
      mediaKind: row.media_kind,
      productDisplayName: row.product_display_name,
      totalScore: row.total_score,
      feedback:
        row.feedback_rating !== null && row.feedback_updated_at
          ? { rating: row.feedback_rating, updatedAt: row.feedback_updated_at }
          : null,
      sourceStatus: row.source_status,
      sourceRecordId: row.source_record_id,
      confirmedAt: row.confirmed_at,
    };
  }

  private normalizeDateBoundary(value: string, endOfDay: boolean): string {
    const normalized = value.trim();
    let parsed: Date;
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
    if (dateOnly) {
      const year = Number(dateOnly[1]);
      const monthIndex = Number(dateOnly[2]) - 1;
      const day = Number(dateOnly[3]);
      parsed = new Date(
        year,
        monthIndex,
        day,
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0,
      );
      if (
        parsed.getFullYear() !== year ||
        parsed.getMonth() !== monthIndex ||
        parsed.getDate() !== day
      ) {
        throw new RecordRepositoryError('INVALID_INPUT', '确认日期格式不正确');
      }
    } else {
      parsed = new Date(normalized);
    }
    if (Number.isNaN(parsed.getTime())) {
      throw new RecordRepositoryError('INVALID_INPUT', '确认日期格式不正确');
    }
    return parsed.toISOString();
  }

  private transaction<T>(operation: () => T): T {
    if (!this.writable) {
      throw new RecordRepositoryError(
        'DATABASE_UNAVAILABLE',
        '分析记录当前为只读，请恢复应用数据目录写入权限后重试',
      );
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof RecordRepositoryError || error instanceof RecordValidationError) {
        throw error;
      }
      throw new RecordRepositoryError('DATABASE_UNAVAILABLE', '分析记录写入失败，请重试');
    }
  }
}
