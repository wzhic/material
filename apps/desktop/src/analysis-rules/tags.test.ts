import { describe, expect, it } from 'vitest';

import { createBuiltinRuleRegistry } from './catalog';
import { validateReportTags } from './tags';

describe('report tag validation', () => {
  const rules = createBuiltinRuleRegistry().resolve('apparel', 'video').tags;
  const evidenceIds = new Set(['evidence:1', 'evidence:2']);

  it('keeps fixed and evidence-bound dynamic tags distinguishable', () => {
    const result = validateReportTags(rules, {
      dynamicTags: [{
        evidenceIds: ['evidence:2'],
        facet: 'scene',
        label: '  通勤   换季  ',
        origin: 'fusion',
      }],
      evidenceIds,
      fixedTags: [{ evidenceIds: ['evidence:1'], tagId: 'apparel.product_showcase' }],
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: 'apparel.product_showcase',
        kind: 'fixed',
        origin: 'product_rule',
      }),
      expect.objectContaining({
        id: 'dynamic.1',
        kind: 'dynamic',
        label: '通勤 换季',
        origin: 'fusion',
      }),
    ]);
  });

  it('rejects dynamic tags that impersonate fixed labels', () => {
    expect(() => validateReportTags(rules, {
      dynamicTags: [{
        evidenceIds: ['evidence:1'],
        facet: 'content',
        label: ' 商品展示 ',
        origin: 'model',
      }],
      evidenceIds,
      fixedTags: [],
    })).toThrow(/覆盖了固定标签/u);
  });

  it('rejects duplicate fixed tags and unknown evidence references', () => {
    expect(() => validateReportTags(rules, {
      dynamicTags: [],
      evidenceIds,
      fixedTags: [
        { evidenceIds: ['evidence:1'], tagId: 'apparel.fabric' },
        { evidenceIds: ['evidence:2'], tagId: 'apparel.fabric' },
      ],
    })).toThrow(/不存在或重复/u);

    expect(() => validateReportTags(rules, {
      dynamicTags: [{
        evidenceIds: ['missing'],
        facet: 'style',
        label: '简约',
        origin: 'tool',
      }],
      evidenceIds,
      fixedTags: [],
    })).toThrow(/当次已知证据/u);
  });
});
