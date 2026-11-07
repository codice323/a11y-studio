import { useEffect, useRef, useState } from 'react';
import { Code2, Eye, Info, ListChecks } from 'lucide-react';
import { diffWordsWithSpace } from 'diff';
import { inspectAudit, type Semantics } from './semantics';
import { versionLabel, type Bounds, type HistoryItem, type Issue, type Proposal, type State } from './types';

export type EvidenceView = 'visual' | 'diff' | 'semantics';
type SemanticResult = { before: Semantics; after: Semantics | null };

function Screenshot({ title, src, bounds, size, location }: {
  title: string; src?: string; bounds?: Bounds | null;
  size?: { width: number; height: number }; location?: string;
}) {
  const [failed, setFailed] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);
  function center() {
    const pane = viewport.current;
    const target = marker.current;
    if (pane && target) pane.scrollTop = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - pane.clientHeight / 3;
  }
  useEffect(center, [bounds, size]);
  const locate = bounds && size && size.width > 0 && size.height > 0;
  return <figure className="shot">
    <figcaption><Eye size={15} />{title}</figcaption>
    {src && !failed ? <div className="screen-wrap" ref={viewport} tabIndex={0} role="region" aria-label={title + '截图'}>
      <div className="screen-image">
        <img src={src} alt={title + '的页面截图'} onLoad={center} onError={() => setFailed(true)} />
        {locate && <div ref={marker} className="highlight" aria-hidden="true" style={{
          left: `${bounds.x / size.width * 100}%`, top: `${bounds.y / size.height * 100}%`,
          width: `${bounds.width / size.width * 100}%`, height: `${bounds.height / size.height * 100}%`,
        }} />}
      </div>
    </div> : <p className="shot-empty">{failed ? '截图加载失败。' : '此版本暂无截图。'}</p>}
    <div className="shot-foot">{locate ? location : '暂无此元素的可靠截图坐标'}{src && !failed && <a href={src} target="_blank" rel="noreferrer">打开完整截图</a>}</div>
  </figure>;
}

function SemanticTable({ result }: { result: SemanticResult }) {
  const stateText = (item: Semantics) => item.states.map(([key, value]) => `${key}=${value}`).join(' · ') || '无记录的控件状态';
  const rows: [string, (item: Semantics) => string][] = [
    ['可访问名称', item => item.ignored ? '未暴露' : item.name || '（空）'],
    ['角色', item => item.ignored ? '未暴露' : item.role || '无具名角色'],
    ['无障碍树', item => item.ignored ? '忽略' + (item.ignoredReasons.length ? `（${item.ignoredReasons.join('、')}）` : '') : '已暴露'],
    ['可聚焦性', item => item.focusable ? '可聚焦' : '不可聚焦'],
    ['控件状态', stateText],
  ];
  return <table className="semantic-table">
    <thead><tr><th scope="col">语义字段</th><th scope="col">{result.after ? '修复前' : '当前扫描版本'}</th>{result.after && <th scope="col">修复后</th>}</tr></thead>
    <tbody>{rows.map(([label, value]) => <tr key={label}>
      <th scope="row">{label}</th><td>{value(result.before)}</td>
      {result.after && <td className={value(result.before) !== value(result.after) ? 'changed' : undefined}>{value(result.after)}{value(result.before) !== value(result.after) && <small>已变化</small>}</td>}
    </tr>)}</tbody>
  </table>;
}

