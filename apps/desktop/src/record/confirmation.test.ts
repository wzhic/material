import { describe, expect, it } from 'vitest';

import type { AnalysisRuntimeResult } from '../analysis-runtime/types';
import type { MaterialSession } from '../media/types';
import { createConfirmedRecordInput } from './confirmation';

type ReportData = Extract<AnalysisRuntimeResult, { ok: true }>['data'];

const material: MaterialSession = {
  previewUrl: 'material-local://session/material-1',
  sessionId: '11111111-1111-4111-8111-111111111111',
  sourceStatus: 'available',
  summary: {
    fingerprintAlgorithm: 'sha256-full-v1',
    fingerprintSha256: 'a'.repeat(64),
    kind: 'video',
    mimeType: 'video/mp4',
    name: '素材.mp4',
    size: 2_048,
  },
};

const data = {
  engineEvents: [],
  media: { durationMs: 4_000, hasAudio: true, height: 1920, width: 1080 },
  report: {
    capabilities: [{
      capabilityId: 'media.evidence.normalize',
      runtimeVersion: '1.0.0',
      schemaVersion: 1,
    }],
    createdAt: '2026-08-25T05:00:00.000Z',
    cta: [{ evidenceIds: ['evidence-1'], text: '引导进入商品页' }],
    diagnoses: [{
      evidenceIds: ['evidence-1'],
      impact: '转化动作不够清楚',
      problem: 'CTA 出现偏晚',
      relatedDimensionIds: ['cta'],
      severity: 'medium',
    }],
    draftId: 'draft-11111111-1111-4111-8111-111111111111',
    emotion: [{
      evidenceIds: ['evidence-1'],
      intensity: 0.5,
      text: '表达强度上升',
      timeMs: 1_000,
    }],
    evidence: [{
      confidence: 0.9,
      evidenceId: 'evidence-1',
      evidenceType: 'visual',
      locator: { endMs: 2_000, kind: 'video_time', startMs: 500 },
      mediaKind: 'video',
      schemaVersion: 1,
      source: { capabilityId: 'media.frame.extract', kind: 'tool', version: '1.0.0' },
      text: '商品展示后出现行动引导',
    }],
    goalScene: 'purchase_conversion',
    industry: 'apparel',
    limitations: ['当前未保存源素材副本'],
    mediaKind: 'video',
    model: {
      adapterVersion: '1.0.0',
      configurationDisplayName: '我的模型',
      configurationId: 'config-1',
      configurationVersion: 1,
      modelId: 'deepseek-chat',
      providerId: 'deepseek',
      usage: {
        completionTokens: 1,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 1,
        promptTokens: 1,
        totalTokens: 2,
      },
    },
    productOrGameplay: [],
    productSnapshot: null,
    prompt: { id: 'analysis.v1', version: '1.0.0' },
    recommendations: [{
      action: '提前展示 CTA',
      diagnosisIndexes: [0],
      priority: 'now',
      rationale: '缩短行动路径',
    }],
    ruleSnapshot: {
      package: {
        packageId: 'analysis.apparel.video',
        packageVersion: '1.0.0',
        schemaVersion: 1,
        scoring: {
          dimensions: [],
          id: 'scoring.apparel.video',
          minimumCoverage: 0.6,
          missingEvidencePolicy: 'renormalize_scored',
          version: '1.0.0',
        },
        tags: { fixedTags: [], id: 'tags.apparel.video', version: '1.0.0' },
        template: {
          goal: 'purchase_conversion',
          id: 'template.apparel.video',
          industry: 'apparel',
          mediaKind: 'video',
          sections: [],
          version: '1.0.0',
        },
      },
      schemaVersion: 1,
    },
    runId: 'run-1',
    schemaVersion: 1,
    score: {
      coverage: 0.2,
      dimensions: [{
        contribution: null,
        dimensionId: 'cta',
        evidenceIds: [],
        label: '转化引导',
        normalizedWeight: null,
        score: null,
        status: 'insufficient_evidence',
        weight: 1,
      }],
      limitations: ['评分证据覆盖不足'],
      scoringRuleId: 'scoring.apparel.video',
      scoringRuleVersion: '1.0.0',
      status: 'insufficient_evidence',
      total: null,
    },
    scriptStructure: [],
    sellingPoints: [],
    shotBreakdown: [],
    status: 'awaiting_confirmation',
    subtitleContent: [],
    summary: '当前证据不足，保留未评分状态。',
    tags: [{
      evidenceIds: ['evidence-1'],
      facet: 'conversion',
      id: 'dynamic-cta',
      kind: 'dynamic',
      label: '行动引导',
      origin: 'model',
    }],
    timeline: [],
    title: '服饰视频素材分析',
    visualContent: [],
    voiceAndSound: [],
  },
} as ReportData;

describe('createConfirmedRecordInput', () => {
  it('creates a self-contained record snapshot without internal prompt or source path', () => {
    const input = createConfirmedRecordInput(data, material, ' 加强情绪转化 ');
    const serialized = JSON.stringify(input);

    expect(input.confirmationId).toBe(data.report.draftId);
    expect(input.material.sourceStatus).toBe('needs_relocation');
    expect(input.material.fingerprintSha256).toBe('a'.repeat(64));
    expect(input.report.score.total).toBeNull();
    expect(input.report.score.dimensions[0].status).toBe('insufficient_evidence');
    expect(input.report.diagnoses[0].suggestion).toContain('提前展示 CTA');
    expect(input.conversionContext).toBe('加强情绪转化');
    expect(serialized).not.toContain('analysis.v1');
    expect(serialized).not.toContain('material-local://');
    expect(serialized).not.toContain('sessionId');
  });

  it('keeps visible conversation and the explicit source-record relation', () => {
    const input = createConfirmedRecordInput(data, material, '加强情绪转化', {
      sourceRecordId: 'record-source-1',
      visibleConversation: [
        { role: 'user', text: '重点关注 00:03 的 CTA', timeReferenceMs: 3_000 },
        { role: 'assistant', text: '已按该关注点生成新版报告。', timeReferenceMs: 3_000 },
      ],
    });

    expect(input.sourceRecordId).toBe('record-source-1');
    expect(input.visibleConversation).toEqual([
      { role: 'user', text: '重点关注 00:03 的 CTA', timeReferenceMs: 3_000 },
      { role: 'assistant', text: '已按该关注点生成新版报告。', timeReferenceMs: 3_000 },
    ]);
  });
});
