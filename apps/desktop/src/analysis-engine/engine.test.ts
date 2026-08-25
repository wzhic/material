import { describe, expect, it, vi } from 'vitest';

import { AnalysisEngineError } from './errors';
import { parseModelAnalysisOutput } from './model-output';
import { buildAnalysisModelRequest, loadBuiltinAnalysisPrompt } from './prompt';
import { AnalysisEngine } from './runner';
import type {
  AnalysisRunInput,
  ModelCompletionPort,
} from './types';
import { createBuiltinRuleRegistry } from '../analysis-rules';
import type { AnalysisRulePackage } from '../analysis-rules';
import type { MediaEvidenceOutput } from '../media-tools';
import type {
  ModelInvocationAudit,
  ModelInvocationResult,
} from '../model/types';

const EVIDENCE_ID = 'evidence-1';
const OCR_EVIDENCE_ID = 'evidence-ocr';

const media: MediaEvidenceOutput = {
  evidence: [{
    confidence: 0.95,
    evidenceId: EVIDENCE_ID,
    evidenceType: 'visual',
    locator: { endMs: 1_000, kind: 'video_time', startMs: 0 },
    mediaKind: 'video',
    schemaVersion: 1,
    source: { capabilityId: 'media.frame.extract', kind: 'tool', version: '1.0.0' },
    text: '模特展示连衣裙整体版型，画面出现立即下单字幕',
  }],
  limitations: ['当前没有可靠的音频事件证据'],
  material: {
    fingerprintAlgorithm: 'sha256-full-v1',
    fingerprintSha256: 'b'.repeat(64),
    kind: 'video',
    size: 456,
  },
  provenance: [
    { capabilityId: 'media.frame.extract', runtimeVersion: '7.1.0', schemaVersion: 1 },
    { capabilityId: 'media.evidence.normalize', runtimeVersion: '1.0.0', schemaVersion: 1 },
  ],
  schemaVersion: 1,
  timeline: [{ endMs: 1_000, evidenceId: EVIDENCE_ID, startMs: 0, track: 'shot' }],
};

const input: AnalysisRunInput = {
  conversionContext: '本次素材用于日常商品转化',
  industry: 'apparel',
  media,
  mediaKind: 'video',
  model: {
    configurationDisplayName: '主模型',
    configurationId: 'config-1',
    modelId: 'deepseek-chat',
  },
};

const audit = (status: ModelInvocationAudit['status'] = 'succeeded'):
ModelInvocationAudit => ({
  adapterVersion: '1.0.0',
  configurationId: 'config-1',
  configurationVersion: 3,
  durationMs: 20,
  errorCode: status === 'succeeded' ? null : 'RATE_LIMITED',
  finishedAt: '2026-08-25T02:00:00.020Z',
  modelId: 'deepseek-chat',
  providerId: 'deepseek',
  startedAt: '2026-08-25T02:00:00.000Z',
  status,
});

const validModelObject = (rule: AnalysisRulePackage): Record<string, unknown> => ({
  cta: [{ evidenceIds: [EVIDENCE_ID], text: '画面明确出现立即下单引导' }],
  diagnoses: [{
    evidenceIds: [EVIDENCE_ID],
    impact: '用户难以快速理解面料信息',
    problem: '当前证据没有展示面料细节',
    relatedDimensionIds: ['selling_point_credibility'],
    severity: 'medium',
  }],
  dimensionAssessments: rule.scoring.dimensions.map((dimension) => ({
    dimensionId: dimension.id,
    evidenceIds: [EVIDENCE_ID],
    score: 80,
    status: 'scored',
  })),
  dynamicTags: [{ evidenceIds: [EVIDENCE_ID], facet: 'style', label: '通勤连衣裙' }],
  emotion: [{
    evidenceIds: [EVIDENCE_ID],
    intensity: 0.4,
    text: '平稳展示商品',
    timeMs: 500,
  }],
  fixedTags: [{ evidenceIds: [EVIDENCE_ID], tagId: 'apparel.product_showcase' }],
  goalScene: 'purchase_conversion',
  limitations: ['仅依据当前结构化证据分析'],
  productOrGameplay: [{ evidenceIds: [EVIDENCE_ID], text: '展示连衣裙上身版型' }],
  recommendations: [{
    action: '增加面料近景与对应说明',
    diagnosisIndexes: [0],
    priority: 'test',
    rationale: '补齐当前缺失的可信卖点证据',
  }],
  schemaVersion: 1,
  scriptStructure: [{ evidenceIds: [EVIDENCE_ID], text: '商品展示后直接进入 CTA' }],
  sellingPoints: [{ evidenceIds: [EVIDENCE_ID], text: '整体版型清晰' }],
  shotBreakdown: [{ evidenceIds: [EVIDENCE_ID], text: '0 到 1 秒为全身展示' }],
  subtitleContent: [{ evidenceIds: [EVIDENCE_ID], text: '出现立即下单字幕' }],
  summary: '商品与 CTA 明确，但卖点证据仍需加强。',
  title: '服饰视频素材分析',
  visualContent: [{ evidenceIds: [EVIDENCE_ID], text: '模特展示连衣裙' }],
  voiceAndSound: [],
});

