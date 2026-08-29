import apparelImageV1 from './catalog/apparel-image.v1.json';
import apparelVideoV1 from './catalog/apparel-video.v1.json';
import gameImageV1 from './catalog/game-image.v1.json';
import gameVideoV1 from './catalog/game-video.v1.json';
import { AnalysisRuleRegistry } from './registry';

const BUILTIN_RULE_PACKAGE_INPUTS: readonly unknown[] = [
  apparelImageV1,
  apparelVideoV1,
  gameImageV1,
  gameVideoV1,
];

export const createBuiltinRuleRegistry = (): AnalysisRuleRegistry => {
  const registry = new AnalysisRuleRegistry();
  for (const rulePackage of BUILTIN_RULE_PACKAGE_INPUTS) {
    registry.register(rulePackage, true);
  }
  return registry;
};
