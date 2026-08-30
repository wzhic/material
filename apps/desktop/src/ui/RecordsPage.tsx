import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Tag } from 'tdesign-react';

import { formatFileSize } from '../analysis/draft';
import type { MaterialSession } from '../media/types';
import {
  AnalysisRecord,
  AnalysisRecordListItem,
  AnalysisRecordQuery,
  MaterialSourceStatus,
  RecordBackupInfo,
  RecordFeedbackState,
  RecordIndustry,
  RecordMediaKind,
  RecordSort,
  RecordStorageStatus,
} from '../record/types';

interface RecordsPageProps {
  initialRecordId?: string | null;
  onCreate: () => void;
  onInitialRecordOpened?: () => void;
  onReanalyze: (record: AnalysisRecord, material: MaterialSession) => void;
}

const PAGE_SIZE = 50;

const formatLocalTime = (value: string): string =>
  new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

const formatReferenceTime = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

const industryLabel = (industry: RecordIndustry): string =>
  industry === 'apparel' ? '服饰' : '游戏';

const mediaLabel = (media: RecordMediaKind): string =>
  media === 'video' ? '视频' : '图片';

const recordUsageLabel = (record: AnalysisRecord): string => {
  const usage = record.run.usage;
  if (!usage || record.run.usageAvailable !== true || usage.available !== true) {
    return '暂不可用';
  }
  return `输入 ${usage.promptTokens} · 缓存命中 ${usage.promptCacheHitTokens} · 输出 ${usage.completionTokens} · 总计 ${usage.totalTokens}`;
};

const providerRequestedModelLabel = (record: AnalysisRecord): string =>
  record.run.providerRequestedModelId ?? record.run.modelId;

const sourceStatusLabel = (status: MaterialSourceStatus): string => {
  if (status === 'available') {
    return '可用';
  }
  if (status === 'mismatch') {
    return '文件不匹配';
  }
  return '需重新定位';
};

const sourceStatusTheme = (
  status: MaterialSourceStatus,
): 'danger' | 'success' | 'warning' => {
  if (status === 'available') {
    return 'success';
  }
  if (status === 'mismatch') {
    return 'danger';
  }
  return 'warning';
};

const backupKindLabel = (backup: RecordBackupInfo): string => {
  if (backup.kind === 'pre-restore') {
    return '恢复前安全备份';
  }
  if (backup.kind === 'pre-migration') {
    return '迁移前备份';
  }
  return '手动备份';
};