const validModelObjectFor = (
  rule: AnalysisRulePackage,
  industry: 'apparel' | 'game',
  mediaKind: 'image' | 'video',
): Record<string, unknown> => {
  const value = validModelObject(rule);
  value.goalScene = industry === 'apparel' ? 'purchase_conversion' : 'unclear';
  value.fixedTags = [{
    evidenceIds: [EVIDENCE_ID],
    tagId: rule.tags.fixedTags[0].id,
  }];
  value.diagnoses = [{
    evidenceIds: [EVIDENCE_ID],
    impact: '影响素材信息理解',
    problem: '当前证据仍有限',
    relatedDimensionIds: [rule.scoring.dimensions[0].id],
    severity: 'medium',
  }];
  value.dimensionAssessments = rule.scoring.dimensions.map((dimension) => ({
    dimensionId: dimension.id,
    evidenceIds: [EVIDENCE_ID, OCR_EVIDENCE_ID],
    score: 80,
    status: 'scored',
  }));
  if (mediaKind === 'image') {
    value.emotion = [{
      evidenceIds: [EVIDENCE_ID],
      intensity: 0.4,
      text: '画面情绪表达平稳',
      timeMs: null,
    }];
    value.voiceAndSound = [];
  }
  return value;
};

const successResult = (content: string): ModelInvocationResult => ({
  audit: audit(),
  completion: {
    content,
    finishReason: 'stop',
    modelId: 'deepseek-chat',
    providerId: 'deepseek',
    systemFingerprint: 'test',
    usage: {
      completionTokens: 200,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 300,
      promptTokens: 300,
      totalTokens: 500,
    },
  },
  ok: true,
});

