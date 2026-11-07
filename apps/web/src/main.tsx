import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronRight, Code2, Download,
  FileArchive, FileCode2, FileUp, History, Info, Layers, Link2, LoaderCircle, LockKeyhole,
  RefreshCw, RotateCcw, ScanSearch, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import { Evidence, type EvidenceView } from './Evidence';
import { versionLabel, type HistoryItem, type Issue, type Proposal, type State, type Verification } from './types';
import './style.css';

const issueNames: Record<string, [string, string]> = {
  'image-alt': ['图片缺少替代文本', '屏幕阅读器用户无法了解这张图片的内容。'],
  label: ['表单控件缺少标签', '用户可能无法判断输入框的用途。'],
  'button-name': ['按钮缺少名称', '屏幕阅读器无法读出按钮的用途。'],
  'link-name': ['链接缺少名称', '用户无法了解链接的目标。'],
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
type Project = { id: string; name: string; assets?: { stylesheets: number; images: number; skipped: number } };
type Knowledge = { title: string; url: string; guidance: string; refs: string[] };
type Source = 'html' | 'zip' | 'url';
type Selection = { issueId: string } | { history: HistoryItem } | null;
const controlTabs = [
  { id: 'issues', label: '问题与历史' },
  { id: 'assistant', label: 'AI 修复助手' },
] as const;
type ControlTab = typeof controlTabs[number]['id'];

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

async function waitJob<T>(id: string): Promise<T> {
  for (let i = 0; i < 120; i++) {
    const job = await request<{ status: string; result: T; error?: string }>('/api/jobs/' + id);
    if (job.status === 'completed') return job.result;
    if (job.status === 'failed') throw new Error(job.error ?? '任务失败。');
    if (job.status === 'cancelled') throw new Error('任务已取消。');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('任务仍在运行，请稍后重新打开项目查看结果。');
}

function App() {
  const [state, setState] = useState<State | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [drafts, setDrafts] = useState<Record<string, { value: string; proposal: Proposal | null }>>({});
  const [busy, setBusy] = useState('');
  const [jobId, setJobId] = useState('');
  const [cancelRequested, setCancelRequested] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState<EvidenceView>('visual');
  const [list, setList] = useState<'open' | 'history'>('open');
  const [controlTab, setControlTab] = useState<ControlTab>('issues');
  const [page, setPage] = useState<'workspace' | 'report'>('workspace');
  const [ai, setAi] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [knowledge, setKnowledge] = useState<Knowledge | null>(null);
  const running = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const evidenceFocus = useRef<HTMLDivElement>(null);
  const assistantPanel = useRef<HTMLDivElement>(null);
  const tabButtons = useRef<Partial<Record<ControlTab, HTMLButtonElement | null>>>({});
  const issue = state?.current?.issues.find(item => selection && 'issueId' in selection && item.id === selection.issueId);
  const history = selection && 'history' in selection ? selection.history : undefined;
  const draftKey = issue && state ? `${state.project.currentSnapshot}:${issue.id}` : '';
  const draft = drafts[draftKey];
  const proposal = draft?.proposal ?? null;
  const input = draft?.value ?? (issue?.ruleId === 'color-contrast' ? '#1c2731' : '');
  const selectedRule = (history?.issue ?? issue)?.ruleId;
  const route = state ? '/api/projects/' + state.project.id : '';
  const working = Boolean(busy);

  async function loadHome() {
    try {
      const [examples, recent, status] = await Promise.all([
        request<Fixture[]>('/api/fixtures'), request<Project[]>('/api/projects'),
        request<{ configured: boolean }>('/api/status'),
      ]);
      setFixtures(examples);
      setProjects(recent);
      setAi(status.configured);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '无法加载工作区。');
    }
  }

  useEffect(() => { void loadHome(); }, []);
  useEffect(() => {
    setKnowledge(null);
    if (!selectedRule) return;
    const controller = new AbortController();
    void request<Knowledge | null>('/api/knowledge/' + encodeURIComponent(selectedRule), { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setKnowledge(value); })
      .catch(() => {});
    return () => controller.abort();
  }, [selectedRule]);

  function run(label: string, action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    void action().catch(problem => {
      setError(problem instanceof Error ? problem.message : '操作失败，请重试。');
      requestAnimationFrame(() => feedback.current?.focus());
    }).finally(() => {
      running.current = false;
      setBusy('');
      setJobId('');
      setCancelRequested(false);
    });
  }

  async function runJob<T>(url: string) {
    const job = await post<{ id: string }>(url);
    setJobId(job.id);
    try { return await waitJob<T>(job.id); }
    finally { setJobId(''); setCancelRequested(false); }
  }

  async function cancelJob() {
    setCancelRequested(true);
    try { await post('/api/jobs/' + jobId + '/cancel'); }
    catch (problem) {
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
    setSelection(null);
    setControlTab('issues');
    setDrafts({});
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
        await runJob('/api/projects/' + pid + '/audits');
        await refresh(pid);
      }
    });
  }

  function createProject(data: FormData | string) {
    run(typeof data === 'string' ? '正在获取公开网页与静态资源…' : '正在导入项目…', async () => {
      const project = typeof data === 'string'
        ? await post<Project>('/api/projects/import-url', { url: data })
        : await request<Project>('/api/projects', { method: 'POST', body: data });
      setProjects(previous => [project, ...previous.filter(item => item.id !== project.id)]);
      resetSelection();
      await refresh(project.id);
      openPage('workspace');
      setBusy('正在运行真实无障碍检测…');
      await runJob('/api/projects/' + project.id + '/audits');
      await refresh(project.id);
      const assets = project.assets;
      setNotice(assets
        ? `URL 快照已导入并完成检测。保存 ${assets.stylesheets} 个样式表、${assets.images} 张图片，跳过或未能获取 ${assets.skipped} 处资源引用。`
        : '项目已导入并完成真实检测。');
    });
  }

  function scanAgain() {
    if (!state) return;
    run('正在运行无障碍检测…', async () => {
      await runJob(route + '/audits');
      await refresh(state.project.id);
      if (!history) resetSelection();
      setNotice('检测完成。');
    });
  }

  function chooseIssue(item: Issue) {
    setSelection({ issueId: item.id });
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

  function saveDraft(value: string, next: Proposal | null) {
    setDrafts(previous => ({ ...previous, [draftKey]: { value, proposal: next } }));
  }

  function chooseHistory(item: HistoryItem, nextView: EvidenceView = view, moveFocus = false) {
    setList('history');
    setSelection({ history: item });
    setView(nextView);
    setPage('workspace');
    openAssistant(!moveFocus);
    if (moveFocus) requestAnimationFrame(() => evidenceFocus.current?.focus());
  }

  function propose(source: 'ai' | 'manual') {
    if (!issue) return;
    run(source === 'ai' ? '正在生成 AI 建议…' : '正在生成补丁预览…', async () => {
      const next = await post<Proposal>(route + '/issues/' + issue.id + '/proposals', { source, value: input });
      saveDraft(next.patch.value, next);
      setView('diff');
      setNotice('建议已生成，请审核实际源码差异。');
    });
  }

  function apply() {
    if (!proposal || !state) return;
    setConfirmApply(false);
    run('正在应用补丁并重新验证…', async () => {
      const result = await runJob<Verification>('/api/proposals/' + proposal.id + '/apply');
      await refresh(state.project.id);
      saveDraft(input, null);
      const target = result.resolved.find(item => item.id === result.patch?.issueId) ?? result.resolved[0];
      if (result.status === 'passed' && target) {
        chooseHistory({ verification: result, issue: target }, 'semantics', true);
        setNotice(result.reason);
      } else {
        setView('visual');
        setError(result.reason);
        requestAnimationFrame(() => feedback.current?.focus());
      }
    });
  }

  function reject() {
    if (!proposal) return;
    run('正在关闭补丁建议…', async () => {
      await post('/api/proposals/' + proposal.id + '/reject');
      saveDraft(input, null);
      setView('visual');
      setNotice('建议已拒绝，当前版本继续使用。');
    });
  }

  function rollback(id: string) {
    if (!state) return;
    run('正在恢复版本…', async () => {
      await post(route + '/rollback', { snapshotId: id });
      await refresh(state.project.id);
      if (!history) resetSelection();
      setNotice('已恢复到所选有效版本。历史证据仍可查看。');
    });
  }

  const records = state?.verifications.flatMap(verification =>
    verification.status === 'passed' ? verification.resolved.map(item => ({ verification, issue: item })) : [],
  ) ?? [];
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
        {error && <div className="alert error" role="alert" tabIndex={-1} ref={feedback}><Info size={17} /><span>{error}</span><button onClick={() => setError('')} aria-label="关闭错误提示"><X size={16} /></button></div>}
        {notice && <div className="alert success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="关闭操作提示"><X size={16} /></button></div>}
        {busy && <div className="busy"><span role="status"><LoaderCircle className="spin" size={16} />{busy}</span>{jobId && <button className="cancel-job" disabled={cancelRequested} onClick={() => void cancelJob()}>{cancelRequested ? '正在取消…' : '取消任务'}</button>}</div>}

        {!state ? <Home fixtures={fixtures} projects={projects} busy={working} onCreate={createProject} onOpen={openProject} onError={setError} /> :
          page === 'report' ? <Report state={state} busy={working} onRollback={rollback} onOpen={(item) => chooseHistory(item, 'visual', true)} onWorkspace={() => openPage('workspace')} /> :
          <>
            <div className="project-strip">
              <div className="project-symbol"><FileCode2 size={19} /></div>
              <div className="project-title"><b>{state.project.name}</b><span>{state.project.entry} · 当前版本 {versionLabel(state, state.project.currentSnapshot)}</span></div>
              <div className="project-actions">
                <button className="secondary" onClick={scanAgain} disabled={working}><RefreshCw size={14} />重新检测</button>
                <select aria-label="切换项目版本" value={state.project.currentSnapshot} onChange={event => rollback(event.target.value)} disabled={working}>
                  {state.snapshots.map((snapshot, index) => <option key={snapshot.id} value={snapshot.id}>V{index} · {snapshot.description}</option>)}
                </select>
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
                        disabled={working} history={`${versionLabel(state, item.verification.fromSnapshot)} → ${versionLabel(state, item.verification.toSnapshot)}`}
                        onClick={() => chooseHistory(item)} />,
                    ) : <Blank icon={<History />} title="暂无已解决记录">通过自动复测的修复会显示在这里。</Blank>}
                  </div>
                  <div className="issue-foot"><Info size={15} /><span>已解决列表包含历史版本，当前问题以所选版本为准。</span></div>
                </div>
                <div className="control-panel" role="tabpanel" id="control-panel-assistant"
                  aria-labelledby="control-tab-assistant" tabIndex={0} ref={assistantPanel} hidden={controlTab !== 'assistant'}>
                  <Assistant issue={issue} history={history} knowledge={knowledge} ai={ai} busy={working} proposal={proposal}
                    input={input} onInput={value => saveDraft(value, proposal)} onPropose={propose} onConfirm={() => setConfirmApply(true)}
                    onReject={reject} onShowPatch={() => { setView('diff'); evidenceFocus.current?.focus(); }} />
                </div>
              </div>
              <div className="evidence-column" role="group" tabIndex={-1} ref={evidenceFocus} aria-label="修复效果对比">
                <Evidence state={state} issue={issue} history={history} proposal={proposal} view={view} onView={setView} />
              </div>
            </div>
            <div className="bottom-note"><ShieldCheck size={16} /><span>修复应用于本地副本。自动复测结果和人工检查项见报告。</span><button onClick={() => openPage('report')}>查看完整报告 <ArrowRight size={14} /></button></div>
          </>}
        <footer><span>A11y Studio · 网页无障碍工作区</span><span>基于 Chromium 和 axe-core</span></footer>
      </div>
    </main>
    {confirmApply && <ConfirmDialog onClose={() => setConfirmApply(false)} onConfirm={apply} />}
  </div>;
}

