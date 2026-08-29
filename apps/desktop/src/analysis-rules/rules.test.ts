import { describe, expect, it } from 'vitest';

import { createBuiltinRuleRegistry } from './catalog';
import { AnalysisRuleRegistry } from './registry';
import { cloneRulePackage, parseRulePackage } from './validation';

describe('analysis rule catalog', () => {
  it('loads exactly one active rule for every industry and media combination', () => {
    const registry = createBuiltinRuleRegistry();
    expect(registry.list()).toHaveLength(4);

    const apparelVideo = registry.resolve('apparel', 'video');
    const apparelImage = registry.resolve('apparel', 'image');
    const gameVideo = registry.resolve('game', 'video');
    const gameImage = registry.resolve('game', 'image');

    expect(apparelVideo.template.goal).toBe('purchase_conversion');
    expect(apparelImage.template.goal).toBe('purchase_conversion');
    expect(gameVideo.template.goal).toBe('acquisition_or_reactivation');
    expect(gameImage.template.goal).toBe('acquisition_or_reactivation');
    expect(apparelVideo.template.sections.map((section) => section.id)).toEqual(
      expect.arrayContaining(['timeline', 'voice_and_sound']),
    );
    expect(apparelImage.template.sections.map((section) => section.id)).not.toEqual(
      expect.arrayContaining(['timeline', 'voice_and_sound']),
    );
  });

  it('returns defensive copies and freezes captured snapshots', () => {
    const registry = createBuiltinRuleRegistry();
    const resolved = registry.resolve('apparel', 'image');
    const snapshot = registry.snapshot('apparel', 'image');

    resolved.template.sections[0].label = 'mutated';
    expect(() => {
      snapshot.package.scoring.dimensions[0].weight = 0.99;
    }).toThrow(TypeError);

    expect(registry.resolve('apparel', 'image').template.sections[0].label).toBe('分析上下文');
    expect(snapshot.package.scoring.dimensions[0].weight).toBe(0.18);
  });

  it('requires explicit activation before a new rule version affects selection', () => {
    const registry = createBuiltinRuleRegistry();
    const original = registry.resolve('game', 'image');
    const next = cloneRulePackage(original);
    next.packageVersion = '1.1.0';
    next.template.version = '1.1.0';
    next.tags.version = '1.1.0';
    next.scoring.version = '1.1.0';

    registry.register(next);
    expect(registry.resolve('game', 'image').packageVersion).toBe('1.0.0');

    registry.activate(next.packageId, next.packageVersion);
    expect(registry.resolve('game', 'image').packageVersion).toBe('1.1.0');
    expect(original.packageVersion).toBe('1.0.0');
  });
});

describe('analysis rule package validation', () => {
  it('rejects unsupported fields and cross-industry goals', () => {
    const base = createBuiltinRuleRegistry().resolve('apparel', 'image');
    expect(() => parseRulePackage({ ...base, prompt: 'must not enter a rule package' })).toThrow(
      /unsupported fields/u,
    );
    expect(() => parseRulePackage({
      ...base,
      template: { ...base.template, goal: 'acquisition_or_reactivation' },
    })).toThrow(/industry goal/u);
  });

  it('rejects invalid weights and duplicate template versions', () => {
    const base = createBuiltinRuleRegistry().resolve('apparel', 'image');
    const invalidWeight = cloneRulePackage(base);
    invalidWeight.scoring.dimensions[0].weight = 0.5;
    expect(() => parseRulePackage(invalidWeight)).toThrow(/add up/u);

    const registry = new AnalysisRuleRegistry();
    registry.register(base);
    expect(() => registry.register({ ...base, packageVersion: '1.0.1' })).toThrow(
      /模板版本/u,
    );
  });
});
