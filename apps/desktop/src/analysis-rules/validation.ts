import { AnalysisRuleError } from './errors';
import {
  AnalysisGoal,
  AnalysisIndustry,
  AnalysisMediaKind,
  AnalysisRulePackage,
  FixedTagDefinition,
  ReportSectionDefinition,
  ReportSectionId,
  ScoringDimensionDefinition,
} from './types';

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPORT_SECTION_IDS = new Set<ReportSectionId>([
  'context',
  'cta',
  'diagnosis',
  'emotion',
  'evidence',
  'limitations',
  'overview',
  'product_or_gameplay',
  'recommendations',
  'selling_points',
  'structure',
  'tags',
  'timeline',
  'visuals',
  'voice_and_sound',
]);
const REQUIRED_SECTIONS = new Set<ReportSectionId>([
  'context',
  'diagnosis',
  'evidence',
  'limitations',
  'overview',
  'recommendations',
  'tags',
]);

const invalid = (path: string, message: string): never => {
  throw new AnalysisRuleError('RULE_PACKAGE_INVALID', `${path}: ${message}`);
};

const objectAt = (
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(path, 'must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, 'must be a plain object');
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return invalid(path, 'contains missing or unsupported fields');
  }
  return record;
};

const arrayAt = (value: unknown, path: string, minimum: number, maximum: number): unknown[] => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return invalid(path, `must contain between ${minimum} and ${maximum} items`);
  }
  return value;
};

const stringAt = (value: unknown, path: string, maximum = 200): string => {
  const hasControlCharacter = typeof value === 'string'
    && Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) as number;
      return codePoint <= 31 || codePoint === 127;
    });
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length === 0
    || value.length > maximum
    || hasControlCharacter
  ) {
    return invalid(path, 'must be bounded, trimmed text');
  }
  return value;
};

const idAt = (value: unknown, path: string): string => {
  const id = stringAt(value, path, 96);
  if (!ID_PATTERN.test(id)) return invalid(path, 'must be a stable lowercase identifier');
  return id;
};

const versionAt = (value: unknown, path: string): string => {
  const version = stringAt(value, path, 32);
  if (!VERSION_PATTERN.test(version)) return invalid(path, 'must be a semantic version');
  return version;
};

