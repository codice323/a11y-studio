import { JobRecoveryError, startJob, waitJob, type JobType } from './jobs';
import type { ImageAltAnalysis, ImagePurpose, RepairAnalysis } from '../../../packages/shared/types';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronRight, Code2, Download,
  FileArchive, FileCode2, FileUp, History, Info, Layers, Link2, LoaderCircle, LockKeyhole,
  RefreshCw, RotateCcw, ScanSearch, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import { reviewRepairIssue, sourceRepairKinds } from '../../../packages/shared/source-repair';
import { DetectionReview } from './DetectionReview';
import type { AiAuditFinding } from '../../../packages/shared/types';
import { Evidence, type EvidenceView } from './Evidence';
import { versionName, type HistoryItem, type Issue, type Proposal, type State, type Verification } from './types';
import './style.css';

const issueNames: Record<string, [string, string]> = {
  'image-alt': ['图片缺少替代文本', '屏幕阅读器用户无法了解这张图片的内容。'],
  label: ['表单控件缺少标签', '用户可能无法判断输入框的用途。'],
  'select-name': ['下拉框缺少名称', '用户可能无法判断下拉框的用途。'],
  'button-name': ['按钮缺少名称', '屏幕阅读器无法读出按钮的用途。'],
  'link-name': ['链接缺少名称', '用户无法了解链接的目标。'],
  'focus-style-unchanged': ['焦点样式待复核', '键盘焦点可能缺少清晰的视觉提示。'],
  'aria-broken-idref': ['ARIA 引用待复核', '名称或说明引用指向不存在的元素。'],
  'aria-valid-attr-value': ['ARIA 属性值无效', '辅助技术可能无法找到关联的名称或说明。'],
  'color-contrast': ['文字对比度不足', '低视力用户可能难以看清文字。'],
};
const impactName: Record<string, string> = {
  critical: '严重', serious: '较严重', moderate: '中等', minor: '轻微', unknown: '待复核',
};
const severityOrder = new Map(Object.keys(impactName).map((impact, index) => [impact, index]));
const severityRank = (impact: string) => severityOrder.get(impact) ?? 4;
const issueTitle = (issue: Issue) => issueNames[issue.ruleId]?.[0] ?? issue.help;
const dateText = (date: string) => new Date(date).toLocaleString('zh-CN');
type Fixture = { id: string; name: string; description: string };
type Project = { id: string; name: string; assets?: { stylesheets: number; images: number; skipped: number }; rendering?: { mode: string; requests: number; blocked: number; empty: boolean } };
type UrlImport = { url: string; mode: 'static' | 'rendered' };
type Knowledge = { title: string; url: string; guidance: string; refs: string[] };
type Source = 'html' | 'zip' | 'url' | 'source';
type Selection = { issueId: string } | { history: HistoryItem; archived: boolean } | null;
const controlTabs = [
  { id: 'issues', label: '问题与历史' },
  { id: 'assistant', label: 'AI 修复助手' },
] as const;
type ControlTab = typeof controlTabs[number]['id'];
type RepairDraft = { value: string; edited?: boolean; proposal: Proposal | null; analysis?: ImageAltAnalysis | RepairAnalysis; purpose?: ImagePurpose };
const applyingLabel = '正在应用补丁并重新验证…';
const imagePurposeLabel = { informative:'内容性图片', decorative:'装饰性图片', uncertain:'用途待确认' };

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || (data === null && response.headers.get('content-type')?.includes('text/html'))) {
    throw new Error(data?.error ?? `服务请求失败（HTTP ${response.status}）。`);
  }
  return data as T;
}

