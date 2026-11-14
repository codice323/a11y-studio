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
  interactive?: ReactNode; autoScanning?:boolean; state: State; jump?:PanoramaJump; onInspection:(value:PageInspection)=>void; stateScoped?: boolean; issue?: Issue; history?: HistoryItem; proposal: Proposal | null;
  pair: VersionPair; pageRequest?:{path:string}; visiblePagePath?:string; onChoosePage?:(path:string)=>void;
  view: EvidenceView; onView: (view: EvidenceView) => void;
  problem: string; impact: string;
  busy: boolean; applying: boolean; archivedEvidence: boolean; patchReady: boolean; reviewHost?: HTMLDivElement | null; onConfirm: () => void; onReject: () => void;
};

export function Evidence(props: EvidenceProps) {
  const { state, history, proposal, issue, view, onView } = props;
  const key = `${state.project.id}:${state.project.currentSnapshot}:${props.jump?.key ?? ''}`;
  const reviewing = proposal && view === 'diff';
  return <section className={'preview panel' + (reviewing ? ' preview-reviewing' : '')} aria-labelledby="evidence-title">
    <div className="panel-head"><h2 id="evidence-title">网页诊断</h2></div>
    <div className="workspace-evidence-controls">
    {proposal || (history && !history.verification.panoramaState) ? <RepairEvidence key={key} {...props} /> :
      <VersionComparison key={key} state={state} autoScanning={props.autoScanning} target={props.stateScoped || history?.verification.panoramaState ? undefined : history?.issue ?? issue}
        pair={props.pair} pageRequest={props.pageRequest} visiblePagePath={props.visiblePagePath} onChoosePage={props.onChoosePage}
        jump={props.jump} onInspection={props.onInspection} busy={props.busy} view={view} onView={onView} />}
    </div>
    <div className="inline-interactive" hidden={view !== 'interactive'}>{props.interactive}</div>
  </section>;
}