describe('model analysis output validation', () => {
  const rule = createBuiltinRuleRegistry().resolve('apparel', 'video');
  const packetEvidence = {
    confidence: 0.95,
    evidenceId: EVIDENCE_ID,
    evidenceType: 'visual',
    locator: { endMs: 1_000, kind: 'video_time' as const, startMs: 0 },
    source: { capabilityId: 'media.frame.extract', kind: 'tool' as const, version: '1.0.0' },
    text: '模特展示连衣裙',
  };
  const context = {
    evidence: new Map([[EVIDENCE_ID, packetEvidence]]),
    evidenceIds: new Set([EVIDENCE_ID]),
    industry: 'apparel' as const,
    maximumTimeMs: 1_000,
    mediaKind: 'video' as const,
    rule,
  };

  it('accepts the exact evidence-bound contract', () => {
    const result = parseModelAnalysisOutput(JSON.stringify(validModelObject(rule)), context);

    expect(result.dimensionAssessments).toHaveLength(rule.scoring.dimensions.length);
    expect(result.fixedTags[0].tagId).toBe('apparel.product_showcase');
  });

  it.each([
    ['apparel', 'video'],
    ['apparel', 'image'],
    ['game', 'video'],
    ['game', 'image'],
  ] as const)('accepts the %s/%s rule and media boundary', (industry, mediaKind) => {
    const currentRule = createBuiltinRuleRegistry().resolve(industry, mediaKind);
    const packetEvidenceForMedia = {
      ...packetEvidence,
      locator: mediaKind === 'video'
        ? packetEvidence.locator
        : { height: 1, kind: 'image_region' as const, width: 1, x: 0, y: 0 },
    };
    const ocrEvidenceForMedia = {
      ...packetEvidenceForMedia,
      evidenceId: OCR_EVIDENCE_ID,
      evidenceType: 'text.ocr',
      text: '进入游戏或立即下单',
    };
    const result = parseModelAnalysisOutput(
      JSON.stringify(validModelObjectFor(currentRule, industry, mediaKind)),
      {
        evidence: new Map([
          [EVIDENCE_ID, packetEvidenceForMedia],
          [OCR_EVIDENCE_ID, ocrEvidenceForMedia],
        ]),
        evidenceIds: new Set([EVIDENCE_ID, OCR_EVIDENCE_ID]),
        industry,
        maximumTimeMs: mediaKind === 'video' ? 1_000 : 0,
        mediaKind,
        rule: currentRule,
      },
    );

    expect(result.goalScene).toBe(industry === 'apparel' ? 'purchase_conversion' : 'unclear');
  });

  it.each([
    ['markdown', `\`\`\`json\n${JSON.stringify(validModelObject(rule))}\n\`\`\``],
    ['unknown root field', JSON.stringify({ ...validModelObject(rule), reasoning: 'hidden' })],
    ['unknown evidence', JSON.stringify({
      ...validModelObject(rule),
      cta: [{ evidenceIds: ['not-sent'], text: '无来源结论' }],
    })],
    ['wrong goal', JSON.stringify({ ...validModelObject(rule), goalScene: 'acquisition' })],
    ['unknown fixed tag', JSON.stringify({
      ...validModelObject(rule),
      fixedTags: [{ evidenceIds: [EVIDENCE_ID], tagId: 'apparel.unknown' }],
    })],
  ])('rejects %s', (_label, content) => {
    expect(() => parseModelAnalysisOutput(content, context)).toThrowError(AnalysisEngineError);
  });

  it('rejects sound and time claims for image analysis', () => {
    const imageRule = createBuiltinRuleRegistry().resolve('apparel', 'image');
    const value = validModelObject(imageRule);
    value.voiceAndSound = [{ evidenceIds: [EVIDENCE_ID], text: '声音结论' }];
    value.emotion = [{
      evidenceIds: [EVIDENCE_ID], intensity: 0.2, text: '情绪', timeMs: 20,
    }];

    expect(() => parseModelAnalysisOutput(JSON.stringify(value), {
      ...context,
      mediaKind: 'image',
      maximumTimeMs: 0,
      rule: imageRule,
    })).toThrowError(/图片/);
  });

  it('rejects a score backed only by incompatible evidence types', () => {
    const value = validModelObject(rule);
    value.dimensionAssessments = rule.scoring.dimensions.map((dimension) => ({
      dimensionId: dimension.id,
      evidenceIds: [EVIDENCE_ID],
      score: 80,
      status: 'scored',
    }));
    expect(() => parseModelAnalysisOutput(JSON.stringify(value), {
      ...context,
      evidence: new Map([[EVIDENCE_ID, {
        ...packetEvidence,
        evidenceType: 'metadata.unknown',
        locator: { height: 1, kind: 'image_region', width: 1, x: 0, y: 0 },
      }]]),
    })).toThrowError(/兼容类型/);
  });
});

