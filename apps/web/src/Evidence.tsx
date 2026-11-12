import type { PageInspection, PanoramaJump } from './Panorama';
import { useEffect, useRef, useState } from 'react';
import { Activity, Info, ListChecks, LoaderCircle } from 'lucide-react';
import { inspectAudit, inspectProposal, type ProposalPreview } from './semantics';
import { versionName, type HistoryItem, type Issue, type Proposal, type State } from './types';

import { EnlargedComparison, Screenshot, SemanticTable, syncScreenshotScroll, type ScreenshotData, type SemanticResult } from './EvidenceDetails';
import { VersionComparison, type VersionPair } from './VersionComparison';
import { PatchReview } from './PatchReview';
import { IssueImpactCard } from './IssueImpactCard';

export type EvidenceView = 'visual' | 'diff' | 'semantics';
type EvidenceProps = {
  autoScanning?:boolean; state: State; jump?:PanoramaJump; onInspection:(value:PageInspection)=>void; scopeTargetId?:string; stateScoped?: boolean; issue?: Issue; history?: HistoryItem; proposal: Proposal | null;
  versionsVisible:boolean; pair: VersionPair; onPair: (pair:VersionPair)=>void; pageRequest?:{path:string};
  view: EvidenceView; onView: (view: EvidenceView) => void;
  problem: string; impact: string;
  busy: boolean; applying: boolean; archivedEvidence: boolean; patchReady: boolean; onConfirm: () => void; onReject: () => void;
};

export function Evidence(props: EvidenceProps) {
  return <ProjectEvidence key={`${props.state.project.id}:${props.state.project.currentSnapshot}:${props.jump?.key ?? ''}`} {...props} />;
}

function ProjectEvidence(props: EvidenceProps) {
  const { state, history, proposal, issue, view, onView } = props;
  const [freeFor, setFreeFor] = useState<string>();
  const historyKey = history && `${history.verification.id}:${history.issue.id}`;
  if (proposal || (historyKey && freeFor !== historyKey)) {
    return <RepairEvidence {...props} onCompare={proposal ? undefined : () => setFreeFor(historyKey)} />;
  }
  return <VersionComparison state={state} autoScanning={props.autoScanning} target={props.stateScoped ? undefined : history?.issue ?? issue} pair={props.pair} onPair={props.onPair} versionsVisible={props.versionsVisible} pageRequest={props.pageRequest} jump={props.jump} onInspection={props.onInspection} scopeTargetId={props.scopeTargetId} busy={props.busy}
    view={view} onView={onView} onHistory={historyKey ? () => setFreeFor(undefined) : undefined} problem={props.problem} impact={props.impact} />;
}

