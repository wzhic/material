import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordValidationError } from './domain';
import { RecordRepository } from './repository';
import { ConfirmedRecordInput } from './types';

const confirmedInput = (
  name = 'fashion_video_01.mp4',
  overrides: Partial<ConfirmedRecordInput> = {},
): ConfirmedRecordInput => ({
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
});
