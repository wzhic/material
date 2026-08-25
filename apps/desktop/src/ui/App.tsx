import React, {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button, Input, Tag } from 'tdesign-react';

import {
  AnalysisDraft,
  formatFileSize,
  Industry,
  validateDraft,
} from '../analysis/draft';
import type {
  AnalysisRuntimeProgress,
  AnalysisRuntimeResult,
} from '../analysis-runtime/types';
import { MaterialSession } from '../media/types';
import { ModelConfigurationSummary } from '../model/types';
import { ProductListItem } from '../product/types';
import { createConfirmedRecordInput } from '../record/confirmation';
import { AnalysisReportPreviewPage } from './AnalysisReportPreviewPage';
import { ModelSettingsPage } from './ModelSettingsPage';
import { ProductLibraryPage } from './ProductLibraryPage';
import { RecordsPage } from './RecordsPage';

type AppPage = 'new-analysis' | 'products' | 'records' | 'report' | 'settings' | 'workspace';

type SelectedMaterial = MaterialSession;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const industryLabel = (industry: Industry): string => {
  if (industry === 'apparel') {
    return '服饰';
  }
  if (industry === 'game') {
    return '游戏';
  }
  return '未选择';
};

const formatTimelineTime = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

const MaterialLogo = (): React.JSX.Element => (
  <div className="brand-mark" aria-hidden="true">
    M
  </div>
);

interface SidebarProps {
  onNavigate: (page: AppPage) => void;
  page: AppPage;
}

const Sidebar = ({ onNavigate, page }: SidebarProps): React.JSX.Element => {
  const currentSection = page === 'workspace' || page === 'report' ? 'new-analysis' : page;

  return (
    <aside className="app-sidebar" aria-label="主导航">
      <div className="brand">
        <MaterialLogo />
        <div>
          <strong>Material</strong>
          <span>素材分析</span>
        </div>
      </div>

      <nav className="nav-list">
        <button
          className={`nav-item ${currentSection === 'new-analysis' ? 'is-active' : ''}`}
          onClick={() => onNavigate('new-analysis')}
          type="button"
        >
          <span className="nav-icon">＋</span>
          <span>新建分析</span>
        </button>
        <button
          className={`nav-item ${currentSection === 'records' ? 'is-active' : ''}`}
          onClick={() => onNavigate('records')}
          type="button"
        >
          <span className="nav-icon">▤</span>
          <span>分析记录</span>
        </button>
        <button
          className={`nav-item ${currentSection === 'products' ? 'is-active' : ''}`}
          onClick={() => onNavigate('products')}
          type="button"
        >
          <span className="nav-icon">◇</span>
          <span>产品库</span>
        </button>
      </nav>

      <div className="sidebar-spacer" />
      <div className="sidebar-status">
        <span className="status-dot" />
        <div>
          <strong>本地优先</strong>
          <span>素材不会复制到应用目录</span>
        </div>
      </div>
      <button
        className={`settings-entry ${currentSection === 'settings' ? 'is-active' : ''}`}
        onClick={() => onNavigate('settings')}
        type="button"
      >
        模型管理
        <span>BYOK</span>
      </button>
    </aside>
  );
};

interface ModelSelectionOption {
  configurationDisplayName: string;
  configurationId: string;
  label: string;
  modelId: string;
  value: string;
}

type RuntimeReportData = Extract<AnalysisRuntimeResult, { ok: true }>['data'];

interface ActiveAnalysisRun {
  clientRunId: string;
  conversionContext: string;
  data?: RuntimeReportData;
  error?: string;
  material: SelectedMaterial;
  materialName: string;
  progress: AnalysisRuntimeProgress[];
  status: 'cancelled' | 'failed' | 'running' | 'succeeded';
}

interface NewAnalysisPageProps {
  analysisBusy: boolean;
  conversionContext: string;
  industry: Industry;
  material: SelectedMaterial | null;
  modelId: string;
  modelOptions: ModelSelectionOption[];
  productId: string;
  products: ProductListItem[];
  onConversionContextChange: (value: string) => void;
  onIndustryChange: (value: Industry) => void;
  onMaterialChange: (value: SelectedMaterial | null) => void;
  onModelChange: (value: string) => void;
  onProductChange: (value: string) => void;
  onPreviewWorkspace: () => void;
  onStartAnalysis: (material: SelectedMaterial) => void;
}

