import { describe, expect, it } from 'vitest';

import { buildAnalysisOutputSchema } from './output-schema';
import { createBuiltinRuleRegistry } from '../analysis-rules';

const collectKeys = (value: unknown, result = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, result));
    return result;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => {
      result.add(key);
      collectKeys(entry, result);
    });
  }
  return result;
};

describe('analysis structured output schema', () => {
  it('uses the supported anyOf subset and keeps duplicate checks in the local parser', () => {
    const rule = createBuiltinRuleRegistry().resolve('apparel', 'video');
    const schema = buildAnalysisOutputSchema(rule, 'apparel', 'video');
    const keys = collectKeys(schema);

    expect(keys.has('oneOf')).toBe(false);
    expect(keys.has('uniqueItems')).toBe(false);
    expect(keys.has('const')).toBe(false);
    expect(keys.has('minLength')).toBe(false);
    expect(keys.has('maxLength')).toBe(false);
    expect(keys.has('anyOf')).toBe(true);
    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: {
        dimensionAssessments: {
          maxItems: rule.scoring.dimensions.length,
          minItems: rule.scoring.dimensions.length,
        },
        schemaVersion: { enum: [1] },
      },
      type: 'object',
    });
  });

  it('forbids sound output and time points for image analysis', () => {
    const rule = createBuiltinRuleRegistry().resolve('game', 'image');
    const schema = buildAnalysisOutputSchema(rule, 'game', 'image') as {
      properties: Record<string, unknown>;
    };

    expect(schema.properties).toMatchObject({
      emotion: {
        items: {
          properties: {
            timeMs: { type: 'null' },
          },
        },
      },
      voiceAndSound: { maxItems: 0 },
    });
  });
});
