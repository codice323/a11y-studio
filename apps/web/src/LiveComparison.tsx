import { pageLocationMessage } from './page-location';
import { createPortal } from 'react-dom';
import { workspaceFetch as fetch } from './workspace-fetch';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { scanLive } from '../../api/live-comparison';
import type { LiveAction, LiveComparison as LiveResult, LiveSide } from '../../../packages/shared/live-comparison';
import { liveEditingKeys } from '../../../packages/shared/live-comparison';
import type { PageInspection } from './Panorama';
import type { PageDiagnostics, PageTarget, WorkspacePageDiagnostics } from '../../../packages/shared/page-diagnostics';

type Scan = Awaited<ReturnType<typeof scanLive>>;
type RepairState = {stateId:string;version:string;path:string;issue:Scan['findings'][number]};
const sides = ['left','right'] as const;
const label = {left:'左侧',right:'右侧'};
const actionNames: Record<LiveAction['action'],string> = {
  click:'点击',activate:'激活控件',fill:'填入测试值',validate:'表单验证',tab:'Tab','shift-tab':'Shift+Tab',
  escape:'Esc',back:'返回上一页',locate:'定位',refresh:'重新获取画面',scroll:'滚动',zoom:'缩放',
  text:'输入文字',key:'按键',
};
const editingKeys = new Set<string>(liveEditingKeys);
type Activity = { time:string; title:string; detail:string };
const savedSessionKey = 'a11y-studio:live-comparison-session';
const dimensions = {route:'路由',dom:'DOM',semantics:'无障碍语义',focus:'焦点',visual:'画面'};

