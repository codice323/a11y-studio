import { useEffect, useRef, useState } from 'react';
import { Code2, Info, ListChecks, LoaderCircle } from 'lucide-react';
import { diffWordsWithSpace } from 'diff';
import { inspectAudit, type Semantics } from './semantics';
import { versionName, type Bounds, type HistoryItem, type Issue, type Proposal, type State } from './types';

export type EvidenceView = 'visual' | 'diff' | 'semantics';
type SemanticResult = { before: Semantics; after: Semantics | null };

function Screenshot({ title, src, bounds, size, location, emptyText = '此版本暂无截图。' }: {
  title: string; src?: string; bounds?: Bounds | null;
  size?: { width: number; height: number }; location?: string; emptyText?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);
  function center() {
    const pane = viewport.current;
    const target = marker.current;
    if (!pane || !target) return;
    const frame = pane.getBoundingClientRect();
    const point = target.getBoundingClientRect();
    pane.scrollTo({
      top: pane.scrollTop + point.top - frame.top - (pane.clientHeight - point.height) / 2,
      left: pane.scrollLeft + point.left - frame.left - (pane.clientWidth - point.width) / 2,
    });
  }
  useEffect(center, [bounds, size, zoomed]);
  const locate = bounds && size && size.width > 0 && size.height > 0;
  return <figure className="shot">
    <figcaption>{title}</figcaption>
    {src && !failed ? <div className="screen-wrap" ref={viewport} tabIndex={0} role="region" aria-label={title + '截图'}>
      <div className={`screen-image${zoomed ? ' zoomed' : ''}`}>
        <img src={src} alt={title + '的页面截图'} onLoad={center} onError={() => setFailed(true)} />
        {locate && <div ref={marker} className="highlight" aria-hidden="true" style={{
          left: `${bounds.x / size.width * 100}%`, top: `${bounds.y / size.height * 100}%`,
          width: `${bounds.width / size.width * 100}%`, height: `${bounds.height / size.height * 100}%`,
        }} />}
      </div>
    </div> : <p className="shot-empty">{failed ? '截图加载失败。' : emptyText}</p>}
    {src && !failed && <div className="shot-foot">
      {locate ? <button type="button" title={location} onClick={center}>定位元素</button> : <span>暂无元素定位</span>}
      <button type="button" aria-label={`放大${title}`} aria-pressed={zoomed} onClick={() => setZoomed(value => !value)}>放大 150%</button>
      <a href={src} target="_blank" rel="noreferrer" aria-label={`打开完整截图（${title}，新标签页）`}>完整截图</a>
    </div>}
  </figure>;
}

function SemanticTable({ result, repaired, afterLabel }: { result: SemanticResult; repaired: boolean; afterLabel: string }) {
  const stateText = (item: Semantics) => item.states.map(([key, value]) => `${key}=${value}`).join(' · ') || '无记录的控件状态';
  const rows: [string, (item: Semantics) => string][] = [
    ['可访问名称', item => item.ignored ? '未暴露' : item.name || '（空）'],
    ['角色', item => item.ignored ? '未暴露' : item.role || '无具名角色'],
    ['无障碍树', item => item.ignored ? '忽略' + (item.ignoredReasons.length ? `（${item.ignoredReasons.join('、')}）` : '') : '已暴露'],
    ['可聚焦性', item => item.focusable ? '可聚焦' : '不可聚焦'],
    ['控件状态', stateText],
  ];
  return <table className="semantic-table">
    <thead><tr><th scope="col">语义字段</th><th scope="col">{result.after ? repaired ? '修复前' : '原始版本' : '当前扫描版本'}</th>{result.after && <th scope="col">{afterLabel}</th>}</tr></thead>
    <tbody>{rows.map(([label, value]) => <tr key={label}>
      <th scope="row">{label}</th><td>{value(result.before)}</td>
      {result.after && <td className={value(result.before) !== value(result.after) ? 'changed' : undefined}>{value(result.after)}{value(result.before) !== value(result.after) && <small>已变化</small>}</td>}
    </tr>)}</tbody>
  </table>;
}

