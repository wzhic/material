import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordValidationError } from './domain';
import { RecordRepository } from './repository';
import { ConfirmedRecordInput } from './types';

const confirmedInput = (
  name = 'fashion_video_01.mp4',
  overrides: Partial<ConfirmedRecordInput> = {},
): ConfirmedRecordInput => ({
  confirmationId: `confirmation-${Buffer.from(name).toString('hex')}`,
  industry: 'apparel',
  material: {
    schemaVersion: 1,
    displayName: name,
    mediaKind: 'video',
    byteSize: 1024,
    fingerprintSha256: 'a'.repeat(64),
    durationMs: 27_000,
    width: 1080,
    height: 1920,
    sourceStatus: 'available',
  },
  productSnapshot: null,
  report: {
    schemaVersion: 1,
    title: '服饰视频素材分析',
    summary: '开场具备转化基础，但卖点证据出现偏晚。',
    scriptStructure: ['开场钩子', '商品展示', '行动引导'],
    shotSummary: ['近景开场', '全身展示'],
    visualSummary: ['竖屏真人出镜'],
    subtitleSummary: ['字幕与口播同步'],
    voiceAndSoundSummary: ['真人口播'],
    sellingPoints: ['通勤剪裁'],
    emotionSummary: ['焦虑切入后转向期待'],
    ctaSummary: ['结尾引导下单'],
    score: {
      total: 82,
      dimensions: [{ id: 'emotion', label: '情绪转化', score: 78 }],
    },
    tags: [{ label: '真人口播', source: 'fixed', evidenceIds: ['evidence-1'] }],
    diagnoses: [
      {
        problem: '利益点出现偏晚',
        suggestion: '在首次商品完整露出时同步给出利益点',
        evidenceIds: ['evidence-1'],
      },
    ],
    limitations: ['未取得投放转化数据'],
    evidence: [
      {
        id: 'evidence-1',
        label: '商品完整露出',
        summary: '首次完整展示商品',
        startMs: 5_000,
        endMs: 11_000,
        source: 'fusion',
      },
    ],
  },
  rules: {
    schemaVersion: 1,
    templateId: 'apparel-video',
    templateVersion: '1.0.0',
    scoringRuleId: 'apparel-video-score',
    scoringRuleVersion: '1.0.0',
    tagPackageVersion: '1.0.0',
  },
  run: {
    schemaVersion: 1,
    modelConfigurationName: '用户配置 A',
    modelId: 'configured-model',
    capabilityVersion: 'broker-1',
    completedAt: '2026-08-24T06:00:00.000Z',
  },
  visibleConversation: [
    { role: 'user', text: '重点判断情绪转化', timeReferenceMs: null },
  ],
  conversionContext: '判断转化基础',
  sourceRecordId: null,
  ...overrides,
});

