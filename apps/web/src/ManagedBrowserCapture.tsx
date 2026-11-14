import { useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type MouseEvent, type Ref } from 'react';
import { ArrowLeft, LoaderCircle, LockKeyhole, RotateCcw, ShieldCheck } from 'lucide-react';
import { workspaceFetch as fetch } from './workspace-fetch';

import type { PageDiagnostics, PageTarget, WorkspacePageDiagnostics } from '../../../packages/shared/page-diagnostics';
import type { LiveFrame } from '../../../packages/shared/live-comparison';

type Frame = { image:string; width:number; height:number; title:string; url:string; scrollHeight?:number; failedResources?:number; resourceFailures?:Record<string,number>; blocked?:string; location?:LiveFrame['location'] };
const resourceTypes:Record<string,string> = {image:'图片',script:'脚本',stylesheet:'样式表',font:'字体',xhr:'接口',fetch:'接口'};
const webpageKeys = new Set(['Enter','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown']);
type Reply<T> = T & { error?:string };

async function api<T>(url:string,init?:RequestInit):Promise<T>{
  const response=await fetch(url,init);
  const result=await response.json().catch(()=>({error:'服务器响应无效。'})) as Reply<T>;
  if(response.status===404)throw new Error('当前后端尚未提供采集接口，请重启后端服务后点击重试。');
  if(!response.ok)throw new Error(result.error||'操作失败，请重试。');
  return result;
}

export type ManagedCaptureHandle = { save: (expectedUrl: string) => Promise<string> };

