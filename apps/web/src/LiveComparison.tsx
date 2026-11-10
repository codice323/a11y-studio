import { workspaceFetch as fetch } from './workspace-fetch';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { scanLive } from '../../api/live-comparison';
import type { LiveAction, LiveComparison as LiveResult, LiveSide } from '../../../packages/shared/live-comparison';
import type { PageInspection } from './Panorama';

type Scan = Awaited<ReturnType<typeof scanLive>>;
type RepairState = {stateId:string;version:string;path:string;issue:Scan['findings'][number]};
const sides = ['left','right'] as const;
const label = {left:'左侧',right:'右侧'};
const actionNames: Record<LiveAction['action'],string> = {
  click:'点击',activate:'激活控件',fill:'填入测试值',validate:'表单验证',tab:'Tab','shift-tab':'Shift+Tab',
  escape:'Esc',refresh:'重新获取画面',scroll:'滚动',zoom:'缩放',
};
type Activity = { time:string; title:string; detail:string };
const dimensions = {route:'路由',dom:'DOM',semantics:'无障碍语义',focus:'焦点',visual:'画面'};

export function LiveComparison({ project, left, right, names, start, current, onInspection, onRepair, onClose, versions, projectMode }: {
  project:string; left:string; right:string; names:Record<LiveSide,string>; start?:string; current:string;
  onInspection:(value:PageInspection)=>void;
  onRepair:(value:RepairState)=>void; onClose:()=>void; versions?:ReactNode; projectMode?:'snapshot'|'static-source'|'react-source';
}) {
  const route = '/api/projects/'+encodeURIComponent(project)+'/live';
  const [session,setSession] = useState<LiveResult>();
  const [error,setError] = useState('');
  const [task,setTask] = useState('');
  const [recordOpen,setRecordOpen] = useState(false);
  const activity = useRef<Activity[]>([]);
  const busy = Boolean(task);
  const [sync,setSync] = useState(true);
  const [scanErrors,setScanErrors] = useState<Partial<Record<LiveSide,{path:string; reason:string}>>>({});
  const [scans,setScans] = useState<Partial<Record<LiveSide,Scan>>>({});
  const [targets,setTargets] = useState({left:'',right:''});
  const [advanced,setAdvanced] = useState(false);
  const [keyboard,setKeyboard] = useState<LiveSide>();
  const lock = useRef(false);
  const latest = useRef<LiveResult|undefined>(undefined);
  const scrollQueue = useRef<{side:LiveSide;delta:number;x?:number;y?:number}[]>([]);
  const scrollTimer = useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const pump = useRef<()=>void>(()=>{});
  const syncRef = useRef(true);
  const drag = useRef<{id:number;y:number;travel:number}|undefined>(undefined);
  const dragged = useRef(false);
  const screens = useRef<Partial<Record<LiveSide,HTMLButtonElement | null>>>({});
  const [restart,setRestart] = useState(0);
  const transition = useRef(Promise.resolve());
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    generation.current++;
    lock.current = true;
    setTask('正在打开网页对比…');
    setError('');
    latest.current=undefined;
    setSession(undefined);
    setScans({});
    setScanErrors({});
    setTargets({left:'',right:''});
    activity.current=[];
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
    void opening.then(async initial => {
      openedId = initial?.id;
      if (active && initial) {
        await decodeFrames(initial);
        if (active) {latest.current=initial;setSession(initial);}
      }
    }, problem => {
      if (active) setError((problem as Error).message);
    }).catch(problem=>{if (active) setError((problem as Error).message);}).finally(() => {
      if (active) {setTask('');lock.current=false;}
    });
    return () => {
      active=false;
      window.removeEventListener('pagehide',closeOnPageExit);
      generation.current++;
      clearTimeout(scrollTimer.current);
      scrollTimer.current=undefined;
      scrollQueue.current=[];
      transition.current = opening.then(async initial => {
        if (initial) await closeSession(initial.id);
      }).catch(()=>{});
    };
  }, [route,left,right,start,restart]);

  function record(title:string, detail:string) {
    activity.current.push({time:new Date().toISOString(),title,detail});
    if (activity.current.length>100) activity.current.shift();
  }

  async function run<T>(request:()=>Promise<T>, done:(value:T)=>void,failed?:(reason:string)=>void, feedback?:string) {
    if (lock.current) {
      if (feedback) setError('这次操作未执行，请稍后重试。');
      return;
    }
    const requestGeneration = generation.current;
    lock.current=true;
    if (feedback) {setTask(feedback);setError('');}
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
      if (requestGeneration === generation.current) {if (feedback) setTask('');lock.current=false;pump.current();}
    }
  }

  function act(side:LiveSide, operation:LiveAction) {
    const previous=latest.current;
    if (!previous) return;
    if (lock.current) {
      if (operation.action==='click' && 'x' in operation) setError('这次点击未执行，请再点一次。');
      return;
    }
    if (operation.action!=='scroll') scrollQueue.current=[];
    let refreshed=false;
    void run(async ()=>{
      const endpoint=route+'/'+previous.id+'/action';
      const send=(operation:LiveAction)=>post<LiveResult>(endpoint,{side,sync:syncRef.current,revision:previous.revision,operation});
      const next=await send(operation).catch(problem=>{
        if (operation.action!=='click' || !(problem instanceof Error) || !problem.message.includes('点击画面已经过期')) throw problem;
        refreshed=true;
        return send({action:'refresh'});
      });
      if (next.id!==previous.id || next.revision<=previous.revision) throw new Error('收到过期画面，请刷新。');
      await decodeFrames(next,previous);
      return next;
    },next=>{
      for (const side of sides) if (!next[side].image) next[side].image=previous[side].image;
      latest.current=next;
      const outcome=next.outcome;
      if (refreshed) {
        record(label[side]+'点击未执行','页面已变化，已重新获取画面。请再点击目标。');
        setError('页面已变化，已重新获取画面，请再点击目标。');
      } else if (outcome) {
        const paths=sides.filter(key=>previous[key].path!==next[key].path)
          .map(key=>label[key]+' '+previous[key].path+' → '+next[key].path);
        const positions=sides.flatMap(key=>outcome.scroll?.[key] ? [label[key]+' '+outcome.scroll[key].position+'px'] : []);
        const result=outcome.matched===true?'两侧已同步':outcome.matched===false?'同步失败 · '+(outcome.reason??'请重试')+'。可核对目标或关闭同步后重试。':'仅操作当前侧';
        record(label[side]+actionNames[operation.action]+(outcome.target?' · '+outcome.target:''),[result,...paths,...positions].join('；'));
        if (operation.action!=='scroll') setError('');
      }
      setSession(next);
      if (operation.action!=='scroll' || next.capture.count>0) {
        setScans({});
        setScanErrors({});
      }
      if (operation.action !== 'refresh' && operation.action !== 'scroll') {
        setTargets({left:'',right:''});
        const currentFrame = left===current ? next.left : right===current ? next.right : undefined;
        if (currentFrame) onInspection({projectId:project,version:current,path:currentFrame.path,scoped:true,findings:[],scanStatus:'unscanned'});
      }
    },reason=>{
      scrollQueue.current=[];
      record(label[side]+actionNames[operation.action]+'失败',reason);
      setError(reason);
    },operation.action==='refresh'?'正在重新获取画面…':undefined);
  }

  pump.current=()=>{
    if (!latest.current || lock.current || scrollTimer.current || !scrollQueue.current.length) return;
    scrollTimer.current=setTimeout(()=>{
      scrollTimer.current=undefined;
      if (lock.current) return;
      const next=scrollQueue.current.shift();
      if (!next) return;
      const delta=Math.round(next.delta);
      if (delta) {
        const applied=Math.max(-1600,Math.min(1600,delta));
        if (delta!==applied) scrollQueue.current.unshift({...next,delta:delta-applied});
        act(next.side,{action:'scroll',delta:applied,x:next.x,y:next.y});
      } else pump.current();
    },45);
  };

  function enqueueScroll(side:LiveSide,delta:number,point?:{x:number;y:number}) {
    if (!Number.isFinite(delta) || !delta) return;
    const queue=scrollQueue.current;
    const tail=queue.at(-1);
    if (tail?.side===side) Object.assign(tail,{...point,delta:Math.max(-6400,Math.min(6400,tail.delta+delta))});
    else if (queue.length<8) queue.push({side,delta,...point});
    pump.current();
  }

  const scrollInput=useRef(enqueueScroll);
  scrollInput.current=enqueueScroll;
  useEffect(() => {
    if (!session?.id) return;
    const cleanup = sides.map(side => {
      const screen = screens.current[side];
      const wheel = (event:WheelEvent) => {
        if (!screen || event.ctrlKey || !event.deltaY || Math.abs(event.deltaY)<Math.abs(event.deltaX)) return;
        const underPointer=document.elementFromPoint(event.clientX,event.clientY);
        if (!screen.matches(':hover') || !screen.contains(underPointer)) return;
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 700 : 1;
        scrollInput.current(side,event.deltaY*unit,screenPoint(screen,event.clientX,event.clientY));
      };
      screen?.addEventListener('wheel',wheel,{passive:false});
      return () => screen?.removeEventListener('wheel',wheel);
    });
    return () => cleanup.forEach(remove=>remove());
  }, [session?.id]);

  function scan(side:LiveSide) {
    if (!session) return;
    void run(() => post<Scan>(route+'/'+session.id+'/scan/'+side), report=>{
      record(label[side]+'检测完成',report.path+' · '+report.findings.length+' 项确定性违规 · '+report.incomplete.reduce((sum,item)=>sum+item.count,0)+' 项待复核');
      setScans(previous=>({...previous,[side]:report}));
      setScanErrors(previous=>({...previous,[side]:undefined}));
      if ((side==='left'?left:right)===current) onInspection({projectId:project,version:current,path:report.path,scoped:true,findings:report.findings,
        scanStatus:'scanned',review:{axe:report.incomplete.reduce((sum,rule)=>sum+rule.count,0),behavior:report.observations.length,behaviorStatus:'partial'}});
    },reason=>{
      record(label[side]+'检测失败',reason);
      setScans(previous=>({...previous,[side]:undefined}));
      setScanErrors(previous=>({...previous,[side]:{path:session[side].path,reason}}));
    },'正在检测'+label[side]+'状态…');
  }

  function download() {
    const report = new Blob([JSON.stringify({versions:{left,right},scans,scanErrors,operations:activity.current,observations:session?.observations},null,2)],{type:'application/json'});
    const url = URL.createObjectURL(report);
    const anchor = document.createElement('a');
    anchor.href=url;
    anchor.download='live-accessibility-evidence.json';
    anchor.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  return <section aria-label="双侧网页交互对比" data-live-revision={session?.revision}>
    <div className="live-toolbar panorama-bar">
      {versions}
      <label><input type="checkbox" checked={sync} onChange={event=>{
        scrollQueue.current=[];
        syncRef.current=event.target.checked;
        setSync(event.target.checked);
      }} />同步操作</label>
      <button type="button" className="secondary" aria-expanded={advanced} aria-controls="live-options" onClick={()=>setAdvanced(value=>!value)}>更多操作</button>
      <button type="button" className="secondary" onClick={onClose}>退出对比</button>
    </div>
    <span className="screen-reader-only" role="status">{task}</span>
    {!session && task && <p aria-hidden="true" className="live-connection">{task}</p>}
    <div id="live-options" hidden={!advanced} className="live-options">
      <div className="panorama-bar">
        <button type="button" className="secondary" disabled={busy||!session} onClick={()=>act('left',{action:'refresh'})}>重新获取画面</button>
        {sides.map(side=><button key={side} type="button" className="secondary" disabled={busy||!session}
          onClick={()=>scan(side)}>检测{label[side]}状态</button>)}
        <button type="button" className="secondary" disabled={!activity.current.length} onClick={download}>下载操作与检测记录</button>
      </div>
      <details><summary>页面信息</summary>
        <p>导入类型 · {projectMode==='react-source'?'React 源码工程':projectMode==='static-source'?'静态源码工程':'静态网页（HTML、ZIP 或 URL）'}</p>
        <p>{session?.modes.left==='source' && session.modes.right==='source'
          ? '隔离环境支持站内导航和本地脚本交互。输入使用测试值，禁止真实提交。'
          : '静态页面支持站内导航与原生控件，原网站脚本不执行，依赖脚本的菜单、弹窗等操作可能不可用。'}</p>
      </details>
    </div>
    {session && <details className="live-record" onToggle={event=>setRecordOpen(event.currentTarget.open)}>
      <summary>操作记录</summary>
      {recordOpen && <div className="live-record-content">
      {activity.current.length ? <ol>{activity.current.map((item,index)=><li key={index}>
        <time dateTime={item.time}>{new Date(item.time).toLocaleTimeString()}</time> · <b>{item.title}</b> · {item.detail}
      </li>)}</ol> : <p className="muted">暂无操作。</p>}
      <p>{(Object.keys(dimensions) as (keyof typeof dimensions)[]).filter(key=>session.differences[key]).map(key=>dimensions[key]).join('、') || '暂无可见差异'}</p>
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
      </div>}
    </details>}
    {session && <div className="panorama-pair live-pair">
      {sides.map(side=>{
        const frame = session[side];
        const target = frame.controls[Number(targets[side])];
        const report = scans[side];
        return <section key={side} aria-label={label[side]+'网页交互对比'}>
          <h3>{label[side]} · {names[side]}</h3>
          <button type="button" className="live-screen" ref={element=>{screens.current[side]=element;}} aria-label={label[side]+'可操作网页画面'} onClick={event=>{
            if (dragged.current) {dragged.current=false;return;}
            if (event.detail===0) {act(side,{action:'activate'});return;}
            act(side,{action:'click',...screenPoint(event.currentTarget,event.clientX,event.clientY)});
          }} onPointerDown={event=>{
            dragged.current=false;
            if (event.pointerType!=='touch') return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current={id:event.pointerId,y:event.clientY,travel:0};
          }} onPointerMove={event=>{
            const gesture=drag.current;
            if (gesture?.id!==event.pointerId) return;
            const delta=gesture.y-event.clientY;
            gesture.y=event.clientY;
            gesture.travel+=Math.abs(delta);
            if (gesture.travel<5) return;
            dragged.current=true;
            enqueueScroll(side,delta*700/event.currentTarget.clientHeight,screenPoint(event.currentTarget,event.clientX,event.clientY));
          }} onLostPointerCapture={()=>{drag.current=undefined;}} onKeyDown={event=>{
            if (event.key==='Escape' && event.shiftKey) {event.preventDefault();setKeyboard(undefined);return;}
            const delta=({ArrowUp:-48,ArrowDown:48,PageUp:-600,PageDown:600} as Record<string,number>)[event.key];
            if (delta) {event.preventDefault();enqueueScroll(side,delta);return;}
            if (keyboard!==side || !['Tab','Escape','Enter',' '].includes(event.key)) return;
            event.preventDefault();
            act(side,{action:event.key==='Tab' ? event.shiftKey?'shift-tab':'tab' : event.key==='Escape'?'escape':'activate'});
          }}><img draggable={false} alt="" src={frame.image} width={900} height={700} /></button>
          <details className="live-more" hidden={!advanced}>
            <summary>{label[side]}更多操作</summary>
            <p className="muted">{frame.path} · 焦点 {frame.focus||'文档'} · 滚动 {frame.scroll}px。聚焦画面后可用方向键或翻页键滚动。隔离浏览器使用固定测试值，禁止真实提交，会话最长 5 分钟。</p>
            <div className="panorama-bar">
              <label><input type="checkbox" checked={keyboard===side} onChange={event=>setKeyboard(event.target.checked?side:undefined)} />转发网页画面中的 Tab（Shift+Esc 退出）</label>
              <button type="button" className="secondary" disabled={busy} onClick={()=>act(side,{action:'tab'})}>Tab</button>
              <button type="button" className="secondary" disabled={busy} onClick={()=>act(side,{action:'escape'})}>Esc</button>
              <label>缩放<select disabled={busy} value={frame.zoom} onChange={event=>act(side,{action:'zoom',percent:Number(event.target.value) as 75|100|125|150})}>
                {[75,100,125,150].map(percent=><option key={percent} value={percent}>{percent}%</option>)}
              </select></label>
              <label>语义控件<select value={targets[side]} disabled={busy} onChange={event=>setTargets({...targets,[side]:event.target.value})}>
                <option value="">选择控件</option>
                {frame.controls.map((control,index)=><option key={index} value={index}>{control.name} ({control.role})</option>)}
              </select></label>
              <button type="button" className="secondary" disabled={busy||!targets[side]||!target} onClick={()=>act(side,{action:'click',target})}>操作控件</button>
              <button type="button" className="secondary" disabled={busy||!targets[side]||target?.role!=='textbox'} onClick={()=>act(side,{action:'fill',target})}>填入测试值</button>
            </div>
          </details>
          {scanErrors[side] && <p role="alert">状态检测未完成 · {scanErrors[side].reason}</p>}
          {report && <p role="status">当前状态检测完成 · {report.violations.reduce((sum,rule)=>sum+rule.targets.length,0)} 项确定性违规 · {report.incomplete.reduce((sum,rule)=>sum+rule.count,0)} 项 axe 待复核 · {report.observations.filter(item=>item.status==='confirmed').length} 项已确认行为异常（会话累计） · {report.observations.filter(item=>item.status==='needs-review').length} 项操作待复核
            {Boolean(report.media.length) && ' · 已记录媒体轨道，请在证据中复核字幕与音频描述'}</p>}
          {report && report.version===current && report.repairable.length>0 && <details>
            <summary>定位可修复的问题</summary>
            <ul>{report.findings.filter(item=>report.repairable.includes(item.id)).map(item=><li key={item.id}>
              <button type="button" className="secondary" disabled={busy} onClick={()=>void run(
                ()=>post<RepairState>(route+'/'+session.id+'/repair-state',{side,stateId:report.id,issueId:item.id}),onRepair,undefined,'正在打开修复证据…'
              )}>在诊断中修复 {item.selector}</button>
            </li>)}</ul>
          </details>}
        </section>;
      })}
    </div>}
    {error && <div className="panorama-bar live-feedback"><p role="alert">{error}</p>
      {(!session || /会话已|会话过期|过期画面/.test(error)) && <button type="button" className="secondary" disabled={busy} onClick={()=>setRestart(value=>value+1)}>重新打开对比</button>}
      <button type="button" className="secondary" onClick={()=>setError('')}>关闭提示</button></div>}
    {session?.outcome?.matched === false && <p className="live-feedback" role="alert">操作匹配失败 · {session.outcome.reason}。可核对目标，或关闭同步后重试。</p>}
  </section>;
}

function screenPoint(screen:HTMLElement,clientX:number,clientY:number) {
  const rect=screen.getBoundingClientRect();
  return {x:Math.min(899,Math.max(0,Math.floor((clientX-rect.left)/rect.width*900))),
    y:Math.min(699,Math.max(0,Math.floor((clientY-rect.top)/rect.height*700)))};
}

async function decodeFrames(next:LiveResult,previous?:LiveResult) {
  await Promise.all(sides.map(async side=>{
    if (!next[side].image || next[side].image===previous?.[side].image) return;
    const image=new Image();
    image.src=next[side].image;
    await image.decode();
  }));
}

async function post<T>(path:string,body?:unknown):Promise<T> {
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body??{})});
  const value=await response.json();
  if (!response.ok) throw new Error(value.error??'网页交互对比请求失败。');
  return value;
}
