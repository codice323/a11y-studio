import { normalizeCaptureUrl } from '../../../packages/shared/capture-url';
import { workspaceFetch as fetch } from './workspace-fetch';
import { JobRecoveryError, startJob, waitJob, type JobType } from './jobs';
import type { ImageAltAnalysis, ImagePurpose, RepairAnalysis } from '../../../packages/shared/types';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronLeft, ChevronRight, Code2, Download,
  FileArchive, FileCode2, FileUp, History, Info, Layers, Link2, LoaderCircle, LockKeyhole,
  ScanSearch, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import { reviewRepairIssue, sourceRepairKinds } from '../../../packages/shared/source-repair';
import { DetectionReview } from './DetectionReview';
import type { AiAuditFinding } from '../../../packages/shared/types';
import { Evidence, type EvidenceView } from './Evidence';
import { LiveComparison } from './LiveComparison';
import { CaptureComparison } from './CaptureComparison';
import { ManagedBrowserCapture, type ManagedCaptureHandle } from './ManagedBrowserCapture';
import type { PageInspection, PanoramaJump } from './Panorama';
import type { PageDiagnostics, PageTarget, WorkspacePageDiagnostics } from '../../../packages/shared/page-diagnostics';
import type { PanoramaIssue } from '../../../packages/shared/panorama';
import type { HistoryItem, Issue, Proposal, State, Verification } from './types';
import { AccountGate, type Account } from './AccountGate';
import { projectFromLocation, rememberProject } from './project-location';
import './style.css';
import './editorial-theme.css';

const issueNames: Record<string, [string, string]> = {
  'image-alt': ['图片缺少替代文本', '屏幕阅读器用户无法了解这张图片的内容。'],
  label: ['表单控件缺少标签', '用户可能无法判断输入框的用途。'],
  'select-name': ['下拉框缺少名称', '用户可能无法判断下拉框的用途。'],
  'button-name': ['按钮缺少名称', '屏幕阅读器无法读出按钮的用途。'],
  'link-name': ['链接缺少名称', '用户无法了解链接的目标。'],
  'focus-style-unchanged': ['焦点样式待复核', '键盘焦点可能缺少清晰的视觉提示。'],
  'aria-broken-idref': ['ARIA 引用待复核', '名称或说明引用指向不存在的元素。'],
  'aria-valid-attr-value': ['ARIA 属性值无效', '辅助技术可能无法找到关联的名称或说明。'],
  'aria-allowed-attr': ['无障碍属性不适用于此元素', '辅助技术可能无法正确理解元素的属性。'],
  'aria-valid-attr': ['无障碍属性名称无效', '辅助技术可能无法正确读取元素的属性。'],
  'aria-roles': ['无障碍角色无效', '辅助技术可能无法正确识别元素的用途。'],
  'aria-required-attr': ['无障碍角色缺少必要属性', '辅助技术可能无法正确理解控件状态。'],
  'aria-required-children': ['无障碍组件缺少必要子元素', '辅助技术可能无法正确理解组件结构。'],
  'aria-required-parent': ['无障碍元素缺少必要的父组件', '辅助技术可能无法正确理解组件结构。'],
  'html-has-lang': ['页面未声明语言', '屏幕阅读器可能使用错误的语言朗读页面。'],
  'document-title': ['页面缺少标题', '用户可能难以区分浏览器标签页。'],
  'color-contrast': ['文字对比度不足', '低视力用户可能难以看清文字。'],
};
const repairableIssueNames = new Set(['image-alt','label','select-name','button-name','link-name','focus-style-unchanged','aria-broken-idref','aria-valid-attr-value','color-contrast']);
const impactName: Record<string, string> = {
  critical: '严重', serious: '较严重', moderate: '中等', minor: '轻微', unknown: '待复核',
};
const severityOrder = new Map(Object.keys(impactName).map((impact, index) => [impact, index]));
const severityRank = (impact: string) => severityOrder.get(impact) ?? 4;
const issueTitle = (issue: Issue) => issueNames[issue.ruleId]?.[0] ?? (/^[\x00-\x7f\s]+$/.test(issue.help) ? `无障碍问题 · ${issue.ruleId}` : issue.help);
const dateText = (date: string) => new Date(date).toLocaleString('zh-CN');
type Fixture = { id: string; name: string; description: string };
type Project = {mode?:string;updatedAt?:string;scanStatus?:string; discovery?:{pages:number;failed:{path:string;reason:string}[];unchecked:number}; id: string; name: string; assets?: { stylesheets: number; images: number; skipped: number }; rendering?: { mode: string; requests: number; blocked: number; empty: boolean } };
type Knowledge = { title: string; url: string; guidance: string; refs: string[] };
type Diagnostics = {
  snapshotId: string;
  audit?: {id:string;status:string};
  job?: {id:string;status:string;error?:string};
  limited: boolean;
  states: {stateId:string;path:string;issues:PanoramaIssue[];findings:import('../../../packages/shared/panorama').InteractionFinding[]}[];
};
type Source = 'zip' | 'url';
type Selection = { issueId: string; captureProject?: string } | { history: HistoryItem; archived: boolean } | null;
const controlTabs = [
  { id: 'issues', label: '问题与历史' },
  { id: 'assistant', label: 'AI 修复助手' },
] as const;
const workspaceViews = [
  {id:'workspace', label:'诊断工作台', icon:ScanSearch},
  {id:'report', label:'结果报告', icon:Activity},
] as const;
type WorkspaceView = typeof workspaceViews[number]['id'];

const sidebarPreference = 'a11y-studio.sidebar-collapsed';

type ControlTab = typeof controlTabs[number]['id'];
type RepairDraft = { value: string; singleLocation?: boolean; edited?: boolean; prepared?: Proposal; proposal: Proposal | null; analysis?: ImageAltAnalysis | RepairAnalysis; purpose?: ImagePurpose };
const applyingLabel = '正在保存补丁…';
const imagePurposeLabel = { informative:'内容性图片', decorative:'装饰性图片', uncertain:'用途待确认' };

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || (data === null && response.headers.get('content-type')?.includes('text/html'))) {
    throw new Error(data?.error ?? `服务请求失败（HTTP ${response.status}）。`,{cause:response.status});
  }
  return data as T;
}

function post<T>(url: string, data: unknown = {}) {
  return request<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

type ReviewDecision = {status:'confirmed'|'dismissed';at:string;item?:Issue};
type ReviewDecisions = Record<string,ReviewDecision>;
function readReviewDecisions(key:string):ReviewDecisions {
  try {return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};} catch {return {};}
}

