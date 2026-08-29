import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Button, Input, Tag } from 'tdesign-react';

import { formatFileSize } from '../analysis/draft';
import { productIndustryLabel } from '../product/domain';
import { mergeGameSuggestion } from '../product-enrichment/form-merge';
import {
  DuplicateCandidate,
  GameContext,
  ProductBackupInfo,
  ProductDimension,
  ProductIndustry,
  ProductInput,
  ProductListItem,
  ProductRecord,
  ProductStorageStatus,
} from '../product/types';
import { GameProductEnrichmentPanel } from './GameProductEnrichmentPanel';
import { resetProductPageScroll } from './product-form-scroll';

type ProductView = 'list' | 'form' | 'detail' | 'maintenance';

interface ProductLibraryPageProps {
  onProductsChanged: () => void;
}

const apparelFields = [
  ['品牌', '例如：自有品牌或系列'],
  ['面料', '例如：棉、羊毛或混纺'],
  ['适用季节', '例如：春秋、四季'],
  ['目标人群', '例如：通勤大码女性'],
  ['价格带', '选填，不要求具体售价'],
  ['款式', '例如：西装套装、连衣裙'],
  ['卖点', '填写产品团队确认的卖点'],
  ['转化依据', '选填，可由后续素材分析补充'],
] as const;

const gameFields = [
  ['游戏类型', '例如：角色扮演、策略、休闲'],
  ['平台', '例如：PC、iOS、Android'],
  ['发售日期', '例如：2026-08-29'],
  ['游戏简介', '可应用联网候选后继续编辑'],
  ['核心玩法', '填写主要玩法与循环'],
  ['角色', '填写重要角色或阵营'],
  ['目标玩家', '填写主要玩家群体'],
  ['内容更新', '填写当前重要更新'],
] as const;

const emptyInput = (industry: ProductIndustry = 'apparel'): ProductInput => ({
  industry,
  name: '',
  apparelCategory: industry === 'apparel' ? '' : null,
  details: {},
  versions: [],
  channels: [],
  contexts: [],
});

const toInput = (product: ProductRecord): ProductInput => ({
  industry: product.industry,
  name: product.name,
  apparelCategory: product.apparelCategory,
  details: { ...product.details },
  versions: product.versions.map((item) => ({ ...item })),
  channels: product.channels.map((item) => ({ ...item })),
  contexts: product.contexts.map((item) => ({ ...item })),
});

const newDimension = (): ProductDimension => ({
  id: window.crypto.randomUUID(),
  name: '',
  notes: '',
});

const newContext = (): GameContext => ({
  id: window.crypto.randomUUID(),
  versionId: null,
  channelId: null,
  notes: '',
});

const formatLocalTime = (value: string): string =>
  new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

interface DimensionEditorProps {
  label: string;
  items: ProductDimension[];
  onChange: (items: ProductDimension[]) => void;
  onRemove: (id: string) => void;
}

const DimensionEditor = ({
  items,
  label,
  onChange,
  onRemove,
}: DimensionEditorProps): React.JSX.Element => (
  <section className="nested-editor">
    <div className="nested-editor-header">
      <div>
        <h3>{label}</h3>
        <p>选填，可添加多项。</p>
      </div>
      <Button onClick={() => onChange([...items, newDimension()])} size="small" variant="outline">
        添加{label}
      </Button>
    </div>
    {items.length ? (
      <div className="nested-list">
        {items.map((item, index) => (
          <div className="dimension-row" key={item.id}>
            <span className="row-index">{index + 1}</span>
            <Input
              onChange={(value) =>
                onChange(
                  items.map((current) =>
                    current.id === item.id ? { ...current, name: value } : current,
                  ),
                )
              }
              placeholder={`${label}名称`}
              value={item.name}
            />
            <Input
              onChange={(value) =>
                onChange(
                  items.map((current) =>
                    current.id === item.id ? { ...current, notes: value } : current,
                  ),
                )
              }
              placeholder="选填说明"
              value={item.notes}
            />
            <Button onClick={() => onRemove(item.id)} size="small" theme="danger" variant="text">
              删除
            </Button>
          </div>
        ))}
      </div>
    ) : (
      <div className="nested-empty">尚未添加{label}</div>
    )}
  </section>
);