describe('analysis engine', () => {
  const rule = createBuiltinRuleRegistry().resolve('apparel', 'video');

  it('calls only the selected model once and returns an unpersisted confirmation draft', async () => {
    const complete = vi.fn<ModelCompletionPort['complete']>();
    complete.mockResolvedValue(successResult(JSON.stringify(validModelObject(rule))));
    const model: ModelCompletionPort = { complete };
    const ids = ['run-1', 'draft-1'];
    const engine = new AnalysisEngine(model, {
      clock: () => new Date('2026-08-25T03:00:00.000Z'),
      idFactory: () => ids.shift() as string,
    });

    const result = await engine.run(input);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toMatchObject({
      configurationId: 'config-1',
      format: 'json',
      modelId: 'deepseek-chat',
      thinking: 'disabled',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report).toMatchObject({
      draftId: 'draft-1',
      status: 'awaiting_confirmation',
      prompt: { id: 'prompt.fusion_analysis', version: '1.0.0' },
      model: {
        configurationDisplayName: '主模型',
        configurationId: 'config-1',
        modelId: 'deepseek-chat',
      },
    });
    expect(result.report.ruleSnapshot.package.packageVersion).toBe('1.0.0');
    expect(result.report.score.total).toBe(80);
    expect(result.report.tags.map((tag) => tag.label)).toEqual([
      '商品展示',
      '通勤连衣裙',
    ]);
    expect(result.events.map((event) => event.stage)).toEqual([
      'validating_input',
      'preparing_evidence',
      'awaiting_model',
      'validating_model_output',
      'fusing_report',
      'succeeded',
    ]);
  });

  it('does not retry or switch after a model failure', async () => {
    const complete = vi.fn(async (): Promise<ModelInvocationResult> => ({
      audit: audit('failed'),
      error: { code: 'RATE_LIMITED', message: 'provider detail' },
      ok: false,
    }));
    const engine = new AnalysisEngine({ complete }, { idFactory: () => 'run-failed' });

    const result = await engine.run(input);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      error: { code: 'MODEL_FAILED', modelErrorCode: 'RATE_LIMITED' },
      modelAudit: { configurationId: 'config-1', modelId: 'deepseek-chat' },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain('provider detail');
  });

  it('rejects a successful response whose model identity changed', async () => {
    const switched = successResult(JSON.stringify(validModelObject(rule)));
    if (switched.ok) switched.completion.modelId = 'silent-switch';
    const complete = vi.fn(async () => switched);
    const engine = new AnalysisEngine({ complete }, { idFactory: () => 'run-switched' });

    const result = await engine.run(input);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ error: { code: 'MODEL_FAILED' }, ok: false });
  });

  it('cancels before model invocation', async () => {
    const complete = vi.fn(async () => successResult(JSON.stringify(validModelObject(rule))));
    const controller = new AbortController();
    controller.abort();
    const engine = new AnalysisEngine({ complete }, { idFactory: () => 'run-cancelled' });

    const result = await engine.run(input, controller.signal);

    expect(complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      error: { code: 'CANCELLED', modelErrorCode: 'CANCELLED' },
      modelAudit: null,
      ok: false,
    });
  });

  it('rejects missing evidence before model invocation', async () => {
    const complete = vi.fn(async () => successResult(JSON.stringify(validModelObject(rule))));
    const engine = new AnalysisEngine({ complete }, { idFactory: () => 'run-no-evidence' });

    const result = await engine.run({
      ...input,
      media: { ...media, evidence: [], timeline: [] },
    });

    expect(complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      error: { code: 'EVIDENCE_INVALID' },
      modelAudit: null,
      ok: false,
    });
  });

  it('normalizes a thrown abort as cancellation without retrying', async () => {
    const controller = new AbortController();
    const complete = vi.fn(async () => {
      controller.abort();
      throw new Error('provider aborted');
    });
    const engine = new AnalysisEngine({ complete }, { idFactory: () => 'run-aborted' });

    const result = await engine.run(input, controller.signal);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ error: { code: 'CANCELLED' }, ok: false });
    expect(JSON.stringify(result)).not.toContain('provider aborted');
  });

  it('rejects invalid model JSON without returning raw content or a draft', async () => {
    const raw = 'not-json-sensitive-provider-output';
    const complete = vi.fn(async () => successResult(raw));
    const engine = new AnalysisEngine({ complete }, { idFactory: () => 'run-invalid' });

    const result = await engine.run(input);

    expect(result).toMatchObject({ error: { code: 'MODEL_OUTPUT_INVALID' }, ok: false });
    expect(JSON.stringify(result)).not.toContain(raw);
    expect('report' in result).toBe(false);
  });

  it('builds a bounded prompt from evidence and rules without local paths', () => {
    const registry = createBuiltinRuleRegistry();
    const packet = {
      includedEvidenceIds: new Set([EVIDENCE_ID]),
      items: [{
        confidence: 0.95,
        evidenceId: EVIDENCE_ID,
        evidenceType: 'visual',
        locator: { endMs: 1_000, kind: 'video_time' as const, startMs: 0 },
        source: { capabilityId: 'media.frame.extract', kind: 'tool' as const, version: '1.0.0' },
        text: '商品画面',
      }],
      limitations: [],
      omittedEvidenceCount: 0,
      schemaVersion: 1 as const,
      truncatedTextCount: 0,
    };
    const request = buildAnalysisModelRequest(
      input,
      registry.snapshot('apparel', 'video'),
      packet,
      loadBuiltinAnalysisPrompt(),
    );
    const serialized = JSON.stringify(request);

    expect(serialized).toContain(EVIDENCE_ID);
    expect(serialized).toContain('scoring.apparel.video');
    expect(serialized).not.toContain('/Users/');
    expect(serialized.length).toBeLessThan(150_000);
  });
});
