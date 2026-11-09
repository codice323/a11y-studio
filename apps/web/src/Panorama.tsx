import { useEffect, useRef, useState } from 'react';
import type { PanoramaComparison, PanoramaIssue, PanoramaRecipe, PanoramaSide, PanoramaStep } from '../../../packages/shared/panorama';
import { startJob, waitJob } from './jobs';
import { versionName, type State } from './types';

type Inventory = {pages: string[]; recipes: PanoramaRecipe[]; interactive: boolean; limit: number};
type Request = {start?: string; stateId?: string; step?: PanoramaStep; from?: 'left' | 'right'};
type Evidence = 'visual' | 'semantics' | 'keyboard';
const actions = {
  click: '点击控件', fill: '输入固定测试值', validate: '检查原生表单校验', tab: 'Tab',
  'shift-tab': 'Shift+Tab', escape: 'Escape', scroll: '滚动',
};
const stepName = (step: PanoramaStep) => actions[step.action] + ('target' in step ? ' · ' + step.target.name : '');

export type PanoramaJump = {stateId: string; left: string; right: string; key: string};

export function Panorama({state, onRepair, disabled, activeView, jump}: {
  state: State; onRepair: (issue: PanoramaIssue, stateId: string, version: string) => void; disabled: boolean; activeView: boolean; jump?: PanoramaJump;
}) {
  const {project, originalSnapshotId, snapshots} = state;
  const baseline = originalSnapshotId ?? project.currentSnapshot;
  const [versions, setVersions] = useState<{left?: string; right?: string}>(jump ? {left: jump.left, right: jump.right} : {});
  const left = versions.left ?? baseline;
  const right = versions.right ?? project.currentSnapshot;
  const route = '/api/projects/' + encodeURIComponent(project.id) + '/panorama';
  const [inventory, setInventory] = useState<Inventory>();
  const [selection, setSelection] = useState<Request>(jump ? {stateId: jump.stateId} : {start: project.entry});
  const [result, setResult] = useState<PanoramaComparison>();
  const [job, setJob] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [from, setFrom] = useState<'left' | 'right'>('left');
  const [controlIndex, setControlIndex] = useState('');
  const [action, setAction] = useState<'click' | 'validate' | 'fill'>('click');
  const [scroll, setScroll] = useState(0);
  const [issue, setIssue] = useState<PanoramaIssue>();
  const [view, setView] = useState<Evidence>('visual');
  const [full, setFull] = useState(true);
  const [sync, setSync] = useState(true);
  const leftShot = useRef<HTMLDivElement>(null);
  const rightShot = useRef<HTMLDivElement>(null);
  const routeQuery = route + '?' + new URLSearchParams({left, right});
  const activeJob = useRef('');

  useEffect(() => {
    if (!activeView || disabled) return;
    const controller = new AbortController();
    const refresh = async () => {
      const response = await fetch(routeQuery, {signal: controller.signal, cache: 'no-store'});
      if (!response.ok) throw new Error('无法加载页面列表。');
      const next: Inventory = await response.json();
      if (!controller.signal.aborted) setInventory(next);
    };
    void (async () => {
      setResult(undefined);
      setIssue(undefined);
      setProgress('准备采集本地页面…');
      setError('');
      try {
        await refresh();
        const id = await startJob(route, 'panorama', {left, right, ...selection}, controller.signal);
        if (controller.signal.aborted) return;
        activeJob.current = id;
        setJob(id);
        const next = await waitJob<PanoramaComparison>(id, 'panorama', controller.signal, setProgress);
        await refresh();
        if (!controller.signal.aborted) setResult(next);
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) {
          activeJob.current = '';
          setJob('');
          setProgress('');
        }
      }
    })();
    return () => {
      controller.abort();
      if (activeJob.current) void fetch('/api/jobs/' + activeJob.current + '/cancel', {method: 'POST'}).catch(() => {});
      activeJob.current = '';
    };
  }, [activeView, disabled, route, routeQuery, left, right, selection, attempt]);

  // After an action, the returned recipe is the stable selection for version changes.
  const stateId = result?.stateId ?? selection.stateId;
  const active = inventory?.recipes.find(recipe => recipe.id === stateId);
  const page = active?.path ?? '/' + (selection.start ?? project.entry);
  const paths = [...new Set([
    ...(inventory?.pages ?? [project.entry]).map(file => '/' + file.split('/').map(encodeURIComponent).join('/')),
    ...(inventory?.recipes ?? []).map(recipe => recipe.path),
  ])];
  const states = inventory?.recipes.filter(recipe => recipe.path === page) ?? [];
  const side = result?.[from];
  const controls = side?.status === 'captured' ? side.capture.controls : [];
  const selected = controls[Number(controlIndex)];
  const busy = Boolean(progress) || disabled;
  const canAct = Boolean(stateId && inventory?.interactive && side?.status === 'captured' && (active?.steps.length ?? 0) < 6);

  function selectRequest(next: Request) {
    setResult(undefined);
    setProgress('准备采集本地页面…');
    setSelection(next);
  }

  function choosePage(path: string) {
    const file = inventory?.pages.find(item => '/' + item.split('/').map(encodeURIComponent).join('/') === path);
    const saved = inventory?.recipes.find(item => item.path === path);
    setControlIndex('');
    if (file) selectRequest({start: file});
    else if (saved) selectRequest({stateId: saved.id});
  }

  function chooseVersions(next: typeof versions) {
    if (stateId) selectRequest({stateId});
    setVersions(next);
  }

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
  const findings = result?.right.status === 'captured' ? result.right.capture.issues :
    result?.left.status === 'captured' ? result.left.capture.issues : [];

  function renderSide(value: PanoramaSide | undefined, position: 'left' | 'right') {
    if (!value) return <p className="muted">等待本地采集。</p>;
    if (value.status === 'unmatched') return <p role="status"><b>状态无法可靠匹配</b><br />
      {value.step === undefined ? '' : '步骤 ' + value.step + ' · '}{value.error}</p>;
    const item = value.capture;
    const bounds = full && issue ? item.issues.find(found => found.id === issue.id)?.bounds : null;
    const file = route + '/captures/' + item.id + '/' + (full ? 'full' : 'viewport');
    return <>
      <p className="panorama-caption">{item.title || item.path} · {item.issues.length} 个问题 · {item.manual} 项待人工核查</p>
      {view === 'visual' ? <div className="panorama-shot" ref={position === 'left' ? leftShot : rightShot}
        tabIndex={0} aria-label={position === 'left' ? '滚动左侧页面截图' : '滚动右侧页面截图'}
        onScroll={event => mirror(event.currentTarget, position)}>
        <div className="panorama-image" style={{aspectRatio: full ? `${item.width} / ${item.height}` : '900 / 700'}}>
          <img src={file} alt={item.title + (full ? ' 完整页面截图' : ' 视口截图')} />
          {bounds && <span className="panorama-highlight" aria-hidden="true" style={{
            left: bounds.x / item.width * 100 + '%', top: bounds.y / item.height * 100 + '%',
            width: bounds.width / item.width * 100 + '%', height: bounds.height / item.height * 100 + '%',
          }} />}
        </div>
      </div> : view === 'semantics' ? <>
        <h4>浏览器无障碍语义</h4><pre tabIndex={0}>{item.ax || '未取得无障碍树内容。'}</pre>
        <details><summary>DOM 结构（已限制字段）</summary><pre tabIndex={0}>{item.dom}</pre></details>
      </> : <>
        <p>采集时焦点 · {item.focus || '文档'}。键盘探测 · {item.keyboard.status === 'completed' ? '已完成' : '未完成，需人工复核'}</p>
        <ol>{item.keyboard.tabSequence.map((selector, index) => <li key={index}><code>{selector}</code></li>)}</ol>
        {item.keyboard.findings.map((finding, index) => <p key={index}><code>{finding.selector}</code> · {finding.explanation}</p>)}
      </>}
    </>;
  }

  return <section className="panel panorama" aria-label="全景交互浏览">
    <div className="panorama-heading"><div><h2>全景交互浏览</h2>
      <p>{project.mode === 'snapshot' ? '静态快照，仅支持浏览已采集状态。' : '在隔离工程里逐步操作，另一版本重放同一序列。'}</p></div>
      <small>{paths.length} 个页面 · {inventory?.recipes.length ?? 0}/{inventory?.limit ?? 12} 个已采集状态</small>
    </div>
    <div className="panorama-bar">
      <label>左侧版本<select aria-label="全景左侧版本" value={left} disabled={busy} onChange={event => chooseVersions({...versions, left: event.target.value})}>
        {snapshots.map(item => <option key={item.id} value={item.id}>{versionName(state, item.id)}</option>)}
      </select></label>
      <button type="button" className="secondary" disabled={busy || left === right} onClick={() => chooseVersions({left: right, right: left})}>交换版本</button>
      <label>右侧版本<select aria-label="全景右侧版本" value={right} disabled={busy} onChange={event => chooseVersions({...versions, right: event.target.value})}>
        {snapshots.map(item => <option key={item.id} value={item.id}>{versionName(state, item.id)}</option>)}
      </select></label>
      <button type="button" className="secondary" disabled={busy} onClick={() => chooseVersions({})}>恢复默认对照</button>
    </div>
    <div className="panorama-grid">
      <nav aria-label="已采集页面和状态" className="panorama-tree">
        <label>页面<select aria-label="页面" value={page} disabled={busy} onChange={event => choosePage(event.target.value)}>
          {paths.map(path => <option key={path}>{path}</option>)}
        </select></label>
        <ul>{paths.map(path => <li key={path}><button className="record-link" disabled={busy} aria-current={path === page ? 'page' : undefined}
          onClick={() => choosePage(path)}>{path}</button>
          <small>{inventory?.recipes.filter(recipe => recipe.path === path).length ?? 0} 个已采集状态</small>
          {path === page && states.length > 0 && <ul>{states.map(recipe => <li key={recipe.id}><button type="button" className="record-link" disabled={busy}
            aria-current={recipe.id === stateId ? 'true' : undefined} onClick={() => selectRequest({stateId: recipe.id})}>{recipe.label}</button>
            <small>左 {recipe.counts[left] ?? '—'} / 右 {recipe.counts[right] ?? '—'} 个问题</small></li>)}</ul>}
        </li>)}</ul>
        <label>交互状态<select aria-label="交互状态" value={active?.id ?? ''} disabled={busy || !states.length} onChange={event => selectRequest({stateId: event.target.value})}>
          {!active && <option value="">尚未采集</option>}
          {states.map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.label}</option>)}
        </select></label>
      </nav>
      <div className="panorama-main">
        {progress && <p role="status">{progress}… {job && <button type="button" className="secondary"
          onClick={() => void fetch('/api/jobs/' + job + '/cancel', {method: 'POST'})}>取消全景采集</button>}</p>}
        {error && <p role="alert">{error} <button type="button" className="secondary" onClick={() => setAttempt(value => value + 1)}>重试采集</button></p>}
        {result && !pair && <button type="button" className="secondary" disabled={busy} onClick={() => setAttempt(value => value + 1)}>重试未匹配侧</button>}
        {active && active.steps.length > 0 && <details className="panorama-steps"><summary>操作记录 · {active.steps.length} 步</summary>
          <ol>{active.steps.map((step, index) => <li key={index}>{stepName(step)}</li>)}</ol></details>}
        <div className="panorama-bar" role="group" aria-label="全景证据">
          {([['visual', '视觉对比'], ['semantics', '语义对比'], ['keyboard', '键盘对比']] as const).map(([key, label]) =>
            <button className="secondary" type="button" key={key} aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}
          {view === 'visual' && <><label><input type="checkbox" checked={full} onChange={event => setFull(event.target.checked)} />完整页面</label>
            <label><input type="checkbox" checked={sync} onChange={event => setSync(event.target.checked)} />同步滚动</label></>}
        </div>
        <div className="panorama-pair">
          <section><h3>左侧 · {versionName(state, left)}</h3>{renderSide(result?.left, 'left')}</section>
          <section><h3>右侧 · {versionName(state, right)}</h3>{renderSide(result?.right, 'right')}</section>
        </div>
        {pair && <p role="status">左右已匹配同一页面和状态。右侧较左侧解决 {resolved.length} 个问题，新增 {added.length} 个问题。
          {pair.some(item => item.manual || item.keyboard.status !== 'completed') && ' 仍有证据需要人工确认。'}</p>}
        {inventory?.interactive && <fieldset className="panorama-actions" disabled={busy || !canAct}>
          <legend>记录安全操作</legend>
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
        </fieldset>}
        <section className="panorama-findings" aria-label="当前状态问题">
          <h3>当前状态问题</h3>
          {findings.length > 0 ? <ul>{findings.map((item, index) => <li key={item.id + index}>
            <button type="button" className="record-link" onClick={() => {setIssue(item); setFull(true); setView('visual');}}>{item.help}</button>
            {' · '}<code>{item.selector}</code>
            {issue === item && <p>{item.description} {item.source && <code>{item.source.file}{item.source.line ? ':' + item.source.line : ''}</code>}
              {' '}<button type="button" className="secondary" disabled={busy || !stateId} onClick={() => stateId && onRepair(item, stateId, result?.right.status === 'captured' ? right : left)}>查看精准修复</button></p>}
          </li>)}</ul> : <p className="muted">{result && (result.left.status === 'captured' || result.right.status === 'captured') ? '此状态未检出自动化违规。' : '尚无状态检测证据。'}</p>}
        </section>
      </div>
    </div>
  </section>;
}