function Blank({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="blank">{icon}<b>{title}</b><p>{children}</p></div>;
}

function Home({ fixtures, projects, busy, onCreate, onOpen, onError }: {
  fixtures: Fixture[]; projects: Project[]; busy: boolean;
  onCreate: (data: FormData | string) => void; onOpen: (id: string) => void; onError: (error: string) => void;
}) {
  const [source, setSource] = useState<Source>('html');
  const [url, setUrl] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  function chooseFile(file: File) {
    if (busy) return;
    if (!/\.(?:html?|zip)$/i.test(file.name)) return onError('请选择 HTML 或 ZIP 文件。');
    if (file.size > 8 * 1024 * 1024) return onError('文件不能超过 8 MB。');
    const data = new FormData();
    data.set('file', file);
    onCreate(data);
  }

  function submitUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy) onCreate(url.trim());
  }

  return <div className="onboarding">
    <section className="import-card" aria-labelledby="import-title">
      <div className="card-heading"><div><span className="section-tag">NEW PROJECT</span><h2 id="import-title">导入网页项目</h2><p>选择你拥有或获准检测的网页。</p></div><span className="section-icon"><FileUp size={20} /></span></div>
      <div className="evidence-tabs import-tabs" role="group" aria-label="网页导入方式">
        <button aria-pressed={source === 'html'} disabled={busy} onClick={() => setSource('html')}><FileCode2 size={16} />HTML</button>
        <button aria-pressed={source === 'zip'} disabled={busy} onClick={() => setSource('zip')}><FileArchive size={16} />ZIP</button>
        <button aria-pressed={source === 'url'} disabled={busy} onClick={() => setSource('url')}><Link2 size={16} />URL</button>
      </div>
      {source === 'url' ? <form className="url-form" onSubmit={submitUrl}>
        <label htmlFor="page-url">公开网页地址</label>
        <input id="page-url" type="url" inputMode="url" placeholder="https://example.com/page" value={url} maxLength={2048} required disabled={busy} onChange={event => setUrl(event.target.value)} aria-describedby="url-scope" />
        <p id="url-scope">获取静态 HTML 与受支持的同源资源。登录内容和依赖脚本渲染的页面可能无法完整呈现。修复仅保存到本地快照。</p>
        <button className="button dark" disabled={busy}>导入 URL 并检测 <ArrowRight size={15} /></button>
      </form> : <div className="dropzone" onDragOver={event => event.preventDefault()} onDrop={event => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) chooseFile(file);
      }}>
        <div className="upload-icon"><FileUp size={24} /></div>
        <b>{source === 'html' ? '上传单个 HTML 文件' : '上传静态网页 ZIP'}</b>
        <span>{source === 'html' ? '支持 .html / .htm' : '可包含 HTML、CSS 与本地图片'} · 可拖放 · 最大 8 MB</span>
        <input ref={fileInput} type="file" accept={source === 'html' ? '.html,.htm' : '.zip'} hidden onChange={event => {
          const file = event.target.files?.[0];
          if (file) chooseFile(file);
          event.target.value = '';
        }} />
        <button className="button dark" disabled={busy} onClick={() => fileInput.current?.click()}>选择文件 <ArrowRight size={15} /></button>
      </div>}
      <div className="import-note"><LockKeyhole size={15} />网页自带脚本不会在检测环境中执行。</div>
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