describe('RecordRepository', () => {
  let repository: RecordRepository;

  beforeEach(() => {
    repository = new RecordRepository(':memory:');
  });

  afterEach(() => {
    repository.close();
    vi.useRealTimers();
  });

  it('atomically saves and reads a confirmed immutable snapshot', () => {
    const input = confirmedInput();
    const saved = repository.confirmAndSave(input);
    input.report.summary = '调用方之后修改的内容';

    const readBack = repository.get(saved.id);

    expect(readBack.report.summary).toContain('卖点证据');
    expect(readBack.report.score.total).toBe(82);
    expect(repository.list().items).toHaveLength(1);
  });

  it('returns the same record when one report preview is confirmed twice', () => {
    const input = confirmedInput();

    const first = repository.confirmAndSave(input);
    const second = repository.confirmAndSave(structuredClone(input));

    expect(second.id).toBe(first.id);
    expect(repository.list().total).toBe(1);
  });

  it('stores an encrypted source reference separately and projects live source status', () => {
    const encryptedPath = Buffer.from('sealed-source-reference', 'utf8').toString('base64');
    const saved = repository.confirmAndSave(
      confirmedInput('安全引用.mp4', {
        material: {
          ...confirmedInput().material,
          displayName: '安全引用.mp4',
          sourceStatus: 'needs_relocation',
        },
      }),
      encryptedPath,
    );

    expect(saved.material.sourceStatus).toBe('available');
    expect(repository.sourceReference(saved.id)).toBe(encryptedPath);
    expect(repository.updateSourceStatus(saved.id, 'mismatch').material.sourceStatus).toBe(
      'mismatch',
    );
    expect(repository.list({ sourceStatus: 'mismatch' }).items).toHaveLength(1);
  });

  it('deletes the encrypted source reference with its analysis record', () => {
    const saved = repository.confirmAndSave(
      confirmedInput('待删除.mp4'),
      Buffer.from('sealed-delete-reference', 'utf8').toString('base64'),
    );

    repository.remove(saved.id);

    expect(() => repository.sourceReference(saved.id)).toThrow('不存在或已删除');
  });

  it('rejects a malformed source reference before creating a partial record', () => {
    expect(() => repository.confirmAndSave(confirmedInput(), '/plain/local/path.mp4')).toThrow(
      '安全引用格式不正确',
    );
    expect(repository.list().total).toBe(0);
  });

  it('rejects reusing a confirmation id for different report content', () => {
    const input = confirmedInput();
    repository.confirmAndSave(input);
    const changed = structuredClone(input);
    changed.report.summary = '同一确认标识下的不同内容';

    expect(() => repository.confirmAndSave(changed)).toThrow('不同内容');
    expect(repository.list().total).toBe(1);
  });

  it('preserves insufficient evidence as unscored instead of zero', () => {
    const input = confirmedInput();
    input.report.score = {
      dimensions: [{
        id: 'emotion',
        label: '情绪转化',
        score: null,
        status: 'insufficient_evidence',
      }],
      total: null,
    };

    const saved = repository.confirmAndSave(input);

    expect(saved.report.score.total).toBeNull();
    expect(repository.list().items[0].totalScore).toBeNull();
  });

  it('rejects an invalid evidence reference without creating a record', () => {
    const input = confirmedInput();
    input.report.tags[0].evidenceIds = ['missing'];

    expect(() => repository.confirmAndSave(input)).toThrow(RecordValidationError);
    expect(repository.list().total).toBe(0);
  });

  it('queries locally by name, industry, media, source and feedback state', () => {
    const video = repository.confirmAndSave(confirmedInput('防晒视频.mp4'));
    repository.confirmAndSave(
      confirmedInput('游戏截图.png', {
        industry: 'game',
        material: {
          ...confirmedInput().material,
          displayName: '游戏截图.png',
          mediaKind: 'image',
          sourceStatus: 'needs_relocation',
        },
        rules: {
          ...confirmedInput().rules,
          templateId: 'game-image',
        },
      }),
    );
    repository.saveFeedback(video.id, {
      rating: 4,
      reason: '整体可用',
      weightDirection: '加强情绪转化',
    });

    expect(repository.list({ query: '防晒', feedbackState: 'rated' }).total).toBe(1);
    expect(
      repository.list({
        industry: 'game',
        mediaKind: 'image',
        sourceStatus: 'needs_relocation',
        feedbackState: 'unrated',
      }).items.map((item) => item.materialDisplayName),
    ).toEqual(['游戏截图.png']);
  });

  it('treats search wildcard characters as literal text', () => {
    repository.confirmAndSave(confirmedInput('素材 100%.mp4'));
    repository.confirmAndSave(confirmedInput('普通素材.mp4'));

    expect(repository.list({ query: '100%' }).total).toBe(1);
    expect(repository.list({ query: '_' }).total).toBe(0);
  });

  it('filters confirmation dates using the current local calendar day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 24, 10, 0, 0));
    repository.confirmAndSave(confirmedInput('第一天.mp4'));
    vi.setSystemTime(new Date(2026, 7, 25, 10, 0, 0));
    repository.confirmAndSave(confirmedInput('第二天.mp4'));

    expect(
      repository
        .list({ confirmedFrom: '2026-08-25', confirmedTo: '2026-08-25' })
        .items.map((item) => item.materialDisplayName),
    ).toEqual(['第二天.mp4']);
  });

  it('updates and clears feedback without changing report score or rules', () => {
    const saved = repository.confirmAndSave(confirmedInput());
    repository.saveFeedback(saved.id, {
      rating: 4,
      reason: '整体可用',
      weightDirection: '加强 CTA 承接',
    });

    const rated = repository.get(saved.id);
    expect(rated.feedback?.rating).toBe(4);
    expect(rated.report.score.total).toBe(82);
    expect(rated.rules.scoringRuleVersion).toBe('1.0.0');

    repository.clearFeedback(saved.id);
    expect(repository.get(saved.id).feedback).toBeNull();
  });

  it('keeps a subsequent record when its source is deleted', () => {
    const source = repository.confirmAndSave(confirmedInput('原始素材.mp4'));
    const subsequent = repository.confirmAndSave(
      confirmedInput('重新分析素材.mp4', { sourceRecordId: source.id }),
    );

    repository.remove(source.id);

    const readBack = repository.get(subsequent.id);
    expect(readBack.sourceRecordId).toBe(source.id);
    expect(readBack.sourceRecordAvailable).toBe(false);
    expect(repository.list().total).toBe(1);
  });

  it('rejects internal or sensitive snapshot keys', () => {
    const input = confirmedInput() as ConfirmedRecordInput & {
      internalPrompt?: string;
    };
    input.internalPrompt = 'must not persist';

    expect(() => repository.confirmAndSave(input)).toThrow('不允许持久化');
    expect(repository.list().total).toBe(0);
  });

  it('rejects malformed visible conversation before persisting a record', () => {
    const input = confirmedInput();
    input.visibleConversation = [
      { role: 'user', text: 'x'.repeat(2_001), timeReferenceMs: 2_000 },
    ];

    expect(() => repository.confirmAndSave(input)).toThrow('可见对话内容过长');
    expect(repository.list().total).toBe(0);
  });

  it('migrates a v1 database without rewriting legacy snapshots', () => {
    repository.close();
    const directory = mkdtempSync(path.join(tmpdir(), 'material-record-migration-'));
    const databasePath = path.join(directory, 'records.sqlite3');
    const database = new DatabaseSync(databasePath);
    const legacy = structuredClone(confirmedInput('旧版记录.mp4'));
    delete (legacy as Partial<ConfirmedRecordInput>).confirmationId;
    database.exec(`
      CREATE TABLE analysis_records (
        id TEXT PRIMARY KEY,
        industry TEXT NOT NULL,
        media_kind TEXT NOT NULL,
        material_display_name TEXT NOT NULL,
        product_display_name TEXT,
        total_score REAL NOT NULL,
        source_status TEXT NOT NULL,
        source_record_id TEXT,
        confirmed_at TEXT NOT NULL,
        search_text TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE analysis_record_feedback (
        record_id TEXT PRIMARY KEY REFERENCES analysis_records(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL,
        reason TEXT NOT NULL,
        weight_direction TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    database.prepare(
      `INSERT INTO analysis_records (
        id, industry, media_kind, material_display_name, product_display_name,
        total_score, source_status, source_record_id, confirmed_at, search_text,
        record_json
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      'legacy-record',
      legacy.industry,
      legacy.material.mediaKind,
      legacy.material.displayName,
      legacy.report.score.total,
      legacy.material.sourceStatus,
      '2026-08-24T06:00:00.000Z',
      '旧版记录.mp4',
      JSON.stringify(legacy),
    );
    database.close();

    const migrated = new RecordRepository(databasePath);
    expect(migrated.get('legacy-record').confirmationId).toBeNull();
    const next = confirmedInput('证据不足.png', {
      confirmationId: 'confirmation-after-migration',
    });
    next.report.score.total = null;
    next.report.score.dimensions = [];
    expect(migrated.confirmAndSave(next).report.score.total).toBeNull();
    migrated.close();

    const verified = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      (verified.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(3);
    expect(
      (verified.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'analysis_record_sources'",
      ).get() as { count: number }).count,
    ).toBe(1);
    verified.close();
    rmSync(directory, { force: true, recursive: true });
    repository = new RecordRepository(':memory:');
  });
});
