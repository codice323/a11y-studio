import { workspaceFetch as fetch } from './workspace-fetch';
import { useEffect, useMemo, useState } from 'react';
import type { compareSnapshots } from '../../api/version-compare';
import { Panorama, type PageInspection, type PanoramaJump } from './Panorama';
import type { EvidenceView } from './Evidence';
import { EnlargedComparison, Screenshot, SemanticTable, type ScreenshotData } from './EvidenceDetails';
import { diffFile, PatchReview } from './PatchReview';
import { inspectAudit, type Semantics } from './semantics';
import { versionName, type Issue, type State } from './types';

export type VersionPair = { left: string; right: string };
type Comparison = ReturnType<typeof compareSnapshots>;
type Evidence = { semantics: Semantics | null; status?: string };

const views: [EvidenceView, string][] = [['visual', '页面对照'], ['semantics', '无障碍语义']];
const sides = ['left', 'right'] as const;
const layouts = [['both', '并排对比'], ['left', '仅左侧版本'], ['right', '仅右侧版本']] as const;

function ComparisonSummary({ comparison, diffs }: { comparison: Comparison; diffs: ReturnType<typeof diffFile>[] }) {
  const { files, findings, review } = comparison;
  const changes = diffs.flatMap(diff => diff.changes);
  const additions = changes.filter(change => change.kind === 'added').length;
  const removals = changes.filter(change => change.kind === 'removed').length;
  return <section className="repair-summary comparison-summary" aria-label="版本差异摘要">
    <h3>版本差异摘要</h3>
    {findings ? <p>右侧不再报告 {findings.resolved.length} 个问题 · 右侧新增 {findings.added.length} 个问题</p>
      : <p>至少一侧缺少扫描结果，无法统计问题增减。</p>}
    <details><summary>查看文件变更摘要</summary><p>{files.length} 个文件有变更 · 已显示 {additions} 处新增、{changes.length - additions - removals} 处修改、{removals} 处删除
      {files.length > diffs.length && ` · ${files.length - diffs.length} 个二进制或超出展示上限的文件未展开`}</p></details>
    {findings && Boolean(findings.resolved.length || findings.added.length) && <details>
      <summary>查看问题增减</summary>
      <ul>{(['resolved', 'added'] as const).flatMap(kind => findings[kind].map(item =>
        <li key={item.id}>{kind === 'resolved' ? '右侧不再报告' : '右侧新增'} · {item.help} · <code>{item.selector || '页面级'}</code></li>))}</ul>
    </details>}
    <p>待人工复核记录 · 左侧 {comparison.left.auditId ? `${review.left.length} 组` : '未扫描'} · 右侧 {comparison.right.auditId ? `${review.right.length} 组` : '未扫描'}</p>
    {Boolean(review.left.length || review.right.length) && <details><summary>查看待复核依据</summary>
      {sides.map(side => review[side].length > 0 && <div key={side}>
        <strong>{side === 'left' ? '左侧' : '右侧'}</strong>
        <ul>{review[side].map((item, index) => <li key={index}>{item.label} · {item.detail}</li>)}</ul>
      </div>)}
    </details>}
  </section>;
}

export function ComparisonVersions({state,pair,onPair,busy}: {
  state:State; pair:VersionPair; onPair:(pair:VersionPair)=>void; busy:boolean;
}) {
  return <div className="version-comparison-toolbar" role="group" aria-label="只读版本对比">
    {sides.map(side => <label key={side}>{side === 'left' ? '左侧版本' : '右侧版本'}
      <select disabled={busy} value={pair[side]} title={versionName(state,pair[side])}
        onChange={event => onPair({...pair,[side]:event.target.value})}>
        {!pair[side] && <option value="">原始版本缺失</option>}
        {state.snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{versionName(state,snapshot.id)}</option>)}
      </select>
    </label>)}
    <button type="button" className="secondary" disabled={busy || !pair.left || pair.left === pair.right}
      onClick={() => onPair({left:pair.right,right:pair.left})}>交换版本</button>
  </div>;
}

