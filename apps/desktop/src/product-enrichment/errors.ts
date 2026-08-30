import { GameEnrichmentErrorCode } from './types';

const PUBLIC_MESSAGES: Record<GameEnrichmentErrorCode, string> = {
  CONSENT_REQUIRED: '联网前需要先选择本次允许或持续允许',
  INVALID_INPUT: '游戏名称或请求参数无效',
  INVALID_RESPONSE: '联网服务返回了无法识别的数据，可稍后重试或继续手工填写',
  OFFLINE: '当前可能处于离线状态，可恢复网络后重试或继续手工填写',
  PROVIDER_UNAVAILABLE: '联网服务暂时不可用，可稍后重试或继续手工填写',
  RATE_LIMITED: '联网查询过于频繁，请稍后重试',
  REQUEST_CANCELLED: '已取消本次联网查询',
  TIMEOUT: '联网查询超时，可重试或继续手工填写',
  UNKNOWN: '联网补全失败，可重试或继续手工填写',
};

export class GameEnrichmentError extends Error {
  readonly code: GameEnrichmentErrorCode;

  constructor(code: GameEnrichmentErrorCode) {
    super(PUBLIC_MESSAGES[code]);
    this.name = 'GameEnrichmentError';
    this.code = code;
  }
}

export const gameEnrichmentMessage = (code: GameEnrichmentErrorCode): string =>
  PUBLIC_MESSAGES[code];