const numberAt = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    return invalid(path, `must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const booleanAt = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') return invalid(path, 'must be boolean');
  return value;
};

const unique = (values: readonly string[], path: string): void => {
  if (new Set(values).size !== values.length) invalid(path, 'must not contain duplicates');
};

const parseSections = (value: unknown, mediaKind: AnalysisMediaKind): ReportSectionDefinition[] => {
  const sections = arrayAt(value, '$.template.sections', 7, 15).map((entry, index) => {
    const path = `$.template.sections[${index}]`;
    const item = objectAt(entry, path, ['id', 'label', 'required']);
    const id = stringAt(item.id, `${path}.id`, 40) as ReportSectionId;
    if (!REPORT_SECTION_IDS.has(id)) invalid(`${path}.id`, 'is not a supported report section');
    return {
      id,
      label: stringAt(item.label, `${path}.label`, 40),
      required: booleanAt(item.required, `${path}.required`),
    };
  });
  unique(sections.map((section) => section.id), '$.template.sections');
  for (const required of REQUIRED_SECTIONS) {
    if (!sections.some((section) => section.id === required && section.required)) {
      invalid('$.template.sections', `must include required section ${required}`);
    }
  }
  const hasTimeline = sections.some((section) => section.id === 'timeline');
  const hasVoiceAndSound = sections.some((section) => section.id === 'voice_and_sound');
  if (mediaKind === 'video' && (!hasTimeline || !hasVoiceAndSound)) {
    invalid('$.template.sections', 'video rules require timeline and voice_and_sound');
  }
  if (mediaKind === 'image' && (hasTimeline || hasVoiceAndSound)) {
    invalid('$.template.sections', 'image rules cannot declare video-only sections');
  }
  return sections;
};

const parseFixedTags = (value: unknown): FixedTagDefinition[] => {
  const tags = arrayAt(value, '$.tags.fixedTags', 4, 48).map((entry, index) => {
    const path = `$.tags.fixedTags[${index}]`;
    const item = objectAt(entry, path, ['description', 'facet', 'id', 'label']);
    return {
      description: stringAt(item.description, `${path}.description`, 240),
      facet: idAt(item.facet, `${path}.facet`),
      id: idAt(item.id, `${path}.id`),
      label: stringAt(item.label, `${path}.label`, 40),
    };
  });
  unique(tags.map((tag) => tag.id), '$.tags.fixedTags.id');
  unique(
    tags.map((tag) => tag.label.normalize('NFKC').toLocaleLowerCase('zh-CN')),
    '$.tags.fixedTags.label',
  );
  return tags;
};

const parseDimensions = (value: unknown): ScoringDimensionDefinition[] => {
  const dimensions = arrayAt(value, '$.scoring.dimensions', 4, 16).map((entry, index) => {
    const path = `$.scoring.dimensions[${index}]`;
    const item = objectAt(entry, path, [
      'description',
      'evidenceKinds',
      'id',
      'label',
      'weight',
    ]);
    const evidenceKinds = arrayAt(item.evidenceKinds, `${path}.evidenceKinds`, 1, 16)
      .map((kind, kindIndex) => idAt(kind, `${path}.evidenceKinds[${kindIndex}]`));
    unique(evidenceKinds, `${path}.evidenceKinds`);
    return {
      description: stringAt(item.description, `${path}.description`, 240),
      evidenceKinds,
      id: idAt(item.id, `${path}.id`),
      label: stringAt(item.label, `${path}.label`, 40),
      weight: numberAt(item.weight, `${path}.weight`, Number.EPSILON, 1),
    };
  });
  unique(dimensions.map((dimension) => dimension.id), '$.scoring.dimensions.id');
  const totalWeight = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  if (Math.abs(totalWeight - 1) > 1e-9) {
    invalid('$.scoring.dimensions.weight', 'weights must add up to exactly 1');
  }
  return dimensions;
};

export const parseRulePackage = (value: unknown): AnalysisRulePackage => {
  const root = objectAt(value, '$', [
    'packageId',
    'packageVersion',
    'schemaVersion',
    'scoring',
    'tags',
    'template',
  ]);
  if (root.schemaVersion !== 1) invalid('$.schemaVersion', 'only schema version 1 is supported');

  const template = objectAt(root.template, '$.template', [
    'goal',
    'id',
    'industry',
    'mediaKind',
    'sections',
    'version',
  ]);
  const industry = stringAt(template.industry, '$.template.industry') as AnalysisIndustry;
  const mediaKind = stringAt(template.mediaKind, '$.template.mediaKind') as AnalysisMediaKind;
  const goal = stringAt(template.goal, '$.template.goal') as AnalysisGoal;
  if (!['apparel', 'game'].includes(industry)) invalid('$.template.industry', 'is unsupported');
  if (!['image', 'video'].includes(mediaKind)) invalid('$.template.mediaKind', 'is unsupported');
  const expectedGoal: AnalysisGoal = industry === 'apparel'
    ? 'purchase_conversion'
    : 'acquisition_or_reactivation';
  if (goal !== expectedGoal) invalid('$.template.goal', 'does not match the industry goal');

  const tags = objectAt(root.tags, '$.tags', ['fixedTags', 'id', 'version']);
  const scoring = objectAt(root.scoring, '$.scoring', [
    'dimensions',
    'id',
    'minimumCoverage',
    'missingEvidencePolicy',
    'version',
  ]);
  if (scoring.missingEvidencePolicy !== 'renormalize_scored') {
    invalid('$.scoring.missingEvidencePolicy', 'is unsupported');
  }

  return {
    packageId: idAt(root.packageId, '$.packageId'),
    packageVersion: versionAt(root.packageVersion, '$.packageVersion'),
    schemaVersion: 1,
    scoring: {
      dimensions: parseDimensions(scoring.dimensions),
      id: idAt(scoring.id, '$.scoring.id'),
      minimumCoverage: numberAt(scoring.minimumCoverage, '$.scoring.minimumCoverage', 0.5, 1),
      missingEvidencePolicy: 'renormalize_scored',
      version: versionAt(scoring.version, '$.scoring.version'),
    },
    tags: {
      fixedTags: parseFixedTags(tags.fixedTags),
      id: idAt(tags.id, '$.tags.id'),
      version: versionAt(tags.version, '$.tags.version'),
    },
    template: {
      goal,
      id: idAt(template.id, '$.template.id'),
      industry,
      mediaKind,
      sections: parseSections(template.sections, mediaKind),
      version: versionAt(template.version, '$.template.version'),
    },
  };
};

export const cloneRulePackage = (rulePackage: AnalysisRulePackage): AnalysisRulePackage =>
  parseRulePackage(JSON.parse(JSON.stringify(rulePackage)) as unknown);