const RecordMaintenance = ({
  onBack,
  onRestored,
}: {
  onBack: () => void;
  onRestored: () => void;
}): React.JSX.Element => {
  const [status, setStatus] = useState<RecordStorageStatus | null>(null);
  const [backups, setBackups] = useState<RecordBackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<RecordBackupInfo | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const [statusResult, backupResult] = await Promise.all([
      window.materialApi.records.storageStatus(),
      window.materialApi.records.listBackups(),
    ]);
    if (!statusResult.ok) {
      setError(statusResult.error.message);
    } else if (!backupResult.ok) {
      setError(backupResult.error.message);
    } else {
      setStatus(statusResult.data);
      setBackups(backupResult.data);
      setError('');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createBackup = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setSuccess('');
    const result = await window.materialApi.records.createBackup();
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSuccess(
      `已创建并验证备份，包含 ${result.data.recordCount ?? 0} 条记录、${result.data.feedbackCount ?? 0} 条反馈。`,
    );
    await load();
  };

  const restore = async (): Promise<void> => {
    if (!restoreTarget) {
      return;
    }
    setBusy(true);
    setError('');
    setSuccess('');
    const result = await window.materialApi.records.restoreBackup(restoreTarget.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      setRestoreTarget(null);
      return;
    }
    setRestoreTarget(null);
    setSuccess(
      `已恢复到 ${formatLocalTime(restoreTarget.createdAt)} 的备份；恢复前数据已另存为安全备份。`,
    );
    onRestored();
    await load();
  };

  return (
    <main className="page-shell product-maintenance-page">
      <header className="page-header">
        <div>
          <button className="text-back" onClick={onBack} type="button">← 返回分析记录</button>
          <h1>分析记录数据维护</h1>
          <p>检查本地数据库状态，并创建由客户端完整性校验过的备份。</p>
        </div>
        <Button
          disabled={busy || !status?.writable}
          loading={busy}
          onClick={() => void createBackup()}
          theme="primary"
        >
          创建备份
        </Button>
      </header>

      {error ? <div className="page-alert is-error" role="alert">{error}</div> : null}
      {success ? <div className="page-alert is-success" role="status">{success}</div> : null}

      <section className="record-storage-status storage-status-grid" aria-label="分析记录库状态">
        <div>
          <span>完整性</span>
          <strong className={status?.integrity === 'ok' ? 'is-healthy' : 'is-unhealthy'}>
            {loading ? '检查中' : status?.integrity === 'ok' ? '正常' : '需要处理'}
          </strong>
        </div>
        <div><span>Schema</span><strong>v{status?.schemaVersion ?? '—'}</strong></div>
        <div><span>写入状态</span><strong>{status?.writable ? '可读写' : '只读'}</strong></div>
        <div><span>确认记录</span><strong>{status?.recordCount ?? '—'}</strong></div>
        <div><span>反馈 / 素材引用</span><strong>{status ? `${status.feedbackCount} / ${status.sourceReferenceCount}` : '—'}</strong></div>
        <div><span>已保留备份</span><strong>{status?.backupCount ?? '—'}</strong></div>
      </section>

      <section className="backup-section">
        <div className="section-heading">
          <div>
            <h2>备份记录</h2>
            <p>备份保存在应用管理目录，不复制源素材、模型凭据或已导出的 PDF。</p>
          </div>
          <Button disabled={busy} onClick={() => void load()} size="small" variant="outline">刷新</Button>
        </div>
        {loading ? <div className="backup-empty">正在读取备份…</div> : null}
        {!loading && !backups.length ? (
          <div className="backup-empty">尚无备份。创建后可在这里核对版本、数量和完整性。</div>
        ) : null}
        {!loading && backups.length ? (
          <div className="backup-list">
            <div className="backup-list-head record-backup-list-row">
              <span>创建时间</span><span>类型</span><span>记录数</span><span>反馈 / 引用</span><span>大小</span><span>校验</span><span />
            </div>
            {backups.map((item) => (
              <div className="backup-row record-backup-list-row" key={item.id}>
                <time dateTime={item.createdAt}>{formatLocalTime(item.createdAt)}</time>
                <span>{backupKindLabel(item)}</span>
                <span>{item.recordCount ?? '—'}</span>
                <span>{item.feedbackCount ?? '—'} / {item.sourceReferenceCount ?? '—'}</span>
                <span>{formatFileSize(item.size)}</span>
                <Tag theme={item.integrity === 'ok' ? 'success' : 'danger'} variant="light">
                  {item.integrity === 'ok' ? `v${item.schemaVersion} 可用` : '校验失败'}
                </Tag>
                <Button
                  disabled={busy || item.integrity !== 'ok' || !status?.writable}
                  onClick={() => setRestoreTarget(item)}
                  size="small"
                  variant="text"
                >
                  恢复
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="maintenance-note">
        <strong>恢复与数据边界</strong>
        <p>恢复前会复验目标并自动备份当前记录；替换失败会回滚原库。备份不复制源素材、模型凭据或外部 PDF。</p>
      </section>

      {restoreTarget ? (
        <div className="modal-backdrop" role="presentation">
          <section aria-labelledby="record-restore-title" aria-modal="true" className="app-modal" role="dialog">
            <Tag theme="warning" variant="light">将替换当前分析记录</Tag>
            <h2 id="record-restore-title">恢复 {formatLocalTime(restoreTarget.createdAt)} 的备份？</h2>
            <p>
              当前记录库将替换为包含 {restoreTarget.recordCount ?? '未知数量'} 条确认记录的已验证备份。
              恢复前会自动创建当前数据的安全备份；源素材和外部 PDF 不会被删除。
            </p>
            <div className="modal-actions">
              <Button disabled={busy} onClick={() => setRestoreTarget(null)} variant="outline">取消</Button>
              <Button loading={busy} onClick={() => void restore()} theme="warning">确认恢复</Button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
};

const DetailSection = ({
  items,
  title,
}: {
  items: string[];
  title: string;
}): React.JSX.Element | null =>
  items.length ? (
    <section className="record-detail-card">
      <h2>{title}</h2>
      <ul className="record-bullet-list">
        {items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
      </ul>
    </section>
  ) : null;

interface RecordDetailProps {
  record: AnalysisRecord;
  onBack: () => void;
  onDeleted: () => void;
  onOpenRecord: (id: string) => void;
  onReanalyze: (record: AnalysisRecord, material: MaterialSession) => void;
  onRefresh: () => Promise<void>;
}

const RecordDetail = ({
  record,
  onBack,
  onDeleted,
  onOpenRecord,
  onReanalyze,
  onRefresh,
}: RecordDetailProps): React.JSX.Element => {
  const [rating, setRating] = useState(String(record.feedback?.rating ?? 4));
  const [reason, setReason] = useState(record.feedback?.reason ?? '');
  const [weightDirection, setWeightDirection] = useState(
    record.feedback?.weightDirection ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [reanalysisBusy, setReanalysisBusy] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(true);
  const [sourceSession, setSourceSession] = useState<MaterialSession | null>(null);
  const [sourceStatus, setSourceStatus] = useState<MaterialSourceStatus>(
    record.material.sourceStatus,
  );
  const sourceSessionRef = useRef<MaterialSession | null>(null);
  const sourceOwnershipTransferred = useRef(false);
  const sourcePreviewRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const replaceSourceSession = useCallback((session: MaterialSession | null): void => {
    const previous = sourceSessionRef.current;
    if (previous && previous.sessionId !== session?.sessionId) {
      void window.materialApi.media.release(previous.sessionId);
    }
    sourceSessionRef.current = session;
    setSourceSession(session);
  }, []);

  useEffect(() => {
    let active = true;
    sourceOwnershipTransferred.current = false;
    setSourceBusy(true);
    setSourceStatus(record.material.sourceStatus);
    void window.materialApi.records.openSource(record.id).then((result) => {
      if (!active) {
        if (result.ok && result.data.session) {
          void window.materialApi.media.release(result.data.session.sessionId);
        }
        return;
      }
      setSourceBusy(false);
      if (!result.ok) {
        setSourceStatus('needs_relocation');
        setError(result.error.message);
        return;
      }
      setSourceStatus(result.data.sourceStatus);
      replaceSourceSession(result.data.session);
    });
    return () => {
      active = false;
      const current = sourceSessionRef.current;
      if (current && !sourceOwnershipTransferred.current) {
        void window.materialApi.media.release(current.sessionId);
      }
      sourceSessionRef.current = null;
    };
  }, [record.id, record.material.sourceStatus, replaceSourceSession]);

  useEffect(() => {
    setRating(String(record.feedback?.rating ?? 4));
    setReason(record.feedback?.reason ?? '');
    setWeightDirection(record.feedback?.weightDirection ?? '');
    setError('');
    setSuccess('');
  }, [record]);

  const relocateSource = async (
    refreshRecord = true,
  ): Promise<MaterialSession | null> => {
    setSourceBusy(true);
    setError('');
    setSuccess('');
    const result = await window.materialApi.records.relocateSource(record.id);
    setSourceBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return null;
    }
    if (result.data.cancelled) return null;
    setSourceStatus(result.data.sourceStatus);
    if (result.data.mismatch) {
      setError(
        `所选文件“${result.data.mismatch.candidate.name}”与原素材指纹不一致，旧引用和报告均未改变`,
      );
      return null;
    }
    replaceSourceSession(result.data.session);
    setSuccess('源素材已通过完整指纹校验，播放和证据定位已恢复。');
    if (refreshRecord) await onRefresh();
    return result.data.session;
  };

  const saveFeedback = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setSuccess('');
    const result = await window.materialApi.records.saveFeedback(record.id, {
      rating: Number(rating),
      reason,
      weightDirection,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSuccess('报告反馈已保存，不会修改报告或评分规则。');
    await onRefresh();
  };

  const clearFeedback = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setSuccess('');
    const result = await window.materialApi.records.clearFeedback(record.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setRating('4');
    setReason('');
    setWeightDirection('');
    setSuccess('报告反馈已删除，报告正文保持不变。');
    await onRefresh();
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError('');
    const result = await window.materialApi.records.remove(record.id);
    setBusy(false);
    if (!result.ok) {
      setConfirmDelete(false);
      setError(result.error.message);
      return;
    }
    setConfirmDelete(false);
    onDeleted();
  };

  const startReanalysis = async (): Promise<void> => {
    if (!record.material.fingerprintSha256) {
      setError('该记录没有可校验的素材指纹，无法安全发起重新分析');
      return;
    }
    setReanalysisBusy(true);
    setError('');
    setSuccess('');
    const restored = sourceSessionRef.current ?? await relocateSource(false);
    setReanalysisBusy(false);
    if (!restored) return;
    sourceOwnershipTransferred.current = true;
    onReanalyze(record, restored);
  };

  const locateEvidence = (milliseconds: number): void => {
    sourcePreviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, milliseconds / 1_000);
      videoRef.current.focus();
    } else {
      sourcePreviewRef.current?.focus();
    }
  };

  const exportPdf = async (): Promise<void> => {
    setExportBusy(true);
    setError('');
    setSuccess('');
    const result = await window.materialApi.records.exportPdf(record.id);
    setExportBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (result.data.cancelled) return;
    setSuccess(`PDF 已导出：${result.data.fileName ?? '分析报告.pdf'}`);
  };

  const sourceUnavailable = sourceStatus !== 'available' || !sourceSession;

  return (
    <main className="page-shell record-detail-page">
      <header className="page-header record-detail-header">
        <div>
          <button className="text-back" onClick={onBack} type="button">← 返回分析记录</button>
          <h1>{record.material.displayName}</h1>
          <p>
            已确认报告 · {formatLocalTime(record.confirmedAt)} · {industryLabel(record.industry)}{mediaLabel(record.material.mediaKind)}
          </p>
        </div>
        <div className="header-actions">
          <Button
            loading={reanalysisBusy}
            onClick={() => void startReanalysis()}
            variant="outline"
          >
            {sourceUnavailable ? '重新定位并分析' : '使用原素材重新分析'}
          </Button>
          <Button loading={exportBusy} onClick={() => void exportPdf()} theme="primary">导出 PDF</Button>
          <Button onClick={() => setConfirmDelete(true)} theme="danger" variant="outline">删除</Button>
        </div>
      </header>

      {error ? <div className="page-alert is-error" role="alert">{error}</div> : null}
      {success ? <div className="page-alert is-success" role="status">{success}</div> : null}
      {sourceUnavailable ? (
        <div className="record-source-alert" role="status">
          <strong>{sourceBusy ? '正在校验源素材' : `源素材${sourceStatusLabel(sourceStatus)}`}</strong>
          <span>报告、反馈和 PDF 仍可使用；选择同一指纹文件后恢复播放、证据定位与重新分析。</span>
          {!sourceBusy ? (
            <Button onClick={() => void relocateSource()} size="small" variant="outline">
              重新定位
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="record-detail-grid">
        <div className="record-detail-main">
          <section className="record-detail-card record-report-overview">
            <div className="record-card-heading">
              <h2>确认报告</h2>
              <span>{record.rules.templateId} · 评分规则 {record.rules.scoringRuleVersion}</span>
            </div>
            <div className="record-score-summary">
              <div><strong>{record.report.score.total ?? '—'}</strong><span>素材总评分</span></div>
              <div>
                <h3>{record.report.title}</h3>
                <p>{record.report.summary}</p>
                <div className="record-tag-row">
                  {record.report.tags.map((tag, index) => (
                    <Tag key={`${tag.label}-${index}`} theme="primary" variant="light">
                      {tag.label}{tag.source === 'dynamic' ? ' · 动态' : ''}
                    </Tag>
                  ))}
                </div>
              </div>
            </div>
            {record.report.score.dimensions.length ? (
              <div className="record-dimension-grid">
                {record.report.score.dimensions.map((dimension) => (
                  <div key={dimension.id}>
                    <span>{dimension.label}</span><strong>{dimension.score ?? '—'}</strong>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="record-detail-card">
            <div className="record-card-heading">
              <h2>问题诊断与建议</h2>
              <span>确认时快照，不在详情页重算</span>
            </div>
            {record.report.diagnoses.length ? (
              <div className="record-diagnosis-list">
                {record.report.diagnoses.map((diagnosis, index) => (
                  <article key={`${diagnosis.problem}-${index}`}>
                    <strong>{diagnosis.problem}</strong>
                    <p>{diagnosis.suggestion}</p>
                    <span>{diagnosis.evidenceIds.length} 条证据引用</span>
                  </article>
                ))}
              </div>
            ) : <p className="record-muted">该报告没有问题诊断。</p>}
          </section>

          <div className="record-section-grid">
            <DetailSection items={record.report.scriptStructure} title="脚本结构" />
            <DetailSection items={record.report.shotSummary} title="镜头拆解" />
            <DetailSection items={record.report.visualSummary} title="画面内容" />
            <DetailSection items={record.report.subtitleSummary} title="字幕" />
            <DetailSection items={record.report.voiceAndSoundSummary} title="口播与声音" />
            <DetailSection items={record.report.sellingPoints} title="卖点 / 玩法" />
            <DetailSection items={record.report.emotionSummary} title="情绪" />
            <DetailSection items={record.report.ctaSummary} title="CTA" />
          </div>

          <section className="record-detail-card">
            <h2>时间证据</h2>
            {record.report.evidence.length ? (
              <div className="record-evidence-list">
                {record.report.evidence.map((evidence) => (
                  <div key={evidence.id}>
                    <strong>{evidence.label}</strong>
                    <p>{evidence.summary}</p>
                    <span>
                      {evidence.startMs === null ? '无时间定位' : `${(evidence.startMs / 1000).toFixed(1)}s`}
                      {evidence.endMs === null ? '' : ` – ${(evidence.endMs / 1000).toFixed(1)}s`}
                      {' · '}{evidence.source === 'tool' ? '工具' : evidence.source === 'model' ? '模型' : '融合'}
                    </span>
                    {evidence.startMs !== null ? (
                      <button
                        disabled={sourceUnavailable}
                        onClick={() => locateEvidence(evidence.startMs as number)}
                        type="button"
                      >
                        {sourceUnavailable ? '素材恢复后可定位' : `定位到 ${formatReferenceTime(evidence.startMs)}`}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : <p className="record-muted">该报告没有可展示的时间证据。</p>}
          </section>

          {record.visibleConversation.length ? (
            <section className="record-detail-card">
              <div className="record-card-heading">
                <h2>确认时的对话分析</h2>
                <span>只保存用户可见内容，不包含内部提示词</span>
              </div>
              <div className="record-conversation-list">
                {record.visibleConversation.map((item, index) => (
                  <article className={`is-${item.role}`} key={`${item.role}-${index}`}>
                    <span>{item.role === 'user' ? '你' : '分析助手'}</span>
                    <p>{item.text}</p>
                    {item.timeReferenceMs !== null ? (
                      <small>引用 {formatReferenceTime(item.timeReferenceMs)}</small>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <section className="record-detail-card record-feedback-card">
            <div className="record-card-heading">
              <h2>报告反馈</h2>
              <span>与素材评分分离，不自动调权</span>
            </div>
            <div className="record-feedback-grid">
              <label>
                <span>内容可信程度</span>
                <select onChange={(event) => setRating(event.target.value)} value={rating}>
                  <option value="1">1 / 5 · 不可信</option>
                  <option value="2">2 / 5</option>
                  <option value="3">3 / 5</option>
                  <option value="4">4 / 5</option>
                  <option value="5">5 / 5 · 高度可信</option>
                </select>
              </label>
              <label>
                <span>可用性原因（选填）</span>
                <textarea maxLength={2000} onChange={(event) => setReason(event.target.value)} value={reason} />
              </label>
              <label>
                <span>希望加强的权重方向（选填）</span>
                <textarea maxLength={2000} onChange={(event) => setWeightDirection(event.target.value)} value={weightDirection} />
              </label>
            </div>
            <div className="record-feedback-actions">
              {record.feedback ? (
                <Button disabled={busy} onClick={() => void clearFeedback()} variant="text">删除反馈</Button>
              ) : <span />}
              <Button loading={busy} onClick={() => void saveFeedback()} theme="primary">保存反馈</Button>
            </div>
          </section>
        </div>

        <aside className="record-detail-side">
          <section className="record-detail-card record-source-card">
            <div className="record-card-heading">
              <h2>源素材</h2>
              <Tag theme={sourceStatusTheme(sourceStatus)} variant="light">
                {sourceBusy ? '校验中' : sourceStatusLabel(sourceStatus)}
              </Tag>
            </div>
            <div
              className={`record-source-preview ${sourceUnavailable ? 'is-unavailable' : ''}`}
              ref={sourcePreviewRef}
              tabIndex={-1}
            >
              {sourceSession && record.material.mediaKind === 'video' ? (
                <video
                  controls
                  preload="metadata"
                  ref={videoRef}
                  src={sourceSession.previewUrl}
                >
                  当前系统无法播放该视频。
                </video>
              ) : null}
              {sourceSession && record.material.mediaKind === 'image' ? (
                <img alt={record.material.displayName} src={sourceSession.previewUrl} />
              ) : null}
              {!sourceSession ? (
                <div className="record-source-placeholder">
                  <span>{record.material.mediaKind === 'video' ? '视' : '图'}</span>
                  <strong>{sourceBusy ? '正在校验本地文件' : '源素材当前不可用'}</strong>
                  <p>应用不复制素材；重新定位仅接受与记录完整指纹一致的文件。</p>
                  {!sourceBusy ? (
                    <Button onClick={() => void relocateSource()} size="small" variant="outline">
                      选择原文件
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          <section className="record-detail-card">
            <h2>记录信息</h2>
            <dl className="record-info-list">
              <div><dt>行业 / 媒体</dt><dd>{industryLabel(record.industry)} · {mediaLabel(record.material.mediaKind)}</dd></div>
              <div><dt>产品快照</dt><dd>{record.productSnapshot?.name ?? '未绑定产品'}</dd></div>
              <div><dt>模型配置</dt><dd>{record.run.modelConfigurationName}</dd></div>
              <div><dt>模型来源</dt><dd>{record.run.providerId ?? '旧记录未保存'}</dd></div>
              <div><dt>目录选择</dt><dd>{record.run.modelId}</dd></div>
              <div><dt>请求模型</dt><dd>{providerRequestedModelLabel(record)}</dd></div>
              <div>
                <dt>实际模型</dt>
                <dd>
                  {record.run.providerReturnedModelId ?? '暂未返回 / 旧记录未保存'}
                  {record.run.providerReturnedModelId
                    && record.run.providerReturnedModelId !== providerRequestedModelLabel(record)
                    ? '（与请求不同）' : ''}
                </dd>
              </div>
              <div>
                <dt>推理强度</dt>
                <dd>{record.run.providerReasoningEffort ?? '不适用 / 旧记录未保存'}</dd>
              </div>
              <div><dt>适配器 / 运行时</dt><dd>{record.run.adapterVersion ?? '旧记录未保存'}</dd></div>
              <div>
                <dt>配置版本</dt>
                <dd>
                  {record.run.modelConfigurationId ?? '旧记录未保存'} · v{
                    record.run.modelConfigurationVersion ?? '—'
                  }
                </dd>
              </div>
              <div><dt>Token 用量</dt><dd>{recordUsageLabel(record)}</dd></div>
              <div><dt>确认时间</dt><dd>{formatLocalTime(record.confirmedAt)}</dd></div>
              <div><dt>本地大小</dt><dd>{Math.max(0, record.material.byteSize / 1024 / 1024).toFixed(1)} MB</dd></div>
            </dl>
          </section>

          <section className="record-detail-card">
            <h2>重新分析关系</h2>
            <div className="record-relations">
              {record.sourceRecordId ? (
                record.sourceRecordAvailable ? (
                  <button onClick={() => onOpenRecord(record.sourceRecordId as string)} type="button">
                    查看来源记录
                  </button>
                ) : <span>来源记录已删除</span>
              ) : <span>不是由历史记录重新分析</span>}
              {record.subsequentRecords.map((item) => (
                <button key={item.id} onClick={() => onOpenRecord(item.id)} type="button">
                    {item.materialDisplayName} · 评分 {item.totalScore ?? '未评分'}
                </button>
              ))}
              {!record.subsequentRecords.length ? <small>尚无后续重新分析记录</small> : null}
            </div>
          </section>

          {record.report.limitations.length ? (
            <section className="record-detail-card">
              <h2>分析局限</h2>
              <ul className="record-bullet-list">
                {record.report.limitations.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>

      {confirmDelete ? (
        <div className="modal-backdrop" role="presentation">
          <section aria-labelledby="record-delete-title" aria-modal="true" className="app-modal" role="dialog">
            <Tag theme="danger" variant="light">删除后客户端不可恢复</Tag>
            <h2 id="record-delete-title">删除 {record.material.displayName} 的分析记录？</h2>
            <p>
              将删除 {formatLocalTime(record.confirmedAt)} 确认的报告、快照和反馈。
              源素材、其他分析记录和已经导出的文件不会删除。
            </p>
            <div className="modal-actions">
              <Button disabled={busy} onClick={() => setConfirmDelete(false)} variant="outline">取消</Button>
              <Button loading={busy} onClick={() => void remove()} theme="danger">确认删除</Button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
};

export const RecordsPage = ({
  initialRecordId = null,
  onCreate,
  onInitialRecordOpened,
  onReanalyze,
}: RecordsPageProps): React.JSX.Element => {
  const [items, setItems] = useState<AnalysisRecordListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [industry, setIndustry] = useState<RecordIndustry | ''>('');
  const [mediaKind, setMediaKind] = useState<RecordMediaKind | ''>('');
  const [sourceStatus, setSourceStatus] = useState<MaterialSourceStatus | ''>('');
  const [feedbackState, setFeedbackState] = useState<RecordFeedbackState | ''>('');
  const [confirmedFrom, setConfirmedFrom] = useState('');
  const [confirmedTo, setConfirmedTo] = useState('');
  const [sort, setSort] = useState<RecordSort>('confirmed_desc');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<AnalysisRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [maintenance, setMaintenance] = useState(false);
  const listScrollTop = useRef(0);

  const listQuery: AnalysisRecordQuery = {
    query,
    industry,
    mediaKind,
    sourceStatus,
    feedbackState,
    confirmedFrom,
    confirmedTo,
    sort,
    limit: PAGE_SIZE,
    offset,
  };

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const result = await window.materialApi.records.list(listQuery);
    if (result.ok) {
      if (result.data.total > 0 && offset >= result.data.total) {
        setOffset(Math.floor((result.data.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        setLoading(false);
        return;
      }
      setItems(result.data.items);
      setTotal(result.data.total);
      setError('');
    } else {
      setError(result.error.message);
    }
    setLoading(false);
  }, [confirmedFrom, confirmedTo, feedbackState, industry, mediaKind, offset, query, sort, sourceStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const openRecord = useCallback(async (id: string): Promise<boolean> => {
    setDetailLoading(true);
    const result = await window.materialApi.records.get(id);
    setDetailLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return false;
    }
    setSelected(result.data);
    setError('');
    return true;
  }, []);

  useEffect(() => {
    if (!initialRecordId) return;
    void openRecord(initialRecordId).then((opened) => {
      if (opened) {
        const container = document.querySelector('.app-content');
        if (container) container.scrollTop = 0;
      }
      onInitialRecordOpened?.();
    });
  }, [initialRecordId, onInitialRecordOpened, openRecord]);

  const openFromList = (id: string): void => {
    listScrollTop.current = document.querySelector('.app-content')?.scrollTop ?? 0;
    void openRecord(id).then((opened) => {
      if (!opened) {
        return;
      }
      const container = document.querySelector('.app-content');
      if (container) {
        container.scrollTop = 0;
      }
    });
  };

  const returnToList = (): void => {
    setSelected(null);
    void load();
    requestAnimationFrame(() => {
      const container = document.querySelector('.app-content');
      if (container) {
        container.scrollTop = listScrollTop.current;
      }
    });
  };

  const refreshSelected = async (): Promise<void> => {
    if (selected) {
      await openRecord(selected.id);
      await load();
    }
  };

  const resetFilters = (): void => {
    setQuery('');
    setIndustry('');
    setMediaKind('');
    setSourceStatus('');
    setFeedbackState('');
    setConfirmedFrom('');
    setConfirmedTo('');
    setSort('confirmed_desc');
    setOffset(0);
  };

  if (maintenance) {
    return (
      <RecordMaintenance
        onBack={() => setMaintenance(false)}
        onRestored={() => {
          setSelected(null);
          setOffset(0);
          void load();
        }}
      />
    );
  }

  if (selected) {
    return (
      <RecordDetail
        record={selected}
        onBack={returnToList}
        onDeleted={() => {
          setSelected(null);
          void load();
        }}
        onOpenRecord={(id) => void openRecord(id)}
        onReanalyze={onReanalyze}
        onRefresh={refreshSelected}
      />
    );
  }

  const filtersActive = Boolean(
    query || industry || mediaKind || sourceStatus || feedbackState || confirmedFrom || confirmedTo,
  );
  const emptyLibrary = !loading && !error && !items.length && !filtersActive;
  const emptyResult = !loading && !error && !items.length && filtersActive;

  return (
    <main className="page-shell records-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">本地确认报告</span>
          <h1>分析记录</h1>
          <p>在本地查找、查看和管理已确认保存的素材分析报告。</p>
        </div>
        <div className="header-actions">
          <Button onClick={() => setMaintenance(true)} variant="outline">数据维护</Button>
          <Button onClick={onCreate} theme="primary">新建分析</Button>
        </div>
      </header>

      <section className="records-toolbar" aria-label="分析记录筛选">
        <Input
          clearable
          onChange={(value) => { setQuery(value); setOffset(0); }}
          placeholder="搜索素材名称或产品名称"
          value={query}
        />
        <select aria-label="筛选行业" onChange={(event) => { setIndustry(event.target.value as RecordIndustry | ''); setOffset(0); }} value={industry}>
          <option value="">全部行业</option><option value="apparel">服饰</option><option value="game">游戏</option>
        </select>
        <select aria-label="筛选媒体类型" onChange={(event) => { setMediaKind(event.target.value as RecordMediaKind | ''); setOffset(0); }} value={mediaKind}>
          <option value="">全部媒体</option><option value="video">视频</option><option value="image">图片</option>
        </select>
        <select aria-label="筛选源素材状态" onChange={(event) => { setSourceStatus(event.target.value as MaterialSourceStatus | ''); setOffset(0); }} value={sourceStatus}>
          <option value="">全部素材状态</option><option value="available">可用</option><option value="needs_relocation">需重新定位</option><option value="mismatch">文件不匹配</option>
        </select>
        <select aria-label="筛选反馈状态" onChange={(event) => { setFeedbackState(event.target.value as RecordFeedbackState | ''); setOffset(0); }} value={feedbackState}>
          <option value="">全部反馈</option><option value="rated">已评价</option><option value="unrated">未评价</option>
        </select>
        <label className="record-date-filter"><span>从</span><input aria-label="确认开始日期" onChange={(event) => { setConfirmedFrom(event.target.value); setOffset(0); }} type="date" value={confirmedFrom} /></label>
        <label className="record-date-filter"><span>至</span><input aria-label="确认结束日期" onChange={(event) => { setConfirmedTo(event.target.value); setOffset(0); }} type="date" value={confirmedTo} /></label>
        <select aria-label="确认时间排序" onChange={(event) => { setSort(event.target.value as RecordSort); setOffset(0); }} value={sort}>
          <option value="confirmed_desc">确认时间：从新到旧</option><option value="confirmed_asc">确认时间：从旧到新</option>
        </select>
      </section>

      <div className="records-filter-summary">
        <span>{loading ? '正在读取本地记录…' : `共 ${total} 条确认记录`}</span>
        {filtersActive ? <Button onClick={resetFilters} size="small" variant="text">清空全部条件</Button> : null}
      </div>

      {error ? (
        <div className="page-alert is-error records-error" role="alert">
          <span>{error}；已有结果和筛选条件已保留。</span>
          <Button onClick={() => void load()} size="small" variant="outline">重试</Button>
        </div>
      ) : null}
      {detailLoading ? <div className="records-loading" role="status">正在读取报告详情…</div> : null}

      {emptyLibrary ? (
        <section className="records-empty">
          <div className="records-empty-illustration" aria-hidden="true"><span /><span /><span /></div>
          <h2>尚无已确认的分析记录</h2>
          <p>只有报告生成后由你点击“确认并保存”且本地写入成功，才会出现在这里。</p>
          <Button onClick={onCreate} variant="outline">先选择一个素材</Button>
        </section>
      ) : null}

      {emptyResult ? (
        <section className="records-empty">
          <div className="records-empty-illustration" aria-hidden="true"><span /><span /><span /></div>
          <h2>没有符合当前条件的记录</h2>
          <p>记录库中可能仍有其他报告，可修改或清空当前筛选。</p>
          <Button onClick={resetFilters} variant="outline">清空全部条件</Button>
        </section>
      ) : null}

      {!loading && items.length ? (
        <>
          <section className="records-list" aria-label="分析记录列表">
            <div className="records-list-head">
              <span>素材</span><span>行业 / 媒体</span><span>产品快照</span><span>素材评分</span><span>可信反馈</span><span>源素材</span><span>确认时间</span><span />
            </div>
            {items.map((item) => (
              <button className="records-row" key={item.id} onClick={() => openFromList(item.id)} type="button">
                <span className="records-material-cell">
                  <span className="records-media-icon">{item.mediaKind === 'video' ? '视' : '图'}</span>
                  <span><strong>{item.materialDisplayName}</strong>{item.sourceRecordId ? <small>由历史记录重新分析</small> : null}</span>
                </span>
                <Tag theme="primary" variant="light">{industryLabel(item.industry)} · {mediaLabel(item.mediaKind)}</Tag>
                <span>{item.productDisplayName ?? '未绑定产品'}</span>
                <strong className="records-score">{item.totalScore ?? '未评分'}</strong>
                <Tag theme={item.feedback ? 'success' : 'warning'} variant="light">
                  {item.feedback ? `已评价 ${item.feedback.rating}/5` : '未评价'}
                </Tag>
                <Tag theme={sourceStatusTheme(item.sourceStatus)} variant="light">{sourceStatusLabel(item.sourceStatus)}</Tag>
                <time dateTime={item.confirmedAt}>{formatLocalTime(item.confirmedAt)}</time>
                <span className="row-action">查看 →</span>
              </button>
            ))}
          </section>
          <nav aria-label="分析记录分页" className="product-pagination">
            <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} size="small" variant="outline">上一页</Button>
            <span>第 {Math.floor(offset / PAGE_SIZE) + 1} 页，共 {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页</span>
            <Button disabled={offset + items.length >= total} onClick={() => setOffset(offset + PAGE_SIZE)} size="small" variant="outline">下一页</Button>
          </nav>
        </>
      ) : null}
    </main>
  );
};
