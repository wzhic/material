import { ProductInput } from '../product/types';
import { GameEnrichmentCandidate } from './types';

const FIELD_MAPPINGS: ReadonlyArray<[
  keyof Pick<GameEnrichmentCandidate, 'gameType' | 'releaseDate' | 'summary'>,
  string,
]> = [
  ['gameType', '游戏类型'],
  ['releaseDate', '发售日期'],
  ['summary', '游戏简介'],
];

export interface GameSuggestionMergeResult {
  appliedFields: string[];
  input: ProductInput;
}

export const mergeGameSuggestion = (
  input: ProductInput,
  candidate: GameEnrichmentCandidate,
): GameSuggestionMergeResult => {
  if (input.industry !== 'game') return { appliedFields: [], input };
  const details = { ...input.details };
  const appliedFields: string[] = [];
  FIELD_MAPPINGS.forEach(([candidateKey, field]) => {
    const value = candidate[candidateKey];
    if (!details[field]?.trim() && value?.trim()) {
      details[field] = value.trim();
      appliedFields.push(field);
    }
  });
  if (!details['平台']?.trim() && candidate.platforms.length) {
    details['平台'] = candidate.platforms.join('、');
    appliedFields.push('平台');
  }
  return {
    appliedFields,
    input: appliedFields.length ? { ...input, details } : input,
  };
};