export function VersionComparison({ state, target, pair, onPair, view, onView, onHistory, jump, onInspection, scopeTargetId, busy, pageRequest, versionsVisible }: {
  state: State; target?: Issue; pair: VersionPair; onPair: (pair: VersionPair) => void;
  view: EvidenceView; onView: (view: EvidenceView) => void; onHistory?: () => void;
  jump?: PanoramaJump; onInspection:(value:PageInspection)=>void; scopeTargetId?:string; busy:boolean; versionsVisible:boolean; pageRequest?: {path:string};
}) {
  const [scoped, setScoped] = useState(Boolean(jump));
  const { left, right } = pair;
  const { id: projectId, currentSnapshot } = state.project;
  const { id: issueId, selector } = target ?? {};
  const [layout, setLayout] = useState<(typeof layouts)[number][0]>('both');
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([projectId, left, right, issueId, selector, state.current?.id, state.baseline?.id, retry]);
  const [result, setResult] = useState<{ key: string; data?: Comparison; error?: string }>();
  const request = result?.key === key ? result : undefined;
  const data = request?.data;
  const [inspected, setInspected] = useState<{ key: string; values: Record<'left' | 'right', Evidence> }>();
  const evidence = inspected?.key === key ? inspected.values : undefined;

  useEffect(() => {
    if (!left || !right) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ left, right });
    if (issueId) params.set('issueId', issueId);
    if (selector) params.set('selector', selector);
    void fetch(`/api/projects/${projectId}/compare?${params}`, { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '无法读取版本差异。');
      if (body.left.id !== left || body.right.id !== right) throw new Error('返回的版本与所选版本不一致。');
      if (!controller.signal.aborted) setResult({ key, data: body });
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setResult({ key, error: error.message });
    });
    return () => controller.abort();
  }, [key, projectId, left, right, issueId, selector]);

  const needsEvidence = view !== 'diff';
  useEffect(() => {
    if (scoped || !data || !selector || !needsEvidence || evidence) return;
    const controller = new AbortController();
    async function inspect(side: Comparison['left']): Promise<Evidence> {
      if (!side.auditId) return { semantics: null, status: '此版本暂无可用扫描证据。' };
      if (!side.selector) return { semantics: null, status: '此版本没有可靠的对应元素定位。' };
      try {
        return { semantics: await inspectAudit(projectId, side.auditId, side.selector, controller.signal) };
      } catch (error) {
        return { semantics: null, status: (error as Error).message };
      }
    }
    void (async () => {
      const before = await inspect(data.left);
      if (controller.signal.aborted) return;
      const after = left === right ? before : await inspect(data.right);
      if (!controller.signal.aborted) setInspected({ key, values: { left: before, right: after } });
    })();
    return () => controller.abort();
  }, [data, key, projectId, selector, needsEvidence, left, right, evidence, scoped]);

  const diffs = useMemo(() => (data?.files ?? []).flatMap(({ file, kind, source }) =>
    source ? [diffFile({ file, kind, selector: '', ...source })] : []), [data]);
  const missingFiles = data?.files.filter(file => !file.source) ?? [];
  const name = (id: string) => versionName(state, id);
  const same = data && !data.files.length && data.findings &&
    !data.findings.resolved.length && !data.findings.added.length &&
    JSON.stringify(data.review.left) === JSON.stringify(data.review.right);

  function screenshot(side: 'left' | 'right'): ScreenshotData {
    const id = pair[side];
    const scan = [state.baseline, state.current].find(item => item?.snapshotId === id);
    const found = evidence?.[side];
    return {
      title: `${side === 'left' ? '左侧' : '右侧'} · ${id ? name(id) : '未选择版本'}`,
      src: data ? data[side].screenshot : scan?.screenshot,
      bounds: found?.semantics?.bounds, size: found?.semantics?.size, location: data?.[side].selector,
      locationStatus: !selector ? '请选择可定位的问题' : found ? found.status ?? '无法在截图上标记该元素。' : request?.error ? '元素位置不可用。' : '正在定位元素…',
      emptyText: !data && !request && id ? '正在加载此版本截图…' : '此版本暂无截图。',
    };
  }

  return <section className="preview panel" aria-labelledby="evidence-title">
    <div className="panel-head"><h2 id="evidence-title">修复效果对比</h2>
      {onHistory && <button type="button" className="secondary comparison-switch" onClick={onHistory}>返回本次修复证据</button>}
    </div>
    {versionsVisible && <ComparisonVersions state={state} pair={pair} onPair={onPair} busy={busy} />}
    <Panorama state={state} pair={pair} jump={jump} onInspection={onInspection} scopeTargetId={scopeTargetId} disabled={busy}
      onScope={setScoped} targetId={target?.id} view={view} pageRequest={pageRequest} viewTools={<>
        <div className="evidence-tabs comparison-view-tabs" role="group" aria-label="修复效果视图">
          {views.map(([id, label]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => onView(id)}>{label}</button>)}
          <details className="developer-options" data-active={view === 'diff'}><summary>开发者选项</summary><button type="button" aria-pressed={view === 'diff'} onClick={event => {
            event.currentTarget.closest('details')!.open = false;
            onView('diff');
          }}>代码变更</button></details>
        </div>
        {target && <details className="evidence-target"><summary>查看定位详情</summary><span>{target.ruleId}</span><code>{selector || '页面级问题'}</code></details>}
        {request?.error && <p className="comparison-status" role="status">{request.error} <button type="button" className="secondary" onClick={() => setRetry(retry + 1)}>重试对比</button></p>}
        {(!scoped || view === 'diff') && !request?.error && (left === right || same) && <p className="comparison-status muted">这两个版本暂无可检测差异。{left === right && '左右选择了同一版本。'}</p>}
      </>} />
    {!scoped && view === 'visual' && <>
      <div className="shot-options" role="group" aria-label="截图排列">
        {layouts.map(([id, label]) => <button key={id} type="button" aria-pressed={layout === id} onClick={() => setLayout(id)}>{label}</button>)}
        <EnlargedComparison left={screenshot('left')} right={screenshot('right')} />
      </div>
      <div className={layout === 'both' ? 'shots' : 'shots single-shot'}>
        {sides.filter(side => layout === 'both' || layout === side).map(side => {
          const shot = screenshot(side);
          return <Screenshot key={`${side}:${pair[side]}:${shot.src}`} {...shot} />;
        })}
      </div>
    </>}
    {view === 'diff' && data && <div className="diff-wrap source-diffs">
      {diffs.length > 0 && <PatchReview proposal={null} problem="" impact="" comparisonDiffs={diffs} />}
      {missingFiles.length > 0 && <ul>{missingFiles.map(file => <li key={file.file}><code>{file.file}</code> · {file.kind === 'added' ? '新增' : file.kind === 'removed' ? '删除' : '修改'} · 二进制或超出展示上限</li>)}</ul>}
      {data.files.length === 0 && <p className="blank">所选快照的文件内容相同。</p>}
    </div>}
    {!scoped && view === 'semantics' && <div className="semantic-content">
      <p className="muted">使用 Chromium 无障碍树读取所选快照的名称、角色和状态。</p>
      {!selector ? <p className="blank">请先选择可定位的问题元素。</p> : data && !evidence ? <p role="status">正在还原快照并读取浏览器语义…</p> : evidence &&
        <><SemanticTable result={{ before: evidence.left.semantics, after: evidence.right.semantics }}
          beforeLabel={name(left)} afterLabel={name(right)} compare />
          {sides.map(side => evidence[side].status && <p key={side} role="status">{name(pair[side])} · {evidence[side].status}</p>)}
          {sides.some(side => evidence[side].status) && <button type="button" className="secondary" onClick={() => setRetry(retry + 1)}>重试语义读取</button>}
        </>}
    </div>}
    {data && !scoped && view !== 'visual' && <ComparisonSummary comparison={data} diffs={diffs} />}
    {scoped && view === 'diff' && <p className="muted">代码变更比较所选版本的项目文件，可能包含其他页面共用的源码。</p>}
    {view !== 'visual' && <p className="comparison-status muted">只读对比 · 项目当前版本为 {name(currentSnapshot)}。</p>}
  </section>;
}
