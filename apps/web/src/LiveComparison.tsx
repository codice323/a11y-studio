import { workspaceFetch as fetch } from './workspace-fetch';
import { useEffect, useRef, useState } from 'react';
import type { scanLive } from '../../api/live-comparison';
import type { LiveAction, LiveComparison as LiveResult, LiveSide } from '../../../packages/shared/live-comparison';
import type { PageInspection } from './Panorama';

type Scan = Awaited<ReturnType<typeof scanLive>>;
type RepairState = {stateId:string;version:string;path:string;issue:Scan['findings'][number]};
const sides = ['left','right'] as const;
const label = {left:'左侧',right:'右侧'};
const dimensions = {route:'路由',dom:'DOM',semantics:'无障碍语义',focus:'焦点',visual:'画面'};

export function LiveComparison({ project, left, right, names, start, current, onInspection, onRepair, onClose }: {
  project:string; left:string; right:string; names:Record<LiveSide,string>; start?:string; current:string;
  onInspection:(value:PageInspection)=>void;
  onRepair:(value:RepairState)=>void; onClose:()=>void;
}) {
  const route = '/api/projects/'+encodeURIComponent(project)+'/live';
  const [session,setSession] = useState<LiveResult>();
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [sync,setSync] = useState(true);
  const [scanErrors,setScanErrors] = useState<Partial<Record<LiveSide,{path:string; reason:string}>>>({});
  const [scans,setScans] = useState<Partial<Record<LiveSide,Scan>>>({});
  const [targets,setTargets] = useState({left:'',right:''});
  const [keyboard,setKeyboard] = useState<LiveSide>();
  const lock = useRef(false);
  const screens = useRef<Partial<Record<LiveSide,HTMLButtonElement | null>>>({});
  const [restart,setRestart] = useState(0);
  const transition = useRef(Promise.resolve());
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    generation.current++;
    lock.current = true;
    setBusy(true);
    setError('');
    setSession(undefined);
    setScans({});
    setScanErrors({});
    setTargets({left:'',right:''});
    const opening = transition.current.then(() => active ? post<LiveResult>(route,{left,right,start}) : undefined);
    let openedId: string | undefined;
    function closeSession(id:string) {
      return fetch(route+'/'+id,{method:'DELETE',keepalive:true});
    }
    const closeOnPageExit = () => {
      if (openedId) void closeSession(openedId).catch(()=>{});
      else void opening.then(initial => initial && closeSession(initial.id)).catch(()=>{});
    };
    window.addEventListener('pagehide',closeOnPageExit);
    void opening.then(initial => {
      openedId = initial?.id;
      if (active) setSession(initial);
    }, problem => {
      if (active) setError((problem as Error).message);
    }).finally(() => {
      if (active) {setBusy(false);lock.current=false;}
    });
    return () => {
      active=false;
      window.removeEventListener('pagehide',closeOnPageExit);
      generation.current++;
      transition.current = opening.then(async initial => {
        if (initial) await closeSession(initial.id);
      }).catch(()=>{});
    };
  }, [route,left,right,start,restart]);

  async function run<T>(request:()=>Promise<T>, done:(value:T)=>void,failed?:(reason:string)=>void) {
    if (lock.current) return;
    const requestGeneration = generation.current;
    lock.current=true;
    setBusy(true);
    setError('');
    try {
      const value = await request();
      if (requestGeneration === generation.current) done(value);
    } catch (problem) {
      if (requestGeneration === generation.current) {
        const reason = (problem as Error).message;
        if (failed) failed(reason);
        else setError(reason);
      }
    } finally {
      if (requestGeneration === generation.current) {setBusy(false);lock.current=false;}
    }
  }

  function act(side:LiveSide, operation:LiveAction) {
    if (!session) return;
    void run(() => post<LiveResult>(route+'/'+session.id+'/action',{side,sync,revision:session.revision,operation}), next=>{
      setSession(next);
      setScans({});
      setScanErrors({});
      if (operation.action !== 'refresh') {
        setTargets({left:'',right:''});
        const currentFrame = left===current ? next.left : right===current ? next.right : undefined;
        if (currentFrame) onInspection({projectId:project,version:current,path:currentFrame.path,scoped:true,findings:[],scanStatus:'unscanned'});
      }
    });
  }

  useEffect(() => {
    const cleanup = sides.map(side => {
      const screen = screens.current[side];
      const wheel = (event:WheelEvent) => {
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 700 : 1;
        if (Math.abs(event.deltaY)>1) act(side,{action:'scroll',delta:Math.max(-1600,Math.min(1600,Math.round(event.deltaY*unit)))});
      };
      screen?.addEventListener('wheel',wheel,{passive:false});
      return () => screen?.removeEventListener('wheel',wheel);
    });
    return () => cleanup.forEach(remove=>remove());
  }, [session,sync]);

  function scan(side:LiveSide) {
    if (!session) return;
    void run(() => post<Scan>(route+'/'+session.id+'/scan/'+side), report=>{
      setScans(previous=>({...previous,[side]:report}));
      setScanErrors(previous=>({...previous,[side]:undefined}));
      if ((side==='left'?left:right)===current) onInspection({projectId:project,version:current,path:report.path,scoped:true,findings:report.findings,
        scanStatus:'scanned',review:{axe:report.incomplete.reduce((sum,rule)=>sum+rule.count,0),behavior:report.observations.length,behaviorStatus:'partial'}});
    },reason=>{
      setScans(previous=>({...previous,[side]:undefined}));
      setScanErrors(previous=>({...previous,[side]:{path:session[side].path,reason}}));
    });
  }

  function download() {
    const report = new Blob([JSON.stringify({versions:{left,right},scans,scanErrors,observations:session?.observations},null,2)],{type:'application/json'});
    const url = URL.createObjectURL(report);
    const anchor = document.createElement('a');
    anchor.href=url;
    anchor.download='live-accessibility-evidence.json';
    anchor.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  return <section aria-label="双侧实时浏览器">
    <div className="panorama-bar">
      <label><input type="checkbox" checked={sync} onChange={event=>setSync(event.target.checked)} />同步操作</label>
      <button type="button" className="secondary" disabled={busy||!session} onClick={()=>act('left',{action:'refresh'})}>刷新实时画面</button>
      <button type="button" className="secondary" disabled={!Object.values(scans).some(Boolean)&&!Object.values(scanErrors).some(Boolean)} onClick={download}>下载当前检测证据</button>
      <button type="button" className="secondary" onClick={onClose}>关闭实时浏览器</button>
    </div>
    <p className="muted">浏览器画面随操作更新。两侧在隔离 Chrome 中运行。输入使用固定测试值，表单只触发原生校验。实时会话最长 5 分钟。</p>
    {busy && <p role="status">{session?'浏览器正在执行操作…':'正在打开两个隔离浏览器…'}</p>}
    {error && <div className="panorama-bar"><p role="alert">{error}</p>
      <button type="button" className="secondary" disabled={busy} onClick={()=>setRestart(value=>value+1)}>重开实时会话</button></div>}
    {session?.outcome?.matched === false && <p role="alert">操作匹配失败 · {session.outcome.reason}</p>}
    {session?.outcome?.matched === true && <p role="status">已在两侧执行操作{session.outcome.target && ' · '+session.outcome.target}</p>}
    {session && <p className="muted">当前有差异的证据 · {
      (Object.keys(dimensions) as (keyof typeof dimensions)[]).filter(key=>session.differences[key]).map(key=>dimensions[key]).join('、') || '无'
    }</p>}
    {session && (scans.left || scans.right || session.observations.left.length > 0 || session.observations.right.length > 0) && <details>
      <summary>交互证据与差异</summary>
      <ul>{sides.flatMap(side=>session.observations[side].map((item,index)=><li key={side+index}>{label[side]} · 第 {item.step ?? '—'} 步 · {
        item.status==='confirmed'?'已确认异常':item.status==='observed'?'已观测':'待人工复核'
      } · {item.evidence}</li>))}</ul>
      {scans.left && scans.right && (scans.left.path===scans.right.path && scans.left.sequenceKey && scans.left.sequenceKey===scans.right.sequenceKey ? (() => {
        const lhs=scans.left;
        const rhs=scans.right;
        const removed=lhs.findings.filter(item=>!rhs.findings.some(other=>other.id===item.id));
        const added=rhs.findings.filter(item=>!lhs.findings.some(other=>other.id===item.id));
        const common=rhs.findings.length-added.length;
        const semanticLines=(scan:Scan)=>scan.ax.split('\n').map(line=>line.trim()).filter(Boolean);
        const before=semanticLines(lhs);
        const after=semanticLines(rhs);
        return <><p>同一路由与操作序列的状态证据 · 消失 {removed.length} 项 · 新增 {added.length} 项 · 仍存在 {common} 项。</p>
          <ul>{before.filter(line=>!after.includes(line)).slice(0,6).map((line,i)=><li key={'before'+i}>仅左侧 · <code>{line}</code></li>)}
            {after.filter(line=>!before.includes(line)).slice(0,6).map((line,i)=><li key={'after'+i}>仅右侧 · <code>{line}</code></li>)}</ul></>;
      })() : <p>两侧路由或可核对的操作序列不同，暂不判定新增或消失的问题。</p>)}
    </details>}
    {session && <div className="panorama-pair">
      {sides.map(side=>{
        const frame = session[side];
        const target = frame.controls[Number(targets[side])];
        const report = scans[side];
        return <section key={side} aria-label={label[side]+'实时浏览器'}>
          <h3>{label[side]} · {names[side]}</h3>
          {session.modes[side]==='snapshot' && <p className="muted">受限快照 · 原网站脚本不执行，只支持本地导航与浏览器原生控件。</p>}
          <p><code>{frame.path}</code>{frame.title && ' · '+frame.title} · 滚动 {frame.scroll}px · 焦点 {frame.focus||'文档'}</p>
          <button type="button" className="live-screen" ref={element=>{screens.current[side]=element;}} aria-label={label[side]+'可操作网页画面'} aria-disabled={busy} onClick={event=>{
            if (event.detail===0) {act(side,{action:'activate'});return;}
            const rect=event.currentTarget.getBoundingClientRect();
            act(side,{action:'click',x:Math.min(899,Math.max(0,Math.floor((event.clientX-rect.left)/rect.width*900))),
              y:Math.min(699,Math.max(0,Math.floor((event.clientY-rect.top)/rect.height*700)))});
          }} onKeyDown={event=>{
            if (event.key==='Escape' && event.shiftKey) {event.preventDefault();setKeyboard(undefined);return;}
            if (keyboard!==side || !['Tab','Escape','Enter',' '].includes(event.key)) return;
            event.preventDefault();
            act(side,{action:event.key==='Tab' ? event.shiftKey?'shift-tab':'tab' : event.key==='Escape'?'escape':'activate'});
          }}><img draggable={false} alt="" src={frame.image} width={900} height={700} /></button>
          <div className="panorama-bar">
            <label><input type="checkbox" checked={keyboard===side} onChange={event=>setKeyboard(event.target.checked?side:undefined)} />转发网页画面中的 Tab（Shift+Esc 退出）</label>
            <button type="button" className="secondary" disabled={busy} onClick={()=>act(side,{action:'tab'})}>Tab</button>
            <button type="button" className="secondary" disabled={busy} onClick={()=>act(side,{action:'escape'})}>Esc</button>
            <button type="button" className="secondary" disabled={busy} onClick={()=>act(side,{action:'scroll',delta:-360})}>向上滚动</button>
            <button type="button" className="secondary" disabled={busy} onClick={()=>act(side,{action:'scroll',delta:360})}>向下滚动</button>
            <label>缩放<select disabled={busy} value={frame.zoom} onChange={event=>act(side,{action:'zoom',percent:Number(event.target.value) as 75|100|125|150})}>
              {[75,100,125,150].map(percent=><option key={percent} value={percent}>{percent}%</option>)}
            </select></label>
          </div>
          <div className="panorama-bar">
            <label>语义控件<select value={targets[side]} disabled={busy} onChange={event=>setTargets({...targets,[side]:event.target.value})}>
              <option value="">选择控件</option>
              {frame.controls.map((control,index)=><option key={index} value={index}>{control.name} ({control.role})</option>)}
            </select></label>
            <button type="button" className="secondary" disabled={busy||!targets[side]||!target} onClick={()=>act(side,{action:'click',target})}>操作控件</button>
            <button type="button" className="secondary" disabled={busy||!targets[side]||target?.role!=='textbox'} onClick={()=>act(side,{action:'fill',target})}>填入测试值</button>
            <button type="button" className="secondary" disabled={busy} onClick={()=>scan(side)}>检测当前状态</button>
          </div>
          {scanErrors[side] && <p role="alert">状态检测未完成 · {scanErrors[side].reason}</p>}
          {report && <p role="status">当前状态检测完成 · {report.violations.reduce((sum,rule)=>sum+rule.targets.length,0)} 项确定性违规 · {report.incomplete.reduce((sum,rule)=>sum+rule.count,0)} 项 axe 待复核 · {report.observations.filter(item=>item.status==='confirmed').length} 项已确认行为异常（会话累计） · {report.observations.filter(item=>item.status==='needs-review').length} 项操作待复核
            {Boolean(report.media.length) && ' · 已记录媒体轨道，请在证据中复核字幕与音频描述'}</p>}
          {report && report.version===current && report.repairable.length>0 && <details>
            <summary>定位可修复的问题</summary>
            <ul>{report.findings.filter(item=>report.repairable.includes(item.id)).map(item=><li key={item.id}>
              <button type="button" className="secondary" disabled={busy} onClick={()=>void run(
                ()=>post<RepairState>(route+'/'+session.id+'/repair-state',{side,stateId:report.id,issueId:item.id}),onRepair
              )}>在诊断中修复 {item.selector}</button>
            </li>)}</ul>
          </details>}
        </section>;
      })}
    </div>}
  </section>;
}

async function post<T>(path:string,body?:unknown):Promise<T> {
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body??{})});
  const value=await response.json();
  if (!response.ok) throw new Error(value.error??'实时浏览器请求失败。');
  return value;
}
