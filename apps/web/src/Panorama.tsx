import { workspaceFetch as fetch } from './workspace-fetch';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PanoramaComparison, PanoramaIssue, PanoramaRecipe, PanoramaSide, PanoramaStep } from '../../../packages/shared/panorama';
import { startJob, waitJob } from './jobs';
import type { EvidenceView } from './Evidence';
import type { VersionPair } from './VersionComparison';
import { versionName, type State } from './types';

type Entry = {file: string; screenshot: string; size: {width: number; height: number}};
type Inventory = {pages: string[]; recipes: PanoramaRecipe[]; interactive: boolean; limit: number; entries: Record<string, Entry>};
const pagePath = (file: string) => '/' + file.split('/').map(encodeURIComponent).join('/');
type Request = {site?:true; start?: string; stateId?: string; step?: PanoramaStep; from?: 'left' | 'right'};
const actions = {
  click: '点击控件', fill: '输入固定测试值', validate: '检查原生表单校验', tab: 'Tab',
  'shift-tab': 'Shift+Tab', escape: 'Escape', scroll: '滚动',
};
const stepName = (step: PanoramaStep) => actions[step.action] + ('target' in step ? ' · ' + step.target.name : '');

export type PageInspection = {
  projectId: string; version: string; path: string; stateId?: string;
  scoped: boolean; findings: PanoramaIssue[];
  scanStatus: 'scanned' | 'pending' | 'failed' | 'unscanned';
  scanError?: string;
  review?: {axe:number; behavior:number; behaviorStatus:string};
  coverage?: string;
  comparison?: string;
};
export type PanoramaJump = {stateId: string; left: string; right: string; key: string};

