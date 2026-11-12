import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function event(){let listener:Function|undefined;return {addListener:(fn:Function)=>{listener=fn;},emit:(...args:any[])=>listener?.(...args)};}
test('原网页连接只允许扩展主动选择的标签页和指定工作台，转发操作并在断开时释放',async()=>{
  const onMessage=event(),onConnect=event(),onRemoved=event(),onDetach=event();
  const commands:{method:string;params:any}[]=[];let detached=0,connected=false;
  const chrome={runtime:{id:'test-extension',getURL:(p:string)=>'chrome-extension://test-extension/'+p,onMessage,onConnect},webNavigation:{onCreatedNavigationTarget:event()},
    tabs:{get:async(id:number)=>({id,active:true,url:'https://example.test/'}),create:async()=>({id:22}),update:async()=>({}),onRemoved},
    scripting:{executeScript:async(options:any)=>{commands.push({method:'scroll',params:options.args[0]});return []; }},
    debugger:{attach:async()=>{connected=true;},detach:async()=>{detached++;},onDetach,
      sendCommand:async(_target:any,method:string,params:any)=>{commands.push({method,params});if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main'}}};if(method==='Page.createIsolatedWorld')return {executionContextId:1};if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{clientWidth:900,clientHeight:700}};if(method==='Page.captureScreenshot'){await new Promise(resolve=>setTimeout(resolve,15));return {data:'AA=='};}return {};}}};
  vm.runInNewContext(fs.readFileSync('browser-extension/background.js','utf8'),{chrome,URL,Number,TextEncoder,setTimeout,clearTimeout});
  const result=await new Promise<any>(resolve=>onMessage.emit({type:'start-original-live',tabId:11},{id:'test-extension',url:'chrome-extension://test-extension/popup.html'},resolve));
  assert.equal(result.ok,true);assert.equal(connected,true);
  let rejected=false;
  onConnect.emit({name:'a11y-original-live',sender:{tab:{id:23},url:'http://127.0.0.1:4173/#original-live'},disconnect:()=>{rejected=true;}});
  assert.equal(rejected,true);
  const portMessage=event(),portDisconnect=event();
  const pending=new Map<string,(value:any)=>void>();
  const port={name:'a11y-original-live',sender:{tab:{id:22},url:'http://127.0.0.1:4173/#original-live'},onMessage:portMessage,onDisconnect:portDisconnect,
    postMessage:(message:any)=>pending.get(message.id)?.(message),disconnect:()=>portDisconnect.emit()};
  onConnect.emit(port);
  const send=(id:string,command:string,payload?:unknown)=>new Promise<any>(resolve=>{pending.set(id,resolve);portMessage.emit({id,command,payload});});
  const [frame,scroll]=await Promise.all([send('frame-1','frame'),send('scroll-1','scroll',{delta:500})]);
  assert.equal(frame.value.width,900);
  assert.equal(scroll.value.ok,true);
  assert.ok(commands.findIndex(item=>item.method==='Page.captureScreenshot') < commands.findIndex(item=>item.method==='scroll'));
  assert.equal(commands.find(item=>item.method==='scroll')?.params.delta,500);
  assert.equal((await send('click-1','click',{x:20,y:20})).value.ok,true);
  assert.ok(commands.some(item=>item.method==='Input.dispatchMouseEvent'&&item.params.type==='mousePressed'));
  assert.match((await send('click-2','click',{x:99999,y:20})).error,/无效/);
  assert.match((await send('unknown','arbitrary-cdp',{})).error,/不支持/);
  portDisconnect.emit();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(detached,1);
});

test('画面刷新超时不会关闭连接，也不会迟到执行排队中的滚动',async()=>{
  const onMessage=event(),onConnect=event(),onRemoved=event(),onDetach=event(),portMessage=event(),portDisconnect=event();
  const commands:string[]=[];let detached=0,finishScreenshot:((value:{data:string})=>void)|undefined;
  const chrome={runtime:{id:'test-extension',getURL:(p:string)=>'chrome-extension://test-extension/'+p,onMessage,onConnect},webNavigation:{onCreatedNavigationTarget:event()},
    tabs:{get:async(id:number)=>({id,active:true,url:'https://example.test/'}),create:async()=>({id:22}),update:async()=>({}),onRemoved},
    scripting:{executeScript:async()=>{commands.push('scroll');return []; }},
    debugger:{attach:async()=>{},detach:async()=>{detached++;},onDetach,sendCommand:async(_target:any,method:string)=>{
      commands.push(method);
      if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{clientWidth:900,clientHeight:700}};
      if(method==='Page.captureScreenshot')return new Promise(resolve=>{finishScreenshot=resolve;});
      return {};
    }}};
  const testTimeout=(fn:()=>void,ms:number)=>setTimeout(fn,ms===10000?20:ms);
  vm.runInNewContext(fs.readFileSync('browser-extension/background.js','utf8'),{chrome,URL,Number,TextEncoder,setTimeout:testTimeout,clearTimeout});
  await new Promise<any>(resolve=>onMessage.emit({type:'start-original-live',tabId:11},{id:'test-extension',url:'chrome-extension://test-extension/popup.html'},resolve));
  const pending=new Map<string,(message:any)=>void>();
  const port={name:'a11y-original-live',sender:{tab:{id:22},url:'http://127.0.0.1:4173/#original-live'},onMessage:portMessage,onDisconnect:portDisconnect,
    postMessage:(message:any)=>pending.get(message.id)?.(message),disconnect:()=>portDisconnect.emit()};
  onConnect.emit(port);
  const send=(id:string,command:string,payload?:unknown)=>new Promise<any>(resolve=>{pending.set(id,resolve);portMessage.emit({id,command,payload});});
  const frame=send('frame','frame'),queuedScroll=send('scroll','scroll',{delta:500});
  assert.match((await frame).error,/超时/);
  assert.match((await queuedScroll).error,/重新操作/);
  assert.equal(detached,0);
  assert.ok(!commands.includes('scroll'));
  assert.equal((await send('scroll-again','scroll',{delta:500})).value.ok,true);
  assert.match((await send('frame-again','frame')).error,/超时/);
  assert.equal(commands.filter(method=>method==='Page.captureScreenshot').length,1);
  finishScreenshot?.({data:'AA=='});
  await new Promise(resolve=>setTimeout(resolve,0));
  const freshFrame=send('fresh-frame','frame');
  await new Promise(resolve=>setTimeout(resolve,0));
  finishScreenshot?.({data:'AQ=='});
  assert.equal((await freshFrame).value.image,'data:image/jpeg;base64,AQ==');
  portDisconnect.emit();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(detached,1);
});

test('鼠标悬停超时不会关闭连接，挂起时不重复发送悬停',async()=>{
  const onMessage=event(),onConnect=event(),onRemoved=event(),onDetach=event(),portMessage=event(),portDisconnect=event();
  const commands:string[]=[];let detached=0,finishMove:(()=>void)|undefined;
  const chrome={runtime:{id:'test-extension',getURL:(p:string)=>'chrome-extension://test-extension/'+p,onMessage,onConnect},webNavigation:{onCreatedNavigationTarget:event()},
    tabs:{get:async(id:number)=>({id,active:true,url:'https://example.test/'}),create:async()=>({id:22}),update:async()=>({}),onRemoved},
    scripting:{executeScript:async()=>{commands.push('scroll');return []; }},
    debugger:{attach:async()=>{},detach:async()=>{detached++;},onDetach,sendCommand:async(_target:any,method:string,params:any)=>{
      commands.push(method+(params?.type?':'+params.type:''));
      if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{clientWidth:900,clientHeight:700}};
      if(method==='Page.captureScreenshot')return {data:'AA=='};
      if(method==='Input.dispatchMouseEvent'&&params.type==='mouseMoved')return new Promise<void>(resolve=>{finishMove=resolve;});
      return {};
    }}};
  const testTimeout=(fn:()=>void,ms:number)=>setTimeout(fn,ms===3000?20:ms);
  vm.runInNewContext(fs.readFileSync('browser-extension/background.js','utf8'),{chrome,URL,Number,TextEncoder,setTimeout:testTimeout,clearTimeout});
  await new Promise<any>(resolve=>onMessage.emit({type:'start-original-live',tabId:11},{id:'test-extension',url:'chrome-extension://test-extension/popup.html'},resolve));
  const pending=new Map<string,(message:any)=>void>();
  const port={name:'a11y-original-live',sender:{tab:{id:22},url:'http://127.0.0.1:4173/#original-live'},onMessage:portMessage,onDisconnect:portDisconnect,
    postMessage:(message:any)=>pending.get(message.id)?.(message),disconnect:()=>portDisconnect.emit()};
  onConnect.emit(port);
  const send=(id:string,command:string,payload?:unknown)=>new Promise<any>(resolve=>{pending.set(id,resolve);portMessage.emit({id,command,payload});});
  await send('frame','frame');
  assert.match((await send('move','move',{x:30,y:30})).error,/悬停/);
  assert.equal(detached,0);
  assert.equal((await send('move-again','move',{x:35,y:35})).value.ok,true);
  assert.equal(commands.filter(method=>method==='Input.dispatchMouseEvent:mouseMoved').length,1);
  assert.equal((await send('scroll','scroll',{delta:500})).value.ok,true);
  finishMove?.();
  portDisconnect.emit();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(detached,1);
});

test('只跟踪由用户点击的受控页面打开的新网页',async()=>{
  const onMessage=event(),onConnect=event(),onRemoved=event(),onDetach=event(),onNavigation=event(),portMessage=event(),portDisconnect=event();
  const attached:number[]=[],detached:number[]=[],notices:string[]=[];
  const chrome={runtime:{id:'test-extension',getURL:(p:string)=>'chrome-extension://test-extension/'+p,onMessage,onConnect},webNavigation:{onCreatedNavigationTarget:onNavigation},
    tabs:{get:async(id:number)=>({id,active:true,url:'https://example.test/',windowId:1}),create:async()=>({id:22}),update:async()=>({}),onRemoved},
    windows:{update:async()=>({})},
    debugger:{attach:async({tabId}:{tabId:number})=>{attached.push(tabId);},detach:async({tabId}:{tabId:number})=>{detached.push(tabId);},onDetach,
      sendCommand:async(_target:any,method:string)=>{if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{clientWidth:900,clientHeight:700}};if(method==='Page.captureScreenshot')return {data:'AA=='};if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main'}}};if(method==='Page.createIsolatedWorld')return {executionContextId:1};return {};}}};
  vm.runInNewContext(fs.readFileSync('browser-extension/background.js','utf8'),{chrome,URL,Number,TextEncoder,setTimeout,clearTimeout});
  await new Promise<any>(resolve=>onMessage.emit({type:'start-original-live',tabId:11},{id:'test-extension',url:'chrome-extension://test-extension/popup.html'},resolve));
  const pending=new Map<string,(message:any)=>void>();
  const port={name:'a11y-original-live',sender:{tab:{id:22},url:'http://127.0.0.1:4173/#original-live'},onMessage:portMessage,onDisconnect:portDisconnect,
    postMessage:(message:any)=>{if(message.event)notices.push(message.event);else pending.get(message.id)?.(message);},disconnect:()=>portDisconnect.emit()};
  onConnect.emit(port);
  const send=(id:string,command:string,payload?:unknown)=>new Promise<any>(resolve=>{pending.set(id,resolve);portMessage.emit({id,command,payload});});
  await send('frame','frame');
  onNavigation.emit({sourceTabId:11,tabId:30,url:'https://example.test/ad'});
  await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(attached,[11]);
  await send('click','click',{x:20,y:20});
  onNavigation.emit({sourceTabId:99,tabId:30,url:'https://example.test/other'});
  onNavigation.emit({sourceTabId:11,tabId:31,url:'chrome://settings/'});
  await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(attached,[11]);
  onNavigation.emit({sourceTabId:11,tabId:32,url:'https://example.test/article'});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(attached,[11,32]);assert.deepEqual(detached,[11]);assert.deepEqual(notices,['switching','switched']);
  portDisconnect.emit();await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(detached,[11,32]);
});
