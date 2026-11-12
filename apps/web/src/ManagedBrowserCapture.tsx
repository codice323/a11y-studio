import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { ArrowLeft, LoaderCircle, LockKeyhole, RotateCcw, ShieldCheck } from 'lucide-react';
import { workspaceFetch as fetch } from './workspace-fetch';

type Frame = { image:string; width:number; height:number; title:string; url:string; scrollHeight?:number; failedResources?:number };
type Reply<T> = T & { error?:string };

async function api<T>(url:string,init?:RequestInit):Promise<T>{
  const response=await fetch(url,init);
  const result=await response.json().catch(()=>({error:'服务器响应无效。'})) as Reply<T>;
  if(response.status===404)throw new Error('当前后端尚未提供采集接口，请重启后端服务后点击重试。');
  if(!response.ok)throw new Error(result.error||'操作失败，请重试。');
  return result;
}

export function ManagedBrowserCapture({initialUrl}:{initialUrl:string}){
  const [frame,setFrame]=useState<Frame>();
  const [sessionId,setSessionId]=useState('');
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [attempt,setAttempt]=useState(0);
  const [busy,setBusy]=useState(false);
  const [forwardKeyboard,setForwardKeyboard]=useState(false);
  const [text,setText]=useState('');
  const [notice,setNotice]=useState('正在启动隔离浏览器…');
  const screen=useRef<HTMLDivElement>(null);
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
      scroll.current.timer=0;scroll.current.delta=0;
      const id=sessionRef.current;sessionRef.current='';
      if(id)void fetch(`/api/browser-capture-sessions/${id}`,{method:'DELETE'}).catch(()=>{});
    };
  },[initialUrl,update,attempt]);

  useEffect(()=>{
    const node=screen.current;if(!node)return;
    const wheel=(event:globalThis.WheelEvent)=>{
      event.preventDefault();
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
  function keyDown(event:KeyboardEvent<HTMLDivElement>){
    if(event.key==='Escape'&&event.shiftKey){event.preventDefault();setForwardKeyboard(false);return;}
    if(!forwardKeyboard)return;
    if(['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown',' '].includes(event.key)){
      event.preventDefault();void sendAction({action:'key',key:event.key===' '?'Space':event.key,shift:event.shiftKey}).catch(problem=>setError((problem as Error).message));
    }else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      event.preventDefault();void sendAction({action:'text',text:event.key}).catch(problem=>setError((problem as Error).message));
    }
  }
  async function sendText(event:FormEvent){
    event.preventDefault();if(!text)return;
    try{await sendAction({action:'text',text});setText('');screen.current?.focus();}
    catch(problem){setError((problem as Error).message);}
  }
  async function capture(){
    if(!sessionId||busy)return;
    busyRef.current=true;setBusy(true);setError('');setNotice('正在采集当前页面并创建修复副本…');
    try{
      const project=await api<{id:string}>(`/api/browser-capture-sessions/${sessionId}/capture`,{method:'POST'});
      sessionRef.current='';
      location.href='/?project='+encodeURIComponent(project.id);
    }catch(problem){setError((problem as Error).message);setNotice('');busyRef.current=false;setBusy(false);}
  }
  async function close(){
    const id=sessionRef.current;sessionRef.current='';
    if(id)await fetch(`/api/browser-capture-sessions/${id}`,{method:'DELETE'}).catch(()=>{});
    location.href='/';
  }
  async function reload(){
    try{setNotice('正在刷新网页…');await sendAction({action:'reload'});}
    catch(problem){setError((problem as Error).message);setNotice('');}
  }

  return <main className="original-live-page managed-capture-page">
    <header className="original-live-header"><div><span className="section-tag">A11Y STUDIO · URL CAPTURE</span><h1>实时操作原网页</h1>
      <p>在应用内浏览器中滚动、点击和登录。采集当前页面状态后，再进入无障碍检测与修复。</p></div>
      <div className="original-live-buttons"><button className="secondary" onClick={()=>void close()}><ArrowLeft size={16}/>结束并返回</button>
        <button className="button dark" disabled={!sessionId||loading||busy||Boolean(error)} onClick={()=>void capture()}>{busy?'正在采集…':'采集当前状态并创建修复副本'}</button></div></header>
    <div className="managed-capture-address"><span className="managed-live-dot" data-connected={Boolean(frame)}/><span title={frame?.url||initialUrl}>{frame?.title||initialUrl}{frame?.url&&frame.url!==initialUrl&&<> · {frame.url}</>}</span><button className="secondary" disabled={!sessionId||loading||busy} onClick={()=>void reload()}><RotateCcw size={15}/>刷新页面</button></div>
    {error&&<div className="alert error" role="alert">{error}{!sessionId&&<button className="secondary" disabled={loading} onClick={()=>setAttempt(value=>value+1)}>重试</button>}</div>}
    {notice&&<div className="managed-capture-status" role="status"><LoaderCircle className="spin" size={16}/>{notice}</div>}
    <div className="original-live-tools managed-capture-tools">
      <label><input type="checkbox" checked={forwardKeyboard} disabled={!sessionId||busy} onChange={event=>{setForwardKeyboard(event.target.checked);screen.current?.focus();}}/>向原网页转发键盘（Shift + Esc 退出）</label>
      <button className="secondary" disabled={!sessionId||loading||busy} onClick={()=>void sendAction({action:'scroll',delta:-600}).catch(problem=>setError((problem as Error).message))}>向上滚动</button>
      <button className="secondary" disabled={!sessionId||loading||busy} onClick={()=>void sendAction({action:'scroll',delta:600}).catch(problem=>setError((problem as Error).message))}>向下滚动</button>
      <form onSubmit={sendText}><label htmlFor="managed-capture-text">向已选输入框输入文字</label><input id="managed-capture-text" value={text} maxLength={500} onChange={event=>setText(event.target.value)}/><button className="secondary" disabled={!sessionId||!text||busy}>输入</button></form>
    </div>
    <p className="muted managed-capture-hint"><LockKeyhole size={15}/>在画面内使用滚轮或触控板滚动，也可以按住鼠标拖动。弹窗打开时，原网页可能暂停背景滚动。登录态只在本次会话内保留，结束或 20 分钟后自动清除；点击和输入会直接操作目标网站。</p>
    {frame && ((frame.failedResources??0)>0 || (frame.scrollHeight!==undefined && frame.scrollHeight<=frame.height)) && <p className="managed-capture-hint" role="status">
      {(frame.failedResources??0)>0 && <>本次加载有 {frame.failedResources} 项网页资源请求失败，页面内容可能不完整。可以点击“刷新页面”重试。 </>}
      {frame.scrollHeight!==undefined && frame.scrollHeight<=frame.height && <>当前页面高度未超出画面。需要登录才能显示的内容，请在此页面登录后查看。</>}
    </p>}
    {frame?<div ref={screen} className="original-live-screen managed-capture-screen" role="region" tabIndex={0} aria-label="应用内原网页实时画面"
      onPointerDown={event=>{
        if(event.button!==0||!sessionRef.current||busyRef.current)return;
        const coordinates=point(event);if(!coordinates)return;
        event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);
        pointer.current=event.pointerId;lastMove.current=0;
        void sendAction({action:'pointerDown',...coordinates}).catch(problem=>setError((problem as Error).message));
      }}
      onPointerMove={event=>{
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
        if(coordinates)void sendAction({action:'pointerUp',...coordinates}).catch(problem=>setError((problem as Error).message));
      }}
      onPointerCancel={event=>{
        if(pointer.current!==event.pointerId)return;
        const coordinates=point(event);pointer.current=null;
        if(coordinates)void sendAction({action:'pointerUp',...coordinates}).catch(problem=>setError((problem as Error).message));
      }}
      onKeyDown={keyDown}><img src={frame.image} alt={`原网页实时画面：${frame.title||frame.url}`} draggable={false}/></div>
      :<div className="managed-capture-placeholder">{loading?<><LoaderCircle className="spin" size={24} aria-hidden="true"/>正在启动网页…</>:error?'网页加载失败':'暂无网页画面'}</div>}
    <div className="managed-capture-foot"><ShieldCheck size={15}/>检测和修复会保存到 A11y Studio 本地副本。采集页不会自动修改目标网站代码。</div>
  </main>;
}