export function Evidence({ state, issue, history, proposal, view, onView }: {
  state: State; issue?: Issue; history?: HistoryItem; proposal: Proposal | null;
  view: EvidenceView; onView: (view: EvidenceView) => void;
}) {
  const verification = history?.verification;
  const target = history?.issue ?? issue;
  const selector = target?.selector;
  const activeScan = state.current;
  const beforeId = verification ? verification.baselineAudit : activeScan?.id;
  const afterId = verification?.audit;
  const projectId = state.project.id;
  const [layout, setLayout] = useState<'both' | 'before' | 'after'>('both');
  const [attempt, setAttempt] = useState(0);
  const key = `${projectId}:${beforeId}:${afterId}:${selector}:${attempt}`;
  const [semantic, setSemantic] = useState<{ key: string; result?: SemanticResult; error?: string }>();
  const computed = semantic?.key === key ? semantic : undefined;

  useEffect(() => {
    if (!beforeId || !selector || computed || (view !== 'semantics' && !(view === 'visual' && afterId))) return;
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
  }, [key, selector, projectId, beforeId, afterId, view, computed]);

  const matchingScan = (id?: string | null) => id ? [state.baseline, activeScan].find(scan => scan?.id === id) : undefined;
  const beforeScan = verification ? matchingScan(verification.baselineAudit) : state.baseline;
  const afterScan = verification ? matchingScan(verification.audit) : activeScan;
  const oldIssue = history?.issue ?? beforeScan?.issues.find(item => item.id === issue?.id);
  const beforeSrc = verification?.baselineAudit ? `/api/audits/${verification.baselineAudit}/screenshot` : beforeScan?.screenshot;
  const afterSrc = verification ? (verification.audit ? `/api/audits/${verification.audit}/screenshot` : undefined) : afterScan?.screenshot;
  const beforeBounds = oldIssue?.bounds ?? computed?.result?.before.bounds;
  const afterBounds = verification ? computed?.result?.after?.bounds : issue?.bounds;
  const tabs = [
    { id: 'visual', name: '视觉对比', icon: Eye },
    { id: 'diff', name: '代码 Diff', icon: Code2 },
    { id: 'semantics', name: '无障碍语义', icon: ListChecks },
  ] as const;

  return <section className="preview panel" aria-labelledby="evidence-title">
    <div className="panel-head"><div><span className="kicker">02 / EVIDENCE</span><h2 id="evidence-title">修复证据</h2></div></div>
    <div className="evidence-tabs" role="group" aria-label="证据视图">
      {tabs.map(({ id, name, icon: Icon }) => <button key={id} aria-pressed={view === id} onClick={() => onView(id)}><Icon size={15} />{name}</button>)}
    </div>
    {target && <div className="evidence-target"><span>{target.ruleId}</span><code>{selector || '页面级问题'}</code></div>}
    {view === 'visual' && <>
      <div className="shot-options" role="group" aria-label="截图排列">
        <button aria-pressed={layout === 'both'} onClick={() => setLayout('both')}>并排对比</button>
        <button aria-pressed={layout === 'before'} onClick={() => setLayout('before')}>{verification ? '仅修复前' : '仅原始版本'}</button>
        <button aria-pressed={layout === 'after'} onClick={() => setLayout('after')}>{verification ? '仅修复后' : '仅当前版本'}</button>
      </div>
      <div className={layout === 'both' ? 'shots' : 'shots single-shot'}>
        {layout !== 'after' && <Screenshot key={beforeSrc ?? 'no-before'} title={verification ? `修复前 · ${versionLabel(state, verification.fromSnapshot)}` : '原始版本'}
          src={beforeSrc} bounds={beforeBounds} size={beforeScan?.size ?? computed?.result?.before.size} location={oldIssue?.bounds ? '扫描定位' : '按扫描版本定位'} />}
        {layout !== 'before' && <Screenshot key={afterSrc ?? 'no-after'} title={verification ? `修复后 · ${versionLabel(state, verification.toSnapshot)}` : '当前版本'}
          src={afterSrc} bounds={afterBounds} size={afterScan?.size ?? computed?.result?.after?.size} location={verification ? '按同一选择器复算位置' : '扫描定位'} />}
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
    {view === 'semantics' && <div className="semantic-content">
      <p className="muted">数据来自 Chromium 无障碍树。系统按扫描记录重现对应快照，并读取元素的可访问名称、角色及控件状态。</p>
      {!selector || !beforeId ? <div className="blank"><ListChecks /><b>请选择可定位的元素</b><p>页面级规则可能没有单一语义目标。</p></div>
        : computed?.error ? <div className="semantic-message"><p role="status">语义证据暂不可用。{computed.error}</p><button className="secondary" onClick={() => setAttempt(attempt + 1)}>重试</button></div>
        : computed?.result ? <><SemanticTable result={computed.result} /><p className="muted">{verification ? '表格用于解释辅助技术可读取的信息。复测是否通过以右侧验证记录为准。' : '应用并验证补丁后，可查看修复前后的语义变化。'}</p></>
        : <p role="status" className="semantic-message">正在还原版本并计算语义…</p>}
    </div>}
  </section>;
}
