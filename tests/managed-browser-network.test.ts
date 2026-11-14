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
  const navigationHops:string[]=[];
  t.mock.method(https,'request',(url:URL,_options:https.RequestOptions,callback:(response:import('node:http').IncomingMessage)=>void)=>{
    const request = new EventEmitter();
    return Object.assign(request,{
      end(){
        if (url.pathname === '/redirect' || url.pathname === '/next') {
          navigationHops.push(url.href);
          const location = url.pathname === '/redirect' ? '/next' : 'https://public-destination.net/';
          callback(Object.assign(Readable.from([]), {
            statusCode:302, headers:{location},
          }) as unknown as import('node:http').IncomingMessage);
          return;
        }
        const script=url.pathname.startsWith('/script-');
        const css=url.pathname==='/theme.css';
        if(script){active++;scriptRequests++;maxActive=Math.max(maxActive,active);}
        const data=url.pathname==='/data';
        const secondPage=url.pathname==='/second';
        if (url.pathname === '/encoded.png' || url.pathname === '/unavailable.png') {
          const denied = url.pathname === '/unavailable.png';
          callback(Object.assign(Readable.from(denied ? [] : [fs.readFileSync('tests/fixtures/vision/bars.png')]), {
            statusCode:denied ? 405 : 200, headers:{'content-type':'image/png','content-encoding':'utf-8'},
          }) as unknown as import('node:http').IncomingMessage);
          return;
        }
        const verification=url.pathname==='/verification';
        const body=verification ? '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>搜索</title><body>百度安全验证<h1>请完成下方验证后继续操作</h1></body></html>' : data ? '{"message":"接口内容"}' : secondPage ? '<!doctype html><html lang="zh-CN"><title>第二页</title><button id="unnamed"></button><script>setTimeout(()=>{const input=document.createElement("input");input.id="delayed";document.body.append(input)},800)</script></html>' : css ? '#data{color:rgb(1,2,3)}' : script ? 'window.loaded=(window.loaded||0)+1;document.title="loaded "+window.loaded;' :
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>loading</title><link rel="stylesheet" href="//public-source.net/theme.css"><style>#toggle{margin-left:1000px}#badge{position:absolute;top:120px;left:700px} nav,aside{background:#fff;color:#aaa}</style>'+Array.from({length:40},(_,i)=>'<script async src="/script-'+i+'.js"></script>').join('')+'</head><body><button id="toggle" onclick="document.getElementById(\'panel\').hidden=false">打开内容</button><p id="panel" hidden>动态内容</p><p id="data"></p><input id="name"><a style="position:absolute;top:300px;left:20px" href="/second">第二页</a><span id="badge">标记</span><img src="/encoded.png" alt=""><img src="/unavailable.png" alt=""><nav><div><span id="pictures">图片</span></div><div><span id="videos">视频</span></div></nav><aside><span id="other-contrast">其他区域</span></aside><script>history.replaceState(null,"","/client-route");fetch("/data?source=test").then(r=>r.json()).then(data=>document.getElementById("data").textContent=data.message)</script></body></html>';
        setTimeout(()=>{
          if(script)active--;
          const response=Object.assign(Readable.from([Buffer.from(body)]),{statusCode:200,headers:{'content-type':data?'application/json':css?'text/css':script?'application/javascript':'text/html'}});
          callback(response as unknown as import('node:http').IncomingMessage);
        },script?120:0);
      },
    });
  });
  const browser=await import('../apps/api/managed-browser-capture');
  let id:string|undefined;
  let otherId:string|undefined;
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
    const report=await browser.diagnoseManagedBrowserPage(id,'owner','auth',{url:frame.url});
    assert.equal(report.path,frame.url);
    assert.ok(report.findings.some(item=>item.ruleId==='label' && item.selector==='#name'));
    const contrastGroup = (selector:string) => {
      const group = report.findings.find(item=>item.ruleId==='color-contrast' && item.selector===selector)?.locationGroup;
      assert.ok(group,selector);
      return group;
    };
    assert.equal(contrastGroup('#pictures'),contrastGroup('#videos'));
    assert.notEqual(contrastGroup('#pictures'),contrastGroup('#other-contrast'));
    const locatedGroup = await browser.actManagedBrowserSession(id,'owner','auth',{
      action:'locate',url:frame.url,selector:'#videos',selectors:['#pictures','#videos'],
    });
    assert.equal(locatedGroup.location?.highlights?.length,2);
    assert.strictEqual(await browser.diagnoseManagedBrowserPage(id,'owner','auth',{url:frame.url}),report);
    await assert.rejects(browser.diagnoseManagedBrowserPage(id,'owner','auth',{url:'https://public-source.net/old'}),/网页已切换/);
    assert.equal(frame.failedResources,1);
    assert.deepEqual(frame.resourceFailures,{'image · HTTP 405':1});
    const located=await browser.actManagedBrowserSession(id,'owner','auth',{action:'locate',url:frame.url,selector:'#name'});
    assert.equal(located.location?.status,'located');
    const navigated=await browser.actManagedBrowserSession(id,'owner','auth',{action:'click',x:40,y:307});
    assert.equal(new URL(navigated.url).pathname,'/second');
    const secondReport=await browser.diagnoseManagedBrowserPage(id,'owner','auth',{url:navigated.url});
    assert.ok(secondReport.findings.some(item=>item.ruleId==='button-name' && item.selector==='#unnamed'));
    assert.ok(secondReport.findings.some(item=>item.ruleId==='label' && item.selector==='#delayed'),'应检测首次导航后异步插入的控件');
    assert.ok(!secondReport.findings.some(item=>item.selector==='#name'));
    assert.ok(secondReport.coverage?.bestPractices.some(rule=>rule.id==='landmark-one-main'));
    assert.equal(secondReport.coverage?.stillLoading,false);
    const returned=await browser.actManagedBrowserSession(id,'owner','auth',{action:'back'});
    assert.equal(returned.url,frame.url);
    assert.strictEqual(await browser.diagnoseManagedBrowserPage(id,'owner','auth',{url:returned.url}),report);
    await assert.rejects(browser.captureManagedBrowserSession(id,'owner','auth',secondReport.path),/网页已切换/);
    assert.equal((await browser.getManagedBrowserFrame(id,'owner','auth')).url,frame.url);

    const blocked=await browser.startManagedBrowserSession('https://public-source.net/verification','owner','auth');
    id=blocked.id;
    assert.match(blocked.frame.blocked ?? '',/网站安全验证/);
    await assert.rejects(browser.diagnoseManagedBrowserPage(id,'owner','auth',{url:blocked.frame.url}),/网站安全验证/);
    await assert.rejects(browser.captureManagedBrowserSession(id,'owner','auth'),/网站安全验证/);

    const other=await browser.startManagedBrowserSession('https://public-source.net/','other','other-auth');
    otherId=other.id;
    const oldId=id;
    const replacement=await browser.startManagedBrowserSession('https://public-source.net/redirect','owner','auth');
    id=replacement.id;
    assert.deepEqual(navigationHops,['https://public-source.net/redirect','https://public-source.net/next']);
    assert.equal(replacement.frame.url,'https://public-destination.net/client-route');
    await assert.rejects(browser.getManagedBrowserFrame(oldId,'owner','auth'),/采集会话不存在或已结束/);
    assert.ok((await browser.getManagedBrowserFrame(otherId,'other','other-auth')).image,'不得关闭其他用户的会话');
    await assert.rejects(browser.startManagedBrowserSession('https://public-source.net/','third','third-auth'),/会话较多/);
    await browser.closeManagedBrowserSession(otherId,'other','other-auth');
    otherId=undefined;
    const storage=await import('../apps/api/storage');
    storage.db.exec('ALTER TABLE projects ADD COLUMN owner_user_id TEXT');
    const project=await browser.captureManagedBrowserSession(id,'owner','auth',replacement.frame.url);
    id=undefined;
    const live=await import('../apps/api/live-comparison');
    const version=storage.id();
    const previous=storage.snapshotDir(project.id,project.currentSnapshot);
    const next=storage.snapshotDir(project.id,version);
    fs.cpSync(previous,next,{recursive:true});
    const html=path.join(next,'index.html');
    const originalHtml=fs.readFileSync(html,'utf8');
    const repairedHtml=originalHtml.replace(/id="toggle" style="([^"]*)"/, 'id="toggle" style="$1;color: #ff0000"');
    fs.writeFileSync(html,repairedHtml);
    storage.db.prepare('INSERT INTO snapshots(id,project_id,parent_id,entry,hash,created_at,description) VALUES(?,?,?,?,?,?,?)')
      .run(version,project.id,project.currentSnapshot,'index.html',storage.treeHash(next),storage.now(),'已验证修复');
    storage.db.prepare('INSERT INTO verifications VALUES(?,?,?,?,?,?)').run(storage.id(),project.id,'test','passed',JSON.stringify({toSnapshot:version,patch:{selector:'#toggle',operation:'set-color',value:'#ff0000'}}),storage.now());
    const {captureComparison}=await import('../apps/api/capture-comparison');
    const cheerio=await import('cheerio');
    const before=cheerio.load(captureComparison(project.id,project.currentSnapshot).html);
    const after=cheerio.load(captureComparison(project.id,version).html);
    assert.match(before('#badge').attr('style')??'',/inset:120px .* 700px/);
    assert.doesNotMatch(before('#toggle').attr('style')??'',/#ff0000/);
    assert.match(after('#toggle').attr('style')??'',/#ff0000/);
    fs.writeFileSync(html,'<!doctype html><title>搜索</title><body>百度安全验证<h1>请完成下方验证后继续操作</h1></body>');
    assert.match(captureComparison(project.id,version).blocked ?? '',/网站安全验证/);
    fs.writeFileSync(html,repairedHtml);
    const replay=await import('../apps/api/browser-replay');
    const color=await replay.withReplayPage(project.id,version,new AbortController().signal,page=>page.locator('#toggle').evaluate(el=>getComputedStyle(el).color));
    assert.equal(color,'rgb(255, 0, 0)');
    const missing:string[]=[];
    const cssColor=await replay.withReplayPage(project.id,version,new AbortController().signal,page=>page.locator('#data').evaluate(el=>getComputedStyle(el).color),type=>missing.push(type));
    assert.equal(cssColor,'rgb(1, 2, 3)','协议相对的 CSS 应命中采集时保存的 HTTPS 资源');
    assert.equal(missing.includes('stylesheet'),false);
    const networkAllowed=await replay.withReplayPage(project.id,version,new AbortController().signal,page=>page.evaluate(async()=>{
      try {await fetch('http://169.254.169.254/');return true;} catch {return false;}
    }));
    assert.equal(networkAllowed,false,'回放中的脚本不能访问内网或外部网络');
    const compared=await live.startLive(project.id,{left:project.currentSnapshot,right:version},'owner','auth');
    try {
      assert.equal(compared.modes.left,'replay');
      assert.equal(compared.modes.right,'replay');
      assert.equal(compared.left.width,1280);
      assert.equal(compared.left.height,820);
      assert.equal(compared.left.title,'loaded 40','已采集的外部脚本应能运行');
      assert.equal(compared.differences.visual,true,'修复后的颜色应显示在右侧');
      const acted=await live.operateLive(project.id,compared.id,{side:'left',sync:true,revision:compared.revision,operation:{action:'click',x:1020,y:18}},'auth');
      assert.equal(acted.outcome?.matched,true);
      const left=await live.scanLive(project.id,compared.id,'left','auth');
      const right=await live.scanLive(project.id,compared.id,'right','auth');
      assert.match(left.ax,/动态内容/);
      assert.match(right.ax,/动态内容/);
      assert.match(left.ax,/接口内容/);
    } finally {await live.closeLive(project.id,compared.id,'auth');}
    const secondVersion = storage.id();
    const secondDir = storage.snapshotDir(project.id,secondVersion);
    fs.cpSync(next,secondDir,{recursive:true});
    fs.writeFileSync(path.join(secondDir,'index.html'),repairedHtml.replace('#ff0000','#0000ff'));
    storage.db.prepare('INSERT INTO snapshots(id,project_id,parent_id,entry,hash,created_at,description) VALUES(?,?,?,?,?,?,?)')
      .run(secondVersion,project.id,version,'index.html',storage.treeHash(secondDir),storage.now(),'已验证修复');
    storage.db.prepare('INSERT INTO verifications VALUES(?,?,?,?,?,?)').run(storage.id(),project.id,'test','passed',JSON.stringify({
      toSnapshot:secondVersion,patch:{selector:'#toggle',operation:'set-color',value:'#0000ff'},
    }),storage.now());
    const repaired = await live.startLive(project.id,{single:true,left:secondVersion,right:secondVersion},'owner','auth');
    try {
      assert.equal(repaired.modes.right,'replay');
      const clicked = await live.operateLive(project.id,repaired.id,{
        side:'right',sync:false,revision:repaired.revision,operation:{action:'click',x:1020,y:18},
      },'auth');
      assert.equal(clicked.outcome?.executions?.right?.status,'executed');
      assert.match((await live.scanLive(project.id,repaired.id,'right','auth')).ax,/动态内容/);
    } finally {await live.closeLive(project.id,repaired.id,'auth');}
  } finally{
    if(id)await browser.closeManagedBrowserSession(id,'owner','auth');
    if(otherId)await browser.closeManagedBrowserSession(otherId,'other','other-auth');
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