export function LiveComparison({ project, left, right, names, start, current, onInspection, onRepair, onClose, versions, projectMode, proposalId, toolsHost, leftSelector, rightSelector, stateId, transition, onDiagnostics, diagnosticsCache, scanRevision=0, target, entryTargetPath, single=false, initialScroll, positionRef, onOpenUncapturedLink }: {
  single?:boolean; initialScroll?:number; positionRef?:{current:number}; project:string; left:string; right:string; names:Record<LiveSide,string>; start?:string; current:string;
  onInspection:(value:PageInspection)=>void;
  onDiagnostics?:(value:WorkspacePageDiagnostics)=>void;
  onOpenUncapturedLink?:(url:string)=>void;
  diagnosticsCache?:Map<string,PageDiagnostics>; scanRevision?:number; target?:PageTarget; entryTargetPath?:string;
  transition:{current:Promise<void>}; proposalId?:string; toolsHost?:HTMLDivElement|null; stateId?:string; leftSelector?:string; rightSelector?:string;
  onRepair:(value:RepairState)=>void; onClose?:()=>void; versions?:ReactNode; projectMode?:'snapshot'|'static-source'|'react-source';
}) {
  const route = '/api/projects/'+encodeURIComponent(project)+'/live';
  const [session,setSession] = useState<LiveResult>();
  const [error,setError] = useState('');
  const [uncapturedLink,setUncapturedLink] = useState<{url:string;reason:string}>();
  const [task,setTask] = useState('');
  const [recordOpen,setRecordOpen] = useState(false);
  const activity = useRef<Activity[]>([]);

  const [sync,setSync] = useState(!single);
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
  const syncRef = useRef(!single);
  const drag = useRef<{id:number;y:number;travel:number}|undefined>(undefined);
  const dragged = useRef(false);
  const screens = useRef<Partial<Record<LiveSide,HTMLButtonElement | null>>>({});
  const typing = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [restart,setRestart] = useState(0);
  const generation = useRef(0);
  const [diagnosticSide,setDiagnosticSide] = useState<LiveSide>(single || right === current ? 'right' : 'left');
  const diagnosticLock = useRef(false);
  const busy = Boolean(task);
  const pendingActions = useRef<{side:LiveSide;operation:LiveAction}[]>([]);
  const resumeActions = useRef<()=>void>(()=>{});
  const [settled,setSettled] = useState(0);
  const diagnosedRevision = useRef(scanRevision);
  const notify = useRef(onDiagnostics);
  notify.current = onDiagnostics;
  const diagnosticsEnabled = Boolean(onDiagnostics);
  const activePath = session?.[diagnosticSide].path;
  const activeTitle = session?.[diagnosticSide].title;
  const activeVersion = diagnosticSide === 'left' ? left : right;
  const diagnosticSession = session?.id;
  const activePageScope = JSON.stringify([project,activeVersion,activePath]);
  useEffect(() => {
    let active = true;
    generation.current++;
    setUncapturedLink(undefined);
    lock.current = true;
    diagnosticLock.current = false;
    setTask(single ? '正在打开网页…' : '正在打开网页对比…');
    setError('');
    latest.current=undefined;
    if (diagnosticsEnabled && !target) notify.current?.({kind:'live',projectId:project,version:single || right === current ? right : left,path:'',status:'pending'});
    setSession(undefined);
    setDiagnosticSide(single || right === current ? 'right' : 'left');
    setScans({});
    setScanErrors({});
    setTargets({left:'',right:''});
    activity.current=[];
    const input = {single,initialScroll,left,right,start,proposalId,stateId,selectors:leftSelector||rightSelector?{left:leftSelector,right:rightSelector}:undefined};
    const opening = transition.current.then(async () => {
      // A full-page reload can finish closing its old session after the new page mounts.
      for (let attempt=0; active; attempt++) {
        try {
          const replaceSession = sessionStorage.getItem(savedSessionKey);
          return await post<LiveResult>(route,{...input,replaceSession:replaceSession || undefined});
        }
        catch (problem) {
          if (attempt >= 9 || !(problem instanceof Error) || problem.message !== '当前已有实时对比，请先关闭另一处预览。') throw problem;
          await new Promise(resolve=>window.setTimeout(resolve,200));
        }
      }
    });
    let openedId: string | undefined;
    function closeSession(id:string) {
      return fetch(route+'/'+id,{method:'DELETE',keepalive:true}).then(response=>{
        if (response.ok && sessionStorage.getItem(savedSessionKey)===id) sessionStorage.removeItem(savedSessionKey);
      });
    }
    const closeOnPageExit = () => {
      if (openedId) void closeSession(openedId).catch(()=>{});
      else void opening.then(initial => initial && closeSession(initial.id)).catch(()=>{});
    };
    window.addEventListener('pagehide',closeOnPageExit);
    void opening.then(async initial => {
      openedId = initial?.id;
      if (active && initial) {
        sessionStorage.setItem(savedSessionKey,initial.id);
        await decodeFrames(initial);
        if (active) {latest.current=initial;setSession(initial);}
      }
    }, problem => {
      if (active) {
        const message = (problem as Error).message;
        setError(message);
        notify.current?.({kind:'live',projectId:project,version:single || right === current ? right : left,path:'',status:'failed',error:message});
      }
    }).catch(problem=>{if (active) setError((problem as Error).message);}).finally(() => {
      if (active) {setTask('');lock.current=false;setSettled(value=>value+1);}
    });
    return () => {
      active=false;
      window.removeEventListener('pagehide',closeOnPageExit);
      generation.current++;
      clearTimeout(scrollTimer.current);
      scrollTimer.current=undefined;
      scrollQueue.current=[];
      pendingActions.current=[];
      composing.current=false;
      transition.current = opening.then(async initial => {
        if (initial) await closeSession(initial.id);
      }).catch(()=>{});
    };
  }, [route,left,right,start,restart,proposalId,leftSelector,rightSelector,stateId,transition,current,diagnosticsEnabled,project,single,initialScroll]);

  useEffect(() => {
    if (positionRef && session) positionRef.current = session.right.scroll;
  }, [positionRef, session]);

  function record(title:string, detail:string) {
    activity.current.push({time:new Date().toISOString(),title,detail});
    if (activity.current.length>100) activity.current.shift();
  }

  async function run<T>(request:()=>Promise<T>, done:(value:T)=>void,failed?:(reason:string)=>void, feedback?:string) {
    if (lock.current && diagnosticLock.current) {
      const pending = generation.current;
      while (diagnosticLock.current && generation.current === pending) await new Promise(resolve=>window.setTimeout(resolve,40));
      if (generation.current !== pending) return;
    }
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
      if (requestGeneration === generation.current) {if (feedback) setTask('');lock.current=false;setSettled(value=>value+1);resumeActions.current();}
    }
  }

  function act(side:LiveSide, operation:LiveAction, onComplete?:(ok:boolean)=>void) {
    const previous=latest.current;
    if (!previous) return false;
    if (lock.current) {
      if (!diagnosticLock.current && operation.action==='click' && 'x' in operation) {
        setError('这次点击未执行，请再点一次。');
        return false;
      }
      const last=pendingActions.current.at(-1);
      if (last?.side===side && last.operation.action==='text' && operation.action==='text' &&
        last.operation.text.length+operation.text.length<=500) {
        last.operation.text+=operation.text;
      } else if (pendingActions.current.length<64) {
        pendingActions.current.push({side,operation});
      } else {
        setError('还有操作正在处理，请稍后再试。');
        return false;
      }
      return true;
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
      if (operation.action==='scroll' && operation.x !== undefined && outcome?.scrollRemainder && screens.current[side]?.matches(':hover')) {
        let remaining=outcome.scrollRemainder;
        for (let el=screens.current[side]?.parentElement; el && el!==document.scrollingElement && Math.abs(remaining)>1; el=el.parentElement) {
          if (!/^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY)) continue;
          const before=el.scrollTop;
          el.scrollBy({top:remaining,behavior:'instant'});
          remaining-=el.scrollTop-before;
        }
        if (Math.abs(remaining)>1) window.scrollBy({top:remaining,behavior:'instant'});
      }
      if (operation.action!=='scroll') {
        setUncapturedLink(outcome?.uncapturedUrl && outcome.reason ? {url:outcome.uncapturedUrl,reason:outcome.reason} : undefined);
      }
      if (refreshed) {
        pendingActions.current=pendingActions.current.filter(item=>item.side!==side || !['text','key'].includes(item.operation.action));
        record(label[side]+'点击未执行','页面已变化，已重新获取画面。请再点击目标。');
        setError('页面已变化，已重新获取画面，请再点击目标。');
      } else if (outcome) {
        const paths=sides.filter(key=>previous[key].path!==next[key].path)
          .map(key=>label[key]+' '+previous[key].path+' → '+next[key].path);
        const positions=sides.flatMap(key=>outcome.scroll?.[key] ? [label[key]+' '+outcome.scroll[key].position+'px'] : []);
        const result=outcome.matched===true?'两侧已同步':outcome.matched===false?'同步失败 · '+(outcome.reason??'请重试')+'。可核对目标或关闭同步后重试。':'仅操作当前侧';
        record(label[side]+actionNames[operation.action]+(outcome.target?' · '+outcome.target:''),[result,...paths,...positions].join('；'));
        if (outcome.executions?.[side]?.status==='failed') {
          if (operation.action==='click') pendingActions.current=pendingActions.current.filter(item=>item.side!==side || !['text','key'].includes(item.operation.action));
          setError(outcome.reason ?? '网页操作未执行。');
        }
        else if (operation.action!=='scroll') setError('');
      }
      setSession(next);
      onComplete?.(outcome?.executions?.[side]?.status!=='failed');
      if (operation.action !== 'locate' && operation.action !== 'refresh' && operation.action !== 'scroll') {
        setDiagnosticSide(syncRef.current && next.left.path === next.right.path && right === current && !proposalId ? 'right' : side);
      }
      if (operation.action!=='scroll' || next.capture.count>0) {
        setScans({});
        setScanErrors({});
      }
      if (operation.action !== 'refresh' && operation.action !== 'scroll' && operation.action !== 'locate') {
        setTargets({left:'',right:''});
        const currentFrame = left===current ? next.left : right===current ? next.right : undefined;
        if (currentFrame) onInspection({projectId:project,version:current,path:currentFrame.path,scoped:true,findings:[],scanStatus:'unscanned'});
      }
    },reason=>{
      scrollQueue.current=[];
      pendingActions.current=[];
      record(label[side]+actionNames[operation.action]+'失败',reason);
      setError(reason);
      onComplete?.(false);
    },operation.action==='refresh'?'正在重新获取画面…':undefined);
    return true;
  }

  resumeActions.current=()=>{
    const queued=pendingActions.current.shift();
    if (queued) act(queued.side,queued.operation);
    else pump.current();
  };

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
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Number(screen.dataset.viewportHeight || 700) : 1;
        scrollInput.current(side,event.deltaY*unit,screenPoint(screen,event.clientX,event.clientY));
      };
      screen?.addEventListener('wheel',wheel,{passive:false});
      return () => screen?.removeEventListener('wheel',wheel);
    });
    return () => cleanup.forEach(remove=>remove());
  }, [session?.id]);

  useEffect(() => {
    if (!diagnosticsEnabled || !activePath || !diagnosticSession) return;
    if (proposalId && diagnosticSide === 'right') return;
    const scope = {kind:'live' as const,projectId:project,version:activeVersion,path:activePath,title:activeTitle};
    const key = activePageScope;
    const cached = diagnosticsCache?.get(key);
    const refresh = diagnosedRevision.current !== scanRevision;
    diagnosedRevision.current = scanRevision;
    if (cached && !refresh) {
      notify.current?.({...scope,...cached,status:'ready'});
      return;
    }
    notify.current?.({...scope,status:'pending'});
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        while (lock.current && !controller.signal.aborted) await new Promise(resolve=>window.setTimeout(resolve,40));
        if (controller.signal.aborted) return;
        if (latest.current?.id !== diagnosticSession || latest.current[diagnosticSide].path !== activePath) return;
        lock.current = true;
        diagnosticLock.current = true;
        try {
          const report = await post<PageDiagnostics>(route+'/'+diagnosticSession+'/diagnostics/'+diagnosticSide,{path:activePath});
          if (controller.signal.aborted) return;
          if (report.path !== activePath || !Array.isArray(report.findings)) throw new Error('检测结果与当前网页不一致，请重试。');
          if (diagnosticsCache && !cached && diagnosticsCache.size >= 100) diagnosticsCache.delete(diagnosticsCache.keys().next().value!);
          diagnosticsCache?.set(key,report);
          notify.current?.({...scope,...report,status:'ready'});
        } catch (problem) {
          if (!controller.signal.aborted) notify.current?.({...scope,status:'failed',error:(problem as Error).message});
        } finally {
          if (latest.current?.id === diagnosticSession) {
            lock.current = false;
            diagnosticLock.current = false;
            setSettled(value=>value+1);
            resumeActions.current();
          }
        }
      })();
    },0);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  },[activePath,activeVersion,diagnosticSession,diagnosticSide,diagnosticsCache,diagnosticsEnabled,project,proposalId,route,scanRevision,activePageScope]);

  const located = useRef('');
  const marker = useRef<HTMLSpanElement>(null);
  const [completedLocation,setCompletedLocation] = useState<{key:string;ok:boolean}>();
  const selector = target?.selector.trim();
  const entryAlias = activePath === '/' && target?.path === entryTargetPath && target?.path === '/index.html';
  const locationKey = selector && diagnosticSession && activePath && (target?.path === activePath || entryAlias)
    ? JSON.stringify([diagnosticSession,diagnosticSide,target.id,activePath,selector]) : '';
  const locationReady = Boolean(locationKey && completedLocation?.key === locationKey);
  const currentLocation = locationReady && completedLocation?.ok ? session?.[diagnosticSide].location : undefined;
  const locationStatus = target && (!selector ? pageLocationMessage(undefined)
    : !locationKey ? '此问题的位置属于另一页面。'
    : !locationReady ? '正在定位问题…'
    : completedLocation?.ok ? pageLocationMessage(currentLocation) : '定位失败，请重新选择问题。');
  useEffect(() => {
    if (!locationKey || !target || !activePath || lock.current || located.current === locationKey) return;
    located.current = locationKey;
    act(diagnosticSide,{action:'locate',path:activePath,selector:target.selector,selectors:target.selectors},
      ok=>setCompletedLocation({key:locationKey,ok}));
  },[locationKey,settled,target,activePath,diagnosticSide]);
  useEffect(() => {
    if (locationKey && currentLocation?.status === 'located')
      marker.current?.scrollIntoView({block:'nearest',inline:'nearest'});
  },[locationKey,currentLocation?.status]);

  function commitReplayText(input:HTMLTextAreaElement,side:LiveSide) {
    const value=input.value;
    input.value='';
    for (const text of value.match(/[\s\S]{1,250}/gu) ?? []) act(side,{action:'text',text});
  }

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

  const tools = <>
    <div className="live-toolbar panorama-bar" hidden={diagnosticsEnabled && !versions && single && !leftSelector && !rightSelector && !onClose}>
      {versions}
      {!single && <label><input type="checkbox" checked={sync} onChange={event=>{
        scrollQueue.current=[];
        syncRef.current=event.target.checked;
        setSync(event.target.checked);
      }} />同步操作</label>}
      {(leftSelector || rightSelector) && <button type="button" className="secondary" disabled={busy||!session}
        onClick={()=>act(single ? 'right' : 'left',{action:'refresh'})}>重新定位</button>}
      {!diagnosticsEnabled && <button type="button" className="secondary" aria-expanded={advanced} aria-controls="live-options" onClick={()=>setAdvanced(value=>!value)}>更多操作</button>}
      {onClose && <button type="button" className="secondary" onClick={onClose}>返回诊断工作台</button>}
    </div>
    <div id="live-options" hidden={!advanced} className="live-options">
      <div className="panorama-bar">
        <button type="button" className="secondary" disabled={busy||!session} onClick={()=>act(single ? 'right' : 'left',{action:'refresh'})}>重新获取画面</button>
        {sides.filter(side=>single ? side==='right' : !proposalId||side==='left').map(side=><button key={side} type="button" className="secondary" disabled={busy||!session}
          onClick={()=>scan(side)}>检测{single ? '当前页面' : label[side]+'状态'}</button>)}
        <button type="button" className="secondary" disabled={!activity.current.length} onClick={download}>下载操作与检测记录</button>
      </div>
      <details><summary>页面信息</summary>
        <p>导入类型 · {projectMode==='react-source'?'React 源码工程':projectMode==='static-source'?'静态源码工程':'静态网页（HTML、ZIP 或 URL）'}</p>
        <p>{session?.modes.left==='replay' && session.modes.right==='replay'
          ? '使用已采集资源离线回放脚本；网络请求、登录状态和未采集资源可能无法重现。修复仅在目标元素匹配时应用。'
          : session?.modes.left==='source' && session.modes.right==='source'
          ? '隔离环境支持站内导航和本地脚本交互。输入使用测试值，禁止真实提交。'
          : '静态页面支持站内导航与原生控件，原网站脚本不执行，依赖脚本的菜单、弹窗等操作可能不可用。'}</p>
      </details>
    </div>
    {session && !single && <details className="live-record" onToggle={event=>setRecordOpen(event.currentTarget.open)}>
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
  </>;
  return <section aria-label={single ? "网页交互" : "双侧网页交互对比"} data-live-revision={session?.revision}>
    {proposalId ? toolsHost && createPortal(tools, toolsHost) : tools}
    <span className="screen-reader-only" role="status">{task}</span>
    {!session && task && <p aria-hidden="true" className="live-connection">{task}</p>}
    {error && <div className="panorama-bar live-feedback"><p role="alert">{error}</p>
      {onOpenUncapturedLink && uncapturedLink && uncapturedLink.reason===error &&
        <button type="button" className="secondary" disabled={busy} onClick={()=>{
          setError('');
          setUncapturedLink(undefined);
          onOpenUncapturedLink(uncapturedLink.url);
        }}>在工作台检测链接</button>}
      {(!session || /会话已|会话过期|过期画面|画面已过期/.test(error)) && <button type="button" className="secondary" disabled={busy} onClick={()=>setRestart(value=>value+1)}>{single ? '重新打开网页' : '重新打开对比'}</button>}
      <button type="button" className="secondary" onClick={()=>setError('')}>关闭提示</button></div>}
    {session && <div className="panorama-pair live-pair" data-single={single}>
      {(single ? ['right'] as const : sides).map(side=>{
        const frame = session[side];
        const control = frame.controls[Number(targets[side])];
        const report = scans[side];
        const directInput = single && session.modes[side]==='replay';
        const location = target && side===diagnosticSide ? currentLocation : target ? undefined : frame.location;
        const boxes = location?.highlights ?? (location?.bounds ? [location.bounds] : []);
        const status = target && side===diagnosticSide ? locationStatus : location && pageLocationMessage(location);
        return <section key={side} aria-label={single ? '当前网页' : label[side]+'网页交互对比'}>
          {single && diagnosticsEnabled ? <div className="workspace-state-heading"><h3>{names[side]}</h3><span title={frame.path}>{frame.title || frame.path}</span></div>
            : <h3>{single ? names[side] : label[side]+' · '+names[side]}</h3>}
          {diagnosticsEnabled && !single && <p className="workspace-live-path" title={frame.path}>
            {!single && <button type="button" className="secondary" aria-pressed={diagnosticSide===side}
              disabled={Boolean(proposalId) && side==='right'} onClick={()=>setDiagnosticSide(side)}>
              {label[side]}问题
            </button>}<span>{frame.title || frame.path}</span>
          </p>}
          {status && <p className={proposalId ? "screen-reader-only" : "page-location-status"} role="status">{status}</p>}
          <div className="live-screen-wrap">
          <button type="button" className="live-screen" style={{aspectRatio:`${frame.width ?? 900} / ${frame.height ?? 700}`}} data-viewport-width={frame.width ?? 900} data-viewport-height={frame.height ?? 700} ref={element=>{screens.current[side]=element;}} aria-label={single ? '可操作网页画面' : label[side]+'可操作网页画面'} onClick={event=>{
            if (dragged.current) {dragged.current=false;return;}
            if (event.detail===0) {
              if (directInput) typing.current?.focus({preventScroll:true});
              else act(side,{action:'activate'});
              return;
            }
            const point=screenPoint(event.currentTarget,event.clientX,event.clientY);
            if (act(side,{action:'click',...point}) && directInput && typing.current) {
              typing.current.style.left=point.x/(frame.width ?? 900)*100+'%';
              typing.current.style.top=point.y/(frame.height ?? 700)*100+'%';
              typing.current.focus({preventScroll:true});
            }
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
            enqueueScroll(side,delta*(frame.height ?? 700)/event.currentTarget.clientHeight,screenPoint(event.currentTarget,event.clientX,event.clientY));
          }} onLostPointerCapture={()=>{drag.current=undefined;}} onKeyDown={event=>{
            if (event.key==='Escape' && event.shiftKey) {event.preventDefault();setKeyboard(undefined);return;}
            const delta=({ArrowUp:-48,ArrowDown:48,PageUp:-600,PageDown:600} as Record<string,number>)[event.key];
            if (delta) {event.preventDefault();enqueueScroll(side,delta);return;}
            if (keyboard!==side || !['Tab','Escape','Enter',' '].includes(event.key)) return;
            event.preventDefault();
            act(side,{action:event.key==='Tab' ? event.shiftKey?'shift-tab':'tab' : event.key==='Escape'?'escape':'activate'});
          }}><img draggable={false} alt="" src={frame.image} width={frame.width ?? 900} height={frame.height ?? 700} />{boxes.map((bounds,index) => <span key={index} ref={index===0 && side===diagnosticSide ? marker : undefined}
            className={index===0 && target ? "highlight page-location-primary" : "highlight"} aria-hidden="true" style={{
            left:bounds.x/(frame.width ?? 900)*100+'%',top:bounds.y/(frame.height ?? 700)*100+'%',
            width:bounds.width/(frame.width ?? 900)*100+'%',height:bounds.height/(frame.height ?? 700)*100+'%',
          }}>{target && index===0 && <span className="page-location-badge">位置</span>}</span>)}</button>
          {directInput && <textarea ref={typing} className="live-screen-typing" tabIndex={-1}
            aria-label="在回放网页中输入" autoComplete="off" autoCapitalize="off" spellCheck={false}
            onKeyDown={event=>{
              if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode===229 ||
                event.ctrlKey || event.metaKey || event.altKey || !editingKeys.has(event.key)) return;
              event.preventDefault();
              act(side,{action:'key',key:event.key as typeof liveEditingKeys[number],shift:event.shiftKey});
            }}
            onCompositionStart={()=>{composing.current=true;}}
            onCompositionEnd={event=>{composing.current=false;commitReplayText(event.currentTarget,side);}}
            onInput={event=>{if (!composing.current) commitReplayText(event.currentTarget,side);}} />}
          </div>
          <details className="live-more" hidden={!advanced}>
            <summary>{single ? '网页控件' : label[side]+'更多操作'}</summary>
            <p className="muted">{frame.path} · 焦点 {frame.focus||'文档'} · 滚动 {frame.scroll}px。{directInput ? '点击网页里的输入框即可打字。' : '聚焦画面后可用方向键或翻页键滚动。语义控件使用固定测试值。'} 会话最长 5 分钟。</p>
            <div className="panorama-bar">
              {!directInput && <label><input type="checkbox" checked={keyboard===side} onChange={event=>setKeyboard(event.target.checked?side:undefined)} />转发网页画面中的 Tab（Shift+Esc 退出）</label>}
              <button type="button" className="secondary" disabled={busy} onClick={()=>act(side,{action:'tab'})}>Tab</button>
              <button type="button" className="secondary" disabled={busy} onClick={()=>act(side,{action:'escape'})}>Esc</button>
              <label>缩放<select disabled={busy} value={frame.zoom} onChange={event=>act(side,{action:'zoom',percent:Number(event.target.value) as 75|100|125|150})}>
                {[75,100,125,150].map(percent=><option key={percent} value={percent}>{percent}%</option>)}
              </select></label>
              <label>语义控件<select value={targets[side]} disabled={busy} onChange={event=>setTargets({...targets,[side]:event.target.value})}>
                <option value="">选择控件</option>
                {frame.controls.map((control,index)=><option key={index} value={index}>{control.name} ({control.role})</option>)}
              </select></label>
              <button type="button" className="secondary" disabled={busy||!targets[side]||!control} onClick={()=>act(side,{action:'click',target:control})}>操作控件</button>
              <button type="button" className="secondary" disabled={busy||!targets[side]||control?.role!=='textbox'} onClick={()=>act(side,{action:'fill',target:control})}>填入测试值</button>
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
    {!single && session?.outcome?.matched === false && <p className="live-feedback" role="alert">操作匹配失败 · {session.outcome.reason}。</p>}
  </section>;
}

function screenPoint(screen:HTMLElement,clientX:number,clientY:number) {
  const rect=screen.getBoundingClientRect();
  const width=Number(screen.dataset.viewportWidth || 900),height=Number(screen.dataset.viewportHeight || 700);
  return {x:Math.min(width-1,Math.max(0,Math.floor((clientX-rect.left)/rect.width*width))),
    y:Math.min(height-1,Math.max(0,Math.floor((clientY-rect.top)/rect.height*height)))};
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
