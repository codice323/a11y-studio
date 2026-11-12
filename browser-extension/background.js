importScripts('screenshot.js');
let session;
let starting=false;
const allowedKeys={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Home:36,End:35,PageUp:33,PageDown:34};
const commandNames={click:'点击',move:'鼠标移动',scroll:'滚动',key:'按键',text:'输入',capture:'采集'};
async function isolatedContext(target){
  const tree=await chrome.debugger.sendCommand(target,'Page.getFrameTree');
  const frameId=tree?.frameTree?.frame?.id;
  if(!frameId)throw new Error('无法读取原网页框架。');
  const world=await chrome.debugger.sendCommand(target,'Page.createIsolatedWorld',{frameId,worldName:'a11y-studio-live'});
  if(!world?.executionContextId)throw new Error('无法连接原网页运行环境。');
  return world.executionContextId;
}
async function evaluateInContext(target,contextId,expression,awaitPromise=false){
  const result=await chrome.debugger.sendCommand(target,'Runtime.evaluate',{contextId,expression,awaitPromise,returnByValue:true});
  if(result?.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'原网页执行失败。');
  return result?.result?.value;
}
async function evaluateInPage(target,fn,args){
  const contextId=await isolatedContext(target);
  return evaluateInContext(target,contextId,`(${fn.toString()})(...${JSON.stringify(args)})`);
}
async function closeSession(){
  const old=session;session=undefined;
  if(!old)return;
  clearTimeout(old.connectTimeout);
  try{await chrome.debugger.detach({tabId:old.target});}catch{}
  try{old.port?.disconnect();}catch{}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.type!=='start-original-live'||sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html'))return;
  void (async()=>{
    if(starting||session)throw new Error('已有原网页实时会话，请先关闭。');
    starting=true;
    let target,attached=false;
    try{
      if(!Number.isInteger(message.tabId))throw new Error('目标标签页无效。');
      const tab=await chrome.tabs.get(message.tabId);
      if(!tab.active||!tab.url||!/^https?:/i.test(tab.url)||/^http:\/\/(?:127\.0\.0\.1|localhost):(?:4173|5173)(?:\/|$)/i.test(tab.url))throw new Error('请在目标网页标签页启动实时操作。');
      target=tab.id;
      await chrome.debugger.attach({tabId:target},'1.3');
      attached=true;
      const viewer=await chrome.tabs.create({url:'about:blank',active:false});
      session={target,viewer:viewer.id,port:null,queue:Promise.resolve(),queued:0,expired:false,width:0,height:0,revision:0,queueEpoch:0};
      session.connectTimeout=setTimeout(()=>{if(session?.viewer===viewer.id&&!session.port)void closeSession();},30000);
      try { await chrome.tabs.update(viewer.id,{url:'http://127.0.0.1:4173/#original-live',active:true}); }
      catch(error){await closeSession();throw error;}
      respond({ok:true});
    } catch(error){if(attached&&!session)try{await chrome.debugger.detach({tabId:target});}catch{}throw error;}
    finally {starting=false;}
  })().catch(error=>respond({ok:false,error:error?.message||'无法连接原网页。'}));
  return true;
});
chrome.runtime.onConnect.addListener(port=>{
  if(port.name!=='a11y-original-live')return;
  const current=session;
  let url;try{url=new URL(port.sender?.url||'');}catch{}
  if(!current||current.port||port.sender?.tab?.id!==current.viewer||url?.origin!=='http://127.0.0.1:4173'||url.pathname!=='/'||url.hash!=='#original-live'){port.disconnect();return;}
  clearTimeout(current.connectTimeout);
  current.port=port;
  port.onDisconnect.addListener(()=>{if(session===current)void closeSession();});
  port.onMessage.addListener(message=>{
    if(session!==current||typeof message?.id!=='string'||message.id.length>80)return;
    if(current.expired){port.postMessage({id:message.id,error:'实时连接已超时，请重新连接。'});return;}
    if(current.queued>=24){port.postMessage({id:message.id,error:'操作过于频繁，请稍后重试。'});return;}
    current.queued++;
    const epoch=current.queueEpoch;
    current.queue=current.queue.catch(()=>{}).then(async()=>{
      if(session!==current||current.expired){current.queued--;return;}
      if(current.switchJob)await current.switchJob;
      if(session!==current||current.expired){current.queued--;return;}
      if(epoch!==current.queueEpoch){current.queued--;try{port.postMessage({id:message.id,error:'页面已切换或画面刷新超时，请重新操作。'});}catch{}return;}
      let timer,reply,timedOut=false;
      try{
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new Error(message.command==='frame'?'原网页画面刷新超时，正在重试。':message.command==='move'?'鼠标悬停响应较慢，可以继续操作。':`原网页${commandNames[message.command]||'操作'}响应超时，请回到原网页重新连接。`));},message.command==='capture'?55000:message.command==='move'?3000:10000);});
        const value=await Promise.race([execute(current,message.command,message.payload),timeout]);
        if(['click','move','scroll','key','text'].includes(message.command))current.revision++;
        reply={id:message.id,value};
      }catch(error){reply={id:message.id,error:error?.message||'操作失败。'};}
      finally{clearTimeout(timer);current.queued--;}
      if(timedOut){current.queueEpoch++;if(message.command==='move')current.moveSlow=true;else if(message.command!=='frame')current.expired=true;}
      if(session===current){try{port.postMessage(reply);}catch{}}
      if(timedOut && current.expired && session===current){try{port.postMessage({event:'disconnected',reason:`原网页${commandNames[message.command]||'操作'}响应超时，连接已关闭；请回到原网页重新连接。`});}catch{}void closeSession();}
    });
  });
});
chrome.webNavigation.onCreatedNavigationTarget.addListener(details=>{
  const current=session;
  if(!current||current.expired||current.switchJob||details.sourceTabId!==current.target||!Number.isFinite(current.followUntil)||Date.now()>current.followUntil)return;
  if(!Number.isInteger(details.tabId)||details.tabId===current.viewer||!(/^(https?:|about:blank(?:$|[?#]))/i.test(details.url)))return;
  current.followUntil=0;
  try{current.port?.postMessage({event:'switching'});}catch{}
  const job=(async()=>{
    const oldTarget=current.target;
    let attached=false;
    try{
      await chrome.debugger.attach({tabId:details.tabId},'1.3');attached=true;
      if(session!==current){await chrome.debugger.detach({tabId:details.tabId});return;}
      current.target=details.tabId;current.width=0;current.height=0;current.revision++;current.queueEpoch++;
      current.frameJob=undefined;current.moveJob=undefined;current.moveSlow=false;
      try{await chrome.debugger.detach({tabId:oldTarget});}catch{}
      const viewer=await chrome.tabs.get(current.viewer);
      await chrome.tabs.update(current.viewer,{active:true});
      if(viewer.windowId!==undefined)await chrome.windows.update(viewer.windowId,{focused:true});
      try{current.port?.postMessage({event:'switched'});}catch{}
    }catch(error){
      if(attached&&current.target!==details.tabId)try{await chrome.debugger.detach({tabId:details.tabId});}catch{}
      try{current.port?.postMessage({event:'switch-failed',reason:'新页面已在浏览器中打开，但工作台无法跟踪，请切到新页面重新连接扩展。'});}catch{}
    }
  })();
  current.switchJob=job;
  void job.finally(()=>{if(current.switchJob===job)current.switchJob=undefined;}).catch(()=>{});
});
chrome.debugger.onDetach.addListener((source,reason)=>{
  if(session?.target!==source.tabId)return;
  const old=session;session=undefined;
  const detail=reason==='target_closed'?'原网页标签页已关闭，请重新打开并连接。':reason==='canceled_by_user'?'Chrome 已停止网页调试，请回到原网页重新连接。':'原网页调试连接已断开，请回到原网页重新连接。';
  try{old.port?.postMessage({event:'disconnected',reason:detail});old.port?.disconnect();}catch{}
});
chrome.tabs.onRemoved.addListener(id=>{if(session && (id===session.target||id===session.viewer))void closeSession();});

async function execute(current,command,payload){
  const target={tabId:current.target};
  if(command==='frame'){
    if(!current.frameJob){
      const revision=current.revision;
      const job=(async()=>{
        const metrics=await chrome.debugger.sendCommand(target,'Page.getLayoutMetrics');
        const view=metrics.cssVisualViewport||metrics.cssLayoutViewport;
        if(!view?.clientWidth||!view?.clientHeight)throw new Error('无法读取网页视口。');
        current.width=view.clientWidth;current.height=view.clientHeight;
        const image=await chrome.debugger.sendCommand(target,'Page.captureScreenshot',{format:'jpeg',quality:65,fromSurface:true});
        if(!image?.data||image.data.length>4000000)throw new Error('实时画面无法读取或过大。');
        if(revision!==current.revision)throw new Error('网页画面已变化，正在刷新。');
        return {image:'data:image/jpeg;base64,'+image.data,width:view.clientWidth,height:view.clientHeight};
      })();
      current.frameJob=job;
      void job.finally(()=>{if(current.frameJob===job)current.frameJob=undefined;}).catch(()=>{});
    }
    return await current.frameJob;
  }
  if(command==='click'||command==='move'){
    const {x,y}=payload||{};
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=current.width||y>=current.height)throw new Error('点击位置无效。');
    if(command==='move'){
      if(current.moveSlow)return {ok:true};
      if(!current.moveJob){
        const job=chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
        current.moveJob=job;
        void job.finally(()=>{if(current.moveJob===job){current.moveJob=undefined;current.moveSlow=false;}}).catch(()=>{});
      }
      await current.moveJob;
      return {ok:true};
    }
    await evaluateInPage(target,(x,y)=>{
      const element=document.elementFromPoint(x,y);
      const link=element?.closest('a[href],area[href]');
      if(!link || link.hasAttribute('download'))return;
      const name=(link.getAttribute('target')||'').trim().toLowerCase();
      if(!name||name==='_self')return;
      let url;try{url=new URL(link.href,document.baseURI);}catch{return;}
      if(url.protocol!=='http:'&&url.protocol!=='https:')return;
      const original=link.getAttribute('target');
      link.setAttribute('target','_self');
      setTimeout(()=>{if(link.isConnected&&link.getAttribute('target')==='_self')link.setAttribute('target',original);},1500);
    },[x,y]);
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    current.followUntil=Date.now()+5000;
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});
    return {ok:true};
  }
  if(command==='scroll'){
    const delta=Number(payload?.delta);
    if(!Number.isFinite(delta)||Math.abs(delta)>1600||!current.width||!current.height)throw new Error('滚动参数无效。');
    const requestedX=Number(payload?.x),requestedY=Number(payload?.y);
    const x=Math.max(0,Math.min(current.width-1,Number.isFinite(requestedX)?requestedX:current.width/2));
    const y=Math.max(0,Math.min(current.height-1,Number.isFinite(requestedY)?requestedY:current.height/2));
    try{
      const scrollPage=({x,y,delta})=>{
        // Native wheel dispatch can wait indefinitely for a background tab's compositor.
        // Scroll the nearest scrollable ancestor in the user's actual page instead.
        let node=document.elementFromPoint(x,y);
        while(node && node!==document.documentElement && node!==document.body){
          const style=getComputedStyle(node);
          if(/^(auto|scroll|overlay)$/.test(style.overflowY)&&node.scrollHeight>node.clientHeight){
            const canScroll=delta>0?node.scrollTop+node.clientHeight<node.scrollHeight-1:node.scrollTop>0;
            if(canScroll){node.scrollBy({top:delta,behavior:'instant'});return;}
          }
          node=node.parentElement;
        }
        window.scrollBy({top:delta,behavior:'instant'});
      };
      try{await chrome.scripting.executeScript({target,func:scrollPage,args:[{x,y,delta}]});}
      catch{await evaluateInPage(target,scrollPage,[{x,y,delta}]);}
    }catch(error){throw new Error('无法滚动原网页。若已跳转到其他网站，请回到原网页重新点击扩展。'+(error?.message?' '+error.message:''));}
    return {ok:true};
  }
  if(command==='key'){
    const key=payload?.key;
    if(typeof key!=='string'||!Object.hasOwn(allowedKeys,key))throw new Error('暂不支持此按键。');
    const modifiers=payload?.shift===true?8:0;
    await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'rawKeyDown',key,windowsVirtualKeyCode:allowedKeys[key],modifiers});
    await chrome.debugger.sendCommand(target,'Input.dispatchKeyEvent',{type:'keyUp',key,windowsVirtualKeyCode:allowedKeys[key],modifiers});
    return {ok:true};
  }
  if(command==='text'){
    const text=payload?.text;
    if(typeof text!=='string'||!text||text.length>500)throw new Error('输入内容需为 1 至 500 个字符。');
    await chrome.debugger.sendCommand(target,'Input.insertText',{text});
    return {ok:true};
  }
  if(command==='capture'){
    let item;
    try {
      await chrome.scripting.executeScript({target:{tabId:current.target},files:['axe.min.js','capture.js']});
      [item]=await chrome.scripting.executeScript({target:{tabId:current.target},func:async()=>await globalThis.a11yStudioCapture()});
    } catch(error){
      try{
        const contextId=await isolatedContext(target);
        for(const file of ['axe.min.js','capture.js']){
          const response=await fetch(chrome.runtime.getURL(file));
          if(!response.ok)throw new Error('无法读取采集程序。');
          await evaluateInContext(target,contextId,await response.text());
        }
        const result=await evaluateInContext(target,contextId,'globalThis.a11yStudioCapture()',true);
        item={result};
      }catch(fallbackError){throw new Error('无法采集当前页面，请重新连接原网页后重试。'+(fallbackError?.message?' '+fallbackError.message:''));}
    }
    const shot=await globalThis.a11yStudioCaptureScreenshot(target);
    if(!item?.result||!shot?.data)throw new Error('采集失败或截图过大。');
    const capture={...item.result,screenshot:'data:image/png;base64,'+shot.data,screenshotFullPage:shot.fullPage};
    if(!shot.fullPage)capture.limitations.push('原始截图受浏览器限制，仅覆盖当前可见区域。');
    if(new TextEncoder().encode(JSON.stringify(capture)).length>8*1024*1024)throw new Error('采集文件超过 8 MB，请尝试较小的页面。');
    return capture;
  }
  if(command==='close'){setTimeout(()=>void closeSession(),0);return {ok:true};}
  throw new Error('不支持的操作。');
}