interface ContextEditorProps {
  channels: ProductDimension[];
  contexts: GameContext[];
  onChange: (contexts: GameContext[]) => void;
  versions: ProductDimension[];
}

const ContextEditor = ({
  channels,
  contexts,
  onChange,
  versions,
}: ContextEditorProps): React.JSX.Element => (
  <section className="nested-editor">
    <div className="nested-editor-header">
      <div>
        <h3>版本 × 渠道差异</h3>
        <p>只在确有内容差异时添加，不自动生成组合。</p>
      </div>
      <Button
        disabled={!versions.length && !channels.length}
        onClick={() => onChange([...contexts, newContext()])}
        size="small"
        variant="outline"
      >
        添加差异
      </Button>
    </div>
    {contexts.length ? (
      <div className="context-list">
        {contexts.map((context) => (
          <div className="context-row" key={context.id}>
            <select
              aria-label="选择游戏版本"
              onChange={(event) =>
                onChange(
                  contexts.map((item) =>
                    item.id === context.id
                      ? { ...item, versionId: event.target.value || null }
                      : item,
                  ),
                )
              }
              value={context.versionId ?? ''}
            >
              <option value="">不限版本</option>
              {versions.map((item) => (
                <option key={item.id} value={item.id}>{item.name || '未命名版本'}</option>
              ))}
            </select>
            <select
              aria-label="选择游戏渠道"
              onChange={(event) =>
                onChange(
                  contexts.map((item) =>
                    item.id === context.id
                      ? { ...item, channelId: event.target.value || null }
                      : item,
                  ),
                )
              }
              value={context.channelId ?? ''}
            >
              <option value="">不限渠道</option>
              {channels.map((item) => (
                <option key={item.id} value={item.id}>{item.name || '未命名渠道'}</option>
              ))}
            </select>
            <Input
              onChange={(value) =>
                onChange(
                  contexts.map((item) =>
                    item.id === context.id ? { ...item, notes: value } : item,
                  ),
                )
              }
              placeholder="填写该上下文中的角色、玩法或内容差异"
              value={context.notes}
            />
            <Button
              onClick={() => onChange(contexts.filter((item) => item.id !== context.id))}
              size="small"
              theme="danger"
              variant="text"
            >
              删除
            </Button>
          </div>
        ))}
      </div>
    ) : (
      <div className="nested-empty">尚未添加版本渠道差异</div>
    )}
  </section>
);

interface ProductFormProps {
  initial: ProductInput;
  product: ProductRecord | null;
  onCancel: () => void;
  onSaved: (product: ProductRecord) => void;
}