export function Evidence({ state, issue, history, proposal, view, onView, busy, applying, archivedEvidence, patchReady, onConfirm, onReject }: {
  state: State; issue?: Issue; history?: HistoryItem; proposal: Proposal | null;
  view: EvidenceView; onView: (view: EvidenceView) => void;
  busy: boolean; applying: boolean; archivedEvidence: boolean; patchReady: boolean; onConfirm: () => void; onReject: () => void;
}) {
  const verification = history?.verification;
  const target = history?.issue ?? issue;
  const selector = target?.selector;
  const activeScan = state.current;
  const originalVersion = state.snapshots[0]?.id ?? state.baseline?.snapshotId;
  const onlyOriginal = !verification && state.project.currentSnapshot === originalVersion;
  const originalIssue = state.baseline?.issues.find(item => item.id === issue?.id);
  const compareOriginal = !onlyOriginal && Boolean(originalIssue && activeScan);
  const beforeId = verification ? verification.baselineAudit : compareOriginal ? state.baseline?.id : activeScan?.id;
  const afterId = verification ? archivedEvidence ? verification.audit : activeScan?.id : compareOriginal ? activeScan?.id : undefined;
  const afterVersion = archivedEvidence && verification ? verification.toSnapshot : state.project.currentSnapshot;
  const afterLabel = verification && afterVersion === verification.toSnapshot ? '修复后' : '当前版本';
  const projectId = state.project.id;
  const layoutKey = `${projectId}:${state.project.currentSnapshot}:${verification?.id}:${target?.id}`;
  const [layoutChoice, setLayoutChoice] = useState<{ key: string; mode: 'both' | 'before' | 'after' }>();
  const layout = layoutChoice?.key === layoutKey ? layoutChoice.mode : 'both';
  const [attempt, setAttempt] = useState(0);
  const key = `${projectId}:${beforeId}:${afterId}:${selector}:${attempt}`;
  const [semantic, setSemantic] = useState<{ key: string; result?: SemanticResult; error?: string }>();
  const computed = semantic?.key === key ? semantic : undefined;

  useEffect(() => {
    if (!beforeId || !selector || computed || (view !== 'semantics' && !(view === 'visual' && verification && afterId))) return;
    const controller = new AbortController();
    const { signal } = controller;
    async function compute() {
      const first = await inspectAudit(projectId, beforeId!, selector!, signal);
      const second = afterId ? await inspectAudit(projectId, afterId, selector!, signal) : null;
      if (!signal.aborted) setSemantic({ key, result: { before: first, after: second } });
    }
    void compute().catch((error: Error) => {
      if (!signal.aborted) setSemantic({ key, error: error.message });
    });
    return () => controller.abort();
  }, [key, selector, projectId, beforeId, afterId, view, computed, verification]);

  const matchingScan = (id?: string | null) => id ? [state.baseline, activeScan].find(scan => scan?.id === id) : undefined;
  const beforeScan = verification ? matchingScan(verification.baselineAudit) : onlyOriginal ? activeScan ?? state.baseline : state.baseline;
  const afterScan = verification ? matchingScan(afterId) : activeScan;
  const oldIssue = history?.issue ?? (onlyOriginal ? issue : originalIssue);
  const beforeSrc = verification?.baselineAudit ? `/api/audits/${verification.baselineAudit}/screenshot` : beforeScan?.screenshot;
  const afterSrc = verification ? (afterId ? `/api/audits/${afterId}/screenshot` : undefined) : afterScan?.screenshot;
  const beforeBounds = oldIssue?.bounds ?? (verification || compareOriginal ? computed?.result?.before.bounds : null);
  const afterBounds = verification ? computed?.result?.after?.bounds : issue?.bounds;
  const tabs = [
    { id: 'visual', name: '页面对照' },
    { id: 'diff', name: '代码变更' },
    { id: 'semantics', name: '无障碍语义' },
  ] as const;

  const reviewing = view === 'diff' && Boolean(proposal);
  return <section className={'preview panel' + (reviewing ? ' preview-reviewing' : '')} aria-labelledby="evidence-title">
    <div className="panel-head"><h2 id="evidence-title">修复效果对比</h2></div>
    <div className="evidence-tabs" role="group" aria-label="修复效果视图">
      {tabs.map(({ id, name }) => <button key={id} aria-pressed={view === id} onClick={() => onView(id)}>{name}</button>)}
    </div>
    {target && <div className="evidence-target"><span>{target.ruleId}</span><code>{selector || '页面级问题'}</code></div>}
    {archivedEvidence && verification && <p className="comparison-status">正在查看历史证据 · {versionName(state, verification.fromSnapshot)} → {versionName(state, verification.toSnapshot)}</p>}
    {view === 'visual' && <>
      <div className="shot-options" role="group" aria-label="截图排列">
        <button aria-pressed={layout === 'both'} onClick={() => setLayoutChoice({ key: layoutKey, mode: 'both' })}>并排对比</button>
        <button aria-pressed={layout === 'before'} onClick={() => setLayoutChoice({ key: layoutKey, mode: 'before' })}>{verification ? '仅修复前' : '仅原始版本'}</button>
        <button aria-pressed={layout === 'after'} onClick={() => setLayoutChoice({ key: layoutKey, mode: 'after' })}>{verification ? '仅修复后' : '仅当前版本'}</button>
      </div>
      {onlyOriginal && <p className="comparison-status">当前为原始版本 V0，尚无修复后版本。</p>}
      <div className={layout === 'both' ? 'shots' : 'shots single-shot'}>
        {layout !== 'after' && <Screenshot key={`before:${beforeSrc}`} title={verification ? `修复前 · ${versionName(state, verification.fromSnapshot)}` : `原始版本 · ${originalVersion ? versionName(state, originalVersion) : 'V0'}`}
          src={beforeSrc} bounds={beforeBounds} size={beforeScan?.size ?? computed?.result?.before.size} location={oldIssue?.bounds ? '扫描定位' : '按扫描版本定位'} />}
        {layout !== 'before' && <Screenshot key={`after:${afterSrc}`} title={verification ? `${afterLabel} · ${versionName(state, afterVersion)}` : onlyOriginal && layout === 'both' ? '修复后版本' : `当前版本 · ${versionName(state, state.project.currentSnapshot)}`}
          src={onlyOriginal && layout === 'both' ? undefined : afterSrc} bounds={afterBounds} size={afterScan?.size ?? computed?.result?.after?.size} location={verification ? '按同一选择器复算位置' : '扫描定位'}
          emptyText={onlyOriginal && layout === 'both' ? '应用补丁并完成复测后，此处将显示修复后的截图。' : undefined} />}
      </div>
      {verification && computed?.error && <p className="shot-location-error">无法复算元素位置。可打开完整截图查看扫描证据。</p>}
      <p className="preview-tip"><Info size={15} />截图来自真实扫描。名称和角色的变化可在「无障碍语义」中查看。</p>
    </>}
    {view === 'diff' && <div className="diff-wrap">
      {proposal ? <>
        <div className="diff-title"><Code2 size={15} />{proposal.patch.targetFile}<span>待审核补丁</span></div>
        <p className="diff-legend"><span>删除内容</span><span>新增内容</span></p>
        <pre className="diff" tabIndex={0} aria-label="待审核的源码差异">{diffWordsWithSpace(proposal.before, proposal.after).map((part, index) =>
          part.added ? <ins key={index}>{part.value}</ins> : part.removed ? <del key={index}>{part.value}</del> : <span key={index}>{part.value}</span>
        )}</pre>
      </> : verification?.diff ? <>
        <div className="diff-title"><Code2 size={15} />{verification.patch?.targetFile ?? state.project.entry}<span>已保存的补丁</span></div>
        <pre className="diff unified-diff" tabIndex={0} aria-label="已保存的源码差异">{verification.diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : undefined}>{line}{'\n'}</span>)}</pre>
      </> : <div className="blank"><Code2 /><b>暂无代码差异</b><p>生成补丁预览，或选择一条修复记录。</p></div>}
    </div>}
    {reviewing && <footer className="patch-review">
      <p id="patch-review-status" role="status">{applying
        ? '正在应用补丁并重新检测。'
        : patchReady ? '请核对源码差异。确认后将修改副本并自动复测。' : '修复内容或图片用途已更改。请重新生成补丁预览。'}</p>
      <div className="repair-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onReject}>取消</button>
        <button type="button" className="button dark" disabled={busy || !patchReady} aria-describedby="patch-review-status" onClick={onConfirm}>
          {applying ? <><LoaderCircle size={15} className="spin" />应用并复测中…</> : '确认应用修复'}
        </button>
      </div>
    </footer>}
    {view === 'semantics' && <div className="semantic-content">
      <p className="muted">数据来自 Chromium 无障碍树。系统按扫描记录重现对应快照，并读取元素的可访问名称、角色及控件状态。</p>
      {!selector || !beforeId ? <div className="blank"><ListChecks /><b>请选择可定位的元素</b><p>页面级规则可能没有单一语义目标。</p></div>
        : computed?.error ? <div className="semantic-message"><p role="status">语义证据暂不可用。{computed.error}</p><button className="secondary" onClick={() => setAttempt(attempt + 1)}>重试</button></div>
        : computed?.result ? <><SemanticTable result={computed.result} repaired={Boolean(verification)} afterLabel={afterLabel} /><p className="muted">{verification ? '复测结论见左侧 AI 修复助手。' : computed.result.after ? '此处对照原始版本与当前版本的浏览器语义。' : '应用并验证补丁后，可查看修复前后的语义变化。'}</p></>
        : <p role="status" className="semantic-message">正在还原版本并计算语义…</p>}
    </div>}
  </section>;
}
