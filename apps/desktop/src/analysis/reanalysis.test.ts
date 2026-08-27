import { describe, expect, it } from 'vitest';

import type { AnalysisRecord } from '../record/types';
import { matchesRecordedMaterial, prepareReanalysisDraft } from './reanalysis';

const record = {
  id: 'record-1',
  conversionContext: '重点看前 5 秒',
  industry: 'apparel',
  material: { fingerprintSha256: 'a'.repeat(64) },
  productSnapshot: { productId: 'product-1' },
  run: {
    modelConfigurationId: 'config-1',
    modelConfigurationName: '主模型',
    modelId: 'model-a',
    providerId: 'openai-compatible',
  },
} as AnalysisRecord;

describe('reanalysis draft preparation', () => {
  it('prefills the original model and active product without starting a run', () => {
    const result = prepareReanalysisDraft(record, [{
      configurationDisplayName: '主模型',
      configurationId: 'config-1',
      modelId: 'model-a',
      providerId: 'openai-compatible',
      source: 'api-key',
      value: 'config-1::model-a',
    }], [{ id: 'product-1', industry: 'apparel' } as never]);

    expect(result).toEqual({
      conversionContext: '重点看前 5 秒',
      industry: 'apparel',
      modelSelectionValue: 'config-1::model-a',
      productId: 'product-1',
      sourceRecordId: 'record-1',
      warnings: [],
    });
  });

  it('requires explicit replacement when the original model or product is unavailable', () => {
    const result = prepareReanalysisDraft(record, [], []);

    expect(result.modelSelectionValue).toBe('');
    expect(result.productId).toBe('');
    expect(result.warnings).toHaveLength(2);
  });

  it('uses configuration id and source instead of a colliding display name', () => {
    const codexRecord = {
      ...record,
      run: {
        ...record.run,
        modelConfigurationId: 'codex-subscription',
        modelConfigurationName: 'Codex 订阅（Beta）',
        providerId: 'codex-subscription',
      },
    } as AnalysisRecord;
    const result = prepareReanalysisDraft(codexRecord, [
      {
        configurationDisplayName: 'Codex 订阅（Beta）',
        configurationId: 'api-config',
        modelId: 'model-a',
        providerId: 'openai-compatible',
        source: 'api-key',
        value: 'api-collision',
      },
      {
        configurationDisplayName: 'Codex 订阅（Beta）',
        configurationId: 'codex-subscription',
        modelId: 'model-a',
        providerId: 'codex-subscription',
        source: 'codex-subscription',
        value: 'codex-exact',
      },
    ], []);

    expect(result.modelSelectionValue).toBe('codex-exact');
    expect(result.warnings).toEqual(['原产品已删除或不可用，本次草稿默认不绑定产品。']);
  });

  it('does not guess a model for a legacy record without source identity', () => {
    const legacyRecord = {
      ...record,
      run: {
        modelConfigurationName: '主模型',
        modelId: 'model-a',
      },
    } as AnalysisRecord;
    const result = prepareReanalysisDraft(legacyRecord, [{
      configurationDisplayName: '主模型',
      configurationId: 'config-1',
      modelId: 'model-a',
      providerId: 'openai-compatible',
      source: 'api-key',
      value: 'unsafe-guess',
    }], []);

    expect(result.modelSelectionValue).toBe('');
    expect(result.warnings[0]).toContain('缺少模型来源标识');
  });

  it('does not restore a reused configuration id from a different API provider', () => {
    const result = prepareReanalysisDraft(record, [{
      configurationDisplayName: '主模型',
      configurationId: 'config-1',
      modelId: 'model-a',
      providerId: 'deepseek',
      source: 'api-key',
      value: 'wrong-provider',
    }], []);

    expect(result.modelSelectionValue).toBe('');
    expect(result.warnings[0]).toContain('模型配置或来源');
  });

  it('accepts only a user-selected file with the recorded fingerprint', () => {
    const material = {
      summary: { fingerprintSha256: 'a'.repeat(64) },
    } as never;
    expect(matchesRecordedMaterial(record, material)).toBe(true);
    expect(matchesRecordedMaterial(record, {
      summary: { fingerprintSha256: 'b'.repeat(64) },
    } as never)).toBe(false);
  });
});
