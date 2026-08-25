import { describe, expect, it } from 'vitest';

import type { AnalysisRecord } from '../record/types';
import { matchesRecordedMaterial, prepareReanalysisDraft } from './reanalysis';

const record = {
  id: 'record-1',
  conversionContext: '重点看前 5 秒',
  industry: 'apparel',
  material: { fingerprintSha256: 'a'.repeat(64) },
  productSnapshot: { productId: 'product-1' },
  run: { modelConfigurationName: '主模型', modelId: 'model-a' },
} as AnalysisRecord;

describe('reanalysis draft preparation', () => {
  it('prefills the original model and active product without starting a run', () => {
    const result = prepareReanalysisDraft(record, [{
      configurationDisplayName: '主模型',
      modelId: 'model-a',
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
