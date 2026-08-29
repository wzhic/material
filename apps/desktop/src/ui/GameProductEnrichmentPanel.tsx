import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Tag } from 'tdesign-react';

import {
  GameEnrichmentCandidate,
  GameEnrichmentConsentChoice,
  GameEnrichmentErrorCode,
  GameEnrichmentStatus,
} from '../product-enrichment/types';
import {
  consumeGrantedQueryAutoRun,
  GrantedQuerySuppression,
  suppressGrantedQueryAutoRun,
} from '../product-enrichment/query-scheduling';

type SearchState =
  | { kind: 'awaiting-consent' }
  | { kind: 'disabled' }
  | { kind: 'empty'; query: string }
  | { code: GameEnrichmentErrorCode; kind: 'error'; message: string; query: string }
  | { kind: 'idle' }
  | { kind: 'loading-status' }
  | { candidates: GameEnrichmentCandidate[]; kind: 'results'; query: string }
  | { kind: 'searching'; query: string };

interface GameProductEnrichmentPanelProps {
  gameName: string;
  onApply: (candidate: GameEnrichmentCandidate) => string[];
  queryNowToken: number;
}

const normalizeForLookup = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/g, ' ').trim();

const displayTime = (value: string): string =>
  new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));

export const GameProductEnrichmentPanel = ({
  gameName,
  onApply,
  queryNowToken,
}: GameProductEnrichmentPanelProps): React.JSX.Element => {
  const [status, setStatus] = useState<GameEnrichmentStatus | null>(null);
  const [state, setState] = useState<SearchState>({ kind: 'loading-status' });
  const [appliedMessage, setAppliedMessage] = useState('');
  const activeRequest = useRef<string | null>(null);
  const latestName = useRef(gameName);
  const lastCompletedQuery = useRef('');
  const lastQueryNowToken = useRef(queryNowToken);
  const grantedQuerySuppression = useRef<GrantedQuerySuppression>({ query: null });

  latestName.current = gameName;

  const cancelActive = useCallback(async (): Promise<void> => {
    const requestId = activeRequest.current;
    activeRequest.current = null;
    if (requestId) await window.materialApi.products.enrichment.cancel(requestId);
  }, []);

  const refreshStatus = useCallback(async (): Promise<GameEnrichmentStatus | null> => {
    const result = await window.materialApi.products.enrichment.getStatus();
    if (!result.ok) {
      setState({ code: result.error.code, kind: 'error', message: result.error.message, query: '' });
      return null;
    }
    setStatus(result.data);
    return result.data;
  }, []);

  useEffect(() => {
    let active = true;
    void refreshStatus().then((current) => {
      if (!active || !current) return;
      if (current.consent === 'declined') setState({ kind: 'disabled' });
      else if (current.consent === 'required') setState({ kind: 'awaiting-consent' });
      else setState({ kind: 'idle' });
    });
    return () => {
      active = false;
      void cancelActive();
    };
  }, [cancelActive, refreshStatus]);

  const runSearch = useCallback(async (rawName: string, force = false): Promise<void> => {
    const query = normalizeForLookup(rawName);
    if (query.length < 2 || query.length > 100) {
      await cancelActive();
      setState({ kind: 'idle' });
      return;
    }
    if (!force && query === lastCompletedQuery.current) return;
    await cancelActive();
    const requestId = window.crypto.randomUUID();
    activeRequest.current = requestId;
    setAppliedMessage('');
    setState({ kind: 'searching', query });
    const result = await window.materialApi.products.enrichment.search({
      gameName: query,
      requestId,
    });
    if (activeRequest.current !== requestId) return;
    activeRequest.current = null;
    if (!result.ok) {
      if (result.error.code === 'CONSENT_REQUIRED') {
        const current = await refreshStatus();
        setState(current?.consent === 'declined'
          ? { kind: 'disabled' }
          : { kind: 'awaiting-consent' });
        return;
      }
      setState({
        code: result.error.code,
        kind: 'error',
        message: result.error.message,
        query,
      });
      return;
    }
    lastCompletedQuery.current = result.data.query;
    void refreshStatus();
    setState(result.data.candidates.length
      ? { candidates: result.data.candidates, kind: 'results', query: result.data.query }
      : { kind: 'empty', query: result.data.query });
  }, [cancelActive, refreshStatus]);

  useEffect(() => {
    const query = normalizeForLookup(gameName);
    const queryImmediately = lastQueryNowToken.current !== queryNowToken;
    lastQueryNowToken.current = queryNowToken;
    if (query.length < 2 || query.length > 100) {
      void cancelActive();
      lastCompletedQuery.current = '';
      setState({ kind: 'idle' });
      return undefined;
    }
    if (!status) return undefined;
    if (status.consent === 'declined') {
      setState({ kind: 'disabled' });
      return undefined;
    }
    if (status.consent === 'required') {
      if (lastCompletedQuery.current !== query) setState({ kind: 'awaiting-consent' });
      return undefined;
    }
    if (consumeGrantedQueryAutoRun(grantedQuerySuppression.current, query)) {
      return undefined;
    }
    void cancelActive();
    const timer = window.setTimeout(
      () => void runSearch(query),
      queryImmediately ? 0 : 650,
    );
    return () => window.clearTimeout(timer);
  }, [cancelActive, gameName, queryNowToken, runSearch, status]);

  const grant = async (choice: GameEnrichmentConsentChoice): Promise<void> => {
    const result = await window.materialApi.products.enrichment.setConsent(choice);
    if (!result.ok) {
      setState({ code: result.error.code, kind: 'error', message: result.error.message, query: '' });
      return;
    }
    setStatus(result.data);
    if (choice === 'declined') {
      setState({ kind: 'disabled' });
      return;
    }
    suppressGrantedQueryAutoRun(
      grantedQuerySuppression.current,
      normalizeForLookup(latestName.current),
    );
    await runSearch(latestName.current, true);
  };

  const disablePersistentConsent = async (): Promise<void> => {
    await cancelActive();
    const cleared = await window.materialApi.products.enrichment.clearPersistentConsent();
    if (!cleared.ok) {
      setState({ code: cleared.error.code, kind: 'error', message: cleared.error.message, query: '' });
      return;
    }
    const declined = await window.materialApi.products.enrichment.setConsent('declined');
    if (declined.ok) setStatus(declined.data);
    setState({ kind: 'disabled' });
  };

  const apply = (candidate: GameEnrichmentCandidate): void => {
    const fields = onApply(candidate);
    setAppliedMessage(fields.length
      ? `已填入：${fields.join('、')}。保存前仍可编辑。`
      : '现有字段均已有内容，未自动覆盖。');
  };

  const retry = (): void => {
    lastCompletedQuery.current = '';
    void runSearch(latestName.current, true);
  };

  return (
    <section className="game-enrichment">
      <div className="game-enrichment-heading">
        <div>
          <span className="field-label">联网补全</span>
          <small>只发送当前游戏名称，候选不会自动保存或覆盖已有内容。</small>
        </div>
        {status?.consent === 'persistent' ? (
          <Button onClick={() => void disablePersistentConsent()} size="small" variant="text">
            关闭持续授权
          </Button>
        ) : null}
      </div>

      {state.kind === 'loading-status' ? (
        <div className="game-enrichment-state">正在检查联网授权…</div>
      ) : null}
      {state.kind === 'idle' ? (
        <div className="game-enrichment-state">输入至少 2 个字符后自动查询，也可完整手工填写。</div>
      ) : null}
      {state.kind === 'awaiting-consent' ? (
        <div className="game-enrichment-consent">
          <div>
            <strong>是否允许向 {status?.provider.name ?? '联网服务'} 发送游戏名称？</strong>
            <p>用途仅为查找游戏类型、平台、发售日期和简介建议，不发送产品库其他内容。</p>
          </div>
          <div className="game-enrichment-actions">
            <Button onClick={() => void grant('declined')} size="small" variant="text">暂不使用</Button>
            <Button onClick={() => void grant('once')} size="small" variant="outline">仅本次允许</Button>
            <Button onClick={() => void grant('persistent')} size="small" theme="primary">持续允许</Button>
          </div>
        </div>
      ) : null}
      {state.kind === 'disabled' ? (
        <div className="game-enrichment-state is-muted">
          <span>本次已关闭联网补全，手工创建不受影响。</span>
          <Button
            onClick={() => {
              setStatus((current) => current ? { ...current, consent: 'required' } : current);
              setState({ kind: 'awaiting-consent' });
            }}
            size="small"
            variant="outline"
          >
            重新启用
          </Button>
        </div>
      ) : null}
      {state.kind === 'searching' ? (
        <div className="game-enrichment-state is-loading" aria-live="polite">
          <span>正在查询“{state.query}”…</span>
          <Button
            onClick={() => {
              void cancelActive();
              setState({
                code: 'REQUEST_CANCELLED',
                kind: 'error',
                message: '已取消本次联网查询',
                query: state.query,
              });
            }}
            size="small"
            variant="outline"
          >
            取消
          </Button>
        </div>
      ) : null}
      {state.kind === 'empty' ? (
        <div className="game-enrichment-state is-muted">
          <span>未找到“{state.query}”的可靠候选，可调整名称重试或继续手工填写。</span>
          <Button onClick={retry} size="small" variant="outline">重试</Button>
        </div>
      ) : null}
      {state.kind === 'error' ? (
        <div className="game-enrichment-state is-error" role="alert">
          <span>{state.message}</span>
          {state.code !== 'REQUEST_CANCELLED' || normalizeForLookup(gameName).length >= 2 ? (
            <Button onClick={retry} size="small" variant="outline">重试</Button>
          ) : null}
        </div>
      ) : null}
      {state.kind === 'results' ? (
        <div className="game-enrichment-results" aria-live="polite">
          <div className="game-enrichment-result-summary">
            <span>找到 {state.candidates.length} 个候选，请选择后再保存产品。</span>
            <Button onClick={retry} size="small" variant="text">重新查询</Button>
          </div>
          {state.candidates.map((candidate) => (
            <article className="game-enrichment-candidate" key={candidate.sourceId}>
              <div className="game-enrichment-candidate-head">
                <div>
                  <strong>{candidate.name}</strong>
                  <small>{candidate.sourceName} · 获取于 {displayTime(candidate.fetchedAt)}</small>
                </div>
                <Button onClick={() => apply(candidate)} size="small" theme="primary">应用建议</Button>
              </div>
              <div className="game-enrichment-tags">
                {candidate.gameType ? <Tag variant="light">{candidate.gameType}</Tag> : null}
                {candidate.platforms.map((platform) => <Tag key={platform}>{platform}</Tag>)}
                {candidate.releaseDate ? <Tag>{candidate.releaseDate}</Tag> : null}
              </div>
              {candidate.summary ? <p>{candidate.summary}</p> : null}
            </article>
          ))}
        </div>
      ) : null}
      {appliedMessage ? <div className="game-enrichment-applied" role="status">{appliedMessage}</div> : null}
    </section>
  );
};