function App({account,signOut,openUpgrade,openVerification}:{account:Account;signOut:()=>Promise<void>;openUpgrade:()=>void;openVerification:()=>void}) {
  const [signingOut,setSigningOut] = useState(false);
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
  const [ruleFilter,setRuleFilter] = useState('all');
  const [inspection, setInspection] = useState<PageInspection>();
  const [scanRevision,setScanRevision] = useState(0);
  const [diagnostics,setDiagnostics] = useState<Diagnostics>();
  const [visibleDiagnostics,setVisibleDiagnostics] = useState<WorkspacePageDiagnostics>();
  const [pageScanRevision,setPageScanRevision] = useState(0);
  const [managedScanRevision,setManagedScanRevision] = useState(0);
  const [pageIssue,setPageIssue] = useState<{item:Issue;scope:string;attempt:number;selectors:string[]}>();
  const livePageCache = useRef(new Map<string,PageDiagnostics>());
  const managedPageCache = useRef(new Map<string,PageDiagnostics>());
  const scopeOf = (value?:WorkspacePageDiagnostics) => JSON.stringify(value ? [value.kind,value.projectId,value.version,value.path] : []);
  const currentPageIssue = visibleDiagnostics?.status==='ready' && pageIssue?.scope === scopeOf(visibleDiagnostics) ? pageIssue : undefined;
  const [directTarget,setDirectTarget] = useState<{project:string;version:string;target:PageTarget}>();
  const [reviewTarget,setReviewTarget] = useState<{scope:string;target:PageTarget}>();
  const pageTarget:PageTarget|undefined = currentPageIssue && visibleDiagnostics ? {
    id:currentPageIssue.item.id+':'+currentPageIssue.attempt,path:visibleDiagnostics.path,selector:currentPageIssue.item.selector,selectors:currentPageIssue.selectors,
  } : visibleDiagnostics?.status === 'ready' && reviewTarget?.scope === scopeOf(visibleDiagnostics) ? reviewTarget.target : undefined;
  const [scanConnectionError,setScanConnectionError] = useState(false);
  const [panoramaJump, setPanoramaJump] = useState<PanoramaJump>();
  const [panoramaIssue, setPanoramaIssue] = useState<{item: PanoramaIssue; stateId: string; version: string; path: string}>();
  const [view, setView] = useState<EvidenceView>('interactive');
  const [list, setList] = useState<'open' | 'history'>('open');
  const [controlTab, setControlTab] = useState<ControlTab>('issues');
  const [captureUrl,setCaptureUrl] = useState(() => sessionStorage.getItem('a11y-studio:url-capture') || '');
  const [linkPreview,setLinkPreview] = useState<{
    url:string; diagnostics:typeof visibleDiagnostics; issue:typeof pageIssue; selection:typeof selection;
    panoramaIssue:typeof panoramaIssue; locations:string[]; tab:ControlTab; filter:string; rule:string; list:typeof list;
  }>();
  const managedUrl = linkPreview?.url ?? captureUrl;
  const managedCapture = useRef<ManagedCaptureHandle>(null);
  const [page, setPage] = useState<WorkspaceView>('workspace');
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(sidebarPreference) === 'true'; } catch { return false; }
  });
  const [snapshotPreview, setSnapshotPreview] = useState<string>();
  const [showOriginal, setShowOriginal] = useState(false);
  const showingOriginal = Boolean(showOriginal && state?.originalSnapshotId && state.originalSnapshotId !== state.project.currentSnapshot);
  const [comparisonScroll, setComparisonScroll] = useState<number>();
  const livePosition = useRef(0);
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [pageRequest, setPageRequest] = useState<{path:string}>();
  const [inlineStart, setInlineStart] = useState<{scope:string;path:string}>();
  const diagnosticProject=state?.project.id;
  const diagnosticVersion=state?.project.currentSnapshot;
  const latestAuditId=useRef<string|undefined>(undefined);
  latestAuditId.current=state?.current?.id;
  useEffect(()=>{
    setDiagnostics(undefined);
    setScanConnectionError(false);
    if (!diagnosticProject || !diagnosticVersion) return;
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    async function update() {
      try {
        const base='/api/projects/'+diagnosticProject;
        const next=await request<Diagnostics>(base+'/diagnostics',{signal:controller.signal});
        if (controller.signal.aborted || next.snapshotId!==diagnosticVersion) return;
        setDiagnostics(next);
        setScanConnectionError(false);
        if (next.audit?.status==='completed' && next.audit.id!==latestAuditId.current) {
          const updated=await request<State>(base,{signal:controller.signal});
          if (!controller.signal.aborted && updated.project.currentSnapshot===diagnosticVersion) {
            setState(previous=>previous && previous.project.id===diagnosticProject && previous.project.currentSnapshot===diagnosticVersion ? updated : previous);
          }
        }
        if (!controller.signal.aborted && next.job && ['queued','running'].includes(next.job.status)) timer=setTimeout(update,1200);
      } catch {
        if (!controller.signal.aborted) setScanConnectionError(true);
      }
    }
    void update();
    return ()=>{controller.abort();clearTimeout(timer);};
  },[diagnosticProject,diagnosticVersion,scanRevision]);
  const currentDiagnostics=diagnostics?.snapshotId===diagnosticVersion ? diagnostics : undefined;
  const diagnosticJob=currentDiagnostics?.job;
  const scanning=Boolean(diagnosticJob && ['queued','running'].includes(diagnosticJob.status));
  const projectScope = state ? state.project.id + ':' + state.project.currentSnapshot : '';
  const pair = {
    left:state?.originalSnapshotId ?? state?.project.currentSnapshot ?? '',
    right:state?.project.currentSnapshot ?? '',
  };
  const activeLabel = workspaceViews.find(item => item.id === page)?.label;
  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(sidebarPreference,String(next)); } catch { /* This browser can still collapse the sidebar. */ }
  }
  const [ai, setAi] = useState({ configured: false, visionConfigured: false, explorerPlanning: false });
  const [knowledge, setKnowledge] = useState<Knowledge | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const activePoll = useRef<AbortController>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const evidenceFocus = useRef<HTMLDivElement>(null);
  const assistantPanel = useRef<HTMLDivElement>(null);
  const tabButtons = useRef<Partial<Record<ControlTab, HTMLButtonElement | null>>>({});
  const pageScope = scopeOf(visibleDiagnostics);
  const lastPageScope = useRef('');
  useEffect(() => {
    if (!visibleDiagnostics?.path || lastPageScope.current === pageScope) return;
    if (selection && 'issueId' in selection && selection.captureProject === visibleDiagnostics.projectId &&
        (visibleDiagnostics.status === 'pending' || visibleDiagnostics.entry)) return;
    lastPageScope.current = pageScope;
    if (selection && 'history' in selection) return;
    setSelectedLocations([]);
    setPageIssue(undefined);
    setSelection(null);
    setPanoramaIssue(previous => previous && previous.path!==visibleDiagnostics.path ? undefined : previous);
    setControlTab('issues');
    setFilter('all');
    setRuleFilter('all');
    setList('open');
  }, [pageScope, visibleDiagnostics?.status, visibleDiagnostics?.entry]);
  const selectedId = selection && 'issueId' in selection ? selection.issueId : undefined;
  const reviewIssue = selectedId && state?.current?.detection?.behavior.findings
    .map(reviewRepairIssue).find(item => item?.id === selectedId);
  useEffect(() => {
    if (currentPageIssue || !panoramaIssue || !inspection || inspection.projectId !== state?.project.id) return;
    // A saved state ID remains stable while the comparison inventory resolves its path.
    if (inspection.stateId ? inspection.stateId !== panoramaIssue.stateId : inspection.path !== panoramaIssue.path) {
      setPanoramaIssue(undefined);
      setControlTab('issues');
    }
  }, [currentPageIssue, inspection, panoramaIssue, state?.project.id]);
  // Older running APIs may not yet expose the inherited issue inventory.
  const workingIssues: Issue[] = (()=>{
    if (!state) return [];
    if (state.current) return state.current.issues;
    if (state.inheritedIssues) return state.inheritedIssues;
    const versions=new Map(state.snapshots.map(version=>[version.id,version]));
    const repairs=new Map(state.verifications.filter(item=>item.status!=='failed').map(item=>[item.toSnapshot,item]));
    const addressed=new Set<string>();
    const visited=new Set<string>();
    for (let id=state.project.currentSnapshot; id && !visited.has(id);) {
      if (id===state.originalSnapshotId) return (state.baseline?.issues ?? []).filter(item=>!addressed.has(item.id));
      visited.add(id);
      const parent=versions.get(id)?.parent_id;
      const repair=repairs.get(id);
      if (!parent || !repair || repair.fromSnapshot!==parent) break;
      if (!repair.panoramaState && repair.patch) {
        addressed.add(repair.patch.issueId);
        for (const target of repair.patch.contrastTargets ?? []) addressed.add(target.issueId);
      }
      for (const item of repair.resolved) addressed.add(item.id);
      id=parent;
    }
    return [];
  })();
  const panoramaContext = !showingOriginal && panoramaIssue?.stateId && panoramaIssue.version === state?.project.currentSnapshot &&
    panoramaIssue.item.ruleId === 'button-name' && panoramaIssue.item.source ? panoramaIssue : undefined;
  const issue: Issue | undefined = showingOriginal ? undefined : panoramaContext ? {
    ...panoramaContext.item, impact: panoramaContext.item.impact ?? 'unknown', html: panoramaContext.item.html ?? '', helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html',
  } : reviewIssue ? { ...reviewIssue, source: state?.current?.sourceLocations?.[reviewIssue.selector] }
    : workingIssues.find(item => item.id === selectedId ||
      (currentPageIssue?.item.selector && visibleDiagnostics && visibleDiagnostics.version === state?.project.currentSnapshot &&
        (visibleDiagnostics.entry || visibleDiagnostics.path.split('#')[0] === '/'+state?.project.entry.split('/').map(encodeURIComponent).join('/')) &&
        item.ruleId === currentPageIssue.item.ruleId && item.selector === currentPageIssue.item.selector));
  useEffect(() => {
    if (!issue || !selection || !('issueId' in selection) || !selection.captureProject ||
        selection.captureProject !== visibleDiagnostics?.projectId || !visibleDiagnostics.entry ||
        visibleDiagnostics.status !== 'ready') return;
    setPageIssue({item:issue,scope:pageScope,attempt:1,selectors:selectedLocations});
  }, [issue, selection, visibleDiagnostics, pageScope, selectedLocations]);
  const history = selection && 'history' in selection ? selection.history : undefined;
  const draftKey = issue && state ? `${state.project.currentSnapshot}:${panoramaContext?.stateId ?? ''}:${issue.id}` : '';
  const draft = drafts[draftKey];
  const proposal = draft?.proposal ?? null;
  const input = draft?.purpose === 'decorative' ? '' : draft?.value ?? '';
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

  useEffect(() => {
    mounted.current=true;
    void loadHome();
    const initialProject=projectFromLocation();
    if (initialProject && !captureUrl) openProject(initialProject);
    return ()=>{mounted.current=false;};
  }, []);
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
      return await waitJob<T>(id, type, controller.signal, type === 'explorer' ? setBusy : undefined);
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
    if (mounted.current) {setState(next);rememberProject(pid);}
    return next;
  }

  function openPage(next: WorkspaceView) {
    setPage(next);
    requestAnimationFrame(() => heading.current?.focus());
  }

  const liveTransition = useRef(Promise.resolve());
  const showHistoryToggle = !proposal && history && (!history.verification.panoramaState || history.verification.status === 'applied');
  function renderVersionToggle() {
    if (!state) return null;
    return state.originalSnapshotId && state.originalSnapshotId !== state.project.currentSnapshot && <label className="repair-version-toggle">
      <input type="checkbox" checked={showingOriginal} disabled={working} onChange={event => {
        const path = visibleDiagnostics?.path.split('#')[0];
        if (path && state.project.mode !== 'react-source' && /\.html?$/i.test(path)) setInlineStart({scope:projectScope,path});
        setComparisonScroll(livePosition.current);
        setShowOriginal(event.target.checked);
      }} />查看原始状态
    </label>;
  }
  function renderInteractivePage(toolsHost: HTMLDivElement | null) {
    if (!state) return null;
    const current = state.project.currentSnapshot;
    const original = state.originalSnapshotId;
    const version = showingOriginal && original ? original : current;
    const target = history?.issue ?? currentPageIssue?.item ?? issue ?? (panoramaIssue && { ...panoramaIssue.item, impact:panoramaIssue.item.impact ?? 'unknown', html:panoramaIssue.item.html ?? '', helpUrl:'' });
    const path = inlineStart?.scope === projectScope ? inlineStart.path : panoramaIssue?.path ?? pageRequest?.path;
    const file = path?.split('#')[0];
    const start = state.project.mode !== 'react-source' && file && /\.html?$/i.test(file) ? decodeURIComponent(file.slice(1)) : undefined;
    const name = showingOriginal ? '原始状态' : '当前状态';
    const names = {left:name,right:name};
    const canReplay = Boolean(state.browserCapture?.dynamicReplay);
    const useCopy = Boolean(state.browserCapture && (!canReplay || snapshotPreview === state.project.id));
    if (proposal && !showingOriginal) {
      const pendingNames = {left:'修复前',right:'待审核预览'};
      return <LiveComparison project={state.project.id} left={current} right={current} current={current} names={pendingNames}
        proposalId={proposal.id} toolsHost={toolsHost} leftSelector={target?.selector} start={start}
        stateId={panoramaIssue?.stateId} transition={liveTransition} projectMode={state.project.mode}
        onInspection={setInspection} onRepair={openStateIssue} />;
    }
    if (useCopy) {
      const afterSelector = version === history?.verification.toSnapshot ? history.verification.sourceTarget : undefined;
      return <CaptureComparison single initialScroll={comparisonScroll} positionRef={livePosition} project={state.project.id} left={version} right={version} names={names}
        current={current} active issue={target} afterSelector={afterSelector} targetPair={{left:version,right:version}}
        groupSelectors={selectedLocations} versions={showHistoryToggle ? undefined : renderVersionToggle()} limitations={state.browserCapture!.limitations}
        onReplay={canReplay ? () => setSnapshotPreview(undefined) : undefined} onDiagnostics={setVisibleDiagnostics} />;
    }
    return <LiveComparison single initialScroll={comparisonScroll} positionRef={livePosition} project={state.project.id} left={version} right={version} names={names}
      start={canReplay ? undefined : start} stateId={panoramaIssue?.stateId ?? (canReplay || history?.verification.status==='applied' ? undefined : history?.verification.panoramaState)}
      transition={liveTransition} current={current} projectMode={state.project.mode} onInspection={setInspection}
      versions={<>{!showHistoryToggle && renderVersionToggle()}{canReplay && <button type="button" className="secondary" onClick={() => setSnapshotPreview(state.project.id)}>查看采集副本</button>}</>}
      onRepair={openStateIssue} onDiagnostics={!state.current && state.verifications.some(item=>item.status==='applied' && item.toSnapshot===version) ? undefined : setVisibleDiagnostics} diagnosticsCache={livePageCache.current}
      scanRevision={pageScanRevision} target={managedUrl ? undefined : directTarget?.project===state.project.id && directTarget.version===version ? directTarget.target : pageTarget}
      entryTargetPath={'/'+state.project.entry.split('/').map(encodeURIComponent).join('/')}
      onOpenUncapturedLink={openLinkPreview} />;
  }

  function resetSelection() {
    setSnapshotPreview(undefined);
    setShowOriginal(false);
    setComparisonScroll(undefined);
    setSelectedLocations([]);
    setPageRequest(undefined);
    setInlineStart(undefined);
    setPanoramaJump(undefined);
    setPanoramaIssue(undefined);
    setRecovery(undefined);
    setSelection(null);
    setControlTab('issues');
    setDrafts({});
    setFilter('all');
    setRuleFilter('all');
    setVisibleDiagnostics(undefined);
    setPageIssue(undefined);
    setView('interactive');
    setList('open');
  }

  function openProject(pid: string) {
    run('正在加载项目…', async () => {
      await loadProject(pid);
    });
  }

  async function loadProject(pid: string, target?: { item: Issue; selectors: string[] }) {
    resetSelection();
    closeManagedUrlCapture();
    openPage('workspace');
    rememberProject(pid);
    const base = '/api/projects/' + pid;
    let next = await refresh(pid).catch(error => {
      if (mounted.current && projectFromLocation()===pid && [403,404].includes(error.cause)) rememberProject(null);
      throw error;
    });
    if (!next.current && (target || !next.snapshots.find(snapshot=>snapshot.id===next.project.currentSnapshot)?.parent_id)) {
      const job = (await request<Diagnostics>(base + '/diagnostics')).job;
      if (target) setBusy('正在检测修复副本并匹配所选问题…');
      if (target && job && ['queued','running'].includes(job.status)) {
        await waitJob(job.id, 'diagnostics', new AbortController().signal);
        next = await refresh(pid);
      } else if (target && job?.status === 'completed') {
        next = await refresh(pid);
      } else if (!job) {
        if (!target) setBusy('正在检测项目…');
        await runJob('audit', base + '/audits');
        next = await refresh(pid);
      }
    }
    if (!target) return;
    const matches = (next.current?.issues ?? []).filter(item =>
      item.ruleId === target.item.ruleId && item.selector === target.item.selector);
    if (matches.length !== 1) {
      setNotice(next.current ? '修复副本已保存。复测未找到与所选位置一致的问题，请在右侧选择副本中的问题。'
        : '修复副本已保存。请重新检测副本后选择要修复的问题。');
      return;
    }
    setSelectedLocations(target.selectors);
    setSelection({issueId:matches[0].id,captureProject:pid});
    openAssistant();
  }

  function repairCapturedIssue(target: NonNullable<typeof currentPageIssue>, path: string) {
    const capture = managedCapture.current;
    if (!capture || working) return;
    run('正在保存当前网页的修复副本…', async () => {
      const pid = await capture.save(path);
      await loadProject(pid, target);
    });
  }

  async function manageProject(projectId:string,change:{name:string}|{confirm:true}) {
    const remove='confirm' in change;
    await request('/api/projects/'+projectId,{method:remove?'DELETE':'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(change)});
    if (remove) {
      setProjects(previous=>previous.filter(project=>project.id!==projectId));
      if (projectFromLocation()===projectId) rememberProject(null);
    } else {
      setProjects(previous=>previous.map(project=>project.id===projectId?{...project,name:change.name.trim()}:project));
    }
    await loadHome();
    setNotice(remove?'项目已删除。':'项目名称已更新。');
  }

  function createProject(data: FormData) {

    run('正在导入项目…', async () => {
      const demo=data.has('fixture');
      if (!demo) data.set('diagnostics','entry');
      const project = await request<Project>('/api/projects', {method:'POST',body:data});
      setProjects(previous=>[project,...previous.filter(item=>item.id!==project.id)]);
      resetSelection();
      await refresh(project.id);
      openPage('workspace');
      if (demo) {
        await runJob('audit','/api/projects/'+project.id+'/audits');
        await refresh(project.id);
        setNotice('项目已导入并完成真实检测。');
      }
    });
  }

  function openManagedUrlCapture(url:string) {
    managedPageCache.current.clear();
    sessionStorage.setItem('a11y-studio:url-capture',url);
    setVisibleDiagnostics({kind:'remote',path:url,status:'pending'});
    setCaptureUrl(url);
    setPage('workspace');
    requestAnimationFrame(() => heading.current?.focus());
  }

  function closeManagedUrlCapture() {
    sessionStorage.removeItem('a11y-studio:url-capture');
    setCaptureUrl('');
    setLinkPreview(undefined);
    managedPageCache.current.clear();
    setVisibleDiagnostics(undefined);
  }

  function openLinkPreview(url:string) {
    managedPageCache.current.clear();
    setLinkPreview({url,diagnostics:visibleDiagnostics,issue:pageIssue,selection,panoramaIssue,
      locations:selectedLocations,tab:controlTab,filter,rule:ruleFilter,list});
    setVisibleDiagnostics({kind:'remote',path:url,status:'pending'});
  }

  function closeLinkPreview() {
    if (!linkPreview) return;
    closeManagedUrlCapture();
    lastPageScope.current = scopeOf(linkPreview.diagnostics);
    setVisibleDiagnostics(linkPreview.diagnostics);
    setPageIssue(linkPreview.issue);
    setSelection(linkPreview.selection);
    setPanoramaIssue(linkPreview.panoramaIssue);
    setSelectedLocations(linkPreview.locations);
    setControlTab(linkPreview.tab);
    setFilter(linkPreview.filter);
    setRuleFilter(linkPreview.rule);
    setList(linkPreview.list);
    requestAnimationFrame(() => evidenceFocus.current?.focus({preventScroll:true}));
  }

  function changeEvidenceView(next:EvidenceView) {
    if (view==='interactive' && next!=='interactive' && visibleDiagnostics?.kind==='live') {
      const path = visibleDiagnostics.path.split(/[?#]/)[0];
      if (/\.html?$/i.test(path)) {
        setPageRequest({path});
        setInlineStart({scope:projectScope,path});
      }
    }
    setView(next);
  }

  function scanCurrentPage() {
    if (view==='interactive' && (visibleDiagnostics?.kind==='live' || visibleDiagnostics?.kind==='remote')) {
      if (visibleDiagnostics.kind==='live') {
        livePageCache.current.delete(JSON.stringify([visibleDiagnostics.projectId,visibleDiagnostics.version,visibleDiagnostics.path]));
      }
      setPageScanRevision(value=>value+1);
    } else scanAgain();
  }

  function scanAgain() {
    run('正在启动检测…',async()=>{
      await post(route+'/diagnostics');
      setScanRevision(value=>value+1);
    });
  }

  function openStateIssue({issue:item,stateId,version,path}:{issue:PanoramaIssue;stateId:string;version:string;path:string}) {
    setSelection(null);
    setInspection(undefined);
    setPanoramaIssue({item,stateId,version,path});
    setPanoramaJump({stateId,key:stateId});
    if (state && item.selector) setDirectTarget({project:state.project.id,version,target:{
      id:crypto.randomUUID(),path,selector:item.selector,
    }});
    setView('interactive');
    openPage('workspace');
    openAssistant();
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
    setPanoramaJump(undefined);
    setPanoramaIssue(undefined);
    setRecovery(undefined);
    setSelection({ issueId: item.id });
    setView('interactive');
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
    setPageIssue(undefined);
    setSelectedLocations([]);
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

  function showRepairPreview(rule: string) {
    setView(rule === 'color-contrast' || rule.startsWith('focus-') ? 'interactive' :
      ['image-alt','button-name','link-name','label','select-name'].includes(rule) ? 'semantics' : 'diff');
    requestAnimationFrame(() => evidenceFocus.current?.focus());
  }

  function chooseHistory(item: HistoryItem, nextView: EvidenceView = view, moveFocus = false, archived = false) {
    if (item.verification.panoramaState) {
      setPanoramaJump({stateId: item.verification.panoramaState, key: item.verification.id});
    } else {
      setPanoramaJump(undefined);
    }
    setPanoramaIssue(undefined);
    setShowOriginal(false);
    setComparisonScroll(undefined);
    setSelectedLocations([]);
    setList('history');
    setSelection({ history: item, archived });
    setPageIssue(undefined);
    setView(nextView);
    setPage('workspace');
    openAssistant(!moveFocus);
    if (moveFocus) requestAnimationFrame(() => evidenceFocus.current?.focus());
  }

  function propose(source: 'agent' | 'manual', value = input) {
    if (!issue) return;
    if (source === 'manual' && draft?.prepared && value === draft.prepared.patch.value && draft.purpose === draft.prepared.imagePurpose) {
      updateDraft({proposal:draft.prepared,prepared:undefined});
      setShowOriginal(false);
      showRepairPreview(issue.ruleId);
      return;
    }
    if (source === 'agent') updateDraft({prepared:undefined,proposal:null,analysis:undefined});
    const mode = state?.project.mode;
    const manualRules = ['label','select-name','link-name'];
    if (mode === 'react-source' || mode === 'static-source') manualRules.push('button-name','color-contrast');
    if (mode === 'react-source') manualRules.push('image-alt');
    const snapshotColor = issue.ruleId === 'color-contrast' && mode === 'snapshot';
    const sourceRepair = Boolean(panoramaContext) || (source === 'manual' ? manualRules.includes(issue.ruleId) :
      !snapshotColor && Object.hasOwn(sourceRepairKinds, issue.ruleId));
    run(sourceRepair ? `Agent 正在分析「${issueTitle(issue)}」并验证隔离副本…` :
      source === 'agent' ? 'AI 正在分析问题…' : '正在生成补丁预览…', async () => {
      const endpoint = route + '/issues/' + encodeURIComponent(issue.id) + '/proposals';
      const data = { source, value, imagePurpose: draft?.purpose,
        ...(!draft?.singleLocation && contrastGroupIds.length && {
          contrastIssueIds: contrastGroupIds, snapshotId: state?.project.currentSnapshot,
        }),
      };
      const next = panoramaContext
        ? await runJob<Proposal | RepairAnalysis>('source-repair', route + '/panorama/proposals', {
          stateId: panoramaContext.stateId, snapshotId: state?.project.currentSnapshot, issueId: issue.id, value, source,
        })
        : sourceRepair ? await runJob<Proposal | RepairAnalysis>('source-repair', endpoint, { ...data, sourceRepair: true, snapshotId: state?.project.currentSnapshot, intent: source === 'manual' || (draft?.edited && issue.ruleId !== 'color-contrast') ? value : undefined })
        : await post<Proposal | ImageAltAnalysis | RepairAnalysis>(endpoint, data);
      if (!('patch' in next)) {
        if ('contentAlt' in next && (next.purpose === 'decorative' ||
          (next.purpose === 'informative' && next.contentAlt?.trim()))) {
          if (!draft?.edited && !draft?.purpose) {
            updateDraft({analysis:next,purpose:next.purpose,value:next.purpose === 'decorative' ? '' : next.contentAlt ?? ''});
            return;
          }
        }
        const suggested = 'contentAlt' in next ? next.contentAlt : next.suggestedValue;
        updateDraft({ analysis: next, ...(sourceRepair ? { proposal: null, prepared:undefined } : {}), ...(!draft?.edited && !proposal && suggested != null ? { value: suggested } : {}) });
        return;
      }
      if (source === 'agent') {
        updateDraft({prepared:next,proposal:null,value:next.patch.value,analysis:next.analysis,edited:false});
        return;
      }
      updateDraft({
        proposal: next,
        prepared: undefined,
        ...(next.imagePurpose !== 'decorative' ? { value: next.patch.value } : {}),
        edited: false,
      });
      setShowOriginal(false);
      showRepairPreview(issue.ruleId);
      setNotice(next.sourceReview ? '已在隔离副本完成预检，请核对修复内容和页面效果。' : '修复预览已生成，请核对页面效果并确认。');
    }, sourceRepair ? { label: source === 'agent' ? '重试 AI 分析' : '重试生成预览', run: () => propose(source, value) } : undefined);
  }

  function apply(semantics?: import("./EvidenceDetails").SemanticResult) {
    if (showingOriginal || !proposal || !state || !patchReady || working) return;
    run(applyingLabel, async () => {
      const result = await runJob<Verification>('verification', '/api/proposals/' + proposal.id + '/apply');
      await refresh(state.project.id);
      updateDraft({proposal: null});
      if (result.status === 'applied') {
        setShowOriginal(false);
        setSnapshotPreview(state.browserCapture ? state.project.id : undefined);
        setVisibleDiagnostics(undefined);
        setFilter('all');
        setRuleFilter('all');
        setList('open');
        setPanoramaIssue(undefined);
        setPanoramaJump(undefined);
        if (result.reviewedTarget) {
          if (panoramaIssue?.path) setInlineStart({scope:projectScope,path:panoramaIssue.path});
          setSelection({history:{verification:result,issue:result.reviewedTarget,semantics},archived:false});
        }
        setNotice(result.reason);
      } else {
        setView('interactive');
        setError('修复失败：'+result.reason);
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
    const returnFocus = 'repair-value';
    run('正在关闭补丁建议…', async () => {
      await post('/api/proposals/' + proposal.id + '/reject');
      updateDraft({proposal: null});
      setView('interactive');
      setNotice('已取消补丁预览，保留编辑内容。当前版本未更改。');
      requestAnimationFrame(() => document.getElementById(returnFocus)?.focus());
    });
  }

  const verificationById = new Map(state?.verifications.map(item => [item.id, item]));
  const entryRecords = (state?.resolved ?? []).flatMap(({ issue, verificationId }) => {
    const verification = verificationById.get(verificationId);
    return verification ? [{ issue, verification }] : [];
  });
  const archivedEvidence = Boolean(selection && 'history' in selection && selection.archived);
  const currentInspection = inspection?.projectId === state?.project.id && inspection?.version === state?.project.currentSnapshot ? inspection : undefined;
  const entryPath=state ? '/'+state.project.entry.split('/').map(encodeURIComponent).join('/') : '';
  const grouped=new Map<string,{item:Issue;path:string;stateId?:string;location?:PanoramaIssue;occurrences:number}>();
  for (const item of workingIssues) {
    grouped.set(JSON.stringify([entryPath,item.ruleId,item.selector]),{item,path:entryPath,occurrences:1});
  }
  for (const result of currentDiagnostics?.states ?? []) {
    const findings=result.findings.map(finding=>({
      id:JSON.stringify([finding.ruleId,finding.selector]),ruleId:finding.ruleId,selector:finding.selector,
      help:finding.explanation,description:finding.explanation,bounds:null,
    }));
    for (const location of [...result.issues,...findings]) {
      const key=JSON.stringify([result.path,location.ruleId,location.selector]);
      const existing=grouped.get(key);
      if (existing) { if (existing.stateId) existing.occurrences++; continue; }
      const captured:PanoramaIssue=location;
      grouped.set(key,{item:{...captured,impact:captured.impact ?? 'unknown',html:captured.html ?? '',helpUrl:''},
        path:result.path,stateId:result.stateId,location:captured,occurrences:1});
    }
  }
  // Manual captures are immediately usable while the next project-wide update is pending.
  if (currentInspection?.scoped && currentInspection.stateId) {
    for (const location of currentInspection.findings) {
      const key=JSON.stringify([currentInspection.path,location.ruleId,location.selector]);
      if (!grouped.has(key)) grouped.set(key,{item:{...location,impact:location.impact ?? 'unknown',html:location.html ?? '',helpUrl:''},
        path:currentInspection.path,stateId:currentInspection.stateId,location,occurrences:1});
    }
  }
  const [reviewChanges,setReviewChanges] = useState<Record<string,ReviewDecisions>>({});
  const reviewKey = (scope:string) => 'a11y:review:'+JSON.stringify([account.id,scope]);
  const reviewStorageKey=reviewKey(pageScope);
  const reviewDecisions={...readReviewDecisions(reviewStorageKey),...reviewChanges[reviewStorageKey]};
  if (visibleDiagnostics?.kind==='live' && state && visibleDiagnostics.projectId===state.project.id) {
    const versions=new Map(state.snapshots.map(snapshot=>[snapshot.id,snapshot]));
    for(let parent=versions.get(visibleDiagnostics.version ?? '')?.parent_id;parent;parent=versions.get(parent)?.parent_id) {
      const key=reviewKey(scopeOf({...visibleDiagnostics,version:parent}));
      for(const [id,decision] of Object.entries(reviewChanges[key] ?? readReviewDecisions(key))) {
        if(!reviewDecisions[id])reviewDecisions[id]=decision;
      }
    }
  }
  const reviewProject=visibleDiagnostics?.kind==='live' ? visibleDiagnostics.projectId : undefined;
  const reviewVersion=visibleDiagnostics?.version;
  const reviewPath=visibleDiagnostics?.path;
  useEffect(()=>{
    if(!reviewProject || !reviewVersion || !reviewPath)return;
    const controller=new AbortController();
    const query=new URLSearchParams({version:reviewVersion,page:reviewPath});
    void request<ReviewDecisions>('/api/projects/'+reviewProject+'/issue-reviews?'+query,{signal:controller.signal})
      .then(saved=>{
        if (!controller.signal.aborted) setReviewChanges(previous=>({
          ...previous,[reviewStorageKey]:{...saved,...previous[reviewStorageKey]},
        }));
      }).catch(()=>{});
    return ()=>controller.abort();
  },[reviewProject,reviewVersion,reviewPath,reviewStorageKey]);
  function saveReview(id:string,decision:ReviewDecision) {
    const next={...reviewDecisions,[id]:decision};
    setReviewChanges(previous=>({...previous,[reviewStorageKey]:next}));
    try {localStorage.setItem(reviewStorageKey,JSON.stringify(next));} catch { /* Keep the in-session decision. */ }
    if(reviewProject && reviewVersion && reviewPath) {
      void post('/api/projects/'+reviewProject+'/issue-reviews',{version:reviewVersion,page:reviewPath,id,status:decision.status})
        .catch(()=>setError('审核决定暂存于当前浏览器，未能同步到项目。'));
    }
  }
  const activePage = view==='interactive' && (visibleDiagnostics?.kind==='remote' ||
    visibleDiagnostics?.projectId===state?.project.id && visibleDiagnostics?.version && state?.snapshots.some(item=>item.id===visibleDiagnostics.version)) ? visibleDiagnostics : undefined;
  const inspectedPath = currentInspection?.path ?? entryPath;
  const activePath = activePage?.path ?? (view==='interactive' && !panoramaJump && !pageRequest ? entryPath : inspectedPath);
  const pageKey = activePage?.kind==='live' ? activePage.entry ? entryPath : activePath.split('#')[0] : activePath;
  const matching = [...grouped.entries()];
  type ListedIssue = (typeof matching)[number][1] & {pageOnly?:boolean;locationGroup?:string};
  const byTarget = new Map(matching.filter(([,entry])=>entry.path===pageKey).map(entry=>[JSON.stringify([entry[1].item.ruleId,entry[1].item.selector]),entry]));
  const liveListed:[string,ListedIssue][] = activePage?.status === 'ready'
    ? (activePage.findings ?? []).map(location=>{
      const match = !showingOriginal && activePage.version===diagnosticVersion
        ? (location.selector ? byTarget.get(JSON.stringify([location.ruleId,location.selector])) : undefined)
        : undefined;
      if (match) return [match[0],{...match[1],locationGroup:location.locationGroup}];
      return [location.id,{item:{...location,impact:location.impact ?? 'unknown',html:location.html ?? '',helpUrl:''},
        path:activePath,occurrences:1,pageOnly:true,locationGroup:location.locationGroup}];
    }) : [];
  const liveKeys=new Set(liveListed.map(([id])=>id));
  const listed:[string,ListedIssue][] = activePage?.kind==='remote' || showingOriginal ? liveListed :
    [...liveListed,...matching.filter(([id])=>!liveKeys.has(id))];
  const reviewPage = visibleDiagnostics?.status==='ready' && (
    visibleDiagnostics.kind==='remote' ? Boolean(managedUrl) :
      visibleDiagnostics.projectId===state?.project.id && visibleDiagnostics.version===diagnosticVersion
  ) ? visibleDiagnostics : undefined;
  const confirmedReviewIds = new Map<string,string[]>();
  const pendingKeys = new Set(listed.map(([,entry])=>JSON.stringify([entry.item.ruleId,entry.item.selector])));
  if (reviewPage && !showingOriginal) for (const rule of reviewPage.coverage?.review ?? []) for (const evidence of rule.evidence ?? []) {
    const id=JSON.stringify([rule.id,evidence.selector,evidence.attributes,evidence.missingRefs]);
    const decision=reviewDecisions[id];
    if(decision?.status!=='confirmed')continue;
    const supported = reviewPage.entry ? state?.current?.detection?.behavior.findings.map(reviewRepairIssue)
      .find(item=>item?.selector===evidence.selector && (evidence.missingRefs.length ? item.ruleId==='aria-broken-idref' : item.ruleId==='focus-style-unchanged')) : undefined;
    const item=supported ?? decision.item ?? {
      id:'review:'+id, ruleId:rule.id, selector:evidence.selector, help:rule.help,
      description:evidence.missingRefs.length ? '找不到引用目标 '+evidence.missingRefs.join('、')+'。' : rule.help,
      impact:'unknown', html:'', helpUrl:'', bounds:null,
    };
    const issueKey=JSON.stringify([rule.id,item.selector]);
    const repairKey=JSON.stringify([item.ruleId,item.selector]);
    const existing = listed.find(([,entry])=>entry.item.selector===item.selector &&
      (entry.item.ruleId===rule.id || entry.item.ruleId===item.ruleId));
    if (existing || !entryRecords.some(record=>record.issue.id===item.id)) {
      const key=existing?.[1].item.id ?? item.id;
      confirmedReviewIds.set(key,[...(confirmedReviewIds.get(key) ?? []),id]);
    }
    if(pendingKeys.has(issueKey)||pendingKeys.has(repairKey)||entryRecords.some(record=>record.issue.id===item.id))continue;
    pendingKeys.add(issueKey);
    pendingKeys.add(repairKey);
    const canRepair=Boolean(supported && (state?.project.mode!=='react-source' || state.current?.sourceLocations?.[item.selector]));
    listed.push([item.id,{item,path:reviewPage.path,occurrences:1,pageOnly:!canRepair}]);
  }
  const issueTypes=new Map<string,{title:string;count:number}>();
  for(const [,entry] of listed) {
    const current=issueTypes.get(entry.item.ruleId);
    if(current) current.count++;
    else issueTypes.set(entry.item.ruleId,{title:issueTitle(entry.item),count:1});
  }
  const filtered=listed.filter(([,item])=>(ruleFilter==='all' || ruleFilter===item.item.ruleId) &&
    (filter==='all' || (filter==='unknown' ? severityRank(item.item.impact)===4 : filter===item.item.impact)))
    .sort(([,a],[,b])=>severityRank(a.item.impact)-severityRank(b.item.impact));
  function issueGroupKey([id,entry]: [string,ListedIssue]) {
    if (entry.locationGroup) return JSON.stringify([entry.path,entry.locationGroup]);
    const selector = entry.item.selector;
    // Ignore positional indices while retaining the surrounding component path.
    const family = selector.replace(/:nth-(?:last-)?(?:child|of-type)\(\d+\)/g, '');
    const tag = /^<([\w-]+)/.exec(entry.item.html)?.[1];
    return selector && (family !== selector || family.includes(' > '))
      ? JSON.stringify([entry.item.ruleId,entry.item.impact,entry.path,entry.stateId,entry.pageOnly,tag,family])
      : id;
  }
  const issueGroups = new Map<string, typeof filtered>();
  for (const row of filtered) {
    const key = issueGroupKey(row);
    const group = issueGroups.get(key);
    if (group) group.push(row);
    else issueGroups.set(key,[row]);
  }
  const displayedIssues = [...issueGroups.values()];
  const issueGroupCount = new Set(listed.map(issueGroupKey)).size;
  const confirmedSummary = issueGroupCount < listed.length
    ? `${issueGroupCount} 组问题 · ${listed.length} 处`
    : `${listed.length} 个已确认问题`;
  function locateReview(selector: string) {
    if (!activePage || activePage.status !== 'ready') return;
    setPageIssue(undefined);
    setSelection(null);
    setPanoramaIssue(undefined);
    setShowOriginal(false);
    setView('interactive');
    setReviewTarget(previous=>({scope:scopeOf(activePage),target:{id:selector+':'+(Number(previous?.target.id.split(':').at(-1) ?? 0)+1),path:activePage.path,selector}}));
  }
  function selectPageFinding(entry:ListedIssue, group:typeof filtered) {
    setReviewTarget(undefined);
    setDirectTarget(undefined);
    const selectors = [...new Set(group.map(([,member])=>member.item.selector).filter(selector=>selector && selector.length<=2000))].slice(0,300);
    setSelectedLocations(selectors);
    setPageIssue({item:entry.item,scope:pageScope,attempt:(currentPageIssue?.attempt ?? 0)+1,selectors});
    if (managedUrl) return;
    if (entry.pageOnly) {setSelection(null);setPanoramaIssue(undefined);openAssistant(false);}
    else if (entry.location && entry.stateId && diagnosticVersion) {
      setInlineStart(undefined);
      openStateIssue({issue:entry.location,stateId:entry.stateId,version:diagnosticVersion,path:entry.path});
    } else {
      if (state && entry.item.selector) {
        setInlineStart({scope:projectScope,path:entry.path});
        setDirectTarget({project:state.project.id,version:state.project.currentSnapshot,target:{
          id:crypto.randomUUID(),path:entry.path,selector:entry.item.selector,selectors,
        }});
      }
      chooseIssue(entry.item);
    }
  }
  const selectedReviewIds = currentPageIssue ? confirmedReviewIds.get(currentPageIssue.item.id) : undefined;
  const dismissSelectedReview = selectedReviewIds?.length === 1 ? <button type="button" className="secondary"
    disabled={working || Boolean(proposal)} onClick={()=>{
      saveReview(selectedReviewIds[0],{status:'dismissed',at:new Date().toISOString()});
      setPageIssue(undefined);
      setSelection(null);
      setPanoramaIssue(undefined);
      setSelectedLocations([]);
      setControlTab('issues');
    }}>改为不是问题</button> : null;
  const selectedGroup = displayedIssues.find(group => group.length > 1 && group.some(([,entry])=>
    currentPageIssue?.item.selector ? currentPageIssue.item.ruleId === entry.item.ruleId && currentPageIssue.item.selector === entry.item.selector :
      entry.item.id === (panoramaIssue?.item.id ?? issue?.id)));
  const contrastLocations = new Set(selectedGroup?.map(([,entry])=>entry.item.selector) ?? selectedLocations);
  const canGroupContrast = !panoramaContext && state?.project.mode==='snapshot' && issue?.ruleId==='color-contrast' &&
    contrastLocations.has(issue.selector);
  const contrastGroupIds = canGroupContrast
    ? (state.current?.issues ?? []).filter(item=>item.id!==issue.id && item.ruleId===issue.ruleId &&
      item.impact===issue.impact && contrastLocations.has(item.selector)).map(item=>item.id)
    : [];
  const locationPicker = selectedGroup && <label className="issue-location-picker">问题位置
    <select value={selectedGroup.find(([,entry])=>entry.item.selector === (currentPageIssue?.item ?? panoramaIssue?.item ?? issue)?.selector)?.[1].item.id} disabled={working}
      onChange={event=>{
        const entry=selectedGroup.find(([,member])=>member.item.id===event.target.value)?.[1];
        if (entry) selectPageFinding(entry,selectedGroup);
      }}>
      {selectedGroup.map(([key,entry],index)=><option key={key} value={entry.item.id}>第 {index+1} 处，共 {selectedGroup.length} 处</option>)}
    </select>
  </label>;
  const records=pageKey===entryPath && activePage?.kind!=='remote' && (!activePage?.version || activePage.version===diagnosticVersion) ? [...entryRecords] : [];
  for (const verification of state?.verifications ?? []) {
    if (verification.status!=='passed' || !verification.reviewedTarget || !verification.panoramaState) continue;
    const versions=new Map(state?.snapshots.map(item=>[item.id,item]));
    let version=diagnosticVersion;
    while (version && version!==verification.toSnapshot) version=versions.get(version)?.parent_id ?? undefined;
    const repairedPath = currentDiagnostics?.states.find(item=>item.stateId===verification.panoramaState)?.path;
    if (version && repairedPath===pageKey && activePage?.kind!=='remote' && (!activePage?.version || activePage.version===diagnosticVersion) && !listed.some(([,item])=>item.stateId===verification.panoramaState && item.item.id===verification.reviewedTarget?.id)) {
      records.push({issue:verification.reviewedTarget,verification});
    }
  }

  return <div className={collapsed ? 'app editorial sidebar-collapsed' : 'app editorial'}>
    <a className="skip-link" href="#page-title">跳到主要内容</a>
    <aside className="sidebar">
      <a className="logo" href="/" aria-label="A11y Studio 首页">
        <span className="logomark"><span /><span /><span /><span /></span>
        <span className="logo-text"><strong>A11y Studio</strong><small>ACCESSIBILITY WORKSPACE</small></span>
      </a>
      <nav id="workspace-nav" aria-label="工作空间导航">
        <div className="navlabel">工作空间</div>
        {workspaceViews.map(({id,label,icon:Icon}) => <button key={id} type="button"
          className={'nav' + (page === id ? ' active' : '')} aria-current={page === id ? 'page' : undefined}
          aria-label={label} title={collapsed ? label : undefined} disabled={id !== 'workspace' && (!state || Boolean(managedUrl))} onClick={() => openPage(id)}>
          <Icon size={18} aria-hidden="true" /><span className="nav-text">{label}</span>
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-information">
          <div className="sidebox"><ShieldCheck size={19} /><strong>受控修复</strong><p>审核补丁、复测副本、保留版本。</p></div>
          <div className="local-status"><i />本地工作区</div>
        </div>
        <button type="button" className="sidebar-toggle" aria-expanded={!collapsed} aria-controls="workspace-nav"
          aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'} title={collapsed ? '展开侧边栏' : '折叠侧边栏'} onClick={toggleSidebar}>
          {collapsed ? <ChevronRight size={18} aria-hidden="true" /> : <ChevronLeft size={18} aria-hidden="true" />}
        </button>
      </div>
    </aside>
    <main className={state ? undefined : 'home-page'}>
      <header className="topbar"><div>工作空间 <span>/</span> <b>{state || captureUrl ? activeLabel : '我的项目'}</b></div><div className="topright">{account.isGuest && <span className="account-guest-label">游客模式</span>}<details className="account-menu"><summary>个人菜单</summary>
        <div className="panel"><strong>个人资料</strong><p>{account.name}</p>{!account.isGuest && <p>{account.email}</p>}{account.emailVerified===false && <button className="secondary" type="button" onClick={openVerification}>验证邮箱</button>}
          <button type="button" className="secondary" disabled={signingOut} onClick={()=>{
            setSigningOut(true);
            void signOut().catch(problem=>setError((problem as Error).message)).finally(()=>setSigningOut(false));
          }}>{signingOut?'正在退出…':'退出登录'}</button>
        </div></details></div></header>
      <div className={state ? 'content' + (page === 'workspace' && !managedUrl ? ' workspace-content' : '') : 'content home-content'}>
        {account.isGuest && account.expiresAt && <p className="account-guest-notice">游客项目临时保存，可用至 {new Date(account.expiresAt).toLocaleString('zh-CN')}。 <button
          type="button" className="secondary" disabled={working} onClick={openUpgrade}>保存我的项目 / 注册账号</button></p>}

        <div className={'page-intro' + (state ? page==='workspace' ? ' compact-intro' : '' : ' hero')}>
          <div><div className="eyebrow"><span />A11y Studio · 网页无障碍</div>
            <h1 id="page-title" tabIndex={-1} ref={heading}>{(state || captureUrl) ? page !== 'report' ? '网页无障碍审阅' : activeLabel : '我的项目'}</h1>
            <p>{(captureUrl || state) ? page === 'report' ? '回顾检测覆盖、问题变化和验证证据。' : '在工作台浏览网页，右侧会显示当前页面的检测结果。' : '导入 URL 或上传 ZIP，检测、修复并对比网页版本。'}</p>

          </div>
          {state && !managedUrl && <div className="intro-actions">
            <button className="secondary" disabled={working} onClick={() => { setState(null); rememberProject(null); void loadHome(); resetSelection(); openPage('workspace'); setError(''); setNotice(''); }}><Layers size={15} />切换项目</button>
            <ExportButton route={route} disabled={working} />
          </div>}
        </div>
        {error && <div className="alert error" role="alert" tabIndex={-1} ref={feedback}><Info size={17} /><span>{error}</span>{recovery && <button className="secondary" onClick={recovery.run} disabled={working}>{recovery.label}</button>}
          <button onClick={() => { setError(''); setRecovery(undefined); }} aria-label="关闭错误提示"><X size={16} /></button></div>}
        {notice && <div className="alert success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="关闭操作提示"><X size={16} /></button></div>}
        {busy && <div className="busy"><span role="status"><LoaderCircle className="spin" size={16} />{busy}</span>{jobId && <button className="cancel-job" disabled={cancelRequested} onClick={() => void cancelJob()}>{cancelRequested ? '正在取消…' : '取消任务'}</button>}</div>}

        {managedUrl && <section className="workspace-view" aria-label="诊断工作区">
          <div className="workbench">
            <div className="workbench-controls panel">
              <header className="review-rail-heading"><div><span>当前页面</span><h2>检测问题</h2></div>
                <span className="review-rail-count">{activePage?.status === 'ready' ? confirmedSummary : activePage?.status === 'failed' ? '未完成检测' : '检测中'}</span></header>
              <PageDiagnosticStatus result={activePage} onRetry={()=>setManagedScanRevision(value=>value+1)} />
              {currentPageIssue && locationPicker}
              {currentPageIssue && activePage && <PageIssueDetails item={currentPageIssue.item} busy={working} grouped={Boolean(selectedGroup)}
                onLocate={()=>setPageIssue({...currentPageIssue,attempt:currentPageIssue.attempt+1})}
                onRepair={()=>repairCapturedIssue(currentPageIssue,activePage.path)} />}
              {dismissSelectedReview}
              <div className="issue-list" role="region" aria-label="待处理问题">
                {displayedIssues.map(group=>{
                  const [key,entry]=group[0];
                  return <IssueButton key={key} issue={entry.item} disabled={working} locations={group.length}
                    active={group.some(([,member])=>currentPageIssue?.item.id===member.item.id)}
                    onClick={()=>selectPageFinding(entry,group)} />;
                })}
                <PageDiagnosticReview key={pageScope} result={activePage} onLocate={locateReview} decisions={reviewDecisions} onDecision={saveReview} behavior={activePage?.entry && activePage.version === state?.project.currentSnapshot ? state?.current?.detection?.behavior : undefined} scan={activePage?.entry && activePage.version === state?.project.currentSnapshot ? state?.current : undefined} />
              </div>
            </div>
            <div className="evidence-column evidence-column-flow">
              <ManagedBrowserCapture key={managedUrl} ref={managedCapture} initialUrl={managedUrl} active onDiagnostics={setVisibleDiagnostics}
                target={pageTarget} scanRevision={managedScanRevision} diagnosticsCache={managedPageCache.current}
                closeLabel={linkPreview ? '返回修复版本' : undefined}
                onClose={linkPreview ? closeLinkPreview : closeManagedUrlCapture} onCaptured={openProject} />
            </div>
          </div>
        </section>}
        {!state ? !managedUrl && <Home fixtures={fixtures} projects={projects} busy={working} onCreate={createProject} onUrlCapture={openManagedUrlCapture} onOpen={openProject} onManage={manageProject} onError={setError} /> :
          <>
          {page === 'report' && <Report key={scanRevision} state={state} busy={working} onOpen={(item) => chooseHistory(item, 'interactive', true, true)} onWorkspace={() => openPage('workspace')} onExploreIssue={openStateIssue} />}
          <section className="workspace-view" hidden={page === 'report' || Boolean(managedUrl)} data-entry-audited={Boolean(state.current)} aria-label="诊断工作区">
            <div className="project-strip">

              <div className="project-title"><b title={state.project.name}>{state.project.name}</b></div>
              <button className="secondary" onClick={scanCurrentPage} disabled={working || activePage?.status==='pending' || (scanning && !activePage)}>重新检测</button>
            </div>

            {scanning && <div className="diagnostic-status"><span role="status">正在检查网站</span>
              <button className="secondary" onClick={()=>void post('/api/jobs/'+diagnosticJob?.id+'/cancel').catch(error=>setError(error.message))}>取消检测</button></div>}
            {(scanConnectionError || diagnosticJob?.status==='failed' || diagnosticJob?.status==='cancelled') && <div className="diagnostic-status" role="alert">
              {scanConnectionError ? '无法读取检测进度。' : diagnosticJob?.status==='cancelled' ? '检测已取消，已发现的问题仍可查看。' : diagnosticJob?.error || '检测未完成。'}
              <button className="secondary" disabled={working} onClick={scanAgain}>重试检测</button>
            </div>}

            {Boolean(state.current?.resourceFailures?.length) && <details className="panel import-resource-warning" open>

              <summary>部分页面资源未加载</summary>
              <ul>{state.current!.resourceFailures!.map(item => <li key={item.type + item.path}>
                <code>{item.path}</code>{item.status ? ` · HTTP ${item.status}` : ''} · {item.reason}
              </li>)}</ul>
              <p>若只上传了 HTML，请将原来的图片和 CSS 按原目录与 HTML 一起压缩为 ZIP 后重新导入。</p>
            </details>}
            <div className="workbench">
              <div className="workbench-controls panel">
                <header className="review-rail-heading"><h2>问题与修复</h2>
                  <span className="review-rail-count">{activePage?.status === 'failed' ? '未完成检测' : activePage?.status === 'pending' ? '检测中' : activePage ? confirmedSummary : `${listed.length} 个问题`}</span>
                </header>
                {activePage?.status === 'failed' && <div className="diagnostic-status" role="alert">
                  {activePage.error || '当前网页尚未打开。'}
                  {activePage.path && <button type="button" className="secondary" onClick={scanCurrentPage}>重试检测</button>}
                </div>}
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
                    <button aria-pressed={list === 'open'} disabled={working} onClick={() => selectList('open')}>待处理 {(!activePage || activePage.status==='ready') && <span>{issueGroupCount}</span>}</button>
                    <button aria-pressed={list === 'history'} disabled={working} onClick={() => selectList('history')}>已解决 <span>{records.length}</span></button>
                  </div>
                  {list === 'open' && listed.length > 0 && <div className="issue-filters"><div className="filter-row"><label htmlFor="severity-filter">严重程度</label>
                    <select id="severity-filter" value={filter} onChange={event => setFilter(event.target.value)}>
                      <option value="all">全部</option>
                      {Object.entries(impactName).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                    </select>
                  </div>
                  <div className="filter-row"><label htmlFor="rule-filter">问题类型</label>
                    <select id="rule-filter" disabled={issueTypes.size <= 1} value={ruleFilter} onChange={event=>setRuleFilter(event.target.value)}>
                      <option value="all">全部类型</option>{[...issueTypes].map(([id,item])=><option key={id} value={id}>{item.title}（{item.count}）</option>)}
                    </select></div></div>}
                  <div className="issue-list" role="region" aria-label={list === 'open' ? '待处理问题' : '已解决问题'}>
                    {list === 'open' ? displayedIssues.length ? displayedIssues.map(group => {
                      const [key,entry]=group[0];
                      return <IssueButton key={key} issue={entry.item} path={entry.path} occurrences={entry.occurrences}
                        locations={group.length} disabled={working}
                        active={group.some(([,member])=>currentPageIssue?.item.selector ? currentPageIssue.item.ruleId===member.item.ruleId && currentPageIssue.item.selector===member.item.selector : member.item.id===(panoramaIssue?.item.id ?? issue?.id))}
                        onClick={()=>selectPageFinding(entry,group)} />;
                    }) : <Blank icon={activePage?.status==='failed' ? <Info /> : activePage?.status==='pending' ? <LoaderCircle className="spin" /> : <CheckCircle2 />} title={activePage?.status==='pending' ? '正在检测当前页面' : activePage?.status==='failed' ? '当前页面检测失败' : scanning && !activePage ? '正在检查当前页面' : listed.length ? '没有匹配的问题' : !state.current && !activePage ? '当前版本尚未重新检测' : '当前无待处理问题'}>
                      {scanning ? '发现的问题会陆续显示。' : listed.length ? '请选择其他筛选条件。' : null}
                    </Blank> : records.length ? records.map(item =>
                      <IssueButton key={item.verification.id + item.issue.id} issue={item.issue}
                        active={history?.verification.id === item.verification.id && history.issue.id === item.issue.id}
                        disabled={working} resolved
                        onClick={() => chooseHistory(item)} />,
                    ) : <Blank icon={<History />} title="当前版本暂无已解决问题">此处显示当前版本包含且通过复测的修复。</Blank>}
                    {list === 'open' && !state.current && workingIssues.length > 0 && <p className="muted note">其余问题沿用上次检测结果。</p>}
                    {list === 'open' && <PageDiagnosticReview key={pageScope} result={activePage} onLocate={locateReview} decisions={reviewDecisions} onDecision={saveReview} behavior={activePage?.entry && activePage.version === state?.project.currentSnapshot ? state?.current?.detection?.behavior : undefined} scan={activePage?.entry && activePage.version === state?.project.currentSnapshot ? state?.current : undefined} />}
                  </div>
                  {pageKey===entryPath && activePage?.kind!=='remote' && (!activePage?.version || activePage.version===diagnosticVersion) &&
                    <DetectionReview key={state.current?.id} detection={state.current?.detection} aiConfigured={ai.configured} busy={working} onReview={reviewWithAi} onDecision={decideAiFinding} onRepair={chooseIssue} />}
                </div>
                <div className="control-panel" role="tabpanel" id="control-panel-assistant"
                  aria-labelledby="control-tab-assistant" tabIndex={0} ref={assistantPanel} hidden={controlTab !== 'assistant'}>
                  {locationPicker}
                  {dismissSelectedReview}
                  {currentPageIssue && (activePage?.kind==='remote' || !issue && !panoramaIssue) ? <PageIssueDetails item={currentPageIssue.item}
                    onLocate={()=>setPageIssue({...currentPageIssue,attempt:currentPageIssue.attempt+1})} /> : panoramaIssue && !panoramaContext ? <section className="assistant-body" aria-label="状态问题详情">
                    <h3>{panoramaIssue.item.help}</h3><p>{panoramaIssue.item.description}</p>
                    <p><code>{panoramaIssue.item.selector}</code> · 此状态的问题可定位和复核，当前未提供自动源码修复。</p>
                  </section> : <Assistant issue={issue} stateScoped={Boolean(panoramaContext)} history={history} knowledge={knowledge} ai={ai.configured}
                    contrastGroupSize={contrastGroupIds.length ? contrastGroupIds.length+1 : 0}
                    unmatchedContrastLocations={canGroupContrast ? Math.max(0,contrastLocations.size-contrastGroupIds.length-1) : 0}
                    singleLocation={Boolean(draft?.singleLocation)}
                    onSingleLocation={singleLocation=>updateDraft({singleLocation,proposal:null,prepared:undefined})} visionReady={ai.visionConfigured} busy={working} proposal={proposal} analysis={draft?.analysis} purpose={draft?.purpose} onPurpose={chooseImagePurpose}
                    previewUrl={issue?.ruleId === 'image-alt' ? route + '/issues/' + encodeURIComponent(issue.id) +
                      '/image-preview?snapshot=' + encodeURIComponent(state.project.currentSnapshot) : undefined}
                    input={input} onInput={value => updateDraft({ value, edited: true })} onPropose={propose} onShowPatch={showPatch} prepared={draft?.prepared} />}
                </div>
              </div>
              <div className="evidence-column" role="group" tabIndex={-1} ref={evidenceFocus} aria-label="网页交互与修复">
                <Evidence state={state} interactive={page === 'workspace' ? renderInteractivePage : undefined} autoScanning={scanning} pair={pair} pageRequest={pageRequest}
                  visiblePagePath={activePage?.kind==='live' ? activePage.path.split(/[?#]/)[0] : undefined}
                  onChoosePage={state.browserCapture ? undefined : path=>{
                    if (!/\.html?$/i.test(path) || view!=='interactive') return;
                    setSelection(null);
                    setPanoramaIssue(undefined);
                    setPageIssue(undefined);
                    setSelectedLocations([]);
                    setPanoramaJump(undefined);
                    setInlineStart({scope:projectScope,path});
                  }} jump={panoramaJump} onInspection={setInspection} stateScoped={Boolean(panoramaIssue)} issue={issue} history={history} proposal={proposal} view={view} onView={changeEvidenceView} problem={(history?.issue ?? issue) ? issueTitle((history?.issue ?? issue)!) : '当前问题'}
                  impact={issueNames[(history?.issue ?? issue)?.ruleId ?? '']?.[1] ?? (history?.issue ?? issue)?.description ?? '需核对目标元素。'}
                  busy={working} applying={busy === applyingLabel} archivedEvidence={archivedEvidence}
                  patchReady={patchReady}
                  versionToggle={showHistoryToggle ? renderVersionToggle() : undefined} onConfirm={apply} onReject={reject} />
              </div>
            </div>
            <div className="bottom-note"><ShieldCheck size={16} /><span>补丁保存为独立版本，可重新检测或回退。</span><button onClick={() => openPage('report')}>查看完整报告 <ArrowRight size={14} /></button></div>
          </section></>}
        <footer><span>A11y Studio · 网页无障碍工作区</span><span>基于 Chromium 和 axe-core</span></footer>
      </div>
    </main>
  </div>;
}

function PageDiagnosticStatus({result,onRetry}:{result?:WorkspacePageDiagnostics;onRetry:()=>void}) {
  if (!result) return <p className="workspace-page-status" role="status">正在加载当前页面…</p>;
  return <div className="workspace-page-status" role={result.status==='failed' ? 'alert' : 'status'}>
    <p title={result.path}>{result.title || result.path}</p>
    {result.status==='pending' && <span>正在检测当前页面…</span>}
    {result.status==='ready' && <>
      <span>{result.coverage?.stillLoading ? '已检测当前内容，页面可能仍在加载。' :
        result.findings?.length ? '已完成当前页面自动检测' : '自动检测暂未确认问题'}</span>
      {result.kind==='remote' && <div className="workspace-page-rescan">
        <span>滚动加载内容或打开弹窗后，可重新检测。</span>
        <button type="button" className="secondary" onClick={onRetry}>重新检测当前页面</button>
      </div>}
    </>}
    {result.status==='failed' && <><span>{result.error || '当前网页尚未打开。'}</span>
      {result.error && result.path && <button type="button" className="secondary" onClick={onRetry}>重试检测</button>}</>}
  </div>;
}

function PageDiagnosticReview({result,onLocate,decisions,onDecision,behavior,scan}:{
  result?:WorkspacePageDiagnostics; onLocate:(selector:string)=>void; decisions:ReviewDecisions; onDecision:(id:string,decision:ReviewDecision)=>void;
  behavior?: NonNullable<NonNullable<State['current']>['detection']>['behavior']; scan?:State['current'];
}) {
  if (result?.status !== 'ready' || !result.coverage) return null;
  const {review,bestPractices} = result.coverage;
  return <div className="workspace-page-review">
    {[{label:'待人工复核',rules:review,manual:true},{label:'可选优化建议',rules:bestPractices,manual:false}].map(({label,rules,manual})=>{
      const entries=rules.flatMap(rule=>(rule.evidence ?? []).map(entry=>({rule,entry,
        id:JSON.stringify([rule.id,entry.selector,entry.attributes,entry.missingRefs])})));
      const pending=entries.filter(({id})=>!decisions[id]);
      if (!entries.length) return null;
      const render=({rule,entry,id}:typeof entries[number])=>{
        const tabindex=rule.id==='tabindex';
        const tab=tabindex ? behavior?.findings.find(item=>item.ruleId==='focus-order-positive-tabindex' && item.selector===entry.selector) : undefined;
        const repair=manual ? behavior?.findings.filter(item=>entry.missingRefs.length ? item.ruleId==='aria-broken-idref' : rule.id.includes('focus') && item.ruleId==='focus-style-unchanged').map(reviewRepairIssue)
          .find(item=>item?.selector===entry.selector) : undefined;
        const decision=decisions[id]?.status;
        const source=scan?.sourceLocations?.[entry.selector];
        const sourceCandidates=scan?.reviewSourceCandidates?.[entry.selector];
        return <li key={id} className="workspace-review-evidence">
          <b>{tabindex ? 'Tab 顺序建议' : issueNames[rule.id]?.[0] ?? rule.help}</b>
          <p><b>问题</b> · <code>{entry.element} · {entry.selector}</code>{entry.attributes.length ? ' · '+entry.attributes.join(' · ') : ''}</p>
          <p><b>原因</b> · {entry.missingRefs.length ? '找不到引用目标 '+entry.missingRefs.join('、')+'。'
            : tab ? `实际 Tab 第 ${tab.evidence.tabPosition} 步提前到达此控件，跳过了文档中更靠前的 ${tab.evidence.overtakenSelector}。`
            : tabindex ? '正数 tabindex 会优先获得焦点，当前证据未确认顺序异常。' : '自动检测尚未确认此元素对实际使用的影响。'}</p>
          <p><b>建议</b> · {entry.missingRefs.length ? '把引用改为实际标签或说明的 ID；无关联内容时移除该引用。'
            : tabindex ? '用 Tab 核对焦点顺序；若不符合阅读顺序，调整 DOM 并移除正数 tabindex。'
            : '定位元素，核对属性是否与控件的实际用途一致。'}</p>
          {source && <p>源码 · {source.file}:{source.line}</p>}
          {!!sourceCandidates?.length && <details><summary>候选源码位置</summary>{sourceCandidates.map(candidate=>
            <p key={candidate.file+':'+candidate.line}><code>{candidate.file}:{candidate.line}</code> · {candidate.reason}</p>)}</details>}
          <button type="button" className="secondary" onClick={()=>onLocate(entry.selector)}>定位元素</button>
          {manual && !decision && <><button type="button" className="secondary" onClick={()=>{onDecision(id,{status:'confirmed',at:new Date().toISOString(),item:repair});}}>确认存在问题</button>
            <button type="button" className="secondary" onClick={()=>onDecision(id,{status:'dismissed',at:new Date().toISOString()})}>不是问题</button></>}
          {decision==='confirmed' && <><small>已确认</small>
            <button type="button" className="secondary" onClick={()=>onDecision(id,{status:'dismissed',at:new Date().toISOString()})}>改为不是问题</button></>}
          {decision==='dismissed' && <small>已标记为不是问题</small>}
          {decision && <small> · {dateText(decisions[id].at)}</small>}
        </li>;
      };
      return <details key={label}><summary>{label} · {pending.length} 处</summary>
        <ul>{pending.map(render)}</ul>
        {manual && entries.length > pending.length && <details><summary>审核记录 · {entries.length-pending.length} 处</summary>
          <ul>{entries.filter(({id})=>decisions[id]).map(render)}</ul></details>}
      </details>;
    })}
  </div>;
}

function PageIssueDetails({item,onLocate,onRepair,busy,grouped}:{item:Issue;onLocate:()=>void;onRepair?:()=>void;busy?:boolean;grouped?:boolean}) {
  const repairable = Boolean(item.selector && repairableIssueNames.has(item.ruleId));
  return <section className="assistant-body" aria-label="当前页面问题详情">
    <h3>{issueTitle(item)}</h3>
    <p>{issueNames[item.ruleId]?.[1] ?? item.description}</p>
    <div className="repair-actions">
      {repairable && onRepair && <button type="button" className="button dark" disabled={busy} onClick={onRepair}>{grouped ? '修复所选位置' : '修复此问题'}</button>}
      {item.selector && <button type="button" className="secondary" disabled={busy} onClick={onLocate}>{grouped ? '在网页中标出整组' : '在网页中定位'}</button>}
    </div>
    {onRepair && <p className="muted note">{repairable ? '保存当前网页的修复副本后，将打开这条问题的修复助手。'
      : '这条问题需要人工处理，可使用定位查看。'}</p>}
  </section>;
}

function Blank({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="blank">{icon}<b>{title}</b><p>{children}</p></div>;
}

function Home({ fixtures, projects, busy, onCreate, onUrlCapture, onOpen, onManage, onError }: {
  fixtures: Fixture[]; projects: Project[]; busy: boolean;
  onCreate: (data: FormData) => void; onUrlCapture:(url:string)=>void; onOpen: (id: string) => void; onManage:(id:string,change:{name:string}|{confirm:true})=>Promise<void>; onError: (error: string) => void;
}) {
  const [manage,setManage]=useState<{project:Project;remove:boolean}>();
  const [source, setSource] = useState<Source>('zip');
  const [url, setUrl] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  function chooseFile(file: File) {

    if (busy) return;
    if (!/\.zip$/i.test(file.name)) return onError('请选择网页或源码工程 ZIP 文件。');
    if (file.size > 8 * 1024 * 1024) return onError('文件不能超过 8 MB。');
    const data = new FormData();
    data.set('file', file);
    data.set('mode','auto');

    onCreate(data);
  }

  function submitUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy) {
      try {onUrlCapture(normalizeCaptureUrl(url));} catch(error){onError((error as Error).message);}
    }
  }

  return <div className="onboarding">
    <section className="import-card" aria-labelledby="import-title">
      <div className="card-heading"><div><span className="section-tag">NEW PROJECT</span><h2 id="import-title">导入网页项目</h2><p>选择你拥有或获准检测的网页。</p></div><span className="section-icon"><FileUp size={20} /></span></div>
      <div className="evidence-tabs import-tabs" role="group" aria-label="网页导入方式">

        <button aria-pressed={source === 'zip'} disabled={busy} onClick={() => setSource('zip')}><FileArchive size={16} />ZIP</button>
        <button aria-pressed={source === 'url'} disabled={busy} onClick={() => setSource('url')}><Link2 size={16} />URL</button>

      </div>
      {source === 'url' ? <form className="url-form managed-url-form" onSubmit={submitUrl}>
        <label htmlFor="page-url">网页地址</label>
        <input id="page-url" type="text" inputMode="url" placeholder="https://example.com/page" value={url} maxLength={2048} required disabled={busy} onChange={event => setUrl(event.target.value)} aria-describedby="url-scope" />
        <p id="url-scope">进入诊断工作台，浏览网页并自动检测当前页面。</p>
        <button className="button dark" disabled={busy}>打开采集浏览器 <ArrowRight size={15} /></button>
      </form> : <div className="dropzone" onDragOver={event => event.preventDefault()} onDrop={event => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) chooseFile(file);
      }}>
        <div className="upload-icon"><FileUp size={24} /></div>

        <b>上传网页或源码工程 ZIP</b>
        <span>支持静态网页和基础 React + Vite 工程，单个 HTML 请先压缩为 ZIP · 可拖放 · 最大 8 MB</span>
        <input ref={fileInput} type="file" accept=".zip" hidden onChange={event => {

          const file = event.target.files?.[0];
          if (file) chooseFile(file);
          event.target.value = '';
        }} />
        <button className="button dark" disabled={busy} onClick={() => fileInput.current?.click()}>选择文件 <ArrowRight size={15} /></button>
      </div>}

      <div className="import-note"><LockKeyhole size={15} />{source === 'url' ? 'URL 会在服务端隔离 Chromium 中打开；所有网页请求经过公网地址校验。登录信息只在采集会话中保留，结束后自动清除。在工作台内浏览、检测和修复。' : '静态网页自带脚本不会执行；React 工程使用固定构建工具，不运行项目安装脚本或构建配置。'}</div>

    </section>
    <section className="examples" aria-labelledby="example-projects-title">
      <div className="section-title"><div><span className="section-tag">DEMO PROJECTS</span><h2 id="example-projects-title">从示例开始</h2></div></div>
      <div className="example-list">{fixtures.map((fixture, index) => <button key={fixture.id} className="example-card" disabled={busy} onClick={() => {
        const form = new FormData();
        form.set('fixture', fixture.id);
        onCreate(form);
      }}><span className="example-number" aria-hidden="true">{String(index + 1).padStart(2,'0')}</span><span><b>{fixture.name}</b><small>{fixture.description}</small></span><ArrowUpRight size={17} aria-hidden="true" /></button>)}</div>
      <div className="section-title recent-title">
        <h2 id="recent-projects-title">我的项目列表</h2>
        {projects.length > 0 && <span className="muted">{projects.length} 个项目</span>}
      </div>
      {projects.length ? <div className="recent-projects-scroll" role="region" aria-labelledby="recent-projects-title" tabIndex={0}>
        <ul className="recent-list">
          {projects.map(project => <li key={project.id} className="account-project-row">
            <button type="button" className="account-project-open" aria-label={project.name} aria-describedby={'project-meta-'+project.id}
              onClick={() => onOpen(project.id)} disabled={busy}>
              <span className="example-number" aria-hidden="true"><FileCode2 size={16} /></span>
              <span className="account-project-title"><b>{project.name}</b>
                <small id={'project-meta-'+project.id}>{project.mode==='react-source'?'React 源码':project.mode==='static-source'?'静态源码':'网页快照'}
                  {' · '+({completed:'检测完成',running:'检测中',failed:'检测失败',queued:'等待检测'}[project.scanStatus??'']??'未检测')}</small>
                {project.updatedAt && <small>最近更新 {dateText(project.updatedAt)}</small>}</span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
            <div className="account-project-actions">
              <button type="button" disabled={busy} aria-label={'重命名 '+project.name} onClick={()=>setManage({project,remove:false})}>重命名</button>
              <button type="button" disabled={busy} aria-label={'删除 '+project.name} onClick={()=>setManage({project,remove:true})}>删除</button>
            </div>
          </li>)}
        </ul>
      </div> : <p className="muted">暂无项目。可导入网页或从示例创建。</p>}
      {manage && <ManageProjectDialog project={manage.project} remove={manage.remove}
        onClose={()=>setManage(undefined)} onSave={onManage} />}
    </section>
    <section className="steps" aria-label="修复流程">
      <div><ScanSearch /><span>01</span><b>发现问题</b><small>运行真实扫描，定位页面元素</small></div>
      <div><Sparkles /><span>02</span><b>审核修复</b><small>查看规范、建议和实际源码差异</small></div>
      <div><ShieldCheck /><span>03</span><b>验证结果</b><small>复测、比较证据并导出报告</small></div>
    </section>
  </div>;
}

function ManageProjectDialog({project,remove,onClose,onSave}:{project:Project;remove:boolean;onClose:()=>void;
  onSave:(id:string,change:{name:string}|{confirm:true})=>Promise<void>}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const running=useRef(false);
  const [name,setName]=useState(project.name);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{dialog.current?.showModal();},[]);
  function close() {dialog.current?.close();onClose();}
  async function submit(event:FormEvent) {
    event.preventDefault();
    if (running.current) return;
    running.current=true;
    setBusy(true);
    setError('');
    try {
      await onSave(project.id,remove?{confirm:true}:{name});
      close();
    } catch (problem) {setError((problem as Error).message);}
    finally {running.current=false;setBusy(false);}
  }
  return <dialog ref={dialog} className="account-upgrade-dialog" aria-labelledby="manage-project-title"
    onCancel={event=>{event.preventDefault();if (!running.current) close();}}>
    <form className="panel account-card" onSubmit={submit} aria-busy={busy}>
      <h2 id="manage-project-title">{remove?'删除项目':'重命名项目'}</h2>
      {remove ? <p>永久删除「{project.name}」及其版本、修复记录和文件？此操作无法撤销。</p>
        : <label>项目名称<input required value={name} onChange={event=>setName(event.target.value)} /></label>}
      {error && <p className="account-error" role="alert">{error}</p>}
      <div className="account-entry-actions">
        <button className="secondary" type="button" disabled={busy} onClick={close}>取消</button>
        <button className={remove?'secondary account-error':'button dark'} disabled={busy} type="submit">{remove?'永久删除':'保存名称'}</button>
      </div>
    </form>
  </dialog>;
}

function IssueButton({ issue, active, resolved, disabled, onClick, path, occurrences, locations }: {
  issue: Issue; active: boolean; resolved?: boolean; path?:string; occurrences?:number; locations?:number; disabled: boolean; onClick: () => void;
}) {
  return <button className={'issue ' + (active ? 'selected' : '')} aria-pressed={active} disabled={disabled} onClick={onClick}>
    <span className={'issue-dot' + (resolved ? ' fixed' : '')} aria-hidden="true">{resolved ? <Check size={16} /> : '!'}</span>
    <span className="issue-summary"><b>{issueTitle(issue)}</b>
      <em className={'severity ' + (resolved ? 'fixed' : issue.impact)}>{impactName[issue.impact] ?? '待复核'}</em>
      <small title={issue.selector}>{resolved ? '查看修复记录' : locations && locations>1 ? `影响 ${locations} 处 · 可逐处查看` : path && path!=='/index.html' ? `页面 ${path}` : '点击查看影响与修复建议'}{occurrences && occurrences>1 ? ' · '+occurrences+' 个状态' : ''}</small></span><ChevronRight size={15} />
  </button>;
}

function ImagePreview({ url }: { url: string }) {
  const [preview, setPreview] = useState<{src?:string; error?:string}>();
  useEffect(() => {
    const controller = new AbortController();
    let imageUrl: string | undefined;
    void fetch(url,{signal:controller.signal}).then(async response => {
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? `视觉证据缺失：预览请求返回 HTTP ${response.status}。`);
      }
      const pixels = await response.blob();
      if (!controller.signal.aborted) {
        imageUrl = URL.createObjectURL(pixels);
        setPreview({src:imageUrl});
      }
    }).catch((error:Error) => {
      if (!controller.signal.aborted) setPreview({error:error.message});
    });
    return () => {
      controller.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [url]);
  return <div className="detail-block image-preview">
    <h4>目标图片预览</h4>
    {preview?.error ? <p role="status">{preview.error}</p> : preview?.src
      ? <img src={preview.src} alt="待修复的目标图片" onError={() => setPreview({error:'视觉证据缺失：浏览器无法解码预览图片。'})} />
      : <p role="status">正在读取图片像素…</p>}
  </div>;
}

function downloadHighContrastImage(content: string) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return;
  const padding = 32;
  const lineHeight = 44;
  const font = '28px system-ui, sans-serif';
  context.font = font;
  const lines = content.split(/\r?\n/).flatMap(paragraph => {
    const wrapped: string[] = [];
    let line = '';
    for (const character of new Intl.Segmenter().segment(paragraph)) {
      if (line && context.measureText(line + character.segment).width > 800) {
        wrapped.push(line);
        line = '';
      }
      line += character.segment;
    }
    return [...wrapped, line];
  });
  canvas.width = Math.ceil(Math.max(1, ...lines.map(line => context.measureText(line).width))) + padding * 2;
  canvas.height = lines.length * lineHeight + padding * 2;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = font;
  context.fillStyle = '#111';
  context.textBaseline = 'middle';
  lines.forEach((line, index) => context.fillText(line, padding, padding + (index + 0.5) * lineHeight));
  const download = document.createElement('a');
  download.href = canvas.toDataURL('image/png');
  download.download = 'high-contrast-text.png';
  download.click();
}

function Assistant({ issue, contrastGroupSize, unmatchedContrastLocations, singleLocation, onSingleLocation, stateScoped, history, knowledge, ai, visionReady, busy, proposal, analysis, purpose, onPurpose, previewUrl, input, onInput, onPropose, onShowPatch, prepared }: {
  contrastGroupSize: number; unmatchedContrastLocations: number; singleLocation: boolean; onSingleLocation: (single: boolean) => void;
  issue?: Issue; stateScoped: boolean; history?: HistoryItem; knowledge: Knowledge | null; ai: boolean; visionReady: boolean; busy: boolean;
  proposal: Proposal | null; analysis?: ImageAltAnalysis | RepairAnalysis; purpose?: ImagePurpose;
  onPurpose: (purpose: ImagePurpose) => void; previewUrl?: string; input: string; onInput: (value: string) => void;
  onPropose: (source: 'agent' | 'manual', value?: string) => void;
  prepared?: Proposal;
  onShowPatch: () => void;
}) {
  const target = history?.issue ?? issue;
  const verification = history?.verification;
  const isImageAlt = target?.ruleId === 'image-alt';
  const isColor = target?.ruleId === 'color-contrast';
  const chosenColor = /^#[0-9a-f]{6}$/i.test(input) ? input : '';
  const groupColors = new Set(proposal?.patch.contrastTargets?.map(target=>target.value));
  const previewHint = isImageAlt && (!purpose
    ? '请先选择内容性图片或装饰性图片，再生成补丁预览。'
    : purpose === 'informative' && !input.trim()
      ? '请填写非空替代文本，再生成补丁预览。'
      : '');
  const agentOnly = target?.ruleId === 'focus-style-unchanged' || target?.ruleId === 'aria-valid-attr-value' || target?.ruleId === 'aria-broken-idref';
  const trace = proposal?.agentTrace ?? (analysis && 'agentTrace' in analysis ? analysis.agentTrace : undefined);
  const refs = verification?.wcag ?? proposal?.wcag ?? knowledge?.refs ?? target?.wcag ?? [];
  const imageAnalysis = analysis && 'purpose' in analysis ? analysis : undefined;
  const agentRun = analysis && 'agentRun' in analysis ? analysis.agentRun : undefined;
  const sources = analysis?.sources ?? proposal?.sources;
  const labelDecision = analysis && 'labelDecision' in analysis ? analysis.labelDecision : undefined;
  const linkDecision = analysis && 'linkDecision' in analysis ? analysis.linkDecision : undefined;
  const nameDecision = labelDecision ?? linkDecision;
  const suggested = imageAnalysis?.contentAlt ?? (analysis && 'suggestedValue' in analysis ? analysis.suggestedValue : null);
  const problem = target && (issueNames[target.ruleId]?.[1] ?? target.description);
  const copy = analysis && 'copy' in analysis ? analysis.copy : undefined;
  const brief = (value?: string) => value?.split(/(?<=[。！？；])|\n/).map(part=>part.trim())
    .find(part=>part.length > 0 && part.length <= 64);
  const suggestion = imageAnalysis?.purpose === 'decorative' ? '装饰图片使用空 alt。'
    : isColor && suggested ? '将文字颜色调整为 ' + suggested + '，并复测对比度。'
    : copy?.suggestion || (suggested && brief('建议值为「' + suggested + '」。')) ||
      (nameDecision === 'needs-input' ? (linkDecision ? '请填写链接实际用途。' : '请填写字段用途。')
        : brief(analysis?.reason) || (analysis ? '请展开详细依据，核对建议后再继续。' : '可先分析问题，再审核修复建议。'));
  return <>
    {!history && <div className="assistant-toolbar">
      <span className="ai-pill"><Sparkles size={13} />{isImageAlt ? (visionReady ? '视觉 AI 已配置' : '视觉 AI 未配置') : (ai ? 'AI 已配置' : 'AI 未配置')}</span>
      {issue && repairableIssueNames.has(issue.ruleId) && !agentOnly && !busy && <a href="#repair-value">前往修复操作</a>}
    </div>}
    {target ? <div className="assistant-body repair-assistant-body">
      <div className="issue-heading"><span className={'issue-dot' + (history ? ' fixed' : '')} aria-hidden="true">{history ? <Check size={16} /> : '!'}</span><div><h3>{issueTitle(target)}</h3><span>{target.ruleId} · {impactName[target.impact] ?? target.impact}</span></div></div>
      {target.source && <p className="muted note">组件源码 <code>{target.source.file} · 第 {target.source.line} 行</code></p>}
      <dl className="repair-copy" aria-live="polite">
        <dt>问题</dt><dd>{copy?.problem || issueTitle(target)}</dd>
        <dt>原因</dt><dd>{copy?.cause || brief(problem) || (refs.length ? '未满足 WCAG ' + refs.join('、') + ' 的要求。' : '此项需要核对网页的实际使用体验。')}</dd>
        <dt>建议</dt><dd>{suggestion}</dd>
      </dl>
      {imageAnalysis?.legibility && <section className="image-legibility-review" aria-label="图片可读性建议">
        <h4>图片可读性 · 待人工复核</h4>
        <p>{imageAnalysis.legibility.observation}</p>
        <p>{imageAnalysis.legibility.recommendation}</p>
        {imageAnalysis.legibility.textOnly && <figure>
          <figcaption>高对比文字预览 · 请核对原图</figcaption>
          <p>{imageAnalysis.legibility.textOnly}</p>
          <button type="button" className="secondary" onClick={() => {
            const recognizedText = imageAnalysis.legibility?.textOnly;
            if (recognizedText) downloadHighContrastImage(recognizedText);
          }}>下载高对比 PNG</button>
        </figure>}
      </section>}
      <details className="detail-block">
        <summary>查看详细依据</summary>
        {ai && !history && <p>AI 分析会向模型服务发送相关页面文本，图片或图标分析还可能发送局部图片。请确认内容适合发送。</p>}
        {analysis?.reason && <p>{analysis.reason}</p>}
        {target.selector && <p>元素定位 <code>{target.selector}</code></p>}
        {agentRun && <p>模型请求 {agentRun.usage.requests} 次 · 候选验证 {agentRun.attempts} 次 · 输入 {agentRun.usage.inputTokens} / 输出 {agentRun.usage.outputTokens} tokens</p>}
        {imageAnalysis && <p><b>{imageAnalysis.media ? 'AI 图片用途判断' : '图片用途'}：</b>{imagePurposeLabel[imageAnalysis.purpose]}</p>}
        {analysis?.description && <p><b>AI 视觉观察：</b>{analysis.description}</p>}
        {analysis?.detail && <p>{analysis.detail}</p>}
        {analysis?.media && <p>视觉证据：{analysis.media.source} · {analysis.media.format} · {analysis.media.bytes} 字节</p>}
        <h4>{history ? '修复前元素' : '检测证据'}</h4><code>{target.html}</code>
        <h4>规则与 WCAG 依据</h4>
        {refs.length > 0 && <div className="rule-tags">{refs.map(ref => <span key={ref}>{ref}</span>)}</div>}
        <a href={verification?.wcagUrl || proposal?.wcagUrl || knowledge?.url || target.helpUrl} target="_blank" rel="noreferrer">{proposal?.wcagTitle || knowledge?.title || '查看规则与规范说明'} <ArrowUpRight size={12} /></a>
        {(proposal?.guidance || knowledge?.guidance) && <p>{proposal?.guidance || knowledge?.guidance}</p>}
        {sources?.length ? <div><h4>检索到的规范依据</h4><p>以下为规范摘要，请结合原文及实际页面确认适用性。</p><ul>{sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title} · {source.refs.join('、')}</a><p>{source.text}</p></li>)}</ul></div> : null}
        {trace && <div><h4>{agentRun?.usage.requests === 0 ? '证据与验证过程' : 'AI 工具与验证过程'}</h4><ol>{trace.map((step, index) => <li key={index}>{step.summary} <code>{step.tool}</code></li>)}</ol></div>}
        {proposal?.risk && <p>{proposal.risk}</p>}
        {proposal && <button type="button" className="secondary" onClick={onShowPatch}>查看完整代码差异</button>}
      </details>
      {verification?.status === 'applied' ? <div className="verification-card"><h4>补丁已应用</h4><p>可使用「重新检测」更新问题状态。</p></div> : verification ? <div className="verification-card">
        <h4><CheckCircle2 size={16} />复测通过</h4>
        <p>{verification.targetFixed ? '已修复，目标问题在复测中消失。' : '已完成复测，请核对结果。'}</p>
        <details className="detail-block"><summary>查看复测详情</summary>
        <p>{verification.reason}</p>
        {!!verification.pendingChecks?.length && <details>
          <summary>待进一步验证</summary>
          <ul>{verification.pendingChecks.map((check,index)=><li key={index}>{check}</li>)}</ul>
        </details>}
        {isImageAlt && <p><b>图片语义审核：</b>{verification.imageReview
          ? '用户已确认 · ' + imagePurposeLabel[verification.imageReview.purpose]
          : '未记录人工确认'}。自动复测只验证规则和页面结构。</p>}
        <ul>
          <li>{verification.patch?.contrastTargets?.length
            ? `修复了 ${verification.patch.contrastTargets.length} 处，复测后均达标`
            : '该问题在修复后扫描中消失'}</li>
          {verification.structurePassed && <li>页面结构检查通过</li>}
          {verification.functionPassed && <li>静态控件与聚焦检查通过</li>}
          <li>新增自动检测问题 {verification.added.length} 项</li>
          {verification.contrastCheck?.valid && <li>{verification.patch?.contrastTargets?.length ? '所选位置' : ''}对比度 {verification.contrastCheck.ratio.toFixed(2)}:1，要求 {verification.contrastCheck.required}:1</li>}
        </ul>
        {verification.sourceChecks && <ul>{verification.sourceChecks.map(check => <li key={check.name}>{check.name} · {check.detail}</li>)}</ul>}
        {verification.proposalReason && <p><b>历史修复方案</b> {verification.proposalReason}</p>}
        {verification.agentTrace && <div><h4>AI 工具调用记录</h4><ol>{verification.agentTrace.map((step, index) => <li key={index}>{step.summary} <code>{step.tool}</code></li>)}</ol></div>}
        {verification.sources && <div><h4>检索依据</h4><ul>{verification.sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title} · {source.refs.join('、')}</a></li>)}</ul></div>}
        <small>{dateText(verification.createdAt)}</small></details>
        {(verification.diff || verification.sourceReview) && <button type="button" className="secondary history-patch" onClick={onShowPatch}>查看历史补丁</button>}
      </div> : repairableIssueNames.has(target.ruleId) ? <>
        {isImageAlt && <>
          {previewUrl && <ImagePreview key={previewUrl} url={previewUrl} />}
          <fieldset disabled={busy} className="image-purpose" aria-describedby={previewHint ? 'repair-preview-hint' : undefined}>
            <legend>图片用途（可修改）</legend>
            <label><input type="radio" name="image-purpose" checked={purpose === 'informative'}
              onChange={() => onPurpose('informative')} /> 内容性图片</label>
            <label><input type="radio" name="image-purpose" checked={purpose === 'decorative'}
              onChange={() => onPurpose('decorative')} /> 装饰性图片</label>
          </fieldset>
        </>}
        {isColor ? <section className="repair-color" aria-label="文字颜色修复">
          <h4>修复文字颜色</h4>
          {contrastGroupSize > 1 && <label className="repair-actions">
            <input type="checkbox" checked={!singleLocation} disabled={busy}
              onChange={event=>onSingleLocation(!event.target.checked)} />修复同组 {contrastGroupSize} 处
          </label>}
          {unmatchedContrastLocations > 0 && <p className="muted note">
            同组另有 {unmatchedContrastLocations} 处未在修复副本的检测结果中匹配到，需重新检测。
          </p>}
          <label className="repair-color-picker"><span>修复颜色</span><input id="repair-value" type="color" value={chosenColor || '#000000'} disabled={busy} onChange={event => onInput(event.target.value)} /></label>
        </section> : <>
        {!agentOnly && <><label className="input-label" htmlFor="repair-value">建议的文本内容</label>
        <input id="repair-value" value={input} maxLength={['label','select-name','link-name'].includes(target.ruleId) ? 120 : 160} disabled={busy} readOnly={isImageAlt && purpose === 'decorative'} onChange={event => onInput(event.target.value)}
          placeholder={isImageAlt ? (purpose === 'decorative' ? '使用空 alt' : '填写图片在页面中传达的信息') : '填写符合实际用途的名称'} /></>}
        {isImageAlt && <p id="repair-preview-hint" className="muted note" role="status">
          可修改替代文本。{previewHint && <span> {previewHint}</span>}
        </p>}
        </>}
        <div className="repair-actions">
          <button className="secondary" disabled={busy} onClick={() => onPropose('agent')}><Sparkles size={15} />AI 分析与修复</button>
          <button className="button dark" disabled={busy || Boolean(previewHint) || (stateScoped && !input.trim()) || (['label','select-name','link-name'].includes(target.ruleId) && !input.trim()) || (agentOnly && !prepared && !proposal?.sourceReview)} aria-describedby={isImageAlt ? 'repair-preview-hint' : undefined} onClick={() => onPropose('manual', isColor ? chosenColor || '#000000' : input)}><Code2 size={15} />生成补丁预览</button>
        </div>
        {proposal && <div className="proposal">
          <div className="proposal-head"><b>{proposal.source !== 'manual' ? 'AI 修复建议' : isColor ? '颜色预览' : '人工修复建议'}</b><span>补丁预览</span></div>
          {isColor && groupColors.size > 1 && <p>按各处背景推荐了 {groupColors.size} 种文字颜色。</p>}
          {isColor && groupColors.size <= 1 && /^#[0-9a-f]{6}$/i.test(proposal.patch.value) && <p className="repair-color-sample"><span aria-hidden="true" style={{backgroundColor:proposal.patch.value}} />{proposal.patch.value === '#000000' ? '黑色文字' : proposal.patch.value === '#ffffff' ? '白色文字' : '候选文字颜色'}</p>}
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

function Report({ state, onOpen, onWorkspace, onExploreIssue, busy }: {
  state: State; onOpen: (item: HistoryItem) => void; onWorkspace: () => void; busy: boolean;
  onExploreIssue: (target:{issue:PanoramaIssue;stateId:string;version:string;path:string}) => void;
}) {
  const [site, setSite] = useState<ReturnType<typeof import('../../api/panorama').siteReport>>();
  const [siteError, setSiteError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setSite(undefined);
    setSiteError(false);
    void request<{site:NonNullable<typeof site>}>(`/api/projects/${state.project.id}/reports`,{signal:controller.signal})
      .then(result => { if (!controller.signal.aborted) setSite(result.site); })
      .catch(() => { if (!controller.signal.aborted) setSiteError(true); });
    return () => controller.abort();
  }, [state.project.id,state.project.currentSnapshot]);
  return <div className="report">
    <Metrics state={state} />
    <div className="export-banner"><span className="section-icon"><Download size={19} /></span><div><h2>导出源码与报告</h2><p>{state.project.mode?.endsWith('-source') ? 'ZIP 包含当前版本的原始工程文件、扫描证据和验证日志。' : 'ZIP 包含当前网页副本、HTML / JSON 报告和验证日志。'}</p></div><ExportButton route={'/api/projects/' + state.project.id} disabled={busy} /></div>
    <section className="panel report-section" aria-label="页面与状态检测">
      <h2>页面与状态检测</h2>
      {siteError ? <p role="status">页面与状态报告暂不可用。</p> : !site ? <p role="status">正在读取页面检测证据…</p> : <>
        {site.exploration && <details>
          <summary>自动探索记录 · {site.exploration.pages.length} 个已发现页面 · {site.exploration.nodes.filter(node=>node.captureId).length} 个已检测状态</summary>
          <p>{site.exploration.planner === 'deepseek' ? 'DeepSeek 排序' : '确定性探索'} · {{running:'未结束',exhausted:'已处理候选操作',budget:'达到探索预算',timeout:'达到时间限制',cancelled:'用户停止'}[site.exploration.stop]} · {(site.exploration.elapsedMs / 1000).toFixed(1)} 秒</p>
          {site.exploration.planning && site.exploration.planning.calls > 0 && <p>模型调用 {site.exploration.planning.calls} 次 · {site.exploration.planning.elapsedMs} ms · 回退 {site.exploration.planning.fallbacks} 次</p>}
          <ul>{site.exploration.uncovered.map(reason=><li key={reason}>{reason}</li>)}</ul>
          <ul>{site.exploration.pages.map(item=><li key={item.pageId}><code>{item.path}</code> · {{discovered:'已发现，未访问',visited:'浏览器已访问',failed:'访问失败'}[item.status]} {item.reason}</li>)}</ul>
          <ol>{site.exploration.edges.map((edge,index)=><li key={index}><code>{edge.path}</code> · {edge.step
            ? edge.step.action + ('target' in edge.step ? ' · '+edge.step.target.name : 'name' in edge.step ? ' · '+edge.step.name : '')
            : '打开本地页面'} · {{captured:'已检测',duplicate:'已匹配先前状态',failed:'失败',skipped:'跳过'}[edge.status]} {edge.reason}
            {edge.interaction?.map((finding,position)=><p key={position}>{finding.status==='confirmed'?'已确认行为异常':finding.status==='needs-review'?'待复核':'已观测'} · {finding.explanation}</p>)}
          </li>)}</ol>
        </details>}
        <p>已检测 {site.pages.filter(page => page.status === 'completed').length}/{site.pages.length} 个已发现页面 · 全站 {site.confirmed} 项确定性违规（同页重复状态去重）。</p>
        <p>{site.mode === 'snapshot' ? '静态快照 · 未执行原站脚本，动态状态未覆盖。' : '覆盖已扫描页面及已重放状态。未执行的交互和未发现的路由不在报告范围内。'}</p>
        <ul>{site.pages.map(page => <li key={page.pageId}><code>{page.path}</code> · {
          page.status === 'completed' ? `已扫描 · ${page.issues} 项违规 · ${page.states} 个已检测状态` :
            page.status === 'failed' ? '检测失败' : page.status === 'running' ? '检测未完成' : page.status === 'skipped' ? '跳过' : '尚未扫描'
        }{page.error && ` · ${page.error}`}</li>)}</ul>
        {site.attempts.length > 0 && <details><summary>未完成的扫描尝试</summary>
          <ul>{site.attempts.map(attempt => <li key={attempt.scope}><code>{attempt.path}</code> · {attempt.error ?? '扫描未完成'}</li>)}</ul>
        </details>}
        <details><summary>按检测维度查看覆盖</summary>
          <ul>
            <li>结构、语义、表单、视觉对比及目标尺寸 · {site.states.filter(item=>item.scan).length} 个历史状态有 axe 规则日志，{site.liveStates.length} 个实时状态有独立扫描。</li>
            <li>键盘 · {site.states.filter(item=>item.keyboard.status==='completed').length} 个历史状态完成有限 Tab 探查；实时检测记录用户实际操作。</li>
            <li>动态组件 · {site.states.filter(item=>item.coverage==='interaction').length} 个历史重放状态。未触发的状态未覆盖。</li>
            <li>媒体及人工体验 · 字幕内容、音频描述、读屏播报和触屏操作需要人工体验。</li>
          </ul>
        </details>
        {site.liveStates.length > 0 && <details><summary>实时交互扫描 · {site.liveStates.length} 个独立状态</summary>
          {site.liveStates.map(item=><details key={item.id}>
            <summary>{item.path} · {item.createdAt} · {item.findings.length} 项确定性违规</summary>
            <p>axe-core {item.engine.version} · {item.rules.length} 条规则记录 · {item.actions.length} 个实际操作 · 焦点 {item.focus || '文档'}</p>
            <ul>{item.findings.map(finding=><li key={finding.id}>{finding.ruleId} · <code>{finding.selector}</code></li>)}</ul>
            <ul>{item.incomplete.map(rule=><li key={rule.id}>{rule.id} · {rule.count} 项 axe 待复核</li>)}
              {item.observations.map((item,index)=><li key={index}>{item.status==='confirmed'?'已确认行为异常':item.status==='observed'?'已观测':'待人工复核'} · {item.rule} · {item.evidence}</li>)}</ul>
            <p>媒体轨道记录：{item.media.length} 个播放器。实际播报、字幕内容及音频描述需人工确认。</p>
            {item.media.length > 0 && <ul>{item.media.map((medium,index)=><li key={index}>{medium.type} · {
              medium.tracks.map(track=>track.kind + (track.language ? ' '+track.language : '')).join('、') || '未声明轨道'
            }</li>)}</ul>}
            {item.resources.map((item,index)=><p key={index}>{item.path} · {item.reason}</p>)}
          </details>)}
        </details>}
        {site.states.map(item => <details key={item.stateId}>
          <summary>{item.title} · {item.sourcePath ?? item.path} · {item.label} · {item.coverage === 'static' ? '静态页面' : item.coverage === 'dynamic-initial' ? '动态初始状态' : '交互状态'} · {item.issues.length} 项违规 / {item.manual} 项 axe 待复核 · V2 {item.keyboard.findings.length} 项行为证据</summary>
          {item.attempt && item.attempt.status !== 'completed' && <p>以下为上一次成功的检测证据。</p>}
          {item.scan ? <>
            <p>axe-core {item.scan.engine.version} · Chromium {item.scan.browser} · {item.scan.rules.length} 条规则有记录 · V2 {item.keyboard.status === 'completed' ? '已执行' : '未完整完成'}</p>
            <p>图片 {item.scan.resources.loadedImages}/{item.scan.resources.images} · 外部样式 {item.scan.resources.loadedStylesheets}/{item.scan.resources.stylesheets}</p>
            {item.scan.incomplete.length > 0 && <ul>{item.scan.incomplete.map(rule => <li key={rule.ruleId}>axe 待复核 · {rule.ruleId} · {rule.selectors.join('、')}</li>)}</ul>}
          </> : <p>历史扫描未保存引擎版本与规则明细。运行全站检测可补全证据。</p>}
          {item.scan?.interaction && item.scan.interaction.transitions.length > 0 && <details>
            <summary>操作证据 · {item.scan.interaction.transitions.length} 步 · {item.scan.interaction.findings.filter(finding => finding.status === 'confirmed').length} 项已确认行为异常</summary>
            <ol>{item.scan.interaction.transitions.map(step => <li key={step.step}>
              {step.action} · <code>{step.fromPath}</code> → <code>{step.toPath}</code> · 焦点 {step.beforeFocus || '文档'} → {step.afterFocus || '文档'}
            </li>)}</ol>
            <ul>{item.scan.interaction.findings.map((finding,index) => <li key={index}>
              第 {finding.step} 步 · {finding.status === 'confirmed' ? '已确认行为异常' : finding.status === 'needs-review' ? '待人工复核' : '浏览器观测'} · <code>{finding.selector}</code> {finding.explanation}
            </li>)}</ul>
          </details>}
          {item.keyboard.findings.length > 0 && <ul>{item.keyboard.findings.map((finding,index) => <li key={index}>{finding.ruleId} · <code>{finding.selector}</code> · {finding.explanation}</li>)}</ul>}
          <ul>{item.issues.map((issue,index) => <li key={issue.id+index}>{issue.ruleId} · <code>{issue.selector}</code>{' '}
            <button className="secondary" disabled={busy} onClick={()=>onExploreIssue({issue,stateId:item.stateId,version:site.snapshotId,path:item.path})}>在诊断中查看</button>
          </li>)}</ul>
          {item.sourceFrom && <p>采集时由 {item.sourceFrom} 点击同源导航进入。</p>}
          {item.steps.length > 0 && <ol>{item.steps.map((step,index) => <li key={index}>{step.action}{'target' in step && ' · '+step.target.name}</li>)}</ol>}
          {item.resourceFailures?.map((failure,index) => <p key={index}>{failure.path} · {failure.reason}</p>)}
        </details>)}
      </>}
    </section>
    <div className="report-grid">
      <section className="panel report-section"><div className="panel-head"><div><span className="kicker">VALIDATION</span><h2>修复与验证记录</h2></div></div>
        {state.verifications.length ? state.verifications.map(item => <div className="log-row" key={item.id}>
          <span className={'log-icon ' + (item.status !== 'failed' ? 'ok' : 'failed')} aria-hidden="true">{item.status !== 'failed' ? <Check size={15} /> : <X size={15} />}</span>
          <div><b>{item.status === 'applied' ? '补丁已保存' : item.status === 'passed' ? '验证通过' : '验证失败 · 当前状态未更改'}</b>
            <p>{item.reason}</p>
            {item.imageReview && <p>图片语义审核：用户已确认 · {imagePurposeLabel[item.imageReview.purpose]}</p>}<small>{dateText(item.createdAt)} · 解决 {item.resolved.length} / 残留 {item.remaining.length} / 新增 {item.added.length}</small>
            {item.status !== 'failed' && [...item.resolved, ...(item.reviewedTarget ? [item.reviewedTarget] : [])].map(resolved => <button className="record-link" key={resolved.id} disabled={busy} onClick={() => onOpen({ issue: resolved, verification: item })}>{issueTitle(resolved)} · 查看证据 <ArrowRight size={14} /></button>)}
            {item.diff && <details><summary>补丁与源码校验</summary>
              <p>{item.proposalReason}</p>
              {item.wcagUrl && <a href={item.wcagUrl} target="_blank" rel="noreferrer">{item.wcag?.join('、') || '规范依据'}</a>}
              <pre className="evidence-diff" tabIndex={0} aria-label="修复补丁">{item.diff}</pre>
              <small className="file-hashes">修改前 SHA-256 {item.beforeHash}<br />修改后 SHA-256 {item.afterHash}</small>
            </details>}
          </div>
        </div>) : <Blank icon={<ShieldCheck />} title="暂无修复记录">审核并应用补丁后，验证证据会显示在这里。</Blank>}
      </section>
      <section className="panel report-section"><div className="panel-head"><div><span className="kicker">MANUAL REVIEW</span><h2>人工复核</h2></div></div>
        <div className="review-list">
          <p>自动扫描覆盖部分 WCAG 规则，请结合以下人工检查。</p>
          <ul><li>键盘能否访问所有功能，焦点顺序是否合理</li><li>屏幕阅读器读出的名称和提示是否准确</li><li>图片描述是否符合语境，装饰图片是否正确标记</li><li>放大文字和页面后，内容是否仍可使用</li></ul>
          <DetectionReview detection={state.current?.detection} report />
          {state.current?.incomplete.map(item => <div className="manual-item" key={item.ruleId}><Info size={14} />{item.help} · {item.count} 项需要进一步判断</div>)}
        </div>
      </section>
    </div>
    <div className="report-actions"><button className="secondary" onClick={onWorkspace}>返回工作台</button></div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<AccountGate>{(account,signOut,openUpgrade,openVerification)=><App key={account.id+':'+Boolean(account.isGuest)} account={account} signOut={signOut} openUpgrade={openUpgrade} openVerification={openVerification} />}</AccountGate>);
