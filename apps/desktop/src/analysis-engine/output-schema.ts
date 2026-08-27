import type {
  AnalysisIndustry,
  AnalysisMediaKind,
  AnalysisRulePackage,
} from '../analysis-rules';

type JsonSchema = Record<string, unknown>;

// Keep the provider-facing schema to the documented Structured Outputs subset.
// Business length, normalization, uniqueness, and identifier checks remain in
// model-output.ts, which is the authoritative local parser.
const stringSchema = (): JsonSchema => ({ type: 'string' });

const evidenceIdsSchema = (allowEmpty = false): JsonSchema => ({
  items: stringSchema(),
  maxItems: 64,
  minItems: allowEmpty ? 0 : 1,
  type: 'array',
});

const exactObject = (
  properties: Record<string, JsonSchema>,
): JsonSchema => ({
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
  type: 'object',
});

const arrayOf = (
  items: JsonSchema,
  maximum: number,
  minimum = 0,
): JsonSchema => ({
  items,
  maxItems: maximum,
  minItems: minimum,
  type: 'array',
});

const claimSchema = exactObject({
  evidenceIds: evidenceIdsSchema(),
  text: stringSchema(),
});

export const buildAnalysisOutputSchema = (
  rule: AnalysisRulePackage,
  industry: AnalysisIndustry,
  mediaKind: AnalysisMediaKind,
): Readonly<Record<string, unknown>> => {
  const dimensionIds = rule.scoring.dimensions.map((dimension) => dimension.id);
  const fixedTagIds = rule.tags.fixedTags.map((tag) => tag.id);
  const dimensionBase = {
    dimensionId: { enum: dimensionIds, type: 'string' },
  };
  const dimensionSchema = {
    anyOf: [
      exactObject({
        ...dimensionBase,
        evidenceIds: evidenceIdsSchema(),
        score: { maximum: 100, minimum: 0, type: 'number' },
        status: { enum: ['scored'], type: 'string' },
      }),
      exactObject({
        ...dimensionBase,
        evidenceIds: evidenceIdsSchema(true),
        score: { type: 'null' },
        status: {
          enum: ['insufficient_evidence', 'not_applicable'],
          type: 'string',
        },
      }),
    ],
  };
  const emotionTimeSchema: JsonSchema = mediaKind === 'image'
    ? { type: 'null' }
    : {
        anyOf: [
          { minimum: 0, type: 'number' },
          { type: 'null' },
        ],
      };

  return exactObject({
    cta: arrayOf(claimSchema, 60),
    diagnoses: arrayOf(exactObject({
      evidenceIds: evidenceIdsSchema(),
      impact: stringSchema(),
      problem: stringSchema(),
      relatedDimensionIds: {
        items: { enum: dimensionIds, type: 'string' },
        maxItems: dimensionIds.length,
        type: 'array',
      },
      severity: { enum: ['high', 'low', 'medium'], type: 'string' },
    }), 30),
    dimensionAssessments: arrayOf(
      dimensionSchema,
      dimensionIds.length,
      dimensionIds.length,
    ),
    dynamicTags: arrayOf(exactObject({
      evidenceIds: evidenceIdsSchema(),
      facet: {
        pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$',
        type: 'string',
      },
      label: stringSchema(),
    }), 50),
    emotion: arrayOf(exactObject({
      evidenceIds: evidenceIdsSchema(),
      intensity: {
        anyOf: [
          { maximum: 1, minimum: -1, type: 'number' },
          { type: 'null' },
        ],
      },
      text: stringSchema(),
      timeMs: emotionTimeSchema,
    }), 100),
    fixedTags: arrayOf(exactObject({
      evidenceIds: evidenceIdsSchema(),
      tagId: { enum: fixedTagIds, type: 'string' },
    }), fixedTagIds.length),
    goalScene: {
      enum: industry === 'apparel'
        ? ['purchase_conversion']
        : ['acquisition', 'reactivation', 'unclear'],
      type: 'string',
    },
    limitations: {
      items: stringSchema(),
      maxItems: 50,
      type: 'array',
    },
    productOrGameplay: arrayOf(claimSchema, 60),
    recommendations: arrayOf(exactObject({
      action: stringSchema(),
      diagnosisIndexes: {
        items: { minimum: 0, type: 'integer' },
        maxItems: 30,
        minItems: 1,
        type: 'array',
      },
      priority: { enum: ['next', 'now', 'test'], type: 'string' },
      rationale: stringSchema(),
    }), 30),
    schemaVersion: { enum: [1], type: 'number' },
    scriptStructure: arrayOf(claimSchema, 60),
    sellingPoints: arrayOf(claimSchema, 60),
    shotBreakdown: arrayOf(claimSchema, 60),
    subtitleContent: arrayOf(claimSchema, 60),
    summary: stringSchema(),
    title: stringSchema(),
    visualContent: arrayOf(claimSchema, 60),
    voiceAndSound: arrayOf(claimSchema, mediaKind === 'image' ? 0 : 60),
  });
};
