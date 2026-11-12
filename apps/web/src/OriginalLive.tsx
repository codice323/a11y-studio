import { useEffect, useRef, useState, type FormEvent } from 'react';

type Frame = {image:string;width:number;height:number};
type Reply = {channel:string;id?:string;value?:unknown;error?:string;event?:string;reason?:string};

export function OriginalLive() {
  const [frame,setFrame]=useState<Frame>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [text,setText]=useState('');
  const [keyboard,setKeyboard]=useState(false);
  const [disconnected,setDisconnected]=useState(false);
  const [switching,setSwitching]=useState(false);
  const [navigationNotice,setNavigationNotice]=useState('');
  const screen=useRef<HTMLDivElement>(null);
  const pending=useRef(new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:number}>());
  const chain=useRef<Promise<unknown>>(Promise.resolve());
  const alive=useRef(false);
  const disconnectedRef=useRef(false);
  const switchingRef=useRef(false);
  const disconnectReason=useRef('原网页连接已关闭，请回到原网页重新连接。');
  const frameRef=useRef<Frame | undefined>(undefined);
  const scroll=useRef({delta:0,x:0,y:0,timer:0});
  const lastMove=useRef(0);
  const operations=useRef(0);

  function send<T>(command:string,payload?:unknown):Promise<T>{
    if(disconnectedRef.current)return Promise.reject(new Error(disconnectReason.current));
    const id=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=window.setTimeout(()=>{pending.current.delete(id);reject(new Error('扩展没有响应，请从目标网页重新连接。'));},command==='capture'?60000:15000);
      pending.current.set(id,{resolve,reject,timer});
      window.postMessage({channel:'a11y-original-request',id,command,payload},location.origin);
    });
  }
  function perform<T>(command:string,payload?:unknown):Promise<T>{
    operations.current++;
    const requestedAt=Date.now();
    const job=chain.current.catch(()=>{}).then(()=>{
      if(['click','move','scroll','key','text'].includes(command)&&Date.now()-requestedAt>3000)throw new Error('等待画面刷新时间过长，请重新操作。');
      return send<T>(command,payload);
    });
    chain.current=job.finally(()=>{operations.current--;}).catch(()=>{});
    return job;
  }
  async function updateFrame(){
    if(!alive.current||disconnectedRef.current||operations.current)return;
    try{
      const next=await perform<Frame>('frame');
      if(alive.current){frameRef.current=next;setFrame(next);setError('');}
    }catch(problem){if(alive.current)setError((problem as Error).message);}
  }
  useEffect(()=>{
    alive.current=true;
    const listener=(event:MessageEvent<Reply>)=>{
      if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='a11y-original-response')return;
      if(event.data.event==='switching'){
        switchingRef.current=true;setSwitching(true);setNavigationNotice('正在连接刚打开的新页面…');return;
      }
      if(event.data.event==='switched'){
        frameRef.current=undefined;setFrame(undefined);switchingRef.current=false;setSwitching(false);setNavigationNotice('已切换到新页面。');return;
      }
      if(event.data.event==='switch-failed'){
        switchingRef.current=false;setSwitching(false);setNavigationNotice(event.data.reason||'无法跟踪新页面，请到新页面重新连接。');return;
      }
      if(event.data.event==='disconnected'){
        disconnectReason.current=event.data.reason||'原网页连接已关闭，请回到原网页重新连接。';
        disconnectedRef.current=true;setDisconnected(true);setError(disconnectReason.current);
        for(const item of pending.current.values()){clearTimeout(item.timer);item.reject(new Error(disconnectReason.current));}
        pending.current.clear();return;
      }
      const id=event.data.id;
      const item=id&&pending.current.get(id);
      if(!item||!id)return;
      clearTimeout(item.timer);pending.current.delete(id);
      event.data.error?item.reject(new Error(event.data.error)):item.resolve(event.data.value);
    };
    window.addEventListener('message',listener);
    void updateFrame();
    const timer=window.setInterval(()=>void updateFrame(),1000);
    return ()=>{
      alive.current=false;clearInterval(timer);clearTimeout(scroll.current.timer);
      scroll.current.timer=0;scroll.current.delta=0;
      window.removeEventListener('message',listener);
      for(const item of pending.current.values()){clearTimeout(item.timer);item.reject(new Error('实时页面已关闭。'));}
      pending.current.clear();
    };
  },[]);
  useEffect(()=>{
    const node=screen.current;if(!node)return;
    const wheel=(event:WheelEvent)=>{
      event.preventDefault();
      const current=frameRef.current;if(!current||switchingRef.current)return;
      const rect=node.getBoundingClientRect();
      const unit=event.deltaMode===1?16:event.deltaMode===2?current.height:1;
      scroll.current.delta=Math.max(-1600,Math.min(1600,scroll.current.delta+event.deltaY*unit));
      scroll.current.x=Math.max(0,Math.min(current.width-1,(event.clientX-rect.left)/rect.width*current.width));
      scroll.current.y=Math.max(0,Math.min(current.height-1,(event.clientY-rect.top)/rect.height*current.height));
      if(scroll.current.timer)return;
      scroll.current.timer=window.setTimeout(()=>{
        const {delta,x,y}=scroll.current;scroll.current.delta=0;scroll.current.timer=0;
        void perform('scroll',{delta,x,y}).then(()=>window.setTimeout(()=>void updateFrame(),120)).catch(problem=>setError(problem.message));
      },100);
    };
    node.addEventListener('wheel',wheel,{passive:false});
    return ()=>node.removeEventListener('wheel',wheel);
  },[Boolean(frame)]);
  function action(command:string,payload?:unknown){
    if(switchingRef.current)return;
    if(command==='move' && operations.current)return;
    void perform(command,payload).then(()=>{if(command!=='move')window.setTimeout(()=>void updateFrame(),120);}).catch(problem=>setError(problem.message));
  }
  async function sendText(event:FormEvent){
    event.preventDefault();if(!text||switchingRef.current||disconnectedRef.current)return;
    try{await perform('text',{text});setText('');screen.current?.focus();void updateFrame();}
    catch(problem){setError((problem as Error).message);}
  }
  async function importCurrent(){
    setBusy(true);setError('');
    try{
      const capture=await perform<Record<string,unknown>>('capture');
      const data=new FormData();data.set('file',new File([JSON.stringify(capture)],'browser-capture.json',{type:'application/json'}));
      const response=await fetch('/api/projects/import-browser-capture',{method:'POST',body:data});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'导入失败。');
      location.href='/?project='+encodeURIComponent(result.id);
    }catch(problem){setError((problem as Error).message);setBusy(false);}
  }
  return <main className="original-live-page">
    <header className="original-live-header"><div><span className="section-tag">A11Y STUDIO</span><h1>实时操作原网页</h1><p>画面来自你选择的浏览器标签页。点击、输入和滚动会直接作用于原网站。</p></div>
      <div className="original-live-buttons"><button className="secondary" onClick={()=>location.href='/'}>结束并返回</button><button className="button dark" disabled={!frame||busy||disconnected||switching} onClick={()=>void importCurrent()}>{busy?'正在采集…':'检测当前状态并创建修复副本'}</button></div></header>
    {error && <div role="alert" className="alert">{error}{disconnected && ' 当前显示的是断开前的画面；请切回目标网页，点击浏览器工具栏的 A11y Studio 扩展，再点击“在 A11y Studio 实时操作”。'}</div>}
    {navigationNotice && <p role="status">{navigationNotice}</p>}
    <div className="original-live-tools"><label><input type="checkbox" checked={keyboard} disabled={disconnected||switching} onChange={event=>setKeyboard(event.target.checked)} />向原网页转发键盘（Shift + Esc 退出）</label>
      <button className="secondary" disabled={!frame||disconnected||switching} onClick={()=>action('scroll',{delta:-500})}>向上滚动</button><button className="secondary" disabled={!frame||disconnected||switching} onClick={()=>action('scroll',{delta:500})}>向下滚动</button>
      <form onSubmit={sendText}><label htmlFor="original-live-text">向已选输入框输入文字</label><input id="original-live-text" value={text} maxLength={500} onChange={event=>setText(event.target.value)} /><button className="secondary" disabled={!frame||!text||disconnected||switching}>输入</button></form>
    </div>
    <p className="muted">在网页画面内使用鼠标滚轮或触控板滚动，也可点击上方滚动按钮。开启键盘转发后，请点击画面中的输入框再输入。点击打开的新页面会尝试在工作台中继续显示。画面更新可能稍有延迟。</p>
    {frame ? <div ref={screen} className="original-live-screen" role="region" tabIndex={0} aria-label="原网页实时画面" onMouseMove={event=>{
      if(event.buttons||Date.now()-lastMove.current<150)return;
      lastMove.current=Date.now();const rect=event.currentTarget.getBoundingClientRect();
      action('move',{x:Math.min(frame.width-1,Math.max(0,Math.floor((event.clientX-rect.left)/rect.width*frame.width))),y:Math.min(frame.height-1,Math.max(0,Math.floor((event.clientY-rect.top)/rect.height*frame.height)))});
    }} onClick={event=>{
      const rect=event.currentTarget.getBoundingClientRect();
      action('click',{x:Math.min(frame.width-1,Math.max(0,Math.floor((event.clientX-rect.left)/rect.width*frame.width))),y:Math.min(frame.height-1,Math.max(0,Math.floor((event.clientY-rect.top)/rect.height*frame.height)))});
      event.currentTarget.focus();
    }} onKeyDown={event=>{
      if(event.key==='Escape'&&event.shiftKey){event.preventDefault();setKeyboard(false);return;}
      if(!keyboard)return;
      if(['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)){
        event.preventDefault();action('key',{key:event.key,shift:event.shiftKey});
      }else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();action('text',{text:event.key});}
    }}><img src={frame.image} alt={disconnected?'连接断开前的原网页画面':'原网页当前画面'} draggable={false} /></div> : <p role="status">{disconnected?'原网页连接已断开。':navigationNotice==='已切换到新页面。'?'正在加载新页面画面…':'正在连接扩展和原网页…请保持原网页标签页打开。'}</p>}
    <p className="muted">原网页继续在你的浏览器中运行；检测和修复会保存为本地副本。实时画面不会自动写入项目。</p>
  </main>;
}
