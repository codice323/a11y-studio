import { workspaceFetch as fetch } from './workspace-fetch';
import { useEffect, useMemo, useState } from 'react';
import type { compareSnapshots } from '../../api/version-compare';
import { Panorama, type PageInspection, type PanoramaJump } from './Panorama';
import type { EvidenceView } from './Evidence';
import { SemanticTable } from './EvidenceDetails';
import { diffFile, PatchReview } from './PatchReview';
import { inspectAudit, type Semantics } from './semantics';
import type { Issue, State } from './types';

export type VersionPair = { left: string; right: string };
type Comparison = ReturnType<typeof compareSnapshots>;
type Evidence = { semantics: Semantics | null; status?: string };

const views: [EvidenceView, string][] = [['interactive', '网页交互'], ['semantics', '无障碍语义']];
const sides = ['left', 'right'] as const;
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

export function VersionComparison({ state, target, pair, view, onView, jump, onInspection, busy, pageRequest, visiblePagePath, pagePickerHost, onChoosePage, autoScanning }: {
  autoScanning?:boolean; state: State; target?: Issue; pair: VersionPair;
  view: EvidenceView; onView: (view: EvidenceView) => void;
  jump?: PanoramaJump; onInspection:(value:PageInspection)=>void; busy:boolean; pageRequest?: {path:string}; visiblePagePath?:string; pagePickerHost?:HTMLDivElement|null; onChoosePage?:(path:string)=>void;
}) {
  const [scoped, setScoped] = useState(Boolean(jump));
  const { left, right } = pair;
  const { id: projectId } = state.project;
  const { id: issueId, selector } = target ?? {};
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([projectId, left, right, issueId, selector, state.current?.id, state.baseline?.id, retry]);
  const [result, setResult] = useState<{ key: string; data?: Comparison; error?: string }>();
  const request = result?.key === key ? result : undefined;
  const data = request?.data;
  const inspectionKey = key + ':' + view;
  const [inspected, setInspected] = useState<{ key: string; values: Record<'left' | 'right', Evidence> }>();
  const evidence = inspected?.key === inspectionKey ? inspected.values : undefined;

  useEffect(() => {
    if (view === 'interactive' || !left || !right) return;
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
  }, [key, projectId, left, right, issueId, selector, view]);

  const needsEvidence = view === 'semantics';
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
      if (!controller.signal.aborted) setInspected({ key: inspectionKey, values: { left: before, right: after } });
    })();
    return () => controller.abort();
  }, [data, inspectionKey, projectId, selector, needsEvidence, left, right, evidence, scoped]);

  const diffs = useMemo(() => (data?.files ?? []).flatMap(({ file, kind, source }) =>
    source ? [diffFile({ file, kind, selector: '', ...source })] : []), [data]);
  const missingFiles = data?.files.filter(file => !file.source) ?? [];
  const labels = {left: '原始状态', right: '当前状态'};
  const same = data && !data.files.length && data.findings &&
    !data.findings.resolved.length && !data.findings.added.length &&
    JSON.stringify(data.review.left) === JSON.stringify(data.review.right);

  return <>


    <Panorama state={state} autoScanning={autoScanning} pair={pair} jump={jump} onInspection={onInspection} disabled={busy}
      onScope={setScoped} targetId={target?.id} view={view} pageRequest={pageRequest} visiblePagePath={visiblePagePath} pagePickerHost={pagePickerHost} onChoosePage={onChoosePage} viewTools={options => <>
        <div className="evidence-tabs comparison-view-tabs" role="group" aria-label="修复效果视图">
          {views.map(([id, label]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => onView(id)}>{label}</button>)}
          <details className="developer-options" data-active={view === 'diff'}><summary>开发者选项</summary><div className="developer-menu"><button type="button" aria-pressed={view === 'diff'} onClick={event => {
            event.currentTarget.closest('details')!.open = false;
            onView('diff');
          }}>代码变更</button>{options}</div></details>
        </div>
        {request?.error && <p className="comparison-status" role="status">{request.error} <button type="button" className="secondary" onClick={() => setRetry(retry + 1)}>重试对比</button></p>}
        {view !== 'interactive' && (!scoped || view === 'diff') && !request?.error && (left === right || same) && <p className="comparison-status muted">{left === right ? '当前状态暂无修复差异。' : '原始状态与当前状态暂无可检测差异。'}</p>}
      </>} />
    {view === 'diff' && data && <div className="diff-wrap source-diffs">
      {diffs.length > 0 && <PatchReview proposal={null} problem="" impact="" comparisonDiffs={diffs} />}
      {missingFiles.length > 0 && <ul>{missingFiles.map(file => <li key={file.file}><code>{file.file}</code> · {file.kind === 'added' ? '新增' : file.kind === 'removed' ? '删除' : '修改'} · 二进制或超出展示上限</li>)}</ul>}
      {data.files.length === 0 && <p className="blank">所选快照的文件内容相同。</p>}
    </div>}
    {!scoped && view === 'semantics' && <div className="semantic-content">
      <p className="muted">使用 Chromium 无障碍树读取所选快照的名称、角色和状态。</p>
      {!selector ? <p className="blank">请先选择可定位的问题元素。</p> : data && !evidence ? <p role="status">正在还原快照并读取浏览器语义…</p> : evidence &&
        <><SemanticTable result={{ before: evidence.left.semantics, after: evidence.right.semantics }}
          beforeLabel={labels.left} afterLabel={labels.right} compare />
          {sides.map(side => evidence[side].status && <p key={side} role="status">{labels[side]} · {evidence[side].status}</p>)}
          {sides.some(side => evidence[side].status) && <button type="button" className="secondary" onClick={() => setRetry(retry + 1)}>重试语义读取</button>}
        </>}
    </div>}
    {data && !scoped && (view === 'diff' || view === 'semantics') && <ComparisonSummary comparison={data} diffs={diffs} />}
    {scoped && view === 'diff' && <p className="muted">代码变更比较所选版本的项目文件，可能包含其他页面共用的源码。</p>}
    {(view === 'diff' || view === 'semantics') && <p className="comparison-status muted">只读对比</p>}
  </>;
}
