import { describe, expect, it } from 'vitest';

import type { AnalysisRecord } from './types';
import { buildRecordPdfHtml, createPdfFilename } from './pdf-document';

const record = (): AnalysisRecord => ({
  confirmationId: 'confirmation-1',
  confirmedAt: '2026-08-25T08:00:00.000Z',
  conversionContext: '促进下单',
  feedback: {
    rating: 4,
    reason: 'private-feedback-marker',
    updatedAt: '2026-08-25T09:00:00.000Z',
    weightDirection: 'private-weight-marker',
  },
  id: '11111111-1111-4111-8111-111111111111',
  industry: 'apparel',
  material: {
    byteSize: 1_024,
    displayName: '夏装<script>.mp4',
    durationMs: 12_000,
    fingerprintSha256: 'a'.repeat(64),
    height: 1920,
    mediaKind: 'video',
    schemaVersion: 1,
    sourceStatus: 'needs_relocation',
    width: 1080,
  },
  productSnapshot: null,
  report: {
    ctaSummary: ['结尾引导下单'],
    diagnoses: [{
      evidenceIds: ['evidence-1'],
      problem: 'CTA <出现偏晚>',
      suggestion: '在 00:03 前展示行动提示',
    }],
    emotionSummary: ['从好奇转为期待'],
    evidence: [{
      endMs: 4_000,
      id: 'evidence-1',
      label: '商品首次完整露出',
      source: 'fusion',
      startMs: 2_000,
      summary: '画面与口播同时表达卖点',
    }],
    limitations: ['未取得投放转化数据'],
    schemaVersion: 1,
    score: {
      dimensions: [{ id: 'cta', label: '转化引导', score: 78 }],
      total: 82,
    },
    scriptStructure: ['开场钩子', '商品展示'],
    sellingPoints: ['通勤剪裁'],
    shotSummary: ['近景开场'],
    subtitleSummary: ['字幕与口播同步'],
    summary: '卖点清楚，但 CTA 出现偏晚。',
    tags: [{ evidenceIds: ['evidence-1'], label: '真人口播', source: 'fixed' }],
    title: '服饰视频素材分析',
    visualSummary: ['竖屏真人出镜'],
    voiceAndSoundSummary: ['真人口播'],
  },
  rules: {
    schemaVersion: 1,
    scoringRuleId: 'scoring.apparel.video',
    scoringRuleVersion: '1.0.0',
    tagPackageVersion: '1.0.0',
    templateId: 'template.apparel.video',
    templateVersion: '1.0.0',
  },
  run: {
    adapterVersion: 'codex-app-server@0.149.1',
    capabilityVersion: 'broker-1',
    completedAt: '2026-08-25T07:59:00.000Z',
    modelConfigurationId: 'codex-subscription',
    modelConfigurationName: 'secret-config-marker',
    modelConfigurationVersion: 1,
    modelId: 'secret-model-marker',
    providerId: 'codex-subscription',
    providerReasoningEffort: 'high',
    providerRequestedModelId: 'requested-model-slug',
    providerReturnedModelId: 'returned-model-marker',
    schemaVersion: 1,
    usage: {
      available: true,
      completionTokens: 40,
      promptCacheHitTokens: 10,
      promptCacheMissTokens: 90,
      promptTokens: 100,
      totalTokens: 140,
    },
    usageAvailable: true,
  },
  sourceRecordAvailable: null,
  sourceRecordId: null,
  subsequentRecords: [],
  visibleConversation: [{
    role: 'user',
    text: '/Users/example/private-material.mp4 conversation-marker',
    timeReferenceMs: null,
  }],
});

describe('PDF report document', () => {
  it('renders the immutable report and evidence while excluding conversation and feedback', () => {
    const html = buildRecordPdfHtml(record());

    expect(html).toContain('服饰视频素材分析');
    expect(html).toContain('00:02–00:04');
    expect(html).toContain('评分规则 1.0.0');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('/Users/example');
    expect(html).not.toContain('conversation-marker');
    expect(html).not.toContain('private-feedback-marker');
    expect(html).toContain('secret-config-marker');
    expect(html).toContain('secret-model-marker');
    expect(html).toContain('requested-model-slug');
    expect(html).toContain('returned-model-marker');
    expect(html).toContain('与请求不同');
    expect(html).toContain('推理强度');
    expect(html).toContain('high');
    expect(html).toContain('codex-app-server@0.149.1');
    expect(html).toContain('输入 100 · 缓存命中 10 · 输出 40 · 总计 140');
  });

  it('labels missing legacy token usage as unavailable instead of zero', () => {
    const legacy = record();
    delete legacy.run.usage;
    delete legacy.run.usageAvailable;

    const html = buildRecordPdfHtml(legacy);

    expect(html).toContain('用量暂不可用');
    expect(html).not.toContain('输入 0');
  });

  it('creates a cross-platform safe and bounded default filename', () => {
    expect(createPdfFilename(' 夏装:首发<>.mp4 ')).toBe('夏装_首发__-分析报告.pdf');
    expect(createPdfFilename('...')).toBe('素材-分析报告.pdf');
    expect(createPdfFilename(`${'长'.repeat(120)}.png`).length).toBeLessThanOrEqual(89);
  });
});