const NewAnalysisPage = ({
  analysisBusy,
  conversionContext,
  industry,
  material,
  modelId,
  modelOptions,
  productId,
  products,
  onConversionContextChange,
  onIndustryChange,
  onMaterialChange,
  onModelChange,
  onProductChange,
  onPreviewWorkspace,
  onStartAnalysis,
}: NewAnalysisPageProps): React.JSX.Element => {
  const [fileError, setFileError] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const draft: AnalysisDraft = {
    industry,
    material: material?.summary ?? null,
    modelId,
  };
  const validation = validateDraft(draft);
  const compatibleProducts = products.filter((product) => product.industry === industry);
  const selectedProduct = products.find((product) => product.id === productId);
  const selectedModel = modelOptions.find((option) => option.value === modelId);

  const handleSelectMaterial = async (): Promise<void> => {
    setFileBusy(true);
    setFileError('');
    const result = await window.materialApi.media.select();
    setFileBusy(false);
    if (!result.ok) {
      setFileError(result.error.message);
      return;
    }
    if (!result.data.cancelled) {
      onMaterialChange(result.data.session);
    }
  };

  const handleInspectMaterial = async (
    nextAction: 'none' | 'preview' | 'start' = 'none',
  ): Promise<void> => {
    if (!material) {
      return;
    }
    setFileBusy(true);
    setFileError('');
    const result = await window.materialApi.media.inspect(material.sessionId);
    setFileBusy(false);
    if (!result.ok) {
      setFileError(result.error.message);
      return;
    }
    onMaterialChange(result.data);
    if (result.data.sourceStatus === 'available') {
      if (nextAction === 'preview') {
        onPreviewWorkspace();
      } else if (nextAction === 'start') {
        onStartAnalysis(result.data);
      }
      return;
    }
    setFileError(
      result.data.sourceStatus === 'mismatch'
        ? '素材内容已发生变化。请选择原文件，或移除后把新文件作为新素材。'
        : '素材已移动、删除或权限失效，请重新定位同一个文件。',
    );
  };

  const handleRelocateMaterial = async (): Promise<void> => {
    if (!material) {
      return;
    }
    setFileBusy(true);
    setFileError('');
    const result = await window.materialApi.media.relocate(material.sessionId);
    setFileBusy(false);
    if (!result.ok) {
      setFileError(result.error.message);
      return;
    }
    if (result.data.cancelled) {
      return;
    }
    onMaterialChange(result.data.session);
    if (result.data.mismatch) {
      setFileError(
        `所选文件与原素材不一致：需要 ${result.data.mismatch.expected.name}，当前选择 ${result.data.mismatch.candidate.name}。旧引用未被替换。`,
      );
    }
  };

  return (
    <main className="page-shell new-analysis-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">单素材分析</span>
          <h1>新建分析</h1>
          <p>选择一个本地视频或图片，确认本次分析上下文。</p>
        </div>
        <Tag theme="primary" variant="light">
          V1 开发中
        </Tag>
      </header>

      <div className="new-analysis-grid">
        <section className="form-card" aria-labelledby="material-heading">
          <div className="section-heading">
            <div>
              <h2 id="material-heading">源素材</h2>
              <p>单次仅选择一个文件；文件仍保存在原位置。</p>
            </div>
            {material ? (
              <div className="material-actions">
                <Button
                  disabled={fileBusy || analysisBusy}
                  onClick={() => void handleInspectMaterial('none')}
                  size="small"
                  variant="text"
                >
                  检查素材
                </Button>
                <Button
                  disabled={fileBusy || analysisBusy}
                  loading={fileBusy}
                  onClick={() => void handleSelectMaterial()}
                  size="small"
                  variant="outline"
                >
                  重新选择
                </Button>
              </div>
            ) : null}
          </div>

          {material ? (
            <div className="material-preview-card">
              <div className="media-preview">
                {material.summary.kind === 'video' ? (
                  <video
                    aria-label={`视频预览：${material.summary.name}`}
                    controls
                    preload="metadata"
                    src={material.previewUrl}
                  />
                ) : (
                  <img
                    alt={`图片预览：${material.summary.name}`}
                    src={material.previewUrl}
                  />
                )}
              </div>
              <div className="material-meta">
                <Tag theme="success" variant="light">
                  {material.summary.kind === 'video' ? '视频' : '图片'}
                </Tag>
                <strong title={material.summary.name}>{material.summary.name}</strong>
                <span>{formatFileSize(material.summary.size)}</span>
                <span>{material.summary.mimeType}</span>
                <span title={material.summary.fingerprintSha256}>
                  指纹 {material.summary.fingerprintSha256.slice(0, 12)}…
                </span>
                <Tag
                  theme={material.sourceStatus === 'available' ? 'success' : 'warning'}
                  variant="light"
                >
                  {material.sourceStatus === 'available'
                    ? '本地可用'
                    : material.sourceStatus === 'mismatch'
                      ? '文件不匹配'
                      : '需重新定位'}
                </Tag>
              </div>
              <button
                aria-label="移除已选择素材"
                className="remove-material"
                disabled={analysisBusy}
                onClick={() => onMaterialChange(null)}
                type="button"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              className="file-dropzone"
              disabled={fileBusy || analysisBusy}
              onClick={() => void handleSelectMaterial()}
              type="button"
            >
              <span className="upload-glyph">↑</span>
              <strong>{fileBusy ? '正在读取并生成素材指纹…' : '选择本地视频或图片'}</strong>
              <span>支持常见视频、图片格式；暂不支持组图和批量导入</span>
              <span className="choose-file-pill">{fileBusy ? '请稍候' : '浏览文件'}</span>
            </button>
          )}

          {material && material.sourceStatus !== 'available' ? (
            <div className="material-recovery" role="status">
              <span>分析配置已保留，重新定位同一素材后可继续。</span>
              <Button
                disabled={fileBusy || analysisBusy}
                loading={fileBusy}
                onClick={() => void handleRelocateMaterial()}
                size="small"
                variant="outline"
              >
                重新定位
              </Button>
            </div>
          ) : null}

          {fileError ? (
            <div className="inline-message is-error" role="alert">
              {fileError}
            </div>
          ) : null}

          <div className="form-divider" />

          <div className="field-grid">
            <label className="form-field">
              <span className="field-label">
                行业 <em>必填</em>
              </span>
              <select
                aria-label="选择素材行业"
                disabled={analysisBusy}
                onChange={(event) =>
                  onIndustryChange(event.target.value as Industry)
                }
                value={industry}
              >
                <option value="">请选择行业</option>
                <option value="apparel">服饰</option>
                <option value="game">游戏</option>
              </select>
              <small>导入时确定，决定后续模板与评分规则。</small>
            </label>

            <label className="form-field">
              <span className="field-label">关联产品</span>
              <select
                aria-label="关联产品"
                disabled={!industry || analysisBusy}
                onChange={(event) => onProductChange(event.target.value)}
                value={productId}
              >
                <option value="">不绑定产品</option>
                {compatibleProducts.map((product) => (
                  <option key={product.id} value={product.id}>{product.name}</option>
                ))}
              </select>
              <small>
                {!industry
                  ? '请先选择行业。'
                  : compatibleProducts.length
                    ? '绑定始终可选，一次最多选择一个产品。'
                    : '当前行业还没有产品，可前往产品库创建。'}
              </small>
            </label>

            <label className="form-field">
              <span className="field-label">
                分析模型 <em>必填</em>
              </span>
              <select
                aria-label="选择分析模型"
                disabled={analysisBusy}
                onChange={(event) => onModelChange(event.target.value)}
                value={modelId}
              >
                <option value="">
                  {modelOptions.length ? '请选择分析模型' : '暂无可用模型'}
                </option>
                {modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <small>
                {modelOptions.length
                  ? '模型由你显式选择；同一任务不会静默切换。'
                  : '请前往“模型管理”保存并验证用户自有 Key。'}
              </small>
            </label>

            <label className="form-field field-span-two">
              <span className="field-label">转化依据或关注点</span>
              <Input
                disabled={analysisBusy}
                maxlength={240}
                onChange={onConversionContextChange}
                placeholder="选填，例如：突出轻薄面料与通勤场景"
                value={conversionContext}
              />
              <small>留空时由后续真实分析根据素材判断。</small>
            </label>
          </div>
        </section>

        <aside className="summary-card" aria-labelledby="summary-heading">
          <div className="summary-card-header">
            <span>开始前复核</span>
            <Tag variant="light">本次分析</Tag>
          </div>
          <h2 id="summary-heading">配置摘要</h2>

          <dl className="summary-list">
            <div>
              <dt>素材</dt>
              <dd>{material?.summary.name ?? '尚未选择'}</dd>
            </div>
            <div>
              <dt>类型</dt>
              <dd>
                {material
                  ? material.summary.kind === 'video'
                    ? '视频'
                    : '图片'
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>行业</dt>
              <dd>{industryLabel(industry)}</dd>
            </div>
            <div>
              <dt>产品</dt>
              <dd>{selectedProduct?.name ?? '不绑定产品'}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd>{selectedModel?.label ?? '尚未配置'}</dd>
            </div>
          </dl>

          <div className="readiness-panel">
            <strong>{validation.errors.length ? '开始前还需完成' : '分析上下文已就绪'}</strong>
            <ul>
              {validation.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
              {validation.errors.length === 0 ? (
                <li>素材、行业和所选模型已就绪，可以启动本次分析。</li>
              ) : null}
            </ul>
          </div>

          <Button
            block
            disabled={!validation.canStartAnalysis || fileBusy || analysisBusy}
            loading={analysisBusy}
            onClick={() => void handleInspectMaterial('start')}
            theme="primary"
          >
            开始分析
          </Button>
          <Button
            block
            disabled={!validation.canPreviewWorkspace || fileBusy || analysisBusy}
            loading={fileBusy}
            onClick={() => void handleInspectMaterial('preview')}
            variant="outline"
          >
            预览分析工作区
          </Button>
          <p className="summary-footnote">
            分析会调用所选模型并生成待确认预览；本阶段不会保存分析记录。
          </p>
        </aside>
      </div>
    </main>
  );
};

interface WorkspacePageProps {
  conversionContext: string;
  industry: Industry;
  material: SelectedMaterial;
  onBack: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onViewReport: () => void;
  productName: string | null;
  run: ActiveAnalysisRun | null;
}

const WorkspacePage = ({
  conversionContext,
  industry,
  material,
  onBack,
  onCancel,
  onRetry,
  onViewReport,
  productName,
  run,
}: WorkspacePageProps): React.JSX.Element => {
  const stageRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const [mediaPercent, setMediaPercent] = useState(58);
  const [panelTab, setPanelTab] = useState<'conversation' | 'progress'>('conversation');
  const [timelineHeight, setTimelineHeight] = useState(292);
  const report = run?.data?.report;
  const durationMs = Math.max(run?.data?.media.durationMs ?? 0, 1);
  const evidenceById = new Map(report?.evidence.map((item) => [item.evidenceId, item]) ?? []);
  const emotionPoints = (report?.emotion ?? [])
    .filter((item) => item.timeMs !== null && item.intensity !== null)
    .map((item) => ({
      ...item,
      x: ((item.timeMs as number) / durationMs) * 1000,
      y: 32 - ((item.intensity as number) * 22),
    }));
  const emotionPath = emotionPoints.map((item) => `${item.x},${item.y}`).join(' ');
  const runtimeLabel = run?.status === 'running'
    ? '分析运行中'
    : run?.status === 'succeeded'
      ? '报告待确认'
      : run?.status === 'cancelled'
        ? '分析已取消'
        : run?.status === 'failed'
          ? '分析未完成'
          : '工作区预览';

  const timelineTrack = (
    tracks: Array<'audio' | 'ocr' | 'shot' | 'speech'>,
  ): React.JSX.Element => {
    const entries = report?.timeline.filter((item) => tracks.includes(item.track)) ?? [];
    if (!entries.length) {
      return <div className="empty-track"><span>当前没有可靠的时间证据</span></div>;
    }
    return (
      <div className={`populated-track is-${tracks.join('-')}`}>
        {entries.map((item) => {
          const left = clamp((item.startMs / durationMs) * 100, 0, 100);
          const end = item.endMs ?? item.startMs + Math.max(500, durationMs * 0.02);
          const width = clamp(((end - item.startMs) / durationMs) * 100, 1.5, 100 - left);
          return (
            <span
              key={item.evidenceId}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={evidenceById.get(item.evidenceId)?.text ?? item.evidenceId}
            >
              {evidenceById.get(item.evidenceId)?.text ?? item.track}
            </span>
          );
        })}
      </div>
    );
  };

  const beginHorizontalResize = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    event.preventDefault();

    const move = (moveEvent: PointerEvent): void => {
      const percentage = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setMediaPercent(clamp(percentage, 38, 72));
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const beginVerticalResize = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    event.preventDefault();

    const move = (moveEvent: PointerEvent): void => {
      setTimelineHeight(
        clamp(rect.bottom - moveEvent.clientY, 220, Math.min(440, rect.height * 0.55)),
      );
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const resizeHorizontalByKeyboard = (
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setMediaPercent((current) =>
        clamp(current + (event.key === 'ArrowLeft' ? -2 : 2), 38, 72),
      );
    }
  };

  const resizeVerticalByKeyboard = (
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setTimelineHeight((current) =>
        clamp(current + (event.key === 'ArrowUp' ? 16 : -16), 220, 440),
      );
    }
  };

  return (
    <main
      ref={workspaceRef}
      className="workspace-page"
      style={{ gridTemplateRows: `minmax(300px, 1fr) 8px ${timelineHeight}px` }}
    >
      <section
        ref={stageRef}
        className="workspace-stage"
        style={{ gridTemplateColumns: `${mediaPercent}% 8px minmax(300px, 1fr)` }}
      >
        <div className="source-panel">
          <div className="workspace-toolbar">
            <Button onClick={onBack} size="small" variant="text">
              ← 返回配置
            </Button>
            <div className="workspace-title">
              <strong>{material.summary.name}</strong>
              <span>
                {industryLabel(industry)} ·{' '}
                {material.summary.kind === 'video' ? '视频' : '图片'}
                {productName ? ` · ${productName}` : ''}
              </span>
            </div>
            <Tag
              theme={run?.status === 'succeeded' ? 'success' : run?.status === 'failed' ? 'danger' : 'warning'}
              variant="light"
            >
              {runtimeLabel}
            </Tag>
          </div>
          <div className="source-viewer">
            {material.summary.kind === 'video' ? (
              <video controls preload="metadata" src={material.previewUrl} />
            ) : (
              <img alt={material.summary.name} src={material.previewUrl} />
            )}
          </div>
          <div className="viewer-meta">
            <span>源素材可播放</span>
            <span>{formatFileSize(material.summary.size)}</span>
            <span>未复制到应用目录</span>
            {run?.status === 'running' ? <span>解析与模型调用进行中</span> : null}
          </div>
        </div>

        <div
          aria-label="调整播放器与对话区域宽度"
          aria-orientation="vertical"
          aria-valuemax={72}
          aria-valuemin={38}
          aria-valuenow={Math.round(mediaPercent)}
          className="panel-resizer is-horizontal"
          onKeyDown={resizeHorizontalByKeyboard}
          onPointerDown={beginHorizontalResize}
          role="separator"
          tabIndex={0}
        >
          <span />
        </div>

        <aside className="conversation-panel">
          <div className="panel-tabs" role="tablist">
            <button
              aria-selected={panelTab === 'conversation'}
              onClick={() => setPanelTab('conversation')}
              role="tab"
              type="button"
            >
              对话分析
            </button>
            <button
              aria-selected={panelTab === 'progress'}
              onClick={() => setPanelTab('progress')}
              role="tab"
              type="button"
            >
              分析进度
            </button>
          </div>
          {panelTab === 'conversation' ? (
            <div className="conversation-empty">
              <div className={`empty-orbit ${run?.status === 'running' ? 'is-running' : ''}`} aria-hidden="true">
                <span />
              </div>
              <h2>{run ? runtimeLabel : '分析工作区已就绪'}</h2>
              <p>
                {run?.status === 'running'
                  ? run.progress[run.progress.length - 1]?.message ?? '正在准备分析'
                  : run?.status === 'succeeded'
                    ? report?.summary ?? '待确认报告已经生成。'
                    : run?.status === 'failed' || run?.status === 'cancelled'
                      ? run.error ?? '本次分析没有完成，配置和本地素材仍然保留。'
                      : '当前为工作区预览，不调用模型，也不会生成或保存分析结果。'}
              </p>
              {conversionContext ? (
                <div className="context-chip">
                  <span>本次关注点</span>
                  <strong>{conversionContext}</strong>
                </div>
              ) : null}
              <div className="runtime-actions">
                {run?.status === 'running' ? (
                  <Button onClick={onCancel} size="small" variant="outline">取消分析</Button>
                ) : null}
                {run?.status === 'failed' || run?.status === 'cancelled' ? (
                  <Button onClick={onRetry} size="small" theme="primary">使用当前配置重试</Button>
                ) : null}
                {run?.status === 'succeeded' ? (
                  <Button onClick={onViewReport} size="small" theme="primary">查看待确认报告</Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="runtime-progress-panel" role="tabpanel">
              <div className="runtime-progress-heading">
                <div><span>本次运行</span><strong>{runtimeLabel}</strong></div>
                {run?.status === 'running' ? (
                  <Button onClick={onCancel} size="small" variant="outline">取消</Button>
                ) : null}
              </div>
              {run?.progress.length ? (
                <ol className="runtime-progress-list">
                  {run.progress.map((item, index) => (
                    <li className={index === run.progress.length - 1 ? 'is-current' : ''} key={`${item.stage}-${index}`}>
                      <span />
                      <div><strong>{item.message}</strong><small>{item.stage}</small></div>
                    </li>
                  ))}
                </ol>
              ) : <p className="runtime-progress-empty">启动真实分析后，这里会显示工具和模型的阶段进度。</p>}
              {run?.status === 'failed' || run?.status === 'cancelled' ? (
                <div className="runtime-recovery">
                  <p>{run.error}</p>
                  <Button onClick={onRetry} size="small" theme="primary">重试</Button>
                </div>
              ) : null}
            </div>
          )}
          <div className="conversation-composer">
            <textarea
              aria-label="补充分析关注点"
              disabled
              placeholder="运行中补充关注点将在后续增量对话阶段接入…"
            />
            <Button disabled size="small" theme="primary">
              发送
            </Button>
          </div>
        </aside>
      </section>

      <div
        aria-label="调整时间轴区域高度"
        aria-orientation="horizontal"
        aria-valuemax={440}
        aria-valuemin={220}
        aria-valuenow={Math.round(timelineHeight)}
        className="panel-resizer is-vertical"
        onKeyDown={resizeVerticalByKeyboard}
        onPointerDown={beginVerticalResize}
        role="separator"
        tabIndex={0}
      >
        <span />
      </div>

      <section className="timeline-panel" aria-label="分析时间轴">
        <div className="timeline-header">
          <div>
            <strong>素材时间轴</strong>
            <span>{report ? `${report.timeline.length} 条时间证据` : run?.status === 'running' ? '正在解析' : '等待真实解析结果'}</span>
          </div>
          <div className="timeline-actions">
            <button disabled type="button">－</button>
            <span>100%</span>
            <button disabled type="button">＋</button>
            <Button disabled size="small" variant="outline">
              适应全片
            </Button>
          </div>
        </div>
        <div className="timeline-chart">
          <div className="timeline-labels">
            <span>情绪变化</span>
            <span>镜头</span>
            <span>画面</span>
            <span>字幕</span>
            <span>口播 / 声音</span>
            <span>分析标签</span>
          </div>
          <div className="timeline-tracks">
            <div className="ruler">
              <span>00:00</span>
              <span>{report ? formatTimelineTime(durationMs / 2) : '等待时长'}</span>
              <span>{report ? formatTimelineTime(durationMs) : '--:--'}</span>
            </div>
            <div className="emotion-track">
              <svg
                aria-label={emotionPoints.length ? '素材表达强度情绪曲线' : '情绪曲线等待真实分析数据'}
                preserveAspectRatio="none"
                role="img"
                viewBox="0 0 1000 64"
              >
                {emotionPoints.length ? (
                  <polyline points={emotionPath} />
                ) : (
                  <path d="M0 38 C150 38 210 38 330 38 S560 38 710 38 S900 38 1000 38" />
                )}
              </svg>
              {!emotionPoints.length ? <span>未生成可靠情绪结论</span> : null}
            </div>
            {timelineTrack(['shot'])}
            <div className="empty-track"><span>代表帧仅证明采样位置，不推断画面语义</span></div>
            {timelineTrack(['ocr'])}
            {timelineTrack(['speech', 'audio'])}
            <div className="empty-track"><span>{report?.tags.length ? '报告标签暂不具备可靠时间定位' : '当前没有可靠分析标签'}</span></div>
          </div>
        </div>
      </section>
    </main>
  );
};

export const App = (): React.JSX.Element => {
  const [page, setPage] = useState<AppPage>('new-analysis');
  const [material, setMaterial] = useState<SelectedMaterial | null>(null);
  const [industry, setIndustry] = useState<Industry>('');
  const [modelId, setModelId] = useState('');
  const [conversionContext, setConversionContext] = useState('');
  const [modelConfigurations, setModelConfigurations] = useState<ModelConfigurationSummary[]>([]);
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [productId, setProductId] = useState('');
  const [activeRun, setActiveRun] = useState<ActiveAnalysisRun | null>(null);
  const [confirmingReport, setConfirmingReport] = useState(false);
  const [confirmReportError, setConfirmReportError] = useState('');
  const [recordToOpenId, setRecordToOpenId] = useState<string | null>(null);

  const refreshProducts = useCallback(async (): Promise<void> => {
    const result = await window.materialApi.products.list({ limit: 500 });
    if (result.ok) {
      setProducts(result.data.items);
      setProductId((current) =>
        current && result.data.items.some((product) => product.id === current) ? current : '',
      );
    }
  }, []);

  const refreshModelConfigurations = useCallback(async (): Promise<void> => {
    const result = await window.materialApi.models.getSettings();
    if (result.ok) {
      setModelConfigurations(result.data.configurations);
    }
  }, []);

  useEffect(() => {
    void refreshProducts();
    void refreshModelConfigurations();
  }, [refreshModelConfigurations, refreshProducts]);

  const modelOptions = useMemo<ModelSelectionOption[]>(() =>
    modelConfigurations.filter((configuration) => configuration.connectionStatus === 'ready').flatMap((configuration) =>
      configuration.availableModels.map((model) => ({
        configurationDisplayName: configuration.displayName,
        configurationId: configuration.id,
        label: `${configuration.displayName} · ${model.id}`,
        modelId: model.id,
        value: `${configuration.id}::${model.id}`,
      }))), [modelConfigurations]);

  useEffect(() => {
    setModelId((current) =>
      current && modelOptions.some((option) => option.value === current) ? current : '');
  }, [modelOptions]);

  useEffect(() => {
    const sessionId = material?.sessionId;
    return () => {
      if (sessionId) {
        void window.materialApi.media.release(sessionId);
      }
    };
  }, [material?.sessionId]);

  useEffect(() => window.materialApi.analysis.onProgress((progress) => {
    setActiveRun((current) => {
      if (!current || current.clientRunId !== progress.clientRunId) return current;
      const previous = current.progress[current.progress.length - 1];
      if (previous?.stage === progress.stage && previous.message === progress.message) return current;
      return { ...current, progress: [...current.progress, progress] };
    });
  }), []);

  const handleStartAnalysis = useCallback(async (
    verifiedMaterial: SelectedMaterial,
  ): Promise<void> => {
    const selectedModel = modelOptions.find((option) => option.value === modelId);
    if (!selectedModel || !industry || verifiedMaterial.sourceStatus !== 'available') return;
    const clientRunId = crypto.randomUUID();
    setActiveRun({
      clientRunId,
      conversionContext,
      material: verifiedMaterial,
      materialName: verifiedMaterial.summary.name,
      progress: [],
      status: 'running',
    });
    setPage('workspace');
    const result = await window.materialApi.analysis.start({
      clientRunId,
      configurationDisplayName: selectedModel.configurationDisplayName,
      configurationId: selectedModel.configurationId,
      conversionContext,
      industry,
      modelId: selectedModel.modelId,
      productId: productId || null,
      sessionId: verifiedMaterial.sessionId,
    });
    setActiveRun((current) => {
      if (!current || current.clientRunId !== clientRunId) return current;
      if (result.ok) return { ...current, data: result.data, status: 'succeeded' };
      return {
        ...current,
        error: result.error.message,
        status: result.error.code === 'CANCELLED' ? 'cancelled' : 'failed',
      };
    });
    if (result.ok) setPage('report');
  }, [conversionContext, industry, modelId, modelOptions, productId]);

  const handleCancelAnalysis = useCallback((): void => {
    if (activeRun?.status === 'running') {
      void window.materialApi.analysis.cancel(activeRun.clientRunId);
    }
  }, [activeRun]);

  const handleConfirmReport = useCallback(async (): Promise<void> => {
    if (!activeRun?.data || confirmingReport) return;
    setConfirmingReport(true);
    setConfirmReportError('');
    const input = createConfirmedRecordInput(
      activeRun.data,
      activeRun.material,
      activeRun.conversionContext,
    );
    const result = await window.materialApi.records.confirm(input);
    setConfirmingReport(false);
    if (!result.ok) {
      setConfirmReportError(result.error.message);
      return;
    }
    setActiveRun(null);
    setConfirmReportError('');
    setRecordToOpenId(result.data.id);
    setPage('records');
  }, [activeRun, confirmingReport]);

  const leaveReportForConfiguration = useCallback((): void => {
    if (confirmingReport) return;
    if (!window.confirm('当前报告尚未保存，返回配置将放弃这份预览。是否继续？')) return;
    setActiveRun(null);
    setConfirmReportError('');
    setPage('new-analysis');
  }, [confirmingReport]);

  const navigate = useCallback((nextPage: AppPage): void => {
    if (page === 'report' && activeRun?.data && nextPage !== 'report') {
      if (confirmingReport) return;
      if (!window.confirm('当前报告尚未保存，离开将放弃这份预览。是否继续？')) return;
      setActiveRun(null);
      setConfirmReportError('');
    }
    setRecordToOpenId(null);
    setPage(nextPage);
  }, [activeRun?.data, confirmingReport, page]);

  const content = useMemo(() => {
    if (page === 'report' && activeRun?.data) {
      return (
        <AnalysisReportPreviewPage
          confirmError={confirmReportError}
          confirming={confirmingReport}
          data={activeRun.data}
          materialName={activeRun.materialName}
          onBackToConfiguration={leaveReportForConfiguration}
          onBackToWorkspace={() => setPage('workspace')}
          onConfirm={() => void handleConfirmReport()}
        />
      );
    }
    if (page === 'workspace' && material) {
      return (
        <WorkspacePage
          conversionContext={conversionContext}
          industry={industry}
          material={material}
          onBack={() => setPage('new-analysis')}
          onCancel={handleCancelAnalysis}
          onRetry={() => void handleStartAnalysis(material)}
          onViewReport={() => setPage('report')}
          productName={products.find((product) => product.id === productId)?.name ?? null}
          run={activeRun}
        />
      );
    }
    if (page === 'records') {
      return (
        <RecordsPage
          initialRecordId={recordToOpenId}
          onCreate={() => setPage('new-analysis')}
          onInitialRecordOpened={() => setRecordToOpenId(null)}
        />
      );
    }
    if (page === 'products') {
      return <ProductLibraryPage onProductsChanged={() => void refreshProducts()} />;
    }
    if (page === 'settings') {
      return (
        <ModelSettingsPage
          onChanged={() => void refreshModelConfigurations()}
        />
      );
    }
    return (
      <NewAnalysisPage
        analysisBusy={activeRun?.status === 'running'}
        conversionContext={conversionContext}
        industry={industry}
        material={material}
        modelId={modelId}
        modelOptions={modelOptions}
        productId={productId}
        products={products}
        onConversionContextChange={(value) => {
          setConversionContext(value);
          if (activeRun?.status !== 'running') setActiveRun(null);
        }}
        onIndustryChange={(value) => {
          setIndustry(value);
          if (activeRun?.status !== 'running') setActiveRun(null);
          setProductId((current) =>
            products.some((product) => product.id === current && product.industry === value)
              ? current
              : '',
          );
        }}
        onMaterialChange={(value) => {
          setMaterial(value);
          if (activeRun?.status !== 'running') setActiveRun(null);
        }}
        onModelChange={(value) => {
          setModelId(value);
          if (activeRun?.status !== 'running') setActiveRun(null);
        }}
        onProductChange={(value) => {
          setProductId(value);
          if (activeRun?.status !== 'running') setActiveRun(null);
        }}
        onPreviewWorkspace={() => {
          setActiveRun(null);
          setPage('workspace');
        }}
        onStartAnalysis={(value) => void handleStartAnalysis(value)}
      />
    );
  }, [
    activeRun,
    conversionContext,
    confirmReportError,
    confirmingReport,
    handleCancelAnalysis,
    handleConfirmReport,
    handleStartAnalysis,
    industry,
    material,
    modelId,
    modelOptions,
    page,
    productId,
    products,
    recordToOpenId,
    refreshModelConfigurations,
    refreshProducts,
    leaveReportForConfiguration,
  ]);

  return (
    <div className="app-frame">
      <Sidebar onNavigate={navigate} page={page} />
      <div className="app-content">{content}</div>
    </div>
  );
};
