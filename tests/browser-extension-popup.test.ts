import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('扩展仅在点击后采集当前标签页，确认标签未变化并完成文件下载',async()=>{
  let click:()=>Promise<void>=async()=>{},liveClick:()=>Promise<void>=async()=>{},calls=0,downloaded=false,revoked=false;
  const button={disabled:false,addEventListener:(_event:string,handler:()=>Promise<void>)=>{click=handler;}};
  const live={disabled:false,addEventListener:(_event:string,handler:()=>Promise<void>)=>{liveClick=handler;}};
  const status={textContent:''};
  const tab={id:5,windowId:3,url:'https://example.test/private'};
  const listeners=new Set<Function>();
  let liveTarget=0;
  const chrome={runtime:{sendMessage:async(message:{tabId:number})=>{liveTarget=message.tabId;return {ok:true};}},tabs:{query:async()=>[tab],captureVisibleTab:async()=> 'data:image/png;base64,aGVsbG8='},
    scripting:{executeScript:async()=>++calls===1?[]:[{result:{format:'a11y-studio-browser-capture',version:1}}]},
    downloads:{download:async({url}:{url:string})=>{assert.equal(url,'blob:test');downloaded=true;return 7;},
      search:async()=>[{state:'complete'}],onChanged:{addListener:(fn:Function)=>listeners.add(fn),removeListener:(fn:Function)=>listeners.delete(fn)}}};
  const sandbox={document:{getElementById:(id:string)=>id==='capture'?button:id==='live'?live:status},chrome,TextEncoder,Blob,
    URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>{revoked=true;}},setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync('browser-extension/popup.js','utf8'),sandbox);
  assert.equal(calls,0);
  await click();
  assert.equal(calls,2);
  assert.equal(downloaded,true);
  assert.equal(revoked,true);
  assert.equal(listeners.size,0);
  assert.match(status.textContent,/已保存/);
  await liveClick();
  assert.equal(liveTarget,5);
});