export function ManagedBrowserCapture({ref, initialUrl,onClose,closeLabel='结束并返回',onCaptured,active, onDiagnostics, target, scanRevision=0, diagnosticsCache}:{
  ref?: Ref<ManagedCaptureHandle>;
  initialUrl:string; onClose:()=>void; closeLabel?:string; onCaptured:(projectId:string)=>void; active:boolean;
  onDiagnostics?:(result:WorkspacePageDiagnostics)=>void; target?:PageTarget; scanRevision?:number; diagnosticsCache?:Map<string,PageDiagnostics>;
}){
  const [frame,setFrame]=useState<Frame>();
  const [sessionId,setSessionId]=useState('');
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [attempt,setAttempt]=useState(0);
  const [reloadRevision,setReloadRevision]=useState(0);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('正在启动隔离浏览器…');
  const screen=useRef<HTMLDivElement>(null);
  const typing=useRef<HTMLTextAreaElement>(null);
  const composing=useRef(false);
  const alive=useRef(false);
  const busyRef=useRef(false);
  const sessionRef=useRef('');
  const frameRef=useRef<Frame|undefined>(undefined);
  const chain=useRef<Promise<unknown>>(Promise.resolve());
  const scroll=useRef({delta:0,x:0,y:0,timer:0});
  const lastMove=useRef(0);
  const actionVersion=useRef(0);
  const actionsPending=useRef(0);
  const hoverPending=useRef(false);
  const pointer=useRef<number|null>(null);
  const inspectedRevision=useRef(scanRevision);
  const inspectedReload=useRef(reloadRevision);
  const diagnose = useRef(onDiagnostics);
  diagnose.current = onDiagnostics;

  const update=useCallback((next:Frame)=>{frameRef.current=next;setFrame(next);setNotice('');setError('');},[]);
  const sendAction=useCallback((action:Record<string,unknown>)=>{
    const id=sessionRef.current;
    if(!id)return Promise.reject(new Error('采集会话尚未就绪。'));
    actionVersion.current++;
    actionsPending.current++;
    const run=chain.current.catch(()=>{}).then(()=>api<Frame>(`/api/browser-capture-sessions/${id}/action`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action),
    }));
    chain.current=run.catch(()=>{});
    return run.then(next=>{if(alive.current)update(next);return next;})
      .finally(()=>{actionsPending.current--;});
  },[update]);

  useEffect(()=>{
    alive.current=true;
    setLoading(true);setError('');setNotice('正在启动隔离浏览器…');
    setFrame(undefined);frameRef.current=undefined;setSessionId('');
    let polling=false;
    let timer=0;
    let cancelled=false;
    const closeOnPageExit=()=>{
      const id=sessionRef.current;sessionRef.current='';
      if(id)void fetch(`/api/browser-capture-sessions/${id}`,{method:'DELETE',keepalive:true}).catch(()=>{});
    };
    window.addEventListener('pagehide',closeOnPageExit);
    void (async()=>{
      try{
        const result=await api<{id:string;frame:Frame}>('/api/browser-capture-sessions',{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:initialUrl}),
        });
        if(cancelled){void fetch(`/api/browser-capture-sessions/${result.id}`,{method:'DELETE'});return;}
        sessionRef.current=result.id;setSessionId(result.id);update(result.frame);setLoading(false);
        timer=window.setInterval(()=>{
          if(cancelled||!alive.current||!sessionRef.current||busyRef.current||polling||actionsPending.current)return;
          polling=true;
          const version=actionVersion.current;
          void api<Frame>(`/api/browser-capture-sessions/${sessionRef.current}/frame`).then(next=>{if(!cancelled&&version===actionVersion.current)update(next);})
            .catch(problem=>{if(!cancelled&&version===actionVersion.current)setError((problem as Error).message);}).finally(()=>{polling=false;});
        },1300);
      }catch(problem){if(!cancelled){setLoading(false);setError((problem as Error).message);setNotice('');}}
    })();
    return()=>{
      cancelled=true;alive.current=false;pointer.current=null;clearInterval(timer);clearTimeout(scroll.current.timer);
      window.removeEventListener('pagehide',closeOnPageExit);
      scroll.current.timer=0;scroll.current.delta=0;
      const id=sessionRef.current;sessionRef.current='';
      if(id)void fetch(`/api/browser-capture-sessions/${id}`,{method:'DELETE',keepalive:true}).catch(()=>{});
    };
  },[initialUrl,update,attempt]);

  const currentUrl = frame?.url;
  const currentTitle = frame?.title;
  const blocked = frame?.blocked;
  const startupError = !sessionId ? error : '';
  const diagnosticsEnabled = Boolean(onDiagnostics);
  useEffect(() => {
    if (!active || !diagnosticsEnabled) return;
    const path = currentUrl || initialUrl;
    const scope = {kind:'remote' as const,path,title:currentTitle};
    if (!sessionId || !currentUrl) {
      diagnose.current?.({...scope,status:startupError?'failed':'pending'});
      return;
    }
    if (blocked) {
      diagnosticsCache?.delete(path);
      diagnose.current?.({...scope,status:'failed',error:blocked});
      return;
    }
    const controller = new AbortController();
    const cached = diagnosticsCache?.get(path);
    const refresh = inspectedRevision.current !== scanRevision || inspectedReload.current !== reloadRevision;
    inspectedRevision.current = scanRevision;
    inspectedReload.current = reloadRevision;
    if (cached && !cached.coverage?.stillLoading && !refresh) {
      diagnose.current?.({...scope,...cached,status:'ready'});
      return;
    }
    diagnose.current?.({...scope,status:'pending'});
    void api<PageDiagnostics>(`/api/browser-capture-sessions/${sessionId}/diagnostics`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:path,refresh}),signal:controller.signal,
    }).then(result=>{
      if (!controller.signal.aborted && frameRef.current?.url === path && sessionRef.current === sessionId) {
        if (result.path !== path || !Array.isArray(result.findings)) throw new Error('检测结果与当前网页不一致，请重试。');
        if (diagnosticsCache && !cached && diagnosticsCache.size >= 50) diagnosticsCache.delete(diagnosticsCache.keys().next().value!);
        diagnosticsCache?.set(path,result);
        diagnose.current?.({...scope,...result,status:'ready'});
      }
    }).catch(problem=>{
      if (!controller.signal.aborted && frameRef.current?.url === path && sessionRef.current === sessionId) {
        diagnosticsCache?.delete(path);
        diagnose.current?.({...scope,status:'failed',error:(problem as Error).message});
      }
    });
    return () => controller.abort();
  }, [active, diagnosticsEnabled, currentUrl, initialUrl, sessionId, scanRevision, reloadRevision, diagnosticsCache, startupError, blocked]);

  useEffect(() => {
    if (!active || !sessionId || !target?.id || target.path !== currentUrl) return;
    void sendAction({action:'locate',url:target.path,selector:target.selector,selectors:target.selectors}).catch(problem=>setError((problem as Error).message));
  },[active,currentUrl,sendAction,sessionId,target?.id,target?.path,target?.selector,target?.selectors]);

  useEffect(()=>{
    const node=screen.current;if(!node)return;
    const wheel=(event:globalThis.WheelEvent)=>{
      event.preventDefault();
      if(busyRef.current)return;
      const current=frameRef.current;if(!current)return;
      const rect=node.getBoundingClientRect();
      const unit=event.deltaMode===1?16:event.deltaMode===2?current.height:1;
      scroll.current.delta=Math.max(-1800,Math.min(1800,scroll.current.delta+event.deltaY*unit));
      scroll.current.x=Math.max(0,Math.min(current.width,(event.clientX-rect.left)/rect.width*current.width));
      scroll.current.y=Math.max(0,Math.min(current.height,(event.clientY-rect.top)/rect.height*current.height));
      if(scroll.current.timer)return;
      scroll.current.timer=window.setTimeout(()=>{
        const {delta,x,y}=scroll.current;scroll.current.delta=0;scroll.current.timer=0;
        void sendAction({action:'scroll',delta,x,y}).catch(problem=>setError((problem as Error).message));
      },90);
    };
    node.addEventListener('wheel',wheel,{passive:false});
    return()=>node.removeEventListener('wheel',wheel);
  },[Boolean(frame),sendAction]);

  function point(event:MouseEvent<HTMLDivElement>){
    const current=frameRef.current;if(!current)return null;
    const rect=event.currentTarget.getBoundingClientRect();
    return {x:Math.max(0,Math.min(current.width-1,Math.floor((event.clientX-rect.left)/rect.width*current.width))),
      y:Math.max(0,Math.min(current.height-1,Math.floor((event.clientY-rect.top)/rect.height*current.height)))};
  }
  function keyDown(event:KeyboardEvent<HTMLTextAreaElement>){
    if(!sessionRef.current||busyRef.current||composing.current||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229||
      event.ctrlKey||event.metaKey||event.altKey||!webpageKeys.has(event.key))return;
    event.preventDefault();
    void sendAction({action:'key',key:event.key,shift:event.shiftKey}).catch(problem=>setError((problem as Error).message));
  }
  function commitText(input:HTMLTextAreaElement){
    const text=input.value;
    input.value='';
    if(!sessionRef.current||busyRef.current||!text)return;
    // Limit each request to 500 UTF-16 units without splitting surrogate pairs.
    for(const chunk of text.match(/[\s\S]{1,250}/gu) ?? []){
      void sendAction({action:'text',text:chunk}).catch(problem=>setError((problem as Error).message));
    }
  }
  async function save(expectedUrl?:string){
    const id=sessionRef.current;
    if(!id||busyRef.current||loading||blocked) throw new Error('当前网页尚未就绪，请稍后重试。');
    busyRef.current=true;setBusy(true);setError('');setNotice('正在采集当前页面并创建修复副本…');
    actionVersion.current++;
    clearTimeout(scroll.current.timer);
    scroll.current.timer=0;scroll.current.delta=0;
    try{
      await chain.current;
      if(sessionRef.current!==id)throw new Error('采集会话已结束，请重新打开。');
      const project=await api<{id:string}>(`/api/browser-capture-sessions/${id}/capture`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedUrl}),
      });
      sessionRef.current='';
      return project.id;
    } finally {
      setNotice('');busyRef.current=false;setBusy(false);
    }
  }
  useImperativeHandle(ref,()=>({save}));
  async function capture(){
    try {onCaptured(await save());}
    catch(problem){setError((problem as Error).message);}
  }
  async function close(){
    const id=sessionRef.current;sessionRef.current='';
    if(id)await fetch(`/api/browser-capture-sessions/${id}`,{method:'DELETE'}).catch(()=>{});
    onClose();
  }
  async function reload(){
    try{
      if(frameRef.current) diagnosticsCache?.delete(frameRef.current.url);
      setNotice('正在刷新网页…');
      await sendAction({action:'reload'});
      setReloadRevision(value=>value+1);
    }
    catch(problem){setError((problem as Error).message);setNotice('');}
  }

  return <section className="managed-capture-page" aria-label="URL 网页采集">
    <header className="managed-capture-header"><h3>当前网页</h3>
      <div className="managed-capture-buttons"><button className="secondary" autoFocus disabled={busy} onClick={()=>void close()}><ArrowLeft size={16}/>{closeLabel}</button>
        <button className="button dark" disabled={!sessionId||loading||busy||Boolean(blocked)} onClick={()=>void capture()}>{busy?'正在采集…':'保存为修复项目'}</button></div></header>
    <div className="managed-capture-address"><span className="managed-live-dot" data-connected={Boolean(frame)}/><span title={frame?.url||initialUrl}>{frame?.title||initialUrl}{frame?.url&&frame.url!==initialUrl&&<> · {frame.url}</>}</span><button className="secondary" disabled={!sessionId||loading||busy} onClick={()=>void reload()}><RotateCcw size={15}/>刷新页面</button>
      <button type="button" className="secondary" disabled={!sessionId||loading||busy} onClick={()=>{
        void sendAction({action:'back'}).catch(problem=>setError((problem as Error).message));
      }}>返回上一页</button></div>
    {error&&<div className="alert error" role="alert">{error}{!sessionId&&<button className="secondary" disabled={loading} onClick={()=>setAttempt(value=>value+1)}>重试</button>}</div>}
    {notice&&<div className="managed-capture-status" role="status"><LoaderCircle className="spin" size={16}/>{notice}</div>}
    <p className="muted managed-capture-hint"><LockKeyhole size={15}/>点击网页里的输入框即可打字。可用滚轮或触控板滚动，也可以按住鼠标拖动。采集时加载的页面和只读接口内容会保存在项目中用于回放，可能包含个人信息；删除项目时一并删除。</p>
    {frame && ((frame.failedResources??0)>0 || (frame.scrollHeight!==undefined && frame.scrollHeight<=frame.height)) && <p className="managed-capture-hint" role="status">
      {(frame.failedResources??0)>0 && <>本次加载有 {frame.failedResources} 项网页资源请求失败，页面内容可能不完整。可以点击“刷新页面”重试。 </>}
      {frame.scrollHeight!==undefined && frame.scrollHeight<=frame.height && <>当前页面高度未超出画面。</>}
    </p>}
    {frame?.resourceFailures && Object.keys(frame.resourceFailures).length > 0 && <details className="managed-capture-hint">
      <summary>查看资源加载失败原因</summary>
      <ul>{Object.entries(frame.resourceFailures).map(([key,count])=>{
        const [type,reason]=key.split(' · ');
        return <li key={key}>{resourceTypes[type] ?? type} · {reason} · {count} 次</li>;
      })}</ul>
    </details>}
    {frame?<div ref={screen} className="managed-capture-screen" role="region" aria-label="应用内原网页实时画面"
      onPointerDown={event=>{
        if(event.button!==0||!sessionRef.current||busyRef.current)return;
        const coordinates=point(event);if(!coordinates)return;
        event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
        pointer.current=event.pointerId;lastMove.current=0;
        void sendAction({action:'pointerDown',...coordinates}).catch(problem=>setError((problem as Error).message));
      }}
      onPointerMove={event=>{
        if(busyRef.current)return;
        const dragging=pointer.current===event.pointerId;
        if((!dragging&&event.buttons)||Date.now()-lastMove.current<(dragging?100:240)||(!dragging&&hoverPending.current))return;
        const coordinates=point(event);if(!coordinates)return;lastMove.current=Date.now();
        if(!dragging)hoverPending.current=true;
        void sendAction({action:dragging?'pointerMove':'move',...coordinates}).catch(problem=>setError((problem as Error).message)).finally(()=>{if(!dragging)hoverPending.current=false;});
      }}
      onPointerUp={event=>{
        if(pointer.current!==event.pointerId)return;
        const coordinates=point(event);pointer.current=null;
        if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
        if(!coordinates)return;
        void sendAction({action:'pointerUp',...coordinates}).catch(problem=>setError((problem as Error).message));
        if(typing.current&&!busyRef.current){
          typing.current.style.left=coordinates.x/frame.width*100+'%';
          typing.current.style.top=coordinates.y/frame.height*100+'%';
          typing.current.focus({preventScroll:true});
        }
      }}
      onPointerCancel={event=>{
        if(pointer.current!==event.pointerId)return;
        const coordinates=point(event);pointer.current=null;
        if(coordinates)void sendAction({action:'pointerUp',...coordinates}).catch(problem=>setError((problem as Error).message));
      }}
      ><textarea ref={typing} className="managed-capture-typing" aria-label="在当前网页中输入" autoComplete="off" autoCapitalize="off" spellCheck={false}
        disabled={!sessionId||busy} onKeyDown={keyDown}
        onCompositionStart={()=>{composing.current=true;}}
        onCompositionEnd={event=>{composing.current=false;commitText(event.currentTarget);}}
        onInput={event=>{if(!composing.current)commitText(event.currentTarget);}} />
      <img src={frame.image} alt={`原网页实时画面：${frame.title||frame.url}`} draggable={false}/>{(frame.location?.highlights ?? (frame.location?.bounds ? [frame.location.bounds] : [])).map((box,index) => <span key={index} className="highlight" aria-hidden="true" style={{
        left:box.x/frame.width*100+'%',top:box.y/frame.height*100+'%',
        width:box.width/frame.width*100+'%',height:box.height/frame.height*100+'%',
      }}/>)}</div>
      :<div className="managed-capture-placeholder">{loading?<><LoaderCircle className="spin" size={24} aria-hidden="true"/>正在启动网页…</>:error?'网页加载失败':'暂无网页画面'}</div>}
    <div className="managed-capture-foot"><ShieldCheck size={15}/>检测和修复会保存到 A11y Studio 本地副本。采集页不会自动修改目标网站代码。</div>
  </section>;
}