const ProductForm = ({
  initial,
  onCancel,
  onSaved,
  product,
}: ProductFormProps): React.JSX.Element => {
  const [draft, setDraft] = useState<ProductInput>(initial);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [duplicatePreview, setDuplicatePreview] = useState<ProductRecord | null>(null);
  const [enrichmentBlurToken, setEnrichmentBlurToken] = useState(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const fields = draft.industry === 'apparel' ? apparelFields : gameFields;

  const changeIndustry = (industry: ProductIndustry): void => {
    if (dirty && !window.confirm('切换行业会清空当前未保存内容，是否继续？')) {
      return;
    }
    setDraft(emptyInput(industry));
  };

  const cancel = (): void => {
    if (!dirty || window.confirm('当前修改尚未保存，确定放弃修改吗？')) {
      onCancel();
    }
  };

  const persist = async (skipDuplicateCheck = false): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      if (!skipDuplicateCheck) {
        const duplicateResult = await window.materialApi.products.findDuplicates(
          draft,
          product?.id,
        );
        if (!duplicateResult.ok) {
          setError(duplicateResult.error.message);
          return;
        }
        if (duplicateResult.data.length) {
          setDuplicates(duplicateResult.data);
          return;
        }
      }

      const result = product
        ? await window.materialApi.products.update(product.id, product.writeVersion, draft)
        : await window.materialApi.products.create(draft);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setDuplicates([]);
      onSaved(result.data);
    } finally {
      setSaving(false);
    }
  };

  const removeDimension = (kind: 'versions' | 'channels', id: string): void => {
    const impacted = draft.contexts.filter((context) =>
      kind === 'versions' ? context.versionId === id : context.channelId === id,
    ).length;
    if (
      impacted &&
      !window.confirm(`删除后会同时移除 ${impacted} 条关联的版本渠道差异，是否继续？`)
    ) {
      return;
    }
    setDraft({
      ...draft,
      [kind]: draft[kind].filter((item) => item.id !== id),
      contexts: draft.contexts.filter((context) =>
        kind === 'versions' ? context.versionId !== id : context.channelId !== id,
      ),
    });
  };

  const previewDuplicate = async (id: string): Promise<void> => {
    const result = await window.materialApi.products.get(id);
    if (result.ok) {
      setDuplicatePreview(result.data);
    }
  };

  return (
    <main className="page-shell product-form-page">
      <header className="page-header product-form-header">
        <div>
          <span className="eyebrow">产品库</span>
          <h1>{product ? '编辑产品' : '新建产品'}</h1>
          <p>只保存用户主动填写并确认的内容，不会从素材自动建库。</p>
        </div>
        <div className="header-actions">
          <Button disabled={saving} onClick={cancel} variant="outline">取消</Button>
          <Button loading={saving} onClick={() => void persist()} theme="primary">保存</Button>
        </div>
      </header>

      {error ? <div className="page-alert is-error" role="alert">{error}</div> : null}

      <section className="product-form-card">
        <div className="form-section-title">
          <div>
            <h2>基础信息</h2>
            <p>{draft.industry === 'apparel' ? '服饰仅产品名称和服饰类别必填。' : '游戏仅游戏名称必填。'}</p>
          </div>
          {product ? <Tag variant="light">行业保存后锁定</Tag> : null}
        </div>
        <div className="field-grid">
          <label className="form-field">
            <span className="field-label">行业 <em>必填</em></span>
            <select
              disabled={Boolean(product)}
              onChange={(event) => changeIndustry(event.target.value as ProductIndustry)}
              value={draft.industry}
            >
              <option value="apparel">服饰</option>
              <option value="game">游戏</option>
            </select>
          </label>
          <label className="form-field">
            <span className="field-label">
              {draft.industry === 'apparel' ? '产品名称' : '游戏名称'} <em>必填</em>
            </span>
            <Input
              onChange={(value) => setDraft({ ...draft, name: value })}
              onBlur={() => setEnrichmentBlurToken((value) => value + 1)}
              placeholder={draft.industry === 'apparel' ? '填写产品名称' : '填写游戏名称'}
              value={draft.name}
            />
          </label>
          {draft.industry === 'apparel' ? (
            <label className="form-field">
              <span className="field-label">服饰类别 <em>必填</em></span>
              <Input
                onChange={(value) => setDraft({ ...draft, apparelCategory: value })}
                placeholder="例如：连衣裙、套装、衬衫"
                value={draft.apparelCategory ?? ''}
              />
            </label>
          ) : (
            <div className="form-field field-span-two">
              <GameProductEnrichmentPanel
                gameName={draft.name}
                onApply={(candidate) => {
                  const merged = mergeGameSuggestion(draft, candidate);
                  setDraft(merged.input);
                  return merged.appliedFields;
                }}
                queryNowToken={enrichmentBlurToken}
              />
            </div>
          )}
        </div>
      </section>

      <section className="product-form-card">
        <div className="form-section-title">
          <div>
            <h2>推荐信息</h2>
            <p>以下均为选填分组，不限制未来扩展。</p>
          </div>
        </div>
        <div className="field-grid">
          {fields.map(([label, placeholder]) => (
            <label className="form-field" key={label}>
              <span className="field-label">{label}</span>
              <Input
                onChange={(value) =>
                  setDraft({ ...draft, details: { ...draft.details, [label]: value } })
                }
                placeholder={placeholder}
                value={draft.details[label] ?? ''}
              />
            </label>
          ))}
          <label className="form-field field-span-two">
            <span className="field-label">补充说明</span>
            <textarea
              maxLength={10_000}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  details: { ...draft.details, 补充说明: event.target.value },
                })
              }
              placeholder="填写其他对后续素材分析有帮助的信息"
              rows={4}
              value={draft.details['补充说明'] ?? ''}
            />
          </label>
        </div>
      </section>

      {draft.industry === 'game' ? (
        <section className="product-form-card game-context-section">
          <div className="form-section-title">
            <div>
              <h2>版本与渠道</h2>
              <p>版本和渠道均为选填，只维护确有差异的上下文。</p>
            </div>
          </div>
          <DimensionEditor
            items={draft.versions}
            label="版本"
            onChange={(versions) => setDraft({ ...draft, versions })}
            onRemove={(id) => removeDimension('versions', id)}
          />
          <DimensionEditor
            items={draft.channels}
            label="渠道"
            onChange={(channels) => setDraft({ ...draft, channels })}
            onRemove={(id) => removeDimension('channels', id)}
          />
          <ContextEditor
            channels={draft.channels}
            contexts={draft.contexts}
            onChange={(contexts) => setDraft({ ...draft, contexts })}
            versions={draft.versions}
          />
        </section>
      ) : null}

      {duplicates.length ? (
        <div className="modal-backdrop" role="presentation">
          <section aria-labelledby="duplicate-title" aria-modal="true" className="app-modal" role="dialog">
            <Tag theme="warning" variant="light">重复候选</Tag>
            <h2 id="duplicate-title">发现可能已经存在的产品</h2>
            <p>系统只提供提醒，不会自动合并或覆盖。请先核对再决定。</p>
            <div className="duplicate-list">
              {duplicates.map((candidate) => (
                <div key={candidate.id}>
                  <div>
                    <strong>{candidate.name}</strong>
                    <span>{candidate.reason}</span>
                  </div>
                  <Button onClick={() => void previewDuplicate(candidate.id)} size="small" variant="text">
                    查看已有产品
                  </Button>
                </div>
              ))}
            </div>
            {duplicatePreview ? (
              <div className="duplicate-preview">
                <strong>{duplicatePreview.name}</strong>
                <span>{productIndustryLabel(duplicatePreview.industry)} · 更新于 {formatLocalTime(duplicatePreview.updatedAt)}</span>
                <p>{duplicatePreview.details['补充说明'] || '暂无补充说明'}</p>
              </div>
            ) : null}
            <div className="modal-actions">
              <Button onClick={() => { setDuplicates([]); setDuplicatePreview(null); }} variant="outline">
                返回修改
              </Button>
              <Button loading={saving} onClick={() => void persist(true)} theme="warning">
                仍然保存
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
};

interface ProductDetailProps {
  onBack: () => void;
  onDelete: (product: ProductRecord) => void;
  onEdit: (product: ProductRecord) => void;
  product: ProductRecord;
}

const ProductDetail = ({
  onBack,
  onDelete,
  onEdit,
  product,
}: ProductDetailProps): React.JSX.Element => (
  <main className="page-shell product-detail-page">
    <header className="page-header">
      <div>
        <button className="text-back" onClick={onBack} type="button">← 返回产品库</button>
        <div className="detail-title-line">
          <h1>{product.name}</h1>
          <Tag theme={product.industry === 'apparel' ? 'primary' : 'success'} variant="light">
            {productIndustryLabel(product.industry)}
          </Tag>
        </div>
        <p>更新于 {formatLocalTime(product.updatedAt)} · 写入版本 {product.writeVersion}</p>
      </div>
      <div className="header-actions">
        <Button onClick={() => onDelete(product)} theme="danger" variant="outline">删除</Button>
        <Button onClick={() => onEdit(product)} theme="primary">编辑</Button>
      </div>
    </header>

    <div className="product-detail-grid">
      <section className="detail-card">
        <h2>基础信息</h2>
        <dl className="detail-list">
          <div><dt>名称</dt><dd>{product.name}</dd></div>
          <div><dt>行业</dt><dd>{productIndustryLabel(product.industry)}</dd></div>
          {product.industry === 'apparel' ? (
            <div><dt>服饰类别</dt><dd>{product.apparelCategory}</dd></div>
          ) : null}
        </dl>
      </section>
      <section className="detail-card">
        <h2>推荐信息</h2>
        {Object.keys(product.details).length ? (
          <dl className="detail-list">
            {Object.entries(product.details).map(([key, value]) => (
              <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        ) : <div className="detail-empty">尚未填写选填信息</div>}
      </section>
      {product.industry === 'game' ? (
        <section className="detail-card detail-card-wide">
          <h2>版本、渠道与差异</h2>
          <div className="context-summary-grid">
            <div>
              <h3>版本</h3>
              {product.versions.length ? product.versions.map((item) => (
                <span className="context-pill" key={item.id}>{item.name}</span>
              )) : <span className="detail-muted">未维护版本</span>}
            </div>
            <div>
              <h3>渠道</h3>
              {product.channels.length ? product.channels.map((item) => (
                <span className="context-pill" key={item.id}>{item.name}</span>
              )) : <span className="detail-muted">未维护渠道</span>}
            </div>
          </div>
          {product.contexts.length ? (
            <div className="detail-context-list">
              {product.contexts.map((context) => (
                <div key={context.id}>
                  <strong>
                    {product.versions.find((item) => item.id === context.versionId)?.name || '不限版本'}
                    {' × '}
                    {product.channels.find((item) => item.id === context.channelId)?.name || '不限渠道'}
                  </strong>
                  <p>{context.notes}</p>
                </div>
              ))}
            </div>
          ) : <div className="detail-empty">尚未维护版本渠道差异</div>}
        </section>
      ) : null}
    </div>
  </main>
);

interface ProductMaintenanceProps {
  onBack: () => void;
  onRestored: () => void;
}

const backupKindLabel = (backup: ProductBackupInfo): string => {
  if (backup.kind === 'pre-restore') {
    return '恢复前安全备份';
  }
  if (backup.kind === 'pre-migration') {
    return '迁移前备份';
  }
  return '手动备份';
};

const ProductMaintenance = ({
  onBack,
  onRestored,
}: ProductMaintenanceProps): React.JSX.Element => {
  const [status, setStatus] = useState<ProductStorageStatus | null>(null);
  const [backups, setBackups] = useState<ProductBackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<ProductBackupInfo | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const [statusResult, backupResult] = await Promise.all([
      window.materialApi.products.storageStatus(),
      window.materialApi.products.listBackups(),
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
    const result = await window.materialApi.products.createBackup();
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSuccess(`已创建并验证备份，包含 ${result.data.productCount ?? 0} 个产品。`);
    await load();
  };

  const restore = async (): Promise<void> => {
    if (!restoreTarget) {
      return;
    }
    setBusy(true);
    setError('');
    setSuccess('');
    const result = await window.materialApi.products.restoreBackup(restoreTarget.id);
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
          <button className="text-back" onClick={onBack} type="button">← 返回产品库</button>
          <h1>产品库数据维护</h1>
          <p>检查本地数据库状态，并管理由客户端验证过的备份。</p>
        </div>
        <Button disabled={busy || !status?.writable} loading={busy} onClick={() => void createBackup()} theme="primary">
          创建备份
        </Button>
      </header>

      {error ? <div className="page-alert is-error" role="alert">{error}</div> : null}
      {success ? <div className="page-alert is-success" role="status">{success}</div> : null}

      <section className="storage-status-grid" aria-label="产品库状态">
        <div>
          <span>完整性</span>
          <strong className={status?.integrity === 'ok' ? 'is-healthy' : 'is-unhealthy'}>
            {loading ? '检查中' : status?.integrity === 'ok' ? '正常' : '需要处理'}
          </strong>
        </div>
        <div><span>Schema</span><strong>v{status?.schemaVersion ?? '—'}</strong></div>
        <div><span>写入状态</span><strong>{status?.writable ? '可读写' : '只读'}</strong></div>
        <div><span>当前产品</span><strong>{status?.productCount ?? '—'}</strong></div>
        <div><span>已保留备份</span><strong>{status?.backupCount ?? '—'}</strong></div>
      </section>

      <section className="backup-section">
        <div className="section-heading">
          <div>
            <h2>备份记录</h2>
            <p>备份保存在应用管理目录；V1 不自动删除，也不暴露本地绝对路径。</p>
          </div>
          <Button disabled={busy} onClick={() => void load()} size="small" variant="outline">刷新</Button>
        </div>
        {loading ? <div className="backup-empty">正在读取备份…</div> : null}
        {!loading && !backups.length ? (
          <div className="backup-empty">尚无备份。创建首个备份后可以在这里核对和恢复。</div>
        ) : null}
        {!loading && backups.length ? (
          <div className="backup-list">
            <div className="backup-list-head">
              <span>创建时间</span><span>类型</span><span>产品数</span><span>大小</span><span>校验</span><span />
            </div>
            {backups.map((backup) => (
              <div className="backup-row" key={backup.id}>
                <time dateTime={backup.createdAt}>{formatLocalTime(backup.createdAt)}</time>
                <span>{backupKindLabel(backup)}</span>
                <span>{backup.productCount ?? '—'}</span>
                <span>{formatFileSize(backup.size)}</span>
                <Tag theme={backup.integrity === 'ok' ? 'success' : 'danger'} variant="light">
                  {backup.integrity === 'ok' ? `v${backup.schemaVersion} 可用` : '校验失败'}
                </Tag>
                <Button
                  disabled={busy || backup.integrity !== 'ok' || !status?.writable}
                  onClick={() => setRestoreTarget(backup)}
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
        <strong>恢复规则</strong>
        <p>恢复前会再次校验目标备份，并自动保存当前产品库。替换失败时恢复原库，不会静默建立空库。</p>
      </section>

      {restoreTarget ? (
        <div className="modal-backdrop" role="presentation">
          <section aria-labelledby="restore-title" aria-modal="true" className="app-modal" role="dialog">
            <Tag theme="warning" variant="light">将替换当前产品库</Tag>
            <h2 id="restore-title">恢复 {formatLocalTime(restoreTarget.createdAt)} 的备份？</h2>
            <p>
              当前产品库将替换为包含 {restoreTarget.productCount ?? '未知数量'} 个产品的已验证备份。
              恢复前会自动创建当前数据的安全备份，操作失败则回滚。
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

export const ProductLibraryPage = ({
  onProductsChanged,
}: ProductLibraryPageProps): React.JSX.Element => {
  const [view, setView] = useState<ProductView>('list');
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [industry, setIndustry] = useState<ProductIndustry | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<ProductRecord | null>(null);
  const [formProduct, setFormProduct] = useState<ProductRecord | null>(null);
  const [formInitial, setFormInitial] = useState<ProductInput>(emptyInput());
  const [deleteTarget, setDeleteTarget] = useState<ProductRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const result = await window.materialApi.products.list({
      query,
      industry,
      limit: 50,
      offset,
    });
    if (result.ok) {
      if (result.data.total > 0 && offset >= result.data.total) {
        setOffset(Math.floor((result.data.total - 1) / 50) * 50);
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
  }, [industry, offset, query]);

  useEffect(() => {
    void load();
  }, [load]);

  useLayoutEffect(() => {
    resetProductPageScroll((selector) => document.querySelector<HTMLElement>(selector));
  }, [view]);

  const openDetail = async (id: string): Promise<void> => {
    const result = await window.materialApi.products.get(id);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSelected(result.data);
    setView('detail');
  };

  const openCreate = (): void => {
    setFormProduct(null);
    setFormInitial(emptyInput());
    setView('form');
  };

  const openEdit = (product: ProductRecord): void => {
    setFormProduct(product);
    setFormInitial(toInput(product));
    setView('form');
  };

  const saved = (product: ProductRecord): void => {
    setSelected(product);
    setView('detail');
    void load();
    onProductsChanged();
  };

  const remove = async (): Promise<void> => {
    if (!deleteTarget) {
      return;
    }
    setDeleting(true);
    const result = await window.materialApi.products.remove(
      deleteTarget.id,
      deleteTarget.writeVersion,
    );
    setDeleting(false);
    if (!result.ok) {
      setError(result.error.message);
      setDeleteTarget(null);
      return;
    }
    setDeleteTarget(null);
    setSelected(null);
    setView('list');
    await load();
    onProductsChanged();
  };

  if (view === 'form') {
    return (
      <ProductForm
        initial={formInitial}
        onCancel={() => setView(formProduct ? 'detail' : 'list')}
        onSaved={saved}
        product={formProduct}
      />
    );
  }
  if (view === 'detail' && selected) {
    return (
      <>
        <ProductDetail
          onBack={() => setView('list')}
          onDelete={setDeleteTarget}
          onEdit={openEdit}
          product={selected}
        />
        {deleteTarget ? (
          <div className="modal-backdrop" role="presentation">
            <section aria-labelledby="delete-product-title" aria-modal="true" className="app-modal" role="dialog">
              <Tag theme="danger" variant="light">不可恢复</Tag>
              <h2 id="delete-product-title">删除“{deleteTarget.name}”？</h2>
              <p>
                产品正文、{deleteTarget.versions.length} 个版本、{deleteTarget.channels.length} 个渠道和
                {deleteTarget.contexts.length} 条组合差异将从产品库移除。V1 没有回收站；下游报告引用数当前不适用。
              </p>
              <div className="modal-actions">
                <Button disabled={deleting} onClick={() => setDeleteTarget(null)} variant="outline">取消</Button>
                <Button loading={deleting} onClick={() => void remove()} theme="danger">确认删除</Button>
              </div>
            </section>
          </div>
        ) : null}
      </>
    );
  }
  if (view === 'maintenance') {
    return (
      <ProductMaintenance
        onBack={() => setView('list')}
        onRestored={() => {
          void load();
          onProductsChanged();
        }}
      />
    );
  }

  const emptyLibrary = !loading && !error && !items.length && !query && !industry;
  const emptySearch = !loading && !error && !items.length && Boolean(query || industry);

  return (
    <main className="page-shell product-library-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">本地产品数据</span>
          <h1>产品库</h1>
          <p>由你主动创建和维护，素材分析不会自动新增或修改产品。</p>
        </div>
        <div className="header-actions">
          <Button onClick={() => setView('maintenance')} variant="outline">数据维护</Button>
          <Button onClick={openCreate} theme="primary">新建产品</Button>
        </div>
      </header>

      <section className="product-toolbar" aria-label="产品筛选">
        <Input
          clearable
          onChange={(value) => { setQuery(value); setOffset(0); }}
          placeholder="搜索产品名称或已填写信息"
          value={query}
        />
        <select
          aria-label="筛选产品行业"
          onChange={(event) => {
            setIndustry(event.target.value as ProductIndustry | '');
            setOffset(0);
          }}
          value={industry}
        >
          <option value="">全部行业</option>
          <option value="apparel">服饰</option>
          <option value="game">游戏</option>
        </select>
        <span>{loading ? '正在读取…' : `共 ${total} 个结果`}</span>
      </section>

      {error ? (
        <section className="product-state is-error" role="alert">
          <h2>产品库暂时无法读取</h2>
          <p>{error}</p>
          <Button onClick={() => void load()} variant="outline">重试</Button>
        </section>
      ) : null}

      {loading ? (
        <section className="product-list-skeleton" aria-label="正在加载产品">
          {[0, 1, 2].map((item) => <div key={item} />)}
        </section>
      ) : null}

      {emptyLibrary ? (
        <section className="product-state">
          <div className="product-state-icon" aria-hidden="true">◇</div>
          <h2>产品库还是空的</h2>
          <p>先创建一个服饰或游戏产品，后续新建分析时可以选择绑定。</p>
          <Button onClick={openCreate} variant="outline">新建首个产品</Button>
        </section>
      ) : null}

      {emptySearch ? (
        <section className="product-state">
          <h2>没有符合当前条件的产品</h2>
          <p>产品库中可能仍有其他产品，可清空关键词和行业筛选。</p>
          <Button onClick={() => { setQuery(''); setIndustry(''); setOffset(0); }} variant="outline">清空条件</Button>
        </section>
      ) : null}

      {!loading && items.length ? (
        <>
          <section className="product-list" aria-label="产品列表">
            <div className="product-list-head">
              <span>产品</span><span>行业</span><span>关键摘要</span><span>更新时间</span><span />
            </div>
            {items.map((item) => (
              <button className="product-row" key={item.id} onClick={() => void openDetail(item.id)} type="button">
                <span className="product-name-cell">
                  <span className={`product-avatar is-${item.industry}`}>{item.name.slice(0, 1).toLocaleUpperCase()}</span>
                  <strong>{item.name}</strong>
                </span>
                <Tag theme={item.industry === 'apparel' ? 'primary' : 'success'} variant="light">
                  {productIndustryLabel(item.industry)}
                </Tag>
                <span className="product-row-summary">{item.summary}</span>
                <time dateTime={item.updatedAt}>{formatLocalTime(item.updatedAt)}</time>
                <span className="row-action">查看 →</span>
              </button>
            ))}
          </section>
          <nav aria-label="产品列表分页" className="product-pagination">
            <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))} size="small" variant="outline">
              上一页
            </Button>
            <span>第 {Math.floor(offset / 50) + 1} 页，共 {Math.max(1, Math.ceil(total / 50))} 页</span>
            <Button disabled={offset + items.length >= total} onClick={() => setOffset(offset + 50)} size="small" variant="outline">
              下一页
            </Button>
          </nav>
        </>
      ) : null}
    </main>
  );
};
