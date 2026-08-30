import { describe, expect, it } from 'vitest';

import { createBuiltinRuleRegistry } from './catalog';
import { calculateMaterialScore } from './scoring';
import { DimensionAssessment, ScoringRuleDefinition } from './types';

const scoreEveryDimension = (
  rule: ScoringRuleDefinition,
  score: number,
): DimensionAssessment[] => rule.dimensions.map((dimension, index) => ({
  dimensionId: dimension.id,
  evidenceIds: [`evidence-${index}`],
  score,
  status: 'scored',
}));

describe('material scoring', () => {
  it('calculates a weighted total from evidence-backed dimensions', () => {
    const rule = createBuiltinRuleRegistry().resolve('apparel', 'video').scoring;
    const result = calculateMaterialScore(rule, scoreEveryDimension(rule, 80));

    expect(result.status).toBe('scored');
    expect(result.coverage).toBe(1);
    expect(result.total).toBe(80);
    expect(result.limitations).toEqual([]);
  });

  it('removes not-applicable dimensions instead of scoring them as zero', () => {
    const rule = createBuiltinRuleRegistry().resolve('apparel', 'image').scoring;
    const assessments = scoreEveryDimension(rule, 75);
    assessments[0] = {
      dimensionId: rule.dimensions[0].id,
      evidenceIds: [],
      status: 'not_applicable',
    };
    const result = calculateMaterialScore(rule, assessments);

    expect(result.coverage).toBe(1);
    expect(result.total).toBe(75);
    expect(result.dimensions[0]).toEqual(expect.objectContaining({
      contribution: null,
      normalizedWeight: null,
      score: null,
      status: 'not_applicable',
    }));
  });

  it('withholds the total when evidence coverage is below the rule threshold', () => {
    const rule = createBuiltinRuleRegistry().resolve('game', 'image').scoring;
    const assessments: DimensionAssessment[] = rule.dimensions.map((dimension, index) => (
      index < 2
        ? {
            dimensionId: dimension.id,
            evidenceIds: [`evidence-${index}`],
            score: 90,
            status: 'scored',
          }
        : {
            dimensionId: dimension.id,
            evidenceIds: [],
            status: 'insufficient_evidence',
          }
    ));
    const result = calculateMaterialScore(rule, assessments);

    expect(result.coverage).toBe(0.3);
    expect(result.status).toBe('insufficient_evidence');
    expect(result.total).toBeNull();
    expect(result.limitations).toEqual(expect.arrayContaining([
      expect.stringContaining('未按 0 分计入'),
      expect.stringContaining('低于规则门槛'),
    ]));
  });

  it('rejects missing, unknown or unsupported assessment data', () => {
    const rule = createBuiltinRuleRegistry().resolve('game', 'video').scoring;
    expect(() => calculateMaterialScore(rule, [])).toThrow(/显式声明/u);

    const unknown = scoreEveryDimension(rule, 80);
    unknown[0] = { ...unknown[0], dimensionId: 'unknown' };
    expect(() => calculateMaterialScore(rule, unknown)).toThrow(/未知或重复/u);

    const noEvidence = scoreEveryDimension(rule, 80);
    noEvidence[0] = { ...noEvidence[0], evidenceIds: [] };
    expect(() => calculateMaterialScore(rule, noEvidence)).toThrow(/不完整/u);
  });
});
