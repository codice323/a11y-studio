import type { PageInspection, PanoramaJump } from './Panorama';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ListChecks, LoaderCircle } from 'lucide-react';
import { inspectAudit, inspectProposal, type ProposalPreview } from './semantics';
import type { HistoryItem, Issue, Proposal, State } from './types';

import { SemanticTable, type SemanticResult } from './EvidenceDetails';
import { VersionComparison, type VersionPair } from './VersionComparison';
import { PatchReview } from './PatchReview';

export type EvidenceView = 'interactive' | 'diff' | 'semantics';
type EvidenceProps = {
  interactive?: (toolsHost: HTMLDivElement | null) => ReactNode; autoScanning?:boolean; state: State; jump?:PanoramaJump; onInspection:(value:PageInspection)=>void; stateScoped?: boolean; issue?: Issue; history?: HistoryItem; proposal: Proposal | null;
  pair: VersionPair; pageRequest?:{path:string}; visiblePagePath?:string; onChoosePage?:(path:string)=>void;
  view: EvidenceView; onView: (view: EvidenceView) => void;
  problem: string; impact: string; versionToggle?: ReactNode;
  busy: boolean; applying: boolean; archivedEvidence: boolean; patchReady: boolean; reviewHost?: HTMLDivElement | null; onConfirm: (semantics?: SemanticResult) => void; onReject: () => void;
};

export function Evidence(props: EvidenceProps) {
  const { state, history, proposal, issue, view, onView } = props;
  const key = `${state.project.id}:${state.project.currentSnapshot}:${props.jump?.key ?? ''}`;
  const [pagePickerHost, setPagePickerHost] = useState<HTMLDivElement | null>(null);
  const [reviewHost, setReviewHost] = useState<HTMLDivElement | null>(null);
  const [toolsHost, setToolsHost] = useState<HTMLDivElement | null>(null);
  const reviewing = proposal && view === 'diff';
  return <section className={'preview panel' + (reviewing ? ' preview-reviewing' : '')} aria-labelledby="evidence-title">
    <div className="panel-head workspace-diagnosis-heading"><h2 id="evidence-title">网页诊断</h2><div ref={setPagePickerHost} className="workspace-page-picker" /></div>
    <div className="workspace-evidence-controls">
    {proposal || (history && (!history.verification.panoramaState || history.verification.status === 'applied')) ? <RepairEvidence key={key} {...props} reviewHost={reviewHost} setToolsHost={setToolsHost} /> :
      <VersionComparison key={key} state={state} autoScanning={props.autoScanning} target={props.stateScoped || history?.verification.panoramaState ? undefined : history?.issue ?? issue}
        pair={props.pair} pagePickerHost={pagePickerHost} pageRequest={props.pageRequest} visiblePagePath={props.visiblePagePath} onChoosePage={props.onChoosePage}
        jump={props.jump} onInspection={props.onInspection} busy={props.busy} view={view} onView={onView} />}
    </div>
    <div className="inline-interactive" hidden={view !== 'interactive'}>{props.interactive?.(toolsHost)}</div>
    <div ref={setReviewHost} className="preview-review-footer" />
  </section>;
}