function Assistant({ issue, history, knowledge, ai, busy, proposal, input, onInput, onPropose, onConfirm, onReject, onShowPatch }: {
  issue?: Issue; history?: HistoryItem; knowledge: Knowledge | null; ai: boolean; busy: boolean;
  proposal: Proposal | null; input: string; onInput: (value: string) => void;
  onPropose: (source: 'ai' | 'manual') => void; onConfirm: () => void; onReject: () => void;
  onShowPatch: () => void;
}) {
  const target = history?.issue ?? issue;
  const verification = history?.verification;
  const refs = verification?.wcag ?? proposal?.wcag ?? knowledge?.refs ?? target?.wcag ?? [];
  return <>
    {!history && <div className="assistant-toolbar">
      <span className="ai-pill"><Sparkles size={13} />{ai ? 'AI 已配置' : 'AI 未配置'}</span>
      {issue && issueNames[issue.ruleId] && !busy && <a href="#repair-value">前往修复操作</a>}
    </div>}
    {target ? <div className="assistant-body">
      <div className="issue-heading"><span className={'issue-dot' + (history ? ' fixed' : '')} aria-hidden="true">{history ? <Check size={16} /> : '!'}</span><div><h3>{issueTitle(target)}</h3><span>{target.ruleId} · {impactName[target.impact] ?? target.impact}</span></div></div>
      <div className="detail-block"><h4>使用影响</h4><p>{issueNames[target.ruleId]?.[1] ?? target.description}</p></div>
      <div className="detail-block"><h4>{history ? '修复前元素' : '问题元素'}</h4><code>{target.html}</code></div>
      <div className="detail-block"><h4>规则与 WCAG 依据</h4>
        {refs.length > 0 && <div className="rule-tags">{refs.map(ref => <span key={ref}>{ref}</span>)}</div>}
        <a href={verification?.wcagUrl || proposal?.wcagUrl || knowledge?.url || target.helpUrl} target="_blank" rel="noreferrer">{proposal?.wcagTitle || knowledge?.title || '查看规则与规范说明'} <ArrowUpRight size={12} /></a>
        {(proposal?.guidance || knowledge?.guidance) && <p>{proposal?.guidance || knowledge?.guidance}</p>}
      </div>
      {verification ? <div className="verification-card">
        <h4><CheckCircle2 size={16} />复测通过</h4>
        <p>{verification.reason}</p>
        <ul>
          <li>该问题在修复后扫描中消失</li>
          {verification.structurePassed && <li>页面结构检查通过</li>}
          {verification.functionPassed && <li>静态控件与聚焦检查通过</li>}
          <li>新增自动检测问题 {verification.added.length} 项</li>
          {verification.contrastCheck?.valid && <li>对比度 {verification.contrastCheck.ratio.toFixed(2)}:1，要求 {verification.contrastCheck.required}:1</li>}
        </ul>
        {verification.proposalReason && <p><b>历史修复方案</b> {verification.proposalReason}</p>}
        <small>{dateText(verification.createdAt)}</small>
        {verification.diff && <button type="button" className="secondary history-patch" onClick={onShowPatch}>查看历史补丁</button>}
      </div> : issueNames[target.ruleId] ? <>
        <label className="input-label" htmlFor="repair-value">{target.ruleId === 'color-contrast' ? '修复颜色' : '建议的文本内容'}</label>
        <input id="repair-value" value={input} maxLength={160} disabled={busy} onChange={event => onInput(event.target.value)}
          placeholder={target.ruleId === 'image-alt' ? '描述图片，装饰图片可留空' : target.ruleId === 'color-contrast' ? '#1c2731' : '填写符合实际用途的名称'} />
        <p className="muted note">{ai ? 'AI 建议会向配置的模型服务发送相关局部代码。' : '可手动填写内容并生成补丁。配置模型服务后可使用 AI 建议。'}</p>
        <div className="repair-actions">
          <button className="button dark" disabled={busy} onClick={() => onPropose('manual')}><Code2 size={15} />生成补丁预览</button>
          <button className="secondary" disabled={busy || !ai} onClick={() => onPropose('ai')}><Sparkles size={15} />AI 生成建议</button>
        </div>
        {proposal && <div className="proposal">
          <div className="proposal-head"><b>{proposal.source === 'ai' ? 'AI 修复建议' : '人工修复建议'}</b><span>待审核</span></div>
          <p>{proposal.reason}</p><p className="muted">{proposal.risk}</p>
          <div className="repair-actions">
            <button className="button dark" disabled={busy || input !== proposal.patch.value} onClick={onConfirm}><Check size={15} />审核并应用</button>
            <button className="secondary" disabled={busy} onClick={onReject}>保留原样</button>
          </div>
          <small>{input !== proposal.patch.value ? '输入已更新，请重新生成补丁预览。' : '应用前请核对源码差异。'}</small>
        </div>}
      </> : <p className="manual-only">此规则需要人工处理。可查看规范和报告中的复核项。</p>}
    </div> : <Blank icon={<Sparkles />} title="选择一个问题">查看使用影响、修复依据和可审核的补丁。</Blank>}
  </>;
}