function post<T>(url: string, data: unknown = {}) {
  return request<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

function App() {
  const [state, setState] = useState<State | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [drafts, setDrafts] = useState<Record<string, RepairDraft>>({});
  const [busy, setBusy] = useState('');
  const [jobId, setJobId] = useState('');
  const [cancelRequested, setCancelRequested] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<{ label: string; run: () => void }>();
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState<EvidenceView>('visual');
  const [list, setList] = useState<'open' | 'history'>('open');
  const [controlTab, setControlTab] = useState<ControlTab>('issues');
  const [page, setPage] = useState<'workspace' | 'report'>('workspace');
  const [ai, setAi] = useState({ configured: false, visionConfigured: false });
  const [versionNameDraft, setVersionNameDraft] = useState<string | null>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const versionNameInput = useRef<HTMLInputElement>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [knowledge, setKnowledge] = useState<Knowledge | null>(null);
  const running = useRef(false);
  const activePoll = useRef<AbortController>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const evidenceFocus = useRef<HTMLDivElement>(null);
  const assistantPanel = useRef<HTMLDivElement>(null);
  const tabButtons = useRef<Partial<Record<ControlTab, HTMLButtonElement | null>>>({});
  const selectedId = selection && 'issueId' in selection ? selection.issueId : undefined;
  const reviewIssue = selectedId && state?.current?.detection?.behavior.findings
    .map(reviewRepairIssue).find(item => item?.id === selectedId);
  const issue = reviewIssue ? { ...reviewIssue, source: state?.current?.sourceLocations?.[reviewIssue.selector] }
    : state?.current?.issues.find(item => item.id === selectedId);
  const history = selection && 'history' in selection ? selection.history : undefined;
  const draftKey = issue && state ? `${state.project.currentSnapshot}:${issue.id}` : '';
  const draft = drafts[draftKey];
  const proposal = draft?.proposal ?? null;
  const input = draft?.purpose === 'decorative' ? '' : draft?.value ?? (issue?.ruleId === 'color-contrast' ? '#1c2731' : '');
  const patchReady = Boolean(proposal && input === proposal.patch.value && draft?.purpose === proposal.imagePurpose);
  const selectedRule = (history?.issue ?? issue)?.ruleId;
  const route = state ? '/api/projects/' + state.project.id : '';
  const working = Boolean(busy);

  async function loadHome() {
    try {
      const [examples, recent, status] = await Promise.all([
        request<Fixture[]>('/api/fixtures'), request<Project[]>('/api/projects'),
        request<typeof ai>('/api/status'),
      ]);
      setFixtures(examples);
      setProjects(recent);
      setAi(status);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '无法加载工作区。');
    }
  }

  useEffect(() => { void loadHome(); }, []);
  useEffect(() => {
    const stopPolling = () => activePoll.current?.abort();
    window.addEventListener('pagehide', stopPolling);
    return () => { window.removeEventListener('pagehide', stopPolling); stopPolling(); };
  }, []);
  useEffect(() => {
    setKnowledge(null);
    if (!selectedRule) return;
    const controller = new AbortController();
    void request<Knowledge | null>('/api/knowledge/' + encodeURIComponent(selectedRule), { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setKnowledge(value); })
      .catch(() => {});
    return () => controller.abort();
  }, [selectedRule]);

  function run(label: string, action: () => Promise<void>, retry?: { label: string; run: () => void }) {
    if (running.current) return;
    running.current = true;
    setBusy(label);
    setError('');
    setRecovery(undefined);
    setNotice('');
    void action().catch(problem => {
      if (problem instanceof DOMException && problem.name === 'AbortError') return;
      if (problem instanceof JobRecoveryError) {
        const pid = state?.project.id;
        setRecovery(retry ?? { label: '重新同步项目', run: () => pid ? openProject(pid) : void loadHome() });
      }
      setError(problem instanceof Error ? problem.message : '操作失败，请重试。');
      requestAnimationFrame(() => feedback.current?.focus());
    }).finally(() => {
      running.current = false;
      setBusy('');
      setJobId('');
      setCancelRequested(false);
    });
  }

  async function runJob<T>(type: JobType, url: string, data: unknown = {}) {
    const controller = new AbortController();
    activePoll.current = controller;
    try {
      const id = await startJob(url, type, data, controller.signal);
      setJobId(id);
      return await waitJob<T>(id, type, controller.signal);
    } finally {
      activePoll.current = null;
      setJobId('');
      setCancelRequested(false);
    }
  }

  async function cancelJob() {
    const poll = activePoll.current;
    setCancelRequested(true);
    try { await post('/api/jobs/' + encodeURIComponent(jobId) + '/cancel'); }
    catch (problem) {
      if (activePoll.current !== poll) return;
      setCancelRequested(false);
      setError(problem instanceof Error ? problem.message : '取消请求失败。');
    }
  }

  async function refresh(pid: string) {
    const next = await request<State>('/api/projects/' + pid);
    setState(next);
    return next;
  }

  function openPage(next: 'workspace' | 'report') {
    setPage(next);
    requestAnimationFrame(() => heading.current?.focus());
  }

  function resetSelection() {
    setRecovery(undefined);
    setSelection(null);
    setControlTab('issues');
    setDrafts({});
    setVersionNameDraft(null);
    setConfirmApply(false);
    setFilter('all');
    setView('visual');
    setList('open');
  }

  function openProject(pid: string) {
    run('正在加载项目…', async () => {
      resetSelection();
      openPage('workspace');
      const next = await refresh(pid);
      if (!next.current) {
        setBusy('正在扫描项目快照…');
        await runJob('audit', '/api/projects/' + pid + '/audits');
        await refresh(pid);
      }
    });
  }

  function createProject(data: FormData | UrlImport) {
    run(!(data instanceof FormData) ? '正在采集公开网页，请稍候…' : '正在导入项目…', async () => {
      const project = !(data instanceof FormData)
        ? await post<Project>('/api/projects/import-url', data)
        : await request<Project>('/api/projects', { method: 'POST', body: data });
      setProjects(previous => [project, ...previous.filter(item => item.id !== project.id)]);
      resetSelection();
      await refresh(project.id);
      openPage('workspace');
      setBusy('正在运行真实无障碍检测…');
      await runJob('audit', '/api/projects/' + project.id + '/audits');
      await refresh(project.id);
      const assets = project.assets;
      setNotice(assets
        ? project.rendering?.empty
          ? '网页已采集，但渲染后的主体仍为空。网站可能需要登录、验证或受限制的请求；本次结果不能代表完整网页。'
          : `URL 快照已导入并完成检测${project.rendering ? '（已运行页面脚本）' : ''}。保存 ${assets.stylesheets} 个样式表、${assets.images} 张图片，跳过或未能获取 ${assets.skipped} 处资源引用${project.rendering?.blocked ? `，拦截 ${project.rendering.blocked} 个请求` : ''}。`
        : '项目已导入并完成真实检测。');
    });
  }

  function scanAgain() {
    if (!state) return;
    run('正在运行无障碍检测…', async () => {
      await runJob('audit', route + '/audits');
      await refresh(state.project.id);
      if (!history) resetSelection();
      setNotice('检测完成。');
    });
  }

  function reviewWithAi() {
    if (!state?.current) return;
    const auditId = state.current.id;
    run('正在进行 AI 语义复核…', async () => {
      await post(`${route}/audits/${auditId}/ai-review`, { consent: true });
      await refresh(state.project.id);
      setNotice('AI 语义复核已完成，请逐项人工确认。');
    });
  }

  function decideAiFinding(id: string, decision: AiAuditFinding['decision']) {
    if (!state?.current) return;
    const auditId = state.current.id;
    run('正在保存人工复核结果…', async () => {
      await request(`${route}/audits/${auditId}/ai-review/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
      });
      await refresh(state.project.id);
      setNotice('人工复核结果已保存。');
    });
  }

  function chooseIssue(item: Issue) {
    setRecovery(undefined);
    setSelection({ issueId: item.id });
    if (selectedId !== item.id) setView('visual');
    openAssistant();
  }

  function openAssistant(moveFocus = true) {
    setControlTab('assistant');
    requestAnimationFrame(() => {
      if (!assistantPanel.current) return;
      assistantPanel.current.scrollTop = 0;
      if (moveFocus) assistantPanel.current.focus({ preventScroll: true });
    });
  }

  function handleControlTabKey(event: KeyboardEvent<HTMLButtonElement>, tab: ControlTab) {
    let next: ControlTab;
    switch (event.key) {
      case 'Home': next = 'issues'; break;
      case 'End': next = 'assistant'; break;
      case 'ArrowLeft':
      case 'ArrowRight': next = tab === 'issues' ? 'assistant' : 'issues'; break;
      default: return;
    }
    event.preventDefault();
    setControlTab(next);
    tabButtons.current[next]?.focus();
  }

  function selectList(next: 'open' | 'history') {
    if (next === list) return;
    setList(next);
    setSelection(null);
  }

  function updateDraft(changes: Partial<RepairDraft>) {
    setDrafts(previous => ({ ...previous, [draftKey]: { ...(previous[draftKey] ?? { value: '', proposal: null }), ...changes } }));
  }

  function chooseImagePurpose(purpose: ImagePurpose) {
    updateDraft({ purpose });
  }

  function showPatch() {
    setView('diff');
    requestAnimationFrame(() => {
      const evidence = evidenceFocus.current;
      evidence?.focus();
      if (window.matchMedia('(min-width: 901px)').matches) {
        evidence?.querySelector('.patch-review')?.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function chooseHistory(item: HistoryItem, nextView: EvidenceView = view, moveFocus = false, archived = false) {
    setList('history');
    setSelection({ history: item, archived });
    setView(nextView);
    setPage('workspace');
    openAssistant(!moveFocus);
    if (moveFocus) requestAnimationFrame(() => evidenceFocus.current?.focus());
  }

  function propose(source: 'agent' | 'manual') {
    if (!issue) return;
    if (source === 'manual' && proposal?.sourceReview && patchReady) { showPatch(); return; }
    const mode = state?.project.mode;
    const manualRules = ['label','select-name','link-name'];
    if (mode === 'react-source' || mode === 'static-source') manualRules.push('button-name','color-contrast');
    if (mode === 'react-source') manualRules.push('image-alt');
    const sourceRepair = source === 'manual' ? manualRules.includes(issue.ruleId) :
      Object.hasOwn(sourceRepairKinds, issue.ruleId);
    run(sourceRepair ? `Agent 正在分析「${issueTitle(issue)}」并验证隔离副本…` :
      source === 'agent' ? 'AI 正在分析问题…' : '正在生成补丁预览…', async () => {
      const endpoint = route + '/issues/' + encodeURIComponent(issue.id) + '/proposals';
      const data = { source, value: input, imagePurpose: draft?.purpose };
      const next = sourceRepair
        ? await runJob<Proposal | RepairAnalysis>('source-repair', endpoint, { ...data, sourceRepair: true, snapshotId: state?.project.currentSnapshot, intent: source === 'manual' || draft?.edited ? input : undefined })
        : await post<Proposal | ImageAltAnalysis | RepairAnalysis>(endpoint, data);
      if (!('patch' in next)) {
        const suggested = 'contentAlt' in next ? next.contentAlt : next.suggestedValue;
        updateDraft({ analysis: next, ...(sourceRepair ? { proposal: null } : {}), ...(!draft?.edited && !proposal && suggested != null ? { value: suggested } : {}) });
        return;
      }
      updateDraft({
        proposal: next,
        ...(next.imagePurpose !== 'decorative' ? { value: next.patch.value } : {}),
        ...(source === 'agent' || sourceRepair ? { analysis: next.analysis, edited: false } : {}),
      });
      showPatch();
      setNotice(next.sourceReview ? 'Agent 已在隔离副本完成复测，请审核实际源码差异。' : '补丁预览已生成，请在右侧审核源码差异并确认应用。');
    }, sourceRepair ? { label: source === 'agent' ? '重试 AI 分析' : '重试生成预览', run: () => propose(source) } : undefined);
  }

  function apply(semanticReviewed: boolean) {
    if (!proposal || !state || !patchReady || working) return;
    setConfirmApply(false);
    run(applyingLabel, async () => {
      const result = await runJob<Verification>('verification', '/api/proposals/' + proposal.id + '/apply', {semanticReviewed, ...(proposal.sourceReview ? {sourceReviewed: semanticReviewed} : {})});
      await refresh(state.project.id);
      updateDraft({proposal: null});
      const target = result.resolved.find(item => item.id === result.patch?.issueId) ?? result.reviewedTarget ?? result.resolved[0];
      if (result.status === 'passed' && target) {
        chooseHistory({ verification: result, issue: target }, 'semantics', true);
        setNotice(result.reason);
      } else {
        setView('visual');
        setError(result.reason);
        setRecovery({label:'返回修复操作',run:() => {
          setError(''); setRecovery(undefined); openAssistant(false);
          requestAnimationFrame(() => (document.getElementById('repair-value') ?? assistantPanel.current)?.focus());
        }});
        requestAnimationFrame(() => feedback.current?.focus());
      }
    });
  }

  function reject() {
    if (!proposal) return;
    run('正在关闭补丁建议…', async () => {
      await post('/api/proposals/' + proposal.id + '/reject');
      updateDraft({proposal: null});
      setView('visual');
      setNotice('已取消补丁预览，保留编辑内容。当前版本未更改。');
      requestAnimationFrame(() => document.getElementById('repair-value')?.focus());
    });
  }

  function rollback(id: string) {
    if (!state) return;
    run('正在恢复版本…', async () => {
      await post(route + '/rollback', { snapshotId: id });
      await refresh(state.project.id);
      resetSelection();
      setList('open');
      setView('visual');
      setNotice('已恢复到所选有效版本。历史证据仍可查看。');
    });
  }

  function renameCurrentVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || versionNameDraft === null) return;
    run('正在保存版本名称…', async () => {
      await request(route + '/snapshots/' + state.project.currentSnapshot, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: versionNameDraft }),
      });
      await refresh(state.project.id);
      closeRename();
      setNotice('版本名称已保存。');
    });
  }

  function closeRename() {
    setVersionNameDraft(null);
    requestAnimationFrame(() => renameButton.current?.focus());
  }

  const verificationById = new Map(state?.verifications.map(item => [item.id, item]));
  const records = (state?.resolved ?? []).flatMap(({ issue, verificationId }) => {
    const verification = verificationById.get(verificationId);
    return verification ? [{ issue, verification }] : [];
  });
  const archivedEvidence = Boolean(selection && 'history' in selection && selection.archived);
  const unresolved = state?.current?.issues ?? [];
  const filtered = unresolved
    .filter(item => filter === 'all' || (filter === 'unknown' ? severityRank(item.impact) === 4 : item.impact === filter))
    .sort((a, b) => severityRank(a.impact) - severityRank(b.impact) || a.id.localeCompare(b.id));

  return <div className="app">
    <a className="skip-link" href="#page-title">跳到主要内容</a>
    <aside className="sidebar">
      <a className="logo" href="/" aria-label="A11y Studio 首页">
        <span className="logomark"><span /><span /><span /><span /></span>
        <span><strong>A11y Studio</strong><small>ACCESSIBILITY WORKSPACE</small></span>
      </a>
      <nav aria-label="工作空间导航">
        <div className="navlabel">工作空间</div>
        <button className={'nav ' + (page === 'workspace' ? 'active' : '')} aria-current={page === 'workspace' ? 'page' : undefined} onClick={() => openPage('workspace')}><ScanSearch size={17} />诊断工作台</button>
        <button className={'nav ' + (page === 'report' ? 'active' : '')} aria-current={page === 'report' ? 'page' : undefined} disabled={!state} onClick={() => openPage('report')}><Activity size={17} />结果报告</button>
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebox"><ShieldCheck size={19} /><strong>受控修复</strong><p>审核补丁、复测副本、保留版本。</p></div>
        <div className="local-status"><i />本地工作区</div>
      </div>
    </aside>
    <main className={state ? undefined : 'home-page'}>
      <header className="topbar"><div>工作空间 <span>/</span> <b>{state ? page === 'report' ? '结果报告' : '诊断工作台' : '导入项目'}</b></div><div className="topright"><span className="pill"><i />本地模式</span></div></header>
      <div className={state ? 'content' : 'content home-content'}>
        <div className={'page-intro' + (state ? '' : ' hero')}>
          <div><div className="eyebrow"><span />ACCESSIBILITY WORKSPACE</div>
            <h1 id="page-title" tabIndex={-1} ref={heading}>{state ? page === 'report' ? '结果报告' : '网页无障碍工作台' : '让每个人，都能更好地使用网页'}</h1>
            <p>{state ? page === 'report' ? '回顾实际问题变化、验证证据和人工复核项。' : '定位问题、审核补丁，并对比修复前后的证据。' : '面向网页开发者、设计师和小型团队的 AI 无障碍检测与智能修复平台。用户上传自己的网页后，系统自动检测问题、可视化定位、解释影响、提供 AI 修复方案，并在用户确认后修改代码，重新验证修复效果，最终导出网页和检测报告。'}</p>
          </div>
          {state && <div className="intro-actions">
            <button className="secondary" disabled={working} onClick={() => { setState(null); resetSelection(); openPage('workspace'); setError(''); setNotice(''); }}><Layers size={15} />切换项目</button>
            <ExportButton route={route} disabled={working} />
          </div>}
        </div>
        {error && <div className="alert error" role="alert" tabIndex={-1} ref={feedback}><Info size={17} /><span>{error}</span>{recovery && <button className="secondary" onClick={recovery.run} disabled={working}>{recovery.label}</button>}
          <button onClick={() => { setError(''); setRecovery(undefined); }} aria-label="关闭错误提示"><X size={16} /></button></div>}
        {notice && <div className="alert success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="关闭操作提示"><X size={16} /></button></div>}
        {busy && <div className="busy"><span role="status"><LoaderCircle className="spin" size={16} />{busy}</span>{jobId && <button className="cancel-job" disabled={cancelRequested} onClick={() => void cancelJob()}>{cancelRequested ? '正在取消…' : '取消任务'}</button>}</div>}

        {!state ? <Home fixtures={fixtures} projects={projects} busy={working} onCreate={createProject} onOpen={openProject} onError={setError} /> :
          page === 'report' ? <Report state={state} busy={working} onRollback={rollback} onOpen={(item) => chooseHistory(item, 'visual', true, true)} onWorkspace={() => openPage('workspace')} /> :
          <>
            <div className="project-strip">
              <div className="project-symbol"><FileCode2 size={19} /></div>
              <div className="project-title"><b>{state.project.name}</b><span>{state.project.mode==='react-source'?'React 原始组件工程':state.project.mode==='static-source'?'静态源码工程':'网页快照'}：{state.project.entry} · 当前版本 {versionName(state, state.project.currentSnapshot)}</span></div>
              <div className="version-controls">
                <div className="project-actions">
                  <button className="secondary" onClick={scanAgain} disabled={working}><RefreshCw size={14} />重新检测</button>
                  <select aria-label="切换项目版本" value={state.project.currentSnapshot} onChange={event => rollback(event.target.value)} disabled={working}>
                    {state.snapshots.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{versionName(state, snapshot.id)}</option>)}
                  </select>
                  <button className="secondary" ref={renameButton} disabled={working || versionNameDraft !== null}
                    onClick={() => {
                      setVersionNameDraft(state.snapshots.find(item => item.id === state.project.currentSnapshot)?.name ?? '');
                      requestAnimationFrame(() => {
                        versionNameInput.current?.focus();
                        versionNameInput.current?.select();
                      });
                    }}>重命名</button>
                </div>
                {versionNameDraft !== null && <form className="version-rename" onSubmit={renameCurrentVersion}
                  onKeyDown={event => { if (event.key === 'Escape' && !working) { event.preventDefault(); closeRename(); } }}>
                  <input id="version-name" aria-label="版本名称" value={versionNameDraft} onChange={event => setVersionNameDraft(event.target.value)}
                    ref={versionNameInput}
                    required disabled={working} />
                  <div className="version-rename-actions">
                    <button className="secondary" type="button" disabled={working} onClick={closeRename}>取消</button>
                    <button className="button dark" disabled={working || !versionNameDraft.trim()}>保存</button>
                  </div>
                </form>}
              </div>
            </div>
            <div className="workbench">
              <div className="workbench-controls panel">
                <div className="evidence-tabs control-tabs" role="tablist" aria-label="诊断工作台操作">
                  {controlTabs.map(({ id, label }) => (
                    <button key={id} type="button" role="tab" id={`control-tab-${id}`}
                      ref={button => { tabButtons.current[id] = button; }}
                      aria-controls={`control-panel-${id}`} aria-selected={controlTab === id}
                      tabIndex={controlTab === id ? 0 : -1} onClick={() => setControlTab(id)}
                      onKeyDown={event => handleControlTabKey(event, id)}>{label}</button>
                  ))}
                </div>
                <div className="control-panel issues-control-panel" role="tabpanel" id="control-panel-issues"
                  aria-labelledby="control-tab-issues" tabIndex={0} hidden={controlTab !== 'issues'}>
                  <div className="evidence-tabs list-tabs" role="group" aria-label="问题列表范围">
                    <button aria-pressed={list === 'open'} disabled={working} onClick={() => selectList('open')}>待处理 <span>{unresolved.length}</span></button>
                    <button aria-pressed={list === 'history'} disabled={working} onClick={() => selectList('history')}>已解决 <span>{records.length}</span></button>
                  </div>
                  {list === 'open' && unresolved.length > 0 && <div className="filter-row"><label htmlFor="severity-filter">严重程度</label>
                    <select id="severity-filter" value={filter} onChange={event => setFilter(event.target.value)}>
                      <option value="all">全部</option>
                      {Object.entries(impactName).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                    </select>
                  </div>}
                  <div className="issue-list" role="region" aria-label={list === 'open' ? '待处理问题' : '已解决问题'}>
                    {list === 'open' ? filtered.length ? filtered.map(item =>
                      <IssueButton key={item.id} issue={item} active={issue?.id === item.id} disabled={working} onClick={() => chooseIssue(item)} />,
                    ) : <Blank icon={<CheckCircle2 />} title={!state.current ? '等待首次检测' : unresolved.length ? '没有匹配的问题' : '当前无待处理问题'}>
                      {!state.current ? '扫描完成后会显示检测结果。' : unresolved.length ? '请选择其他严重程度。' : records.length ? '可在「已解决」中查看历史证据。' : '仍可在报告中查看人工复核清单。'}
                    </Blank> : records.length ? records.map(item =>
                      <IssueButton key={item.verification.id + item.issue.id} issue={item.issue}
                        active={history?.verification.id === item.verification.id && history.issue.id === item.issue.id}
                        disabled={working} history={`${versionName(state, item.verification.fromSnapshot)} → ${versionName(state, item.verification.toSnapshot)}`}
                        onClick={() => chooseHistory(item)} />,
                    ) : <Blank icon={<History />} title="当前版本暂无已解决问题">此处显示当前版本包含且通过复测的修复。</Blank>}
                  </div>
                  <DetectionReview key={state.current?.id} detection={state.current?.detection} aiConfigured={ai.configured} busy={working} onReview={reviewWithAi} onDecision={decideAiFinding} onRepair={chooseIssue} />
                  <div className="issue-foot"><Info size={15} /><span>问题状态仅对应当前版本。<button className="record-link" onClick={() => openPage('report')}>查看跨版本历史</button></span></div>
                </div>
                <div className="control-panel" role="tabpanel" id="control-panel-assistant"
                  aria-labelledby="control-tab-assistant" tabIndex={0} ref={assistantPanel} hidden={controlTab !== 'assistant'}>
                  <Assistant issue={issue} history={history} knowledge={knowledge} ai={ai.configured} engineering={state.project.mode === 'react-source' || state.project.mode === 'static-source'} visionReady={ai.visionConfigured} busy={working} proposal={proposal} analysis={draft?.analysis} purpose={draft?.purpose} onPurpose={chooseImagePurpose}
                    previewUrl={issue?.ruleId === 'image-alt' ? route + '/issues/' + encodeURIComponent(issue.id) +
                      '/image-preview?snapshot=' + encodeURIComponent(state.project.currentSnapshot) : undefined}
                    input={input} onInput={value => updateDraft({ value, edited: true })} onPropose={propose} onShowPatch={showPatch} />
                </div>
              </div>
              <div className="evidence-column" role="group" tabIndex={-1} ref={evidenceFocus} aria-label="修复效果对比">
                <Evidence state={state} issue={issue} history={history} proposal={proposal} view={view} onView={setView} problem={(history?.issue ?? issue) ? issueTitle((history?.issue ?? issue)!) : '当前问题'}
                  impact={issueNames[(history?.issue ?? issue)?.ruleId ?? '']?.[1] ?? (history?.issue ?? issue)?.description ?? '需核对目标元素。'}
                  busy={working} applying={busy === applyingLabel} archivedEvidence={archivedEvidence}
                  patchReady={patchReady} onConfirm={() => setConfirmApply(true)} onReject={reject} />
              </div>
            </div>
            <div className="bottom-note"><ShieldCheck size={16} /><span>修复应用于本地副本。自动复测结果和人工检查项见报告。</span><button onClick={() => openPage('report')}>查看完整报告 <ArrowRight size={14} /></button></div>
          </>}
        <footer><span>A11y Studio · 网页无障碍工作区</span><span>基于 Chromium 和 axe-core</span></footer>
      </div>
    </main>
    {confirmApply && proposal && patchReady && <ConfirmDialog imagePurpose={proposal?.imagePurpose} sourceReview={Boolean(proposal.sourceReview)} onClose={() => setConfirmApply(false)} onConfirm={apply} />}
  </div>;
}

function Blank({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="blank">{icon}<b>{title}</b><p>{children}</p></div>;
}

function Home({ fixtures, projects, busy, onCreate, onOpen, onError }: {
  fixtures: Fixture[]; projects: Project[]; busy: boolean;
  onCreate: (data: FormData | UrlImport) => void; onOpen: (id: string) => void; onError: (error: string) => void;
}) {
  const [source, setSource] = useState<Source>('html');
  const [url, setUrl] = useState('');
  const [urlMode, setUrlMode] = useState<'static' | 'rendered'>('rendered');
  const fileInput = useRef<HTMLInputElement>(null);
  function chooseFile(file: File) {
    if (busy) return;
    if (source==='source'&&!/\.zip$/i.test(file.name)) return onError('请选择源码工程 ZIP。');
    if (!/\.(?:html?|zip)$/i.test(file.name)) return onError('请选择 HTML 或 ZIP 文件。');
    if (file.size > 8 * 1024 * 1024) return onError('文件不能超过 8 MB。');
    const data = new FormData();
    data.set('file', file);
    if (source === 'source') data.set('mode','source');
    onCreate(data);
  }

  function submitUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy) onCreate({ url: url.trim(), mode: urlMode });
  }

  return <div className="onboarding">
    <section className="import-card" aria-labelledby="import-title">
      <div className="card-heading"><div><span className="section-tag">NEW PROJECT</span><h2 id="import-title">导入网页项目</h2><p>选择你拥有或获准检测的网页。</p></div><span className="section-icon"><FileUp size={20} /></span></div>
      <div className="evidence-tabs import-tabs" role="group" aria-label="网页导入方式">
        <button aria-pressed={source === 'html'} disabled={busy} onClick={() => setSource('html')}><FileCode2 size={16} />HTML</button>
        <button aria-pressed={source === 'zip'} disabled={busy} onClick={() => setSource('zip')}><FileArchive size={16} />ZIP</button>
        <button aria-pressed={source === 'source'} disabled={busy} onClick={() => setSource('source')}><FileCode2 size={16} />源码工程</button>
        <button aria-pressed={source === 'url'} disabled={busy} onClick={() => setSource('url')}><Link2 size={16} />URL</button>
      </div>
      {source === 'url' ? <form className="url-form" onSubmit={submitUrl}>
        <label htmlFor="page-url">公开网页地址</label>
        <input id="page-url" type="url" inputMode="url" placeholder="https://example.com/page" value={url} maxLength={2048} required disabled={busy} onChange={event => setUrl(event.target.value)} aria-describedby="url-scope" />
        <fieldset className="url-mode"><legend>网页采集方式</legend>
          <label><input type="radio" name="url-mode" value="rendered" checked={urlMode === 'rendered'} disabled={busy} onChange={() => setUrlMode('rendered')} />执行 JavaScript 后采集（推荐）</label>
          <label><input type="radio" name="url-mode" value="static" checked={urlMode === 'static'} disabled={busy} onChange={() => setUrlMode('static')} />仅采集静态 HTML</label>
        </fieldset>
        <p id="url-scope">动态采集会在独立浏览器中运行网页脚本，限制网络请求。登录、验证、交互及部分资源可能无法还原；修复只保存到本地快照。</p>
        <button className="button dark" disabled={busy}>导入 URL 并检测 <ArrowRight size={15} /></button>
      </form> : <div className="dropzone" onDragOver={event => event.preventDefault()} onDrop={event => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) chooseFile(file);
      }}>
        <div className="upload-icon"><FileUp size={24} /></div>
        <b>{source === 'html' ? '上传单个 HTML 文件' : source === 'source' ? '上传静态或 React 源码工程 ZIP' : '上传静态网页 ZIP'}</b>
        <span>{source === 'html' ? '支持 .html / .htm' : source === 'source' ? '支持静态工程或基础 React + Vite，根目录保留入口与源码' : '可包含 HTML、CSS 与本地图片'} · 可拖放 · 最大 8 MB</span>
        <input ref={fileInput} type="file" accept={source === 'html' ? '.html,.htm' : '.zip'} hidden onChange={event => {
          const file = event.target.files?.[0];
          if (file) chooseFile(file);
          event.target.value = '';
        }} />
        <button className="button dark" disabled={busy} onClick={() => fileInput.current?.click()}>选择文件 <ArrowRight size={15} /></button>
      </div>}
      <div className="import-note"><LockKeyhole size={15} />{source === 'url' && urlMode === 'rendered' ? '采集时运行脚本，检测和修复使用不执行脚本的本地快照。' : source === 'source' ? 'React 使用应用固定的构建工具和隔离浏览器，不运行项目安装脚本或构建配置。' : '网页自带脚本不会在检测环境中执行。'}</div>
    </section>
    <section className="examples">
      <div className="section-title"><div><span className="section-tag">DEMO PROJECTS</span><h2>从示例开始</h2></div></div>
      <div className="example-list">{fixtures.map((fixture, index) => <button key={fixture.id} className="example-card" disabled={busy} onClick={() => {
        const form = new FormData();
        form.set('fixture', fixture.id);
        onCreate(form);
      }}><span className="example-number">0{index + 1}</span><span><b>{fixture.name}</b><small>{fixture.description}</small></span><ArrowUpRight size={17} /></button>)}</div>
      {projects.length > 0 && <><div className="section-title recent-title"><div><span className="section-tag">RECENT PROJECTS</span><h2>最近项目</h2></div></div>
        <div className="recent-list">{projects.slice(0, 6).map(project => <button key={project.id} onClick={() => onOpen(project.id)} disabled={busy}><FileCode2 size={16} /><span>{project.name}</span><ChevronRight size={15} /></button>)}</div></>}
    </section>
    <section className="steps" aria-label="修复流程">
      <div><ScanSearch /><span>01</span><b>发现问题</b><small>运行真实扫描，定位页面元素</small></div>
      <div><Sparkles /><span>02</span><b>审核修复</b><small>查看规范、建议和实际源码差异</small></div>
      <div><ShieldCheck /><span>03</span><b>验证结果</b><small>复测、比较证据并导出报告</small></div>
    </section>
  </div>;
}

function IssueButton({ issue, active, history, disabled, onClick }: {
  issue: Issue; active: boolean; history?: string; disabled: boolean; onClick: () => void;
}) {
  return <button className={'issue ' + (active ? 'selected' : '')} aria-pressed={active} disabled={disabled} onClick={onClick}>
    <span className={'issue-dot' + (history ? ' fixed' : '')} aria-hidden="true">{history ? <Check size={16} /> : '!'}</span>
    <span className="issue-summary"><b>{issueTitle(issue)}</b>
      <em className={'severity ' + (history ? 'fixed' : issue.impact)}>{impactName[issue.impact] ?? '待复核'}</em>
      <small title={issue.selector}>{issue.selector || '页面级问题'}{history && ` · ${history}`}</small></span><ChevronRight size={15} />
  </button>;
}

function ImagePreview({ url }: { url: string }) {
  const [unavailable, setUnavailable] = useState(false);
  return <div className="detail-block image-preview">
    <h4>目标图片预览</h4>
    {unavailable ? <p>本地快照中没有可预览的目标图片。</p>
      : <img src={url} alt="待修复的目标图片" onError={() => setUnavailable(true)} />}
  </div>;
}

function Assistant({ issue, history, knowledge, ai, engineering, visionReady, busy, proposal, analysis, purpose, onPurpose, previewUrl, input, onInput, onPropose, onShowPatch }: {
  issue?: Issue; history?: HistoryItem; knowledge: Knowledge | null; ai: boolean; engineering: boolean; visionReady: boolean; busy: boolean;
  proposal: Proposal | null; analysis?: ImageAltAnalysis | RepairAnalysis; purpose?: ImagePurpose;
  onPurpose: (purpose: ImagePurpose) => void; previewUrl?: string; input: string; onInput: (value: string) => void;
  onPropose: (source: 'agent' | 'manual') => void;
  onShowPatch: () => void;
}) {
  const target = history?.issue ?? issue;
  const verification = history?.verification;
  const isImageAlt = target?.ruleId === 'image-alt';
  const previewHint = isImageAlt && (!purpose
    ? '请先选择内容性图片或装饰性图片，再生成补丁预览。'
    : purpose === 'informative' && !input.trim()
      ? '请填写非空替代文本，再生成补丁预览。'
      : '');
  const localAnalysis = engineering && ['label','select-name','link-name','focus-style-unchanged'].includes(target?.ruleId ?? '');
  const agentOnly = target?.ruleId === 'focus-style-unchanged' || target?.ruleId === 'aria-valid-attr-value' || target?.ruleId === 'aria-broken-idref';
  const trace = proposal?.agentTrace ?? (analysis && 'agentTrace' in analysis ? analysis.agentTrace : undefined);
  const refs = verification?.wcag ?? proposal?.wcag ?? knowledge?.refs ?? target?.wcag ?? [];
  const imageAnalysis = analysis && 'purpose' in analysis ? analysis : undefined;
  const sources = analysis?.sources ?? proposal?.sources;
  const labelDecision = analysis && 'labelDecision' in analysis ? analysis.labelDecision : undefined;
  const linkDecision = analysis && 'linkDecision' in analysis ? analysis.linkDecision : undefined;
  const nameDecision = labelDecision ?? linkDecision;
  const suggested = imageAnalysis?.contentAlt ?? (analysis && 'suggestedValue' in analysis ? analysis.suggestedValue : null);
  const problem = target && (issueNames[target.ruleId]?.[1] ?? target.description);
  return <>
    {!history && <div className="assistant-toolbar">
      <span className="ai-pill"><Sparkles size={13} />{isImageAlt ? (visionReady ? '视觉 AI 已配置' : '视觉 AI 未配置') : (ai ? 'AI 已配置' : 'AI 未配置')}</span>
      {issue && issueNames[issue.ruleId] && !agentOnly && !busy && <a href="#repair-value">前往修复操作</a>}
    </div>}
    {target ? <div className="assistant-body">
      <div className="issue-heading"><span className={'issue-dot' + (history ? ' fixed' : '')} aria-hidden="true">{history ? <Check size={16} /> : '!'}</span><div><h3>{issueTitle(target)}</h3><span>{target.ruleId} · {impactName[target.impact] ?? target.impact}</span></div></div>
      {target.source && <p className="muted note">组件源码 <code>{target.source.file}:{target.source.line}</code></p>}
      {!analysis && <p className="muted note">{problem}</p>}
      {analysis && <div className="proposal" role="status">
        <p><b>问题</b> · {problem}</p>
        <p><b>建议</b> · {imageAnalysis?.purpose === 'decorative'
          ? '若确认纯装饰，可用空 alt。' + (suggested ? ' 内容性候选：' + suggested : '')
          : suggested ? (linkDecision ? '链接名称：' : labelDecision ? '添加可见标签：' : isImageAlt ? '替代文本候选：' : '建议值：') + suggested : nameDecision === 'needs-input' ? (linkDecision ? '在下方填写链接实际用途，再生成补丁。' : '请填写字段用途。') : '请人工确定合适的修复值。'}</p>
        <p><b>{nameDecision === 'confirm' ? '建议人工确认' : nameDecision === 'needs-input' ? '需要补充信息' : analysis.status === 'needs-manual-review' || !suggested ? '待人工确认' : '理由'}</b> · {analysis.reason}</p>
      </div>}
      <details className="detail-block">
        <summary>查看详细依据</summary>
        {imageAnalysis && <p><b>AI 图片用途判断：</b>{imagePurposeLabel[imageAnalysis.purpose]}</p>}
        {analysis?.description && <p><b>AI 视觉观察：</b>{analysis.description}</p>}
        {analysis?.detail && <p>{analysis.detail}</p>}
        {analysis?.media && <p>视觉证据：{analysis.media.source} · {analysis.media.format} · {analysis.media.bytes} 字节</p>}
        <h4>{history ? '修复前元素' : '检测证据'}</h4><code>{target.html}</code>
        <h4>规则与 WCAG 依据</h4>
        {refs.length > 0 && <div className="rule-tags">{refs.map(ref => <span key={ref}>{ref}</span>)}</div>}
        <a href={verification?.wcagUrl || proposal?.wcagUrl || knowledge?.url || target.helpUrl} target="_blank" rel="noreferrer">{proposal?.wcagTitle || knowledge?.title || '查看规则与规范说明'} <ArrowUpRight size={12} /></a>
        {(proposal?.guidance || knowledge?.guidance) && <p>{proposal?.guidance || knowledge?.guidance}</p>}
        {sources?.length ? <div><h4>检索到的规范依据</h4><ul>{sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title} · {source.refs.join('、')}</a><p>{source.text}</p></li>)}</ul></div> : null}
        {trace && <div><h4>AI 工具调用</h4><ol>{trace.map((step, index) => <li key={index}>{step.summary} <code>{step.tool}</code></li>)}</ol></div>}
        {proposal?.risk && <p>{proposal.risk}</p>}
        {proposal && <button type="button" className="secondary" onClick={onShowPatch}>查看完整代码差异</button>}
      </details>
      {verification ? <div className="verification-card">
        <h4><CheckCircle2 size={16} />复测通过</h4>
        <p>{verification.reason}</p>
        {isImageAlt && <p><b>图片语义审核：</b>{verification.imageReview
          ? '用户已确认 · ' + imagePurposeLabel[verification.imageReview.purpose]
          : '未记录人工确认'}。自动复测只验证规则和页面结构。</p>}
        <ul>
          <li>该问题在修复后扫描中消失</li>
          {verification.structurePassed && <li>页面结构检查通过</li>}
          {verification.functionPassed && <li>静态控件与聚焦检查通过</li>}
          <li>新增自动检测问题 {verification.added.length} 项</li>
          {verification.contrastCheck?.valid && <li>对比度 {verification.contrastCheck.ratio.toFixed(2)}:1，要求 {verification.contrastCheck.required}:1</li>}
        </ul>
        {verification.sourceChecks && <ul>{verification.sourceChecks.map(check => <li key={check.name}>{check.name} · {check.detail}</li>)}</ul>}
        {verification.proposalReason && <p><b>历史修复方案</b> {verification.proposalReason}</p>}
        {verification.agentTrace && <div><h4>AI 工具调用记录</h4><ol>{verification.agentTrace.map((step, index) => <li key={index}>{step.summary} <code>{step.tool}</code></li>)}</ol></div>}
        {verification.sources && <div><h4>检索依据</h4><ul>{verification.sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title} · {source.refs.join('、')}</a></li>)}</ul></div>}
        <small>{dateText(verification.createdAt)}</small>
        {verification.diff && <button type="button" className="secondary history-patch" onClick={onShowPatch}>查看历史补丁</button>}
      </div> : issueNames[target.ruleId] ? <>
        {isImageAlt && <>
          {previewUrl && <ImagePreview key={previewUrl} url={previewUrl} />}
          <fieldset disabled={busy} className="image-purpose" aria-describedby={previewHint ? 'repair-preview-hint' : undefined}>
            <legend>请选择实际图片用途</legend>
            <label><input type="radio" name="image-purpose" checked={purpose === 'informative'}
              onChange={() => onPurpose('informative')} /> 内容性图片</label>
            <label><input type="radio" name="image-purpose" checked={purpose === 'decorative'}
              onChange={() => onPurpose('decorative')} /> 装饰性图片</label>
          </fieldset>
        </>}
        {!agentOnly && <><label className="input-label" htmlFor="repair-value">{target.ruleId === 'color-contrast' ? '修复颜色' : '建议的文本内容'}</label>
        <input id="repair-value" value={input} maxLength={['label','select-name','link-name'].includes(target.ruleId) ? 120 : 160} disabled={busy} readOnly={isImageAlt && purpose === 'decorative'} onChange={event => onInput(event.target.value)}
          placeholder={target.ruleId === 'image-alt' ? (purpose === 'decorative' ? '使用空 alt' : '填写图片在页面中传达的信息') : target.ruleId === 'color-contrast' ? '#1c2731' : '填写符合实际用途的名称'} /></>}
        <p className="muted note">{isImageAlt
          ? (ai ? 'AI 按需读取目标图片和邻近文字。确认纯装饰时可留空。' : '当前模型未配置为支持图像输入，可手动填写。')
          : target.ruleId === 'link-name' ? '例如：查看课程目录。填写链接真实用途后即可生成补丁。'
          : sourceRepairKinds[target.ruleId] === 'label' ? '可编辑标签文案，再生成原生标签补丁。'
          : (ai ? (Object.hasOwn(sourceRepairKinds, target.ruleId) ? 'Agent 会检查局部源码并验证隔离副本。若需指定文案，填写后重新分析。' : 'AI 按需使用局部代码和视觉证据。') : '可手动填写内容并生成补丁。配置模型服务后可使用 AI 建议。')}</p>
        <p id="repair-preview-hint" className="note" role="status">{previewHint || (isImageAlt && purpose === 'decorative' ? '预览将添加空 alt（alt=""），请确认该图片只用于装饰。' : null)}</p>
        <div className="repair-actions">
          <button className="button dark" disabled={busy || Boolean(previewHint) || (['label','select-name','link-name'].includes(target.ruleId) && !input.trim()) || (agentOnly && !proposal?.sourceReview)} aria-describedby={isImageAlt ? 'repair-preview-hint' : undefined} onClick={() => onPropose('manual')}><Code2 size={15} />生成补丁预览</button>
          <button className="secondary" disabled={busy || (!ai && !localAnalysis)} onClick={() => onPropose('agent')}><Sparkles size={15} />AI 分析与修复</button>
        </div>
        {proposal && <div className="proposal">
          <div className="proposal-head"><b>{proposal.source === 'manual' ? '人工修复建议' : 'AI 修复建议'}</b><span>{proposal.imagePurpose ? '待人工确认' : '待审核'}</span></div>
          <button type="button" className="secondary" onClick={onShowPatch}>前往右侧审核补丁</button>
        </div>}
      </> : <p className="manual-only">{target.ruleId === 'target-size'
        ? '当前需要人工处理。检查可点击区域是否达到 24 × 24 CSS 像素，或是否满足目标间距等例外。调整内边距或相邻控件布局后，重新扫描桌面和窄屏。'
        : '此规则需要人工处理。可查看规范和报告中的复核项。'}</p>}
    </div> : <Blank icon={<Sparkles />} title="选择一个问题">查看使用影响、修复依据和可审核的补丁。</Blank>}
  </>;
}

function Metrics({ state }: { state: State }) {
  return <div className="metrics">
    <div><span>初始问题</span><strong>{state.summary.initial ?? '—'}</strong><small>原始版本扫描</small></div>
    <div className="metric-ok"><span>已解决</span><strong>{state.current ? state.summary.resolved : '—'}</strong><small>当前版本包含的已验证修复</small></div>
    <div><span>原有问题残留</span><strong>{state.current ? state.summary.remaining : '—'}</strong><small>仍需处理</small></div>
    <div><span>新增问题</span><strong>{state.current ? state.summary.added : '—'}</strong><small>相对原始版本</small></div>
  </div>;
}

function ExportButton({ route, disabled }: { route: string; disabled: boolean }) {
  return disabled ? <button className="button dark" disabled><Download size={15} />导出项目 ZIP</button>
    : <a className="button dark" href={route + '/export'}><Download size={15} />导出项目 ZIP</a>;
}

function Report({ state, onRollback, onOpen, onWorkspace, busy }: {
  state: State; onRollback: (id: string) => void; onOpen: (item: HistoryItem) => void; onWorkspace: () => void; busy: boolean;
}) {
  return <div className="report">
    <p className="muted">当前报告 · {versionName(state, state.project.currentSnapshot)}</p>
    <Metrics state={state} />
    <div className="export-banner"><span className="section-icon"><Download size={19} /></span><div><h2>导出源码与报告</h2><p>{state.project.mode?.endsWith('-source') ? 'ZIP 包含当前版本的原始工程文件、扫描证据和验证日志。' : 'ZIP 包含当前本地快照、扫描截图、HTML / JSON 报告和验证日志。'}</p></div><ExportButton route={'/api/projects/' + state.project.id} disabled={busy} /></div>
    <div className="report-grid">
      <section className="panel report-section"><div className="panel-head"><div><span className="kicker">VALIDATION</span><h2>跨版本修复与验证记录</h2></div></div>
        {state.verifications.length ? state.verifications.map(item => <div className="log-row" key={item.id}>
          <span className={'log-icon ' + (item.status === 'passed' ? 'ok' : 'failed')} aria-hidden="true">{item.status === 'passed' ? <Check size={15} /> : <X size={15} />}</span>
          <div><b>{item.status === 'passed' ? '验证通过' : '验证失败 · 已保留原版本'} · {versionName(state, item.fromSnapshot)} → {versionName(state, item.toSnapshot)}</b>
            <p>{item.reason}</p>
            {item.imageReview && <p>图片语义审核：用户已确认 · {imagePurposeLabel[item.imageReview.purpose]}</p>}<small>{dateText(item.createdAt)} · 解决 {item.resolved.length} / 残留 {item.remaining.length} / 新增 {item.added.length}</small>
            {item.status === 'passed' && [...item.resolved, ...(item.reviewedTarget ? [item.reviewedTarget] : [])].map(resolved => <button className="record-link" key={resolved.id} disabled={busy} onClick={() => onOpen({ issue: resolved, verification: item })}>{issueTitle(resolved)} · 查看证据 <ArrowRight size={14} /></button>)}
            {item.diff && <details><summary>补丁与源码校验</summary>
              <p>{item.proposalReason}</p>
              {item.wcagUrl && <a href={item.wcagUrl} target="_blank" rel="noreferrer">{item.wcag?.join('、') || '规范依据'}</a>}
              <pre className="evidence-diff" tabIndex={0} aria-label="修复补丁">{item.diff}</pre>
              <small className="file-hashes">修改前 SHA-256 {item.beforeHash}<br />修改后 SHA-256 {item.afterHash}</small>
            </details>}
          </div>
        </div>) : <Blank icon={<ShieldCheck />} title="暂无修复记录">审核并应用补丁后，验证证据会显示在这里。</Blank>}
      </section>
      <section className="panel report-section"><div className="panel-head"><div><span className="kicker">MANUAL REVIEW</span><h2>人工复核与版本</h2></div></div>
        <div className="review-list">
          <p>自动扫描覆盖部分 WCAG 规则，请结合以下人工检查。</p>
          <ul><li>键盘能否访问所有功能，焦点顺序是否合理</li><li>屏幕阅读器读出的名称和提示是否准确</li><li>图片描述是否符合语境，装饰图片是否正确标记</li><li>放大文字和页面后，内容是否仍可使用</li></ul>
          <DetectionReview detection={state.current?.detection} report />
          {state.current?.incomplete.map(item => <div className="manual-item" key={item.ruleId}><Info size={14} />{item.help} · {item.count} 项需要进一步判断</div>)}
        </div>
        <div className="versions"><h3>版本记录</h3>{state.snapshots.map((snapshot, index) => <div key={snapshot.id}>
          <span><b>{versionName(state, snapshot.id)}</b>{snapshot.id === state.project.currentSnapshot ? ' · 当前' : ''}</span>
          {snapshot.id !== state.project.currentSnapshot && <button disabled={busy} aria-label={`恢复版本 V${index}`} onClick={() => onRollback(snapshot.id)}><RotateCcw size={13} />恢复</button>}
        </div>)}</div>
      </section>
    </div>
    <div className="report-actions"><button className="secondary" onClick={onWorkspace}>返回工作台</button></div>
  </div>;
}

function ConfirmDialog({ imagePurpose, sourceReview, onClose, onConfirm }: {
  imagePurpose?: ImagePurpose; sourceReview: boolean; onClose: () => void; onConfirm: (semanticReviewed: boolean) => void;
}) {
  const [semanticReviewed, setSemanticReviewed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialog} className="modal" aria-labelledby="confirm-title" aria-describedby="confirm-description" onCancel={event => { event.preventDefault(); onClose(); }}>
    <button className="close" aria-label="关闭" onClick={onClose}><X size={18} /></button>
    <span className="section-icon"><ShieldCheck size={20} /></span>
    <h2 id="confirm-title">确认应用修复？</h2>
    <p id="confirm-description">系统会修改当前版本的副本，并重新扫描、检查页面结构与控件聚焦。复测失败时继续使用上一个有效版本。</p>
    {(imagePurpose || sourceReview) && <p><label><input type="checkbox" checked={semanticReviewed}
      onChange={event => setSemanticReviewed(event.target.checked)} /> {sourceReview ? '我已审核源码差异并确认符合页面用途' : '我已确认图片用途和替代文本符合页面语境'}
      {imagePurpose && <>（{imagePurposeLabel[imagePurpose]}，已核对替代文本）</>}</label></p>}
    <div className="confirm-actions">
      <button ref={cancel} className="secondary" onClick={onClose}>取消</button>
      <button className="button dark" disabled={Boolean((imagePurpose || sourceReview) && !semanticReviewed)} onClick={() => onConfirm(semanticReviewed)}>确认应用并复测 <ArrowRight size={15} /></button>
    </div>
  </dialog>;
}

createRoot(document.getElementById('root')!).render(<App />);