export function Panorama({state, onInspection, disabled, jump, pair: versions, view, onScope, targetId, scopeTargetId, viewTools, pageRequest}: {
  state: State; onInspection: (value: PageInspection) => void; disabled: boolean; jump?: PanoramaJump;
  pair: VersionPair; view: EvidenceView; onScope:(scoped:boolean)=>void; targetId?:string; scopeTargetId?:string; viewTools?:ReactNode; pageRequest?:{path:string};
}) {
  const {project} = state;
  const {left, right} = versions;
  const route = '/api/projects/' + encodeURIComponent(project.id) + '/panorama';
  const [loaded, setLoaded] = useState<{query: string; inventory: Inventory}>();
  const [selection, setSelection] = useState<Request>(jump ? {stateId: jump.stateId} : {start: project.entry});
  const [compared, setCompared] = useState<{query: string; result: PanoramaComparison}>();
  const [job, setJob] = useState('');
  const [progress, setProgress] = useState('');
  const [listError, setListError] = useState('');
  const [captureError, setCaptureError] = useState('');
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const [zoom, setZoom] = useState(100);
  const [attempt, setAttempt] = useState(0);
  const [from, setFrom] = useState<'left' | 'right'>('left');
  const [controlIndex, setControlIndex] = useState('');
  const [action, setAction] = useState<'click' | 'validate' | 'fill'>('click');
  const [scroll, setScroll] = useState(0);
  const [batchFailures, setBatchFailures] = useState<{page:string;reason:string}[]>([]);
  const [full, setFull] = useState(true);
  const [sync, setSync] = useState(true);
  const leftShot = useRef<HTMLDivElement>(null);
  const rightShot = useRef<HTMLDivElement>(null);
  const routeQuery = route + '?' + new URLSearchParams({left, right});
  const inventory = loaded?.query === routeQuery ? loaded.inventory : undefined;
  const resultQuery = JSON.stringify([routeQuery,state.current?.id,selection,attempt]);
  const result = compared?.query === resultQuery ? compared.result : undefined;

  const hasAudit = Boolean(state.current);
  useEffect(() => {
    if (!left || !right || !hasAudit) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const refresh = async () => {
      try {
        const response = await fetch(routeQuery, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), cache: 'no-store',
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(body?.pages) || !Array.isArray(body?.recipes)) {
          const reason = body?.error ?? (response.status === 404 ? '当前后端未提供全景接口，请更新服务后重试。' :
            response.ok ? '返回的页面列表格式无效。' : '请检查后端服务后重试。');
          throw new Error(`全景页面列表加载失败（HTTP ${response.status}）。${reason}`);
        }
        if (!signal.aborted) {
          setLoaded({query: routeQuery, inventory: body});
          setListError('');
        }
        return true;
      } catch (error) {
        if (!signal.aborted) setListError(error instanceof TypeError ? '无法连接后端加载全景页面列表，请检查服务后重试。' :
          (error as Error).name === 'TimeoutError' ? '全景页面列表请求超时，请重试。' : (error as Error).message);
        return false;
      }
    };
    void (async () => {
      setCompared(undefined);
      setJob('');
      setProgress('正在加载页面列表');
      setListError('');
      setCaptureError('');
      setMissing({});
      try {
        if (!await refresh() || signal.aborted) return;
        setProgress('准备采集本地页面');
        const id = await startJob(route, 'panorama', {left, right, ...selection}, signal);
        if (signal.aborted) return;
        setJob(id);
        if (selection.site) {
          const batch = await waitJob<{failures:{page:string;reason:string}[]}>(id, 'panorama', signal, setProgress);
          if (!signal.aborted) {
            setBatchFailures(batch.failures);
            setSelection({start:project.entry});
          }
          return;
        }
        const next = await waitJob<PanoramaComparison>(id, 'panorama', signal, setProgress);
        await refresh();
        if (!signal.aborted) setCompared({query: resultQuery, result: next});
      } catch (error) {
        if (!signal.aborted) setCaptureError((error as Error).message);
      } finally {
        if (!signal.aborted) {
          setJob('');
          setProgress('');
        }
      }
    })();
    return () => controller.abort();
  }, [hasAudit, route, routeQuery, resultQuery, left, right, selection, attempt, project.entry]);

  // After an action, the returned recipe is the stable selection for version changes.
  const stateId = result?.stateId ?? selection.stateId;
  const active = inventory?.recipes.find(recipe => recipe.id === stateId);
  const page = active?.path ?? pagePath(selection.start ?? project.entry);
  const paths = [...new Set([
    ...(inventory?.pages ?? [project.entry]).map(pagePath),
    ...(inventory?.recipes ?? []).map(recipe => recipe.path),
  ])];
  useEffect(() => {
    if (!targetId || jump) return;
    setSelection(current => current.start === project.entry && !current.step ? current : {start:project.entry});
  }, [targetId, jump, project.entry]);
  const scoped = Boolean(jump || selection.stateId || selection.start && selection.start !== project.entry || active?.steps.length);
  useEffect(() => onScope(scoped), [onScope, scoped]);
  const pathNames = new Map(inventory?.recipes.filter(recipe => recipe.title).map(recipe => [recipe.path,recipe.title]));
  const states = inventory?.recipes.filter(recipe => recipe.path === page) ?? [];
  const side = result?.[from];
  const controls = side?.status === 'captured' ? side.capture.controls : [];
  const selected = controls[Number(controlIndex)];
  const busy = Boolean(progress) || disabled;
  const canAct = Boolean(stateId && inventory?.interactive && side?.status === 'captured' && (active?.steps.length ?? 0) < 6);

  function selectRequest(next: Request) {
    setCompared(undefined);
    setProgress('准备采集本地页面…');
    setSelection(next);
  }

  function choosePage(path: string) {
    const file = inventory?.pages.find(item => pagePath(item) === path);
    const saved = inventory?.recipes.find(item => item.path === path);
    setControlIndex('');
    if (file) selectRequest({start: file});
    else if (saved) selectRequest({stateId: saved.id});
  }

  const lastPageRequest = useRef<{path:string} | undefined>(undefined);
  useEffect(() => {
    if (!pageRequest || !inventory || lastPageRequest.current === pageRequest || busy) return;
    lastPageRequest.current = pageRequest;
    if (paths.includes(pageRequest.path) && pageRequest.path !== page) choosePage(pageRequest.path);
  }, [pageRequest, inventory, busy, page]);

  function perform(step: PanoramaStep) {
    if (!stateId || !canAct) return;
    setControlIndex('');
    selectRequest({stateId, step, from});
  }

  function mirror(source: HTMLDivElement, side: 'left' | 'right') {
    const other = side === 'left' ? rightShot.current : leftShot.current;
    if (sync && other && (Math.abs(other.scrollTop - source.scrollTop) > 1 || Math.abs(other.scrollLeft - source.scrollLeft) > 1)) {
      other.scrollTo({top: source.scrollTop, left: source.scrollLeft});
    }
  }

  const pair = result?.left.status === 'captured' && result.right.status === 'captured'
    ? [result.left.capture, result.right.capture] as const : null;
  const resolved = pair?.[0].issues.filter(item => !pair[1].issues.some(other => other.id === item.id)) ?? [];
  const added = pair?.[1].issues.filter(item => !pair[0].issues.some(other => other.id === item.id)) ?? [];
  const discovered = new Set([
    ...(inventory?.pages ?? []).map(file => 'page:' + file),
    ...(inventory?.recipes ?? []).map(recipe => recipe.steps.length ? 'state:' + recipe.id : 'page:' + recipe.start),
  ]).size;
  const covered = new Set(inventory?.recipes.filter(recipe => recipe.counts[state.project.currentSnapshot] !== undefined).map(recipe => recipe.path));
  const inspectedStates = inventory?.recipes.filter(recipe => recipe.counts[state.project.currentSnapshot] !== undefined).length ?? 0;
  const shownVersion = project.currentSnapshot;
  const currentSide = right === shownVersion ? result?.right : left === shownVersion ? result?.left : undefined;
  const shown = currentSide?.status === 'captured' ? currentSide.capture : undefined;
  const scanError = captureError || listError || (currentSide?.status !== 'captured' ? currentSide?.error : undefined);
  const scanStatus = shown ? 'scanned' : progress ? 'pending' : scanError ? 'failed' : 'unscanned';
  const coverage = inventory ? `当前版本已检测 ${covered.size}/${paths.length} 个已发现页面、${inspectedStates}/${discovered} 个已知状态。` : undefined;
  const comparison = pair && scoped ? `右侧较左侧解决 ${resolved.length} 个问题，新增 ${added.length} 个问题。` : undefined;
  useEffect(() => {
    onInspection({projectId:project.id,version:shownVersion,path:page,stateId,scoped,findings:shown?.issues ?? [],coverage,comparison,
      scanStatus,scanError,review:shown && {axe:shown.manual,behavior:shown.keyboard.findings.length,behaviorStatus:shown.keyboard.status}});
  }, [onInspection, project.id, shownVersion, page, stateId, scoped, shown, coverage, comparison, scanStatus, scanError]);

  function renderShot(position: 'left' | 'right', src: string, title: string, size: Entry['size'],
    fullFile: string, bounds?: PanoramaIssue['bounds']) {
    if (missing[src]) return <p role="alert">截图无法读取，请重试采集此状态。</p>;
    return <>
      <div className="panorama-shot" ref={position === 'left' ? leftShot : rightShot}
        tabIndex={0} aria-label={position === 'left' ? '滚动左侧页面截图' : '滚动右侧页面截图'}
        onScroll={event => mirror(event.currentTarget, position)}>
        <div className="panorama-image" style={{aspectRatio: `${size.width} / ${size.height}`, width: zoom + '%'}}>
          <img src={src} alt={title} onError={() => setMissing(files => ({...files, [src]: true}))} />
          {bounds && <span className="panorama-highlight" aria-hidden="true" style={{
            left: bounds.x / size.width * 100 + '%', top: bounds.y / size.height * 100 + '%',
            width: bounds.width / size.width * 100 + '%', height: bounds.height / size.height * 100 + '%',
          }} />}
        </div>
      </div>
      <a href={fullFile} target="_blank" rel="noreferrer">在新标签页查看整页截图</a>
    </>;
  }

  function renderSide(value: PanoramaSide | undefined, position: 'left' | 'right') {
    const version = position === 'left' ? left : right;
    if (value?.status !== 'captured') {
      const audit = [state.baseline, state.current].find(scan => scan?.snapshotId === version);
      const entry = inventory?.entries?.[version] ??
        (audit?.screenshot && audit.size ? {...audit, file: project.entry} : undefined);
      const start = !selection.step && (active?.steps.length === 0 ? active.start : !selection.stateId ? selection.start : undefined);
      return <>
        {value ? <p role="status"><b>{value.status === 'unmatched' ? '状态无法可靠匹配' :
          value.status === 'failed' ? '此版本采集失败' : '此版本未采集'}</b><br />
          {value.step === undefined ? '' : '步骤 ' + value.step + ' · '}{value.error}</p> :
          <p className="muted">{listError ? '无法从页面列表读取此状态。' :
            captureError ? '本次未能采集此状态。' : busy ? '正在准备此版本的状态证据。' : '此版本尚未采集。'}</p>}
        {entry && entry.file === start && value?.status !== 'unmatched' && (view === 'visual' ? <>
          <p className="panorama-caption">首页整页截图 · 来自此版本的扫描记录</p>
          {renderShot(position, entry.screenshot, '已扫描首页整页截图', entry.size, entry.screenshot)}
        </> : <p className="muted">首页扫描截图已可查看。语义和键盘证据需完成全景采集。</p>)}
      </>;
    }
    const item = value.capture;
    const bounds = full ? item.issues.find(found => found.id === (scopeTargetId ?? targetId))?.bounds : null;
    const fullFile = route + '/captures/' + item.id + '/full';
    const file = full ? fullFile : route + '/captures/' + item.id + '/viewport';
    return <>
      {Boolean(item.resourceFailures?.length) && <details><summary>{item.resourceFailures!.length} 个资源加载失败</summary>
        <ul>{item.resourceFailures!.map((item,index)=><li key={index}><code>{item.path}</code> · {item.reason}</li>)}</ul>
      </details>}

      {view === 'visual' ? renderShot(position, file, (item.title || item.path) + (full ? ' 完整页面截图' : ' 视口截图'),
        full ? item : {width: 900, height: 700}, fullFile, bounds) : view === 'semantics' ? <>
        <h4>浏览器无障碍语义</h4><pre tabIndex={0}>{item.ax || '未取得无障碍树内容。'}</pre>
        <details><summary>DOM 结构（已限制字段）</summary><pre tabIndex={0}>{item.dom}</pre></details>
        <details><summary>键盘检测</summary><p>采集时焦点：{item.focus || '文档'}。{item.keyboard.status !== 'completed' && '键盘探测未完成。'}</p>
          <ol>{item.keyboard.tabSequence.map((selector,index)=><li key={index}><code>{selector}</code></li>)}</ol>
          {item.keyboard.findings.map((finding,index)=><p key={index}>{finding.selector} · {finding.explanation}</p>)}
        </details>
      </> : <>
        <p>采集时焦点 · {item.focus || '文档'}。键盘探测 · {item.keyboard.status === 'completed' ? '已完成' : '未完成，需人工复核'}</p>
        <ol>{item.keyboard.tabSequence.map((selector, index) => <li key={index}><code>{selector}</code></li>)}</ol>
        {item.keyboard.findings.map((finding, index) => <p key={index}><code>{finding.selector}</code> · {finding.explanation}</p>)}
      </>}
    </>;
  }

  return <section className="panorama" aria-label="页面与状态">
    <div className="panorama-bar page-comparison-toolbar" role="group" aria-label="页面和扫描操作">
        <label>页面<select aria-label="页面" value={page} disabled={busy} onChange={event => choosePage(event.target.value)}>
          {paths.map(path => <option key={path} value={path}>{pathNames.get(path) ? pathNames.get(path) + ' · ' : ''}{path}</option>)}
        </select></label>
        <label>交互状态<select aria-label="交互状态" value={active?.id ?? ''} disabled={busy || !states.length} onChange={event => selectRequest({stateId: event.target.value})}>
          {!active && <option value="">{listError ? '状态列表加载失败' : '尚未采集'}</option>}
          {states.map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.label}</option>)}
        </select></label>
      <button type="button" className="secondary" disabled={busy || !inventory} onClick={() => {
        setBatchFailures([]);
        selectRequest({site:true});
      }}>检测已发现页面</button>
    </div>
    {viewTools}
    {project.mode === 'snapshot' && <p className="comparison-status muted">静态快照 · 动态交互状态未覆盖</p>}
    {batchFailures.length > 0 && <details><summary>未完成 {batchFailures.length} 个页面检查</summary>
      <ul>{batchFailures.map(({page,reason},index)=><li key={index}>{page} · {reason}</li>)}</ul>
    </details>}
        {progress && <p role="status">{progress}… {job && <button type="button" className="secondary"
          onClick={() => void fetch('/api/jobs/' + job + '/cancel', {method: 'POST'})}>取消全景采集</button>}</p>}
        {listError && <p role="alert">{listError}</p>}
        {captureError && <p role="alert">全景采集未完成。{captureError}</p>}
        {(listError || captureError || (result && !pair) || Object.values(missing).some(Boolean)) &&
          <button type="button" className="secondary" disabled={busy} onClick={() => setAttempt(value => value + 1)}>
            {listError ? '重试加载页面列表' : '重试采集'}
          </button>}

        {active && active.steps.length > 0 && <details className="panorama-steps"><summary>操作记录 · {active.steps.length} 步</summary>
          <ol>{active.steps.map((step, index) => <li key={index}>{stepName(step)}</li>)}</ol></details>}
        {scoped && view === 'visual' && <div className="panorama-bar" role="group" aria-label="页面截图选项">
          <label><input type="checkbox" checked={full} onChange={event => setFull(event.target.checked)} />完整页面</label>
          <label><input type="checkbox" checked={sync} onChange={event => setSync(event.target.checked)} />同步滚动</label>
          <label>截图缩放<select value={zoom} onChange={event => setZoom(Number(event.target.value))}>
            {[50, 75, 100, 125, 150, 200].map(value => <option key={value} value={value}>{value}%</option>)}
          </select></label>
        </div>}
        {scoped && view !== 'diff' && <div className="panorama-pair">
          <section><h3>左侧 · {versionName(state, left)}</h3>{renderSide(result?.left, 'left')}</section>
          <section><h3>右侧 · {versionName(state, right)}</h3>{renderSide(result?.right, 'right')}</section>
        </div>}
        {pair && <p className="screen-reader-only" role="status">左右已匹配同一页面和状态。</p>}
        {inventory?.interactive && <details className="panorama-steps"><summary>记录安全操作</summary><fieldset className="panorama-actions" aria-label="记录安全操作" disabled={busy || !canAct}>
          <legend>记录安全操作</legend>
          {side?.status === 'captured' && Boolean(side.capture.navigation?.length) && <details>
            <summary>站内导航</summary>
            <div className="panorama-bar">{side.capture.navigation!.map((link,index) => <button
              key={index} type="button" className="secondary" title={link.path}
              onClick={() => perform({action:'click', target:{role:'link',name:link.name}, navigationPath:link.path})}>{link.name}</button>)}</div>
          </details>}
          <div className="panorama-bar">
            <label>操作侧<select aria-label="操作侧" value={from} onChange={event => {setFrom(event.target.value === 'left' ? 'left' : 'right'); setControlIndex('');}}>
              <option value="left">左侧版本</option><option value="right">右侧版本</option>
            </select></label>
            <label>控件<select aria-label="控件" value={controlIndex} onChange={event => setControlIndex(event.target.value)}>
              <option value="">选择当前状态的可访问控件</option>
              {controls.map((item, index) => <option key={index} value={index}>{item.name} ({item.role})</option>)}
            </select></label>
            <label>操作<select aria-label="操作" value={action} onChange={event => setAction(event.target.value as typeof action)}>
              {(['click', 'fill', 'validate'] as const).map(key => <option key={key} value={key}>{actions[key]}</option>)}
            </select></label>
            <button type="button" className="button dark" disabled={!controlIndex || !selected} onClick={() => perform({action, target: selected})}>执行并重放</button>
          </div>
          <div className="panorama-bar">
            {(['tab', 'shift-tab', 'escape'] as const).map(key =>
              <button type="button" className="secondary" key={key} onClick={() => perform({action: key})}>{actions[key]}</button>)}
            <label>滚动到像素<input type="number" min={0} max={6000} value={scroll} onChange={event => setScroll(Number(event.target.value))} /></label>
            <button type="button" className="secondary" onClick={() => perform({action: 'scroll', y: scroll})}>对齐浏览器滚动</button>
          </div>
        </fieldset></details>}
  </section>;
}
