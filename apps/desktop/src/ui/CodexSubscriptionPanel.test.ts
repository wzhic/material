import { describe, expect, it } from 'vitest';

import {
  CodexSubscriptionState,
  CodexSubscriptionStatus,
} from '../codex-subscription/types';
import {
  codexStatusLabel,
  codexTestDisabledReason,
  formatCodexPlan,
  formatRateLimitDuration,
  isCodexConnectedState,
  shouldClearDeviceLogin,
} from './CodexSubscriptionPanel';

const readyState = (overrides: Partial<CodexSubscriptionState> = {}): CodexSubscriptionState => ({
  accountLabel: 'a***@example.com',
  lastError: null,
  models: [{
    defaultReasoningEffort: 'medium',
    displayName: 'GPT-5 Codex',
    id: 'gpt-5-codex',
    inputModalities: ['text'],
    isDefault: true,
    supportedReasoningEfforts: [],
  }],
  pendingLoginId: null,
  planType: 'plus',
  rateLimits: null,
  selectedModelId: 'gpt-5-codex',
  status: 'ready',
  ...overrides,
});

describe('CodexSubscriptionPanel pure presentation rules', () => {
  it('keeps known plans explicit and unknown plans visible', () => {
    expect(formatCodexPlan('plus')).toBe('ChatGPT Plus');
    expect(formatCodexPlan('future-plan')).toBe('ChatGPT 套餐（future-plan）');
    expect(formatCodexPlan(null)).toBe('套餐信息未提供');
  });

  it('formats minute, hour, and day rate-limit windows', () => {
    expect(formatRateLimitDuration(45)).toBe('45 分钟窗口');
    expect(formatRateLimitDuration(180)).toBe('3 小时窗口');
    expect(formatRateLimitDuration(2_880)).toBe('2 天窗口');
    expect(formatRateLimitDuration(null)).toBe('窗口信息未提供');
  });

  it('provides a user-visible label for every public state', () => {
    const statuses: CodexSubscriptionStatus[] = [
      'unavailable',
      'signedOut',
      'loginPending',
      'ready',
      'limited',
      'testing',
      'error',
    ];
    expect(statuses.map(codexStatusLabel)).toEqual([
      '组件不可用',
      '未登录',
      '登录中',
      '已连接',
      '额度受限',
      '测试中',
      '需要处理',
    ]);
  });

  it('requires a ready account, discovered model, and explicit selection before testing', () => {
    expect(codexTestDisabledReason(readyState(), false)).toBeNull();
    expect(codexTestDisabledReason(readyState({ status: 'limited' }), false))
      .toContain('订阅额度当前受限');
    expect(codexTestDisabledReason(readyState({ models: [] }), false))
      .toContain('没有可用于测试');
    expect(codexTestDisabledReason(readyState({ selectedModelId: null }), false))
      .toContain('明确选择');
    expect(codexTestDisabledReason(readyState(), true))
      .toContain('不能重复测试');
  });

  it('keeps a ready account connected even when model discovery is empty', () => {
    expect(isCodexConnectedState(readyState({
      accountLabel: null,
      models: [],
      planType: null,
      selectedModelId: null,
    }))).toBe(true);
    expect(isCodexConnectedState(readyState({
      accountLabel: null,
      models: [],
      planType: null,
      selectedModelId: null,
      status: 'signedOut',
    }))).toBe(false);
    expect(isCodexConnectedState(readyState({ status: 'error' }))).toBe(true);
  });

  it('clears a late device code whenever the authoritative state is no longer pending', () => {
    expect(shouldClearDeviceLogin('loginPending')).toBe(false);
    expect(shouldClearDeviceLogin('ready')).toBe(true);
    expect(shouldClearDeviceLogin('signedOut')).toBe(true);
    expect(shouldClearDeviceLogin('limited')).toBe(true);
    expect(shouldClearDeviceLogin('error')).toBe(true);
    expect(shouldClearDeviceLogin('unavailable')).toBe(true);
  });
});