function RepairEvidence({ state, stateScoped, issue, history, proposal, view, onView, busy, applying, archivedEvidence, patchReady, onConfirm, onReject, problem, impact, onCompare }: EvidenceProps & { onCompare?: () => void }) {
  const verification = history?.verification;
  const target = history?.issue ?? issue;
  const selector = target?.selector;
  const activeScan = state.current;
  const beforeId = verification ? verification.baselineAudit : activeScan?.id;
  const afterId = verification?.audit;
  const afterSelector = verification?.sourceTarget ?? selector;
  const afterVersion = verification ? verification.toSnapshot : state.project.currentSnapshot;
  const afterLabel = verification && afterVersion === verification.toSnapshot ? '修复后' : '当前版本';
  const projectId = state.project.id;
  const layoutKey = `${projectId}:${state.project.currentSnapshot}:${verification?.id}:${target?.id}`;
  const [layoutChoice, setLayoutChoice] = useState<{ key: string; mode: 'both' | 'before' | 'after' }>();
  const layout = layoutChoice?.key === layoutKey ? layoutChoice.mode : 'both';
  const [syncScroll, setSyncScroll] = useState(true);
  const shotPanes = useRef<{left:HTMLDivElement|null;right:HTMLDivElement|null}>({left:null,right:null});
  const [attempt, setAttempt] = useState(0);
  const key = `${projectId}:${beforeId}:${afterId}:${selector}:${afterSelector}:${attempt}`;
  const [semantic, setSemantic] = useState<{ key: string; result?: SemanticResult; error?: string }>();
  const computed = semantic?.key === key ? semantic : undefined;

  useEffect(() => {
    if (proposal || !beforeId || !selector || computed || (view !== 'semantics' && !(view === 'visual' && verification && afterId))) return;
    const controller = new AbortController();
    const { signal } = controller;
    async function compute() {
      const first = await inspectAudit(projectId, beforeId!, selector!, signal);
      const second = afterId ? await inspectAudit(projectId, afterId, afterSelector!, signal) : null;
      if (!signal.aborted) setSemantic({ key, result: { before: first, after: second } });
    }
    void compute().catch((error: Error) => {
      if (!signal.aborted) setSemantic({ key, error: error.message });
    });
    return () => controller.abort();
  }, [key, selector, projectId, beforeId, afterId, afterSelector, view, computed, verification, proposal]);

  const proposalId = proposal?.id;
  const [pending, setPending] = useState<{ id: string; attempt: number; data?: ProposalPreview; error?: string }>();
  const preview = proposalId && pending?.id === proposalId && pending.attempt === attempt ? pending : undefined;
  const needsPreview = view !== 'diff' || target?.ruleId === 'color-contrast';
  useEffect(() => {
    if (!proposalId || !needsPreview || preview || applying) return;
    const controller = new AbortController();
    void inspectProposal(proposalId, controller.signal).then(data => {
      if (!controller.signal.aborted) setPending({ id: proposalId, attempt, data });
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setPending({ id: proposalId, attempt, error: error.message });
    });
    return () => controller.abort();
  }, [proposalId, preview, needsPreview, attempt, applying]);
  const previewData = preview?.data;
  const displaySemantics = proposal
    ? previewData && { before: previewData.before.semantics, after: previewData.after.semantics }
    : computed?.result;
  const nonVisual = ['image-alt','aria-broken-idref','aria-valid-attr-value'].includes(target?.ruleId ?? '');
  const matchingScan = (id?: string | null) => id ? [state.baseline, activeScan].find(scan => scan?.id === id) : undefined;
  const beforeScan = matchingScan(beforeId);
  const afterScan = verification ? matchingScan(afterId) : activeScan;
  const oldIssue = target;
  const beforeSrc = previewData?.before.screenshot ?? (stateScoped ? undefined : verification?.baselineAudit ? `/api/audits/${verification.baselineAudit}/screenshot` : beforeScan?.screenshot);
  const afterSrc = proposal ? previewData?.after.screenshot ?? undefined : verification ? (afterId ? `/api/audits/${afterId}/screenshot` : undefined) : afterScan?.screenshot;
  const beforeBounds = previewData?.before.semantics.bounds ?? oldIssue?.bounds ?? computed?.result?.before.bounds;
  const afterBounds = proposal ? previewData?.after.semantics.bounds : verification ? computed?.result?.after?.bounds : issue?.bounds;
  const tabs = [
    { id: 'visual', name: '页面对照' },
    { id: 'semantics', name: '无障碍语义' },
  ] as const;
  const leftShot: ScreenshotData = {
    title: proposal ? '修复前 · ' + versionName(state, state.project.currentSnapshot) : verification ? `修复前 · ${versionName(state, verification.fromSnapshot)}` : versionName(state, state.project.currentSnapshot),
    src: beforeSrc, bounds: beforeBounds, size: previewData?.before.semantics.size ?? beforeScan?.size ?? computed?.result?.before.size,
    location: oldIssue?.bounds ? '扫描定位' : '按扫描版本定位',
  };
  const rightShot: ScreenshotData = {
    title: proposal ? '隔离候选 · 尚未应用' : `${afterLabel} · ${versionName(state, afterVersion)}`,
    src: afterSrc, bounds: afterBounds, size: previewData?.after.semantics.size ?? afterScan?.size ?? computed?.result?.after?.size,
    location: verification ? '按同一选择器复算位置' : '扫描定位',
  };

  const reviewing = view === 'diff' && Boolean(proposal);
  const reviewEvidenceReady = view === 'diff' || (view === 'visual' ? Boolean(previewData && beforeSrc && afterSrc) : Boolean(displaySemantics));
  return <section className={'preview panel' + (reviewing ? ' preview-reviewing' : '')} aria-labelledby="evidence-title">
    <div className="panel-head"><h2 id="evidence-title">修复效果对比</h2><div className="evidence-head-actions">
      <a className="secondary evidence-live-link" href="#original-live"><Activity size={16} />实时操作原网页</a>
      {onCompare && <button type="button" className="secondary comparison-switch" onClick={onCompare}>自由版本对比</button>}
    </div></div>
    {target && <IssueImpactCard problem={problem} impact={impact} />}
    <p className="evidence-state-note">当前画面是扫描时的证据。需要检查登录后、点击或滚动后的状态？进入实时操作后采集，系统会将该状态作为新项目导入。</p>
    <div className="evidence-tabs" role="group" aria-label="修复效果视图">
      {tabs.map(({ id, name }) => <button key={id} aria-pressed={view === id} onClick={() => onView(id)}>{name}</button>)}
      <details className="developer-options"><summary>开发者选项</summary><button type="button" aria-pressed={view === 'diff'} onClick={() => onView('diff')}>代码变更</button></details>
    </div>
    {target && <details className="evidence-target"><summary>查看定位详情</summary><span>{target.ruleId}</span><code>{selector || '页面级问题'}</code></details>}
    {verification && <p className="comparison-status">{archivedEvidence ? '正在查看历史证据' : '已应用 · 本次修复版本'} · {versionName(state, verification.fromSnapshot)} → {versionName(state, verification.toSnapshot)}
      {view !== 'diff' && verification.diff && <> · <button type="button" className="secondary" onClick={() => onView('diff')}>查看已验证补丁</button></>}
    </p>}
    {proposal && <p className="comparison-status">待应用预览 · {versionName(state, state.project.currentSnapshot)} → 隔离候选{!patchReady && ' · 已编辑，需重新生成'}</p>}
    {proposal && view === 'visual' && <section className="repair-summary visual-repair-summary" aria-label="修复内容摘要">
      <h3>本次修复</h3><p>{problem}</p><p><b>建议：</b>{proposal.reason}</p>
      {proposal.patch.value && <p><b>修复内容：</b>{proposal.patch.value}</p>}
      {proposal.imagePurpose === 'decorative' && <p>图片将标记为装饰图片，屏幕阅读器会忽略它。</p>}
      {proposal.sourceReview && <p>修复涉及 {proposal.sourceReview.changes.length} 个文件，已在隔离副本完成预检。</p>}
      {previewData?.before.contrast && previewData.after.contrast && <p>对比度：{previewData.before.contrast.ratio.toFixed(2)}:1 → {previewData.after.contrast.ratio.toFixed(2)}:1</p>}
      <p>请结合页面效果和实际用途核对，确认后系统会再次检测。</p>
    </section>}
    {proposal && view !== 'diff' && !previewData && <p className="comparison-status" role="status">{preview?.error
      ? <>候选证据不可用。<button type="button" className="secondary" onClick={() => setAttempt(attempt + 1)}>重试预览</button></>
      : '正在读取候选页面与浏览器语义…'}</p>}
    {view === 'visual' && <>
      <div className="shot-options" role="group" aria-label="截图排列">
        <button aria-pressed={layout === 'both'} onClick={() => setLayoutChoice({ key: layoutKey, mode: 'both' })}>并排对比</button>
        <button aria-pressed={layout === 'before'} onClick={() => setLayoutChoice({ key: layoutKey, mode: 'before' })}>仅修复前</button>
        <button aria-pressed={layout === 'after'} onClick={() => setLayoutChoice({ key: layoutKey, mode: 'after' })}>{verification ? '仅修复后' : proposal ? '仅候选页面' : '仅当前版本'}</button>
        <label className="sync-scroll"><input type="checkbox" checked={syncScroll} disabled={layout !== 'both'} onChange={event => setSyncScroll(event.target.checked)} />同步滚动{layout !== 'both' && '（并排时生效）'}</label>
        <EnlargedComparison left={leftShot} right={rightShot} />
      </div>
      {nonVisual && (proposal || verification) && <p className="comparison-status">此修改主要影响辅助技术读取。<button type="button" className="secondary" onClick={() => onView('semantics')}>查看语义变化</button></p>}
      <div className={layout === 'both' ? 'shots' : 'shots single-shot'}>
        {layout !== 'after' && <Screenshot key={`before:${beforeSrc}`} {...leftShot}
          onViewport={node => { shotPanes.current.left = node; }}
          onScroll={event => { if (syncScroll && layout === 'both') syncScreenshotScroll(event.currentTarget, shotPanes.current.right); }} />}
        {layout !== 'before' && <Screenshot key={`after:${afterSrc}`} {...rightShot}
          onViewport={node => { shotPanes.current.right = node; }}
          onScroll={event => { if (syncScroll && layout === 'both') syncScreenshotScroll(event.currentTarget, shotPanes.current.left); }} />}
      </div>
      {verification && computed?.error && <p className="shot-location-error">无法复算元素位置。可打开完整截图查看扫描证据。</p>}
      <p className="preview-tip"><Info size={15} />{proposal ? '候选截图来自隔离副本。' : '截图来自真实扫描。'} 名称和角色的变化可在「无障碍语义」中查看。</p>
    </>}
    {view === 'diff' && <div className="diff-wrap source-diffs">
      {proposal || verification?.diff ? <PatchReview key={proposal?.id ?? verification?.id} proposal={proposal} verification={verification}
        problem={problem} impact={impact} rule={target?.ruleId} contrast={previewData && {before:previewData.before.contrast,after:previewData.after.contrast}} />
        : <p className="blank">生成补丁预览，或选择一条修复记录。</p>}
    </div>}
    {proposal && (view === 'diff' || view === 'visual' || view === 'semantics') && <footer className="patch-review">
      <p id="patch-review-status" role="status">{applying
        ? '正在应用补丁并重新检测。'
        : !patchReady ? '修复内容或图片用途已更改。请重新生成修复预览。'
        : !reviewEvidenceReady ? '预览证据尚未就绪；如截图不可用，请查看无障碍语义或开发者代码。'
        : '请核对修复内容和页面效果。确认后将修改副本并自动复测。'}</p>
      <div className="repair-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onReject}>取消</button>
        <button type="button" className="button dark" disabled={busy || !patchReady || !reviewEvidenceReady} aria-describedby="patch-review-status" onClick={onConfirm}>
          {applying ? <><LoaderCircle size={15} className="spin" />应用并复测中…</> : '确认应用修复'}
        </button>
      </div>
    </footer>}
    {view === 'semantics' && <div className="semantic-content">
      <p className="muted">数据来自 Chromium 无障碍树。系统按扫描记录重现对应快照，并读取元素的可访问名称、角色及控件状态。</p>
      {!selector || !beforeId ? <div className="blank"><ListChecks /><b>请选择可定位的元素</b><p>页面级规则可能没有单一语义目标。</p></div>
        : !proposal && computed?.error ? <div className="semantic-message"><p role="status">语义证据暂不可用。{computed.error}</p><button className="secondary" onClick={() => setAttempt(attempt + 1)}>重试</button></div>
        : displaySemantics ? <><SemanticTable result={displaySemantics} repaired={Boolean(verification || proposal)} afterLabel={proposal ? '隔离候选' : afterLabel} /><p className="muted">{proposal ? '这是隔离候选的实际浏览器语义，尚未应用。' : verification ? '复测结论见左侧 AI 修复助手。' : displaySemantics.after ? '此处对照原始版本与当前版本的浏览器语义。' : '应用并验证补丁后，可查看修复前后的语义变化。'}</p></>
        : !proposal && <p role="status" className="semantic-message">正在还原版本并计算语义…</p>}
    </div>}
  </section>;
}