function RepairEvidence({ state, stateScoped, issue, history, proposal, view, onView, busy, applying, archivedEvidence, patchReady, reviewHost, onConfirm, onReject, problem, impact, versionToggle, setToolsHost }: EvidenceProps & {setToolsHost:(node:HTMLDivElement|null)=>void}) {
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
  const [attempt, setAttempt] = useState(0);
  const key = `${projectId}:${beforeId}:${afterId}:${selector}:${afterSelector}:${attempt}`;
  const [semantic, setSemantic] = useState<{ key: string; result?: SemanticResult; error?: string }>();
  const computed = semantic?.key === key ? semantic : undefined;

  useEffect(() => {
    if (proposal || history?.semantics || !beforeId || !selector || computed || view !== 'semantics') return;
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
  useEffect(() => {
    if (!proposalId || preview || applying) return;
    const controller = new AbortController();
    void inspectProposal(proposalId, controller.signal).then(data => {
      if (!controller.signal.aborted) setPending({ id: proposalId, attempt, data });
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setPending({ id: proposalId, attempt, error: error.message });
    });
    return () => controller.abort();
  }, [proposalId, preview, attempt, applying]);
  const previewData = preview?.data;
  const displaySemantics = proposal
    ? previewData && { before: previewData.before.semantics, after: previewData.after.semantics }
    : history?.semantics ?? computed?.result;
  const tabs = [
    { id: 'interactive', name: '网页交互' },
    { id: 'semantics', name: '无障碍语义' },
  ] as const;
  const contrastReview = proposal && target?.ruleId === 'color-contrast';
  const candidateContrast = previewData?.after.contrast;
  const reviewEvidenceReady = Boolean(previewData);
  const reviewActions = proposal && <footer className="patch-review">
    <p id="patch-review-status" role="status">{previewData?.before.contrast && candidateContrast && !candidateContrast.uncertain && !previewData.before.contrast.uncertain && `对比度 ${previewData.before.contrast.ratio.toFixed(2)}:1 → ${candidateContrast.ratio.toFixed(2)}:1。`}
      {applying ? '正在保存补丁。' : preview?.error ? '页面预览失败，请重试。' : !reviewEvidenceReady ? '正在加载预览。' : ''}</p>
    <div className="repair-actions">
      {reviewHost && preview?.error && <button type="button" className="secondary" disabled={busy}
        onClick={() => setAttempt(attempt + 1)}>重试预览</button>}
      <button type="button" className="secondary" disabled={busy} onClick={onReject}>取消</button>
      <button type="button" className="button dark" disabled={busy || !patchReady || !reviewEvidenceReady} aria-describedby="patch-review-status" onClick={()=>onConfirm(displaySemantics || undefined)}>
        {applying ? <><LoaderCircle size={15} className="spin" />保存中…</> : '确认应用修复'}
      </button>
    </div>
  </footer>;
  return <>
    <div className="evidence-tabs comparison-view-tabs" role="group" aria-label="修复效果视图">
      {tabs.map(({ id, name }) => <button key={id} aria-pressed={view === id} onClick={() => onView(id)}>{name}</button>)}
      <details className="developer-options"><summary>开发者选项</summary><div className="developer-menu"><button type="button" aria-pressed={view === 'diff'} onClick={() => onView('diff')}>代码变更</button><div ref={setToolsHost} /></div></details>
    </div>
    {verification && <div className="comparison-status repair-status-row"><span>
      {archivedEvidence ? '历史复测' : '本次修复'} · {verification.status === 'applied' ? '补丁已应用' : verification.status === 'passed' && verification.targetFixed ? '已修复' : '请核对复测结果'}
      {verification.contrastBefore && !verification.contrastBefore.uncertain && verification.contrastCheck?.valid &&
        !verification.contrastCheck.uncertain && `，对比度由 ${verification.contrastBefore.ratio.toFixed(2)}:1 提升到 ${verification.contrastCheck.ratio.toFixed(2)}:1`}
      {view !== 'diff' && (verification.diff || verification.sourceReview) && <> · <button type="button" className="secondary" onClick={() => onView('diff')}>查看补丁</button></>}
    </span>{view === 'interactive' && versionToggle}</div>}
    {proposal && (view !== 'diff' || contrastReview) && !previewData && <p className="comparison-status" role="status">{preview?.error
      ? <>候选证据不可用。<button type="button" className="secondary" onClick={() => setAttempt(attempt + 1)}>重试预览</button></>
      : '正在读取候选页面与浏览器语义…'}</p>}
    {view === 'diff' && <div className="diff-wrap source-diffs">
      {proposal || verification?.diff || verification?.sourceReview ? <PatchReview key={proposal?.id ?? verification?.id} proposal={proposal} verification={verification}
        problem={problem} impact={impact} rule={target?.ruleId} contrast={previewData && {before:previewData.before.contrast,after:previewData.after.contrast}} />
        : <p className="blank">生成补丁预览，或选择一条修复记录。</p>}
    </div>}
    {reviewHost ? createPortal(reviewActions, reviewHost) : reviewActions}
    {view === 'semantics' && <div className="semantic-content">
      <p className="muted">数据来自 Chromium 无障碍树。系统按扫描记录重现对应快照，并读取元素的可访问名称、角色及控件状态。</p>
      {!selector || !beforeId ? <div className="blank"><ListChecks /><b>请选择可定位的元素</b><p>页面级规则可能没有单一语义目标。</p></div>
        : !proposal && computed?.error ? <div className="semantic-message"><p role="status">语义证据暂不可用。{computed.error}</p><button className="secondary" onClick={() => setAttempt(attempt + 1)}>重试</button></div>
        : displaySemantics ? <><SemanticTable result={displaySemantics} repaired={Boolean(verification || proposal)} afterLabel={proposal ? '隔离候选' : afterLabel} /><p className="muted">{proposal ? '这是隔离候选的实际浏览器语义，尚未应用。' : verification?.status === 'passed' ? '复测结论见右侧 AI 修复助手。' : displaySemantics.after ? '此处对照原始版本与当前版本的浏览器语义。' : '可在补丁预览中查看修改前后的语义。'}</p></>
        : !proposal && <p role="status" className="semantic-message">正在还原版本并计算语义…</p>}
    </div>}
  </>;
}
