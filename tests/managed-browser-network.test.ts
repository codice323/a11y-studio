import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

test('网页并发资源排队加载，脚本不会因并发达到上限被丢弃', {timeout:45000}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'a11y-managed-network-'));
  process.env.A11Y_DATA_DIR = dir;
  const resolver = t.mock.method(dns,'lookup',async () => [{address:'93.184.216.34',family:4}]);
  syncBuiltinESMExports();
  t.after(() => {resolver.mock.restore();syncBuiltinESMExports();});
  let active=0, maxActive=0, scriptRequests=0;
  t.mock.method(https,'request',(url:URL,_options:https.RequestOptions,callback:(response:import('node:http').IncomingMessage)=>void)=>{
    const request = new EventEmitter();
    return Object.assign(request,{
      end(){
        const script=url.pathname.startsWith('/script-');
        if(script){active++;scriptRequests++;maxActive=Math.max(maxActive,active);}
        const body=script ? 'window.loaded=(window.loaded||0)+1;document.title="loaded "+window.loaded;' :
          '<!doctype html><html><head><title>loading</title>'+Array.from({length:40},(_,i)=>'<script async src="/script-'+i+'.js"></script>').join('')+'</head><body>网页</body></html>';
        setTimeout(()=>{
          if(script)active--;
          const response=Object.assign(Readable.from([Buffer.from(body)]),{statusCode:200,headers:{'content-type':script?'application/javascript':'text/html'}});
          callback(response as unknown as import('node:http').IncomingMessage);
        },script?120:0);
      },
    });
  });
  const browser=await import('../apps/api/managed-browser-capture');
  let id:string|undefined;
  try{
    const started=await browser.startManagedBrowserSession('https://public-source.net/','owner','auth');
    id=started.id;
    let frame=started.frame;
    for(let i=0;i<30 && frame.title!=='loaded 40';i++){
      await new Promise(resolve=>setTimeout(resolve,200));
      frame=await browser.getManagedBrowserFrame(id,'owner','auth');
    }
    assert.equal(scriptRequests,40);
    assert.ok(maxActive<=24);
    assert.equal(frame.title,'loaded 40');
    assert.equal((frame as typeof frame & {failedResources:number}).failedResources,0);
  } finally{
    if(id)await browser.closeManagedBrowserSession(id,'owner','auth');
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