function Metrics({ state }: { state: State }) {
  return <div className="metrics">
    <div><span>初始问题</span><strong>{state.summary.initial ?? '—'}</strong><small>原始版本扫描</small></div>
    <div className="metric-ok"><span>已解决</span><strong>{state.current ? state.summary.resolved : '—'}</strong><small>相对原始版本</small></div>
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
    <Metrics state={state} />
    <div className="export-banner"><span className="section-icon"><Download size={19} /></span><div><h2>导出源码与报告</h2><p>ZIP 包含当前本地快照、扫描截图、HTML / JSON 报告和验证日志。</p></div><ExportButton route={'/api/projects/' + state.project.id} disabled={busy} /></div>
    <div className="report-grid">
      <section className="panel report-section"><div className="panel-head"><div><span className="kicker">VALIDATION</span><h2>修复与验证记录</h2></div></div>
        {state.verifications.length ? state.verifications.map(item => <div className="log-row" key={item.id}>
          <span className={'log-icon ' + (item.status === 'passed' ? 'ok' : 'failed')} aria-hidden="true">{item.status === 'passed' ? <Check size={15} /> : <X size={15} />}</span>
          <div><b>{item.status === 'passed' ? '验证通过' : '验证失败 · 已保留原版本'} · {versionLabel(state, item.fromSnapshot)} → {versionLabel(state, item.toSnapshot)}</b>
            <p>{item.reason}</p><small>{dateText(item.createdAt)} · 解决 {item.resolved.length} / 残留 {item.remaining.length} / 新增 {item.added.length}</small>
            {item.status === 'passed' && item.resolved.map(resolved => <button className="record-link" key={resolved.id} disabled={busy} onClick={() => onOpen({ issue: resolved, verification: item })}>{issueTitle(resolved)} · 查看证据 <ArrowRight size={14} /></button>)}
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
          {state.current?.incomplete.map(item => <div className="manual-item" key={item.ruleId}><Info size={14} />{item.help} · {item.count} 项需要进一步判断</div>)}
        </div>
        <div className="versions"><h3>版本记录</h3>{state.snapshots.map((snapshot, index) => <div key={snapshot.id}>
          <span><b>V{index}</b> {snapshot.description}{snapshot.id === state.project.currentSnapshot ? ' · 当前' : ''}</span>
          {snapshot.id !== state.project.currentSnapshot && <button disabled={busy} aria-label={`恢复版本 V${index}`} onClick={() => onRollback(snapshot.id)}><RotateCcw size={13} />恢复</button>}
        </div>)}</div>
      </section>
    </div>
    <div className="report-actions"><button className="secondary" onClick={onWorkspace}>返回工作台</button></div>
  </div>;
}

function ConfirmDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
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
    <div className="confirm-actions">
      <button ref={cancel} className="secondary" onClick={onClose}>再检查一下</button>
      <button className="button dark" onClick={onConfirm}>确认并验证 <ArrowRight size={15} /></button>
    </div>
  </dialog>;
}

createRoot(document.getElementById('root')!).render(<App />);