function RepairEvidence({ state, stateScoped, issue, history, proposal, view, onView, busy, applying, archivedEvidence, patchReady, reviewHost, onConfirm, onReject, problem, impact }: EvidenceProps) {
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
    if (proposal || !beforeId || !selector || computed || view !== 'semantics') return;
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
  const tabs = [
    { id: 'interactive', name: '网页交互' },
    { id: 'semantics', name: '无障碍语义' },
  ] as const;
  const contrastReview = proposal && target?.ruleId === 'color-contrast';
  const candidateContrast = previewData?.after.contrast;
  const groupSize = proposal?.patch.contrastTargets?.length ?? 1;
  const contrastChecks = [candidateContrast, ...(previewData?.after.additionalContrast ?? [])];
  const passedCount=contrastChecks.filter(check=>check?.valid).length;
  const reviewEvidenceReady = contrastReview ? passedCount === groupSize : view === 'diff' || Boolean(displaySemantics);
  const reviewActions = proposal && <footer className="patch-review">
    <p id="patch-review-status" role="status">{applying
      ? '正在应用补丁并重新检测。'
      : !patchReady ? (reviewHost ? '颜色已更改，请重新预览。' : '修复内容或图片用途已更改。请重新生成修复预览。')
      : contrastReview && contrastChecks.some(check=>check?.uncertain) ? '无法可靠测量候选颜色，请人工复核文字和背景。'
      : contrastReview && previewData && !reviewEvidenceReady
        ? (groupSize > 1 ? `${passedCount}/${groupSize} 处对比度达标。请选择其他颜色，或取消勾选「修复同组」。` : '对比度未达标，请选择其他颜色。')
      : !reviewEvidenceReady ? (contrastReview ? (preview?.error ? '配色预览失败，请重试。' : '正在检查所选颜色的对比度…') : '预览证据尚未就绪。可查看无障碍语义或开发者代码。')
      : contrastReview ? (groupSize > 1 ? `${groupSize} 处对比度均达标，可以应用修复。` : '所选颜色对比度达标，可以应用修复。')
      : '请核对修复内容和页面效果。确认后将修改副本并自动复测。'}</p>
    <div className="repair-actions">
      {reviewHost && preview?.error && <button type="button" className="secondary" disabled={busy}
        onClick={() => setAttempt(attempt + 1)}>重试颜色预览</button>}
      <button type="button" className="secondary" disabled={busy} onClick={onReject}>取消</button>
      <button type="button" className="button dark" disabled={busy || !patchReady || !reviewEvidenceReady} aria-describedby="patch-review-status" onClick={onConfirm}>
        {applying ? <><LoaderCircle size={15} className="spin" />应用并复测中…</> : '确认应用修复'}
      </button>
    </div>
  </footer>;
  return <>
    <div className="evidence-tabs" role="group" aria-label="修复效果视图">
      {tabs.map(({ id, name }) => <button key={id} aria-pressed={view === id} onClick={() => onView(id)}>{name}</button>)}
      <details className="developer-options"><summary>开发者选项</summary><button type="button" aria-pressed={view === 'diff'} onClick={() => onView('diff')}>代码变更</button></details>
    </div>
    {target && <details className="evidence-target"><summary>查看定位详情</summary><span>{target.ruleId}</span><code>{selector || '页面级问题'}</code></details>}
    {verification && <p className="comparison-status">{archivedEvidence ? '正在查看历史证据' : '修复已应用'}
      {view !== 'diff' && (verification.diff || verification.sourceReview) && <> · <button type="button" className="secondary" onClick={() => onView('diff')}>查看已验证补丁</button></>}
    </p>}
    {proposal && <p className="comparison-status">待应用预览{!patchReady && ' · 已编辑，需重新生成'}</p>}
    {proposal && view === 'interactive' && <section className="repair-summary visual-repair-summary" aria-label="修复内容摘要">
      <h3>本次修复</h3><p>{problem}</p><p><b>建议：</b>{proposal.reason}</p>
      {groupSize > 1 && <p>同组 {groupSize} 处{previewData && `，预览验证 ${passedCount} 处达标`}。</p>}
      {proposal.patch.value && (new Set(proposal.patch.contrastTargets?.map(target=>target.value)).size <= 1) && (!contrastReview ? <p><b>修复内容：</b>{proposal.patch.value}</p>
        : /^#[0-9a-f]{6}$/i.test(proposal.patch.value) && <p className="repair-color-sample"><span aria-hidden="true" style={{backgroundColor:proposal.patch.value}} />建议的文字颜色</p>)}
      {proposal.imagePurpose === 'decorative' && <p>图片将标记为装饰图片，屏幕阅读器会忽略它。</p>}
      {proposal.sourceReview && <p>修复涉及 {proposal.sourceReview.changes.length} 个文件，已在隔离副本完成预检。</p>}
      {previewData?.before.contrast && candidateContrast && !candidateContrast.uncertain && <p>
        {groupSize > 1 ? '所选位置' : ''}对比度 {previewData.before.contrast.uncertain ? '原值未知' : previewData.before.contrast.ratio.toFixed(2) + ':1'} → {candidateContrast.ratio.toFixed(2)}:1，要求 {candidateContrast.required}:1。
      </p>}
      <p>请结合页面效果和实际用途核对，确认后系统会再次检测。</p>
    </section>}
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
        : displaySemantics ? <><SemanticTable result={displaySemantics} repaired={Boolean(verification || proposal)} afterLabel={proposal ? '隔离候选' : afterLabel} /><p className="muted">{proposal ? '这是隔离候选的实际浏览器语义，尚未应用。' : verification ? '复测结论见右侧 AI 修复助手。' : displaySemantics.after ? '此处对照原始版本与当前版本的浏览器语义。' : '应用并验证补丁后，可查看修复前后的语义变化。'}</p></>
        : !proposal && <p role="status" className="semantic-message">正在还原版本并计算语义…</p>}
    </div>}
  </>;
}
