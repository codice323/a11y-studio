import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {chromium,type Page} from 'playwright-core';
import {build,preview} from 'vite';
import {campusFixtures,campusUpstream} from '../scripts/campus-fixtures';

const chrome=process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out=path.resolve(process.env.CAMPUS_EVIDENCE_DIR ?? 'data/campus-evidence');
const maxStage=Number(process.env.CAMPUS_STAGE ?? 5);
const title='校园综合服务平台';
const modes=[
  {id:'html',tab:'HTML',actor:'网站管理员'},
  {id:'zip',tab:'ZIP',actor:'无障碍体验审核'},
  {id:'source',tab:'源码工程',actor:'前端开发者'},
  {id:'url-static',tab:'URL',actor:'网站管理员',rendered:false},
  {id:'url-rendered',tab:'URL',actor:'无障碍体验审核',rendered:true},
] as const;
type Mode=typeof modes[number];
type Scenario={mode:Mode;page:Page;id:string;original:string;previous?:string;requests:{method:string;url:string;status:number;error?:string}[]};
let agentCalls=0;
const visionCalls:{model:string;mime:string;bytes:number;contextPresent:boolean}[]=[];
const stages=['导入网站','首次检测','全景浏览','AI 分析与补丁审核','应用复测、版本及导出'];

async function listen(server:http.Server) {
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return (server.address() as AddressInfo).port;
}
async function close(server:http.Server) {
  if(!server.listening)return;
  const closed=once(server,'close');
  server.close();
  server.closeAllConnections();
  await closed;
}
async function stop(service:ChildProcess) {
  if(service.exitCode!==null||service.signalCode!==null)return;
  const exit=once(service,'exit');
  service.kill();
  if(!await Promise.race([exit.then(()=>true),delay(3000,false,{ref:false})])){
    service.kill('SIGKILL'); await exit;
  }
}
function precise(page:Page){return page.getByRole('button',{name:'精准修复',exact:true}).click();}
function panorama(page:Page){return page.getByRole('region',{name:'全景交互浏览',exact:true});}
async function panoramaReady(page:Page){
  await panorama(page).getByText(/左右已匹配同一页面和状态/).waitFor();
}
async function issue(page:Page,selector:string) {
  await page.getByRole('tab',{name:'问题与历史'}).click();
  await page.getByRole('button',{name:/^待处理 /}).click();
  await page.getByRole('region',{name:'待处理问题'}).getByRole('button').filter({hasText:selector}).first().click();
}
async function apply(page:Page){
  await page.getByRole('button',{name:'确认应用修复',exact:true}).click();
  const confirmation=page.getByRole('dialog').getByRole('checkbox');
  if(await confirmation.count())await confirmation.check();
  await page.getByRole('button',{name:'确认应用并复测',exact:true}).click();
  await page.getByText(/已应用 · 本次修复版本/).waitFor();
}
async function seeDiff(page:Page){
  const options=page.locator('.developer-options');
  if(!await options.evaluate(node=>(node as HTMLDetailsElement).open))await options.locator('summary').click();
  await options.getByRole('button',{name:'代码变更',exact:true}).click();
}
async function step(page:Page,name:string){
  const panel=panorama(page);
  const picker=panel.getByLabel('控件',{exact:true});
  const option=picker.getByRole('option').filter({hasText:new RegExp('^'+name+' \\(')});
  const before=await panel.getByLabel('交互状态').inputValue();
  await picker.selectOption((await option.getAttribute('value'))!);
  await panel.getByRole('button',{name:'执行并重放',exact:true}).click();
  await panoramaReady(page);
  await page.waitForFunction(previous=>{
    const control=document.querySelector<HTMLSelectElement>('select[aria-label="交互状态"]');
    return control?.value && control.value!==previous && !control.disabled;
  },before);
}
async function saveJson(file:string,data:unknown){await fs.writeFile(path.join(out,file),JSON.stringify(data,null,2)+'\n');}

test('校园综合服务平台按用户操作顺序验收四种导入入口', {timeout:600_000}, async()=>{
  assert.ok(Number.isInteger(maxStage)&&maxStage>=1&&maxStage<=5);
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'a11y-campus-'));
  await fs.mkdir(out,{recursive:true});
  const fixtures=await campusFixtures(path.join(scratch,'fixtures'));
  const upstreamHits:string[]=[];
  const upstream=campusUpstream(fixtures.url,upstreamHits);
  const upstreamPort=await listen(upstream);
  const fixturePng=await fs.readFile(path.join(fixtures.url,'assets/campus.png'));
  const model=http.createServer(async(req,res)=>{
    let raw='';
    for await(const chunk of req)raw+=chunk;
    try{
      const body=JSON.parse(raw);
      const content=body.messages.find((message:{role:string})=>message.role==='user')?.content;
      if(!Array.isArray(content)){
        if(!body.tools?.some(tool=>tool.function.name==='inspect_browser') || !content?.includes('color-contrast')) {
          throw Error('非测试范围内的 Agent 调用');
        }
        agentCalls++;
        const tools=['inspect_issue','search_wcag','read_source','inspect_browser'];
        const reply=body.messages.some(message=>message.role==='tool') ? {
          content:JSON.stringify({plan:{kind:'contrast',value:'#223744',file:'src/campus.css'},
            reason:'根据浏览器读取的当前前景与背景，局部加深公告文字颜色并复测。'}),
        } : {tool_calls:tools.map(name=>({id:name,type:'function',function:{name,
          arguments:name==='search_wcag'?JSON.stringify({query:'WCAG 文字对比度 1.4.3'}):'{}'}}))};
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({choices:[{message:reply}]}));
        return;
      }
      const match=content.find(part=>part.type==='image_url')?.image_url?.url.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if(!match)throw Error('缺少视觉像素');
      const image=Buffer.from(match[2],'base64');
      const contextPresent=content.some(part=>part.type==='text'&&part.text.includes('校园'));
      if(match[1]==='image/png'&&!image.equals(fixturePng))throw Error('请求图片与实际校验资源不同');
      assert.ok(contextPresent && image.length>500);
      visionCalls.push({model:body.model,mime:match[1],bytes:image.length,contextPresent});
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({
        purpose:'informative',description:'蓝色教学楼、绿树和太阳',contentAlt:'教学楼旁有绿树，天空中有太阳',reason:'横幅展示校园环境，请核对页面语境。',
      })}}]}));
    }catch{res.writeHead(422,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Mock 请求未通过证据校验'}));}
  });
  const modelPort=await listen(model);
  const probe=http.createServer();
  const port=await listen(probe);await close(probe);
  const origin='http://127.0.0.1:'+port;
  const service=spawn(process.execPath,['--require','./tests/helpers/url-upstream.cjs','--import','tsx','apps/api/server.ts'],{
    env:{...process.env,PORT:String(port),A11Y_DATA_DIR:path.join(scratch,'data'),
      A11Y_TEST_UPSTREAM_PORT:String(upstreamPort),AI_API_KEY:'local-fixture-key',
      AI_BASE_URL:'http://127.0.0.1:'+modelPort,AI_MODEL:'campus-mock',AI_VISION_MODEL:'campus-mock-vision'},
    stdio:['ignore','pipe','pipe'],
  });
  const serverOutput:string[]=[];
  service.stderr.on('data',chunk=>serverOutput.push(String(chunk)));
  const records:unknown[]=[];
  const scenarios:Scenario[]=[];
  async function readProject(id:string){
    const response=await fetch(origin+'/api/projects/'+id);
    assert.ok(response.ok);
    return response.json();
  }
  async function record(stage:number,scenario:Scenario,operation:()=>Promise<unknown>){
    const begin=Date.now();
    let result:unknown;
    let failure:string|undefined;
    try{result=await operation();}
    catch(error){failure=(error as Error).message;}
    const name='stage-'+stage+'-'+scenario.mode.id;
    await scenario.page.screenshot({path:path.join(out,name+'.png'),fullPage:true}).catch(()=>{});
    if(failure)await fs.writeFile(path.join(out,name+'-failure.txt'),await scenario.page.locator('body').innerText().catch(()=>failure!));
    const state=scenario.id ? await readProject(scenario.id).catch(()=>null) : null;
    records.push({stage,name:stages[stage-1],mode:scenario.mode.id,actor:scenario.mode.actor,
      projectId:scenario.id||null,version:state?.project.currentSnapshot??null,outcome:failure?'failed':'passed',
      elapsedMs:Date.now()-begin,result,failure,screenshot:name+'.png',requests:scenario.requests.splice(0)});
    await saveJson('journey.json',records);
    if(failure)throw Error(name+': '+failure);
  }
  try{
    for(let n=0;!(await fetch(origin+'/api/status').then(res=>res.ok,()=>false));n++){
      if(n===100||service.exitCode!==null)throw Error('验收服务未启动');
      await delay(100);
    }
    const browser=await chromium.launch({executablePath:chrome,headless:true});
    try{
      for(const mode of modes){
        const page=await browser.newPage({viewport:{width:1400,height:900},acceptDownloads:true});
        page.setDefaultTimeout(28_000);
        const scenario:Scenario={mode,page,id:'',original:'',requests:[]};
        page.on('response',async response=>{
          const url=new URL(response.url());
          if(!url.pathname.startsWith('/api/'))return;
          const record={method:response.request().method(),url:url.pathname,status:response.status(),error:undefined as string|undefined};
          if(response.status()>=400)record.error=await response.json().then(body=>body.error,()=>undefined);
          scenario.requests.push(record);
        });
        scenarios.push(scenario);
        await record(1,scenario,async()=>{
          await page.goto(origin);
          await page.getByRole('group',{name:'网页导入方式'}).getByRole('button',{name:mode.tab,exact:true}).click();
          const input=page.locator('input[type=file]');
          const alert=page.getByRole('alert');
          let rejection:string;
          const imported=()=>page.getByText(/项目已导入并完成真实检测|URL 快照已导入并完成检测/).waitFor({timeout:65000});
          if('rendered' in mode){
            await page.getByLabel(mode.rendered?'执行 JavaScript 后采集（推荐）':'仅采集静态 HTML').check();
            const url=page.getByLabel('公开网页地址');
            await url.fill('http://93.184.216.34/private-redirect');
            await page.getByRole('button',{name:'导入 URL 并检测'}).click();
            await alert.getByText(/非公网/).waitFor();
            rejection=await alert.innerText();
            await page.screenshot({path:path.join(out,'stage-1-'+mode.id+'-rejected.png')});
            await url.fill('http://93.184.216.34/');
            await page.getByRole('button',{name:'导入 URL 并检测'}).click();
          }else{
            if(mode.id==='html'){
              await input.setInputFiles(fixtures.zip);
            }else if(mode.id==='zip'){
              await input.setInputFiles({name:'scripts.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({
                'index.html':strToU8('<title>test</title>'),'script.js':strToU8('console.log(1)'),
              }))});
            }else{
              const files=unzipSync(await fs.readFile(fixtures.project));
              files['package.json']=strToU8(JSON.stringify({dependencies:{react:'*','react-dom':'*','react-router-dom':'*'}}));
              await input.setInputFiles({name:'unsupported-dependencies.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(files))});
            }
            const message=mode.id==='html'?/HTML/:mode.id==='zip'?/不支持文件类型.*script\.js/:/React DOM 运行依赖/;
            await alert.getByText(message).waitFor();
            rejection=await alert.innerText();
            await page.screenshot({path:path.join(out,'stage-1-'+mode.id+'-rejected.png')});
            await input.setInputFiles(mode.id==='html'?fixtures.html:mode.id==='zip'?fixtures.zip:fixtures.project);
          }
          await page.locator('.busy').waitFor();
          await page.screenshot({path:path.join(out,'stage-1-'+mode.id+'-loading.png')});
          await imported();
          const response=await fetch(origin+'/api/projects');
          const [project]=await response.json();
          scenario.id=project.id;scenario.original=project.currentSnapshot;
          assert.equal(project.mode,mode.id==='source'?'react-source':'snapshot');
          assert.equal(project.entry,'index.html');
          assert.match(await page.locator('.project-title').innerText(),mode.id.startsWith('url')?new RegExp(title):/campus-/);
          return {steps:['选择入口','提交不支持输入','读取错误','从同一入口重试','进入项目'],rejection,mode:project.mode,entry:project.entry};
        });
      }
      console.log('阶段 1：四种入口、两种 URL 模式均完成失败恢复与成功导入。');

      if(maxStage>=2)for(const s of scenarios)await record(2,s,async()=>{
        const {page}=s;
        const state=await readProject(s.id);
        const scan=state.current;
        assert.equal(scan.status,'completed');
        const annotations=JSON.parse(await fs.readFile('tests/fixtures/campus/annotations.json','utf8'));
        const observations=annotations.entryAutomatic.map(({id,rule,selector})=>({id,rule,selector,
          observed:scan.issues.some(item=>item.ruleId===rule&&item.selector===selector)}));
        assert.ok(observations.every(item=>item.observed),JSON.stringify({observations,issues:scan.issues.map(item=>[item.ruleId,item.selector])}));
        const controls=['#student-name','#student-email','#course-choice','#focusless'];
        const falsePositives=scan.issues.filter(item=>controls.includes(item.selector)&&['label','button-name','select-name'].includes(item.ruleId));
        assert.equal(falsePositives.length,0);
        if(s.mode.id==='source'){
          assert.match(scan.issues.find(item=>item.selector==='#campus-hero').source.file,/campus\.tsx$/);
          assert.equal(scan.build.tool,'esbuild');
        }
        const index=await fs.readFile(path.join(scratch,'data/projects',s.id,s.original,'index.html'),'utf8');
        if('rendered' in s.mode)assert.equal(index.includes('data-rendered="true"'),s.mode.rendered);
        await precise(page);
        await issue(page,'#campus-hero');
        await page.getByRole('heading',{name:'图片缺少替代文本'}).waitFor();
        return {steps:['检查首次扫描版本与引擎','核对人工标注','定位图片问题'],observations,falsePositives,
          engine:scan.detection.engine,behavior:scan.detection.behavior,issues:scan.issues.map(item=>({
            id:item.id,ruleId:item.ruleId,selector:item.selector,impact:item.impact,source:item.source})),incomplete:scan.incomplete};
      });
      if(maxStage>=2)console.log('阶段 2：所有形式均匹配四项入口核心规则，已保存完整扫描清单和辅助复核证据。');

      if(maxStage>=3)for(const s of scenarios)await record(3,s,async()=>{
        const {page}=s;
        await page.getByRole('button',{name:'全景交互浏览',exact:true}).click();
        await panoramaReady(page);
        const panel=panorama(page);
        const picker=panel.getByLabel('页面',{exact:true});
        const pages=await picker.getByRole('option').allTextContents();
        if(s.mode.id==='zip'){
          assert.equal(pages.length,6);
          await picker.selectOption('/pages/enroll.html');
          await panoramaReady(page);
          await panel.getByRole('button',{name:'语义对比',exact:true}).click();
          assert.match(await panel.locator('.panorama-pair pre').first().innerText(),/课程报名/);
          await picker.selectOption('/index.html');
          await panoramaReady(page);
        }else if(s.mode.id==='source'){
          await step(page,'个人中心');
          await step(page,'我的设置');
          await step(page,'编辑资料');
          await panel.getByRole('button',{name:'语义对比',exact:true}).click();
          assert.match(await panel.locator('.panorama-pair pre').first().innerText(),/dialog "编辑资料"/);
          await page.screenshot({path:path.join(out,'stage-3-source-dialog.png'),fullPage:true});
          await picker.selectOption('/index.html');
          await panoramaReady(page);
        }else{
          assert.equal(pages.length,1);
        }
        if(s.mode.id!=='source'){
          assert.match(await panel.innerText(),/静态快照，仅支持浏览已采集状态/);
          assert.equal(await panel.getByRole('group',{name:'记录安全操作'}).count(),0);
        }
        await panel.getByRole('button',{name:'视觉对比',exact:true}).click();
        await panel.locator('.panorama-pair img').first().waitFor();
        return {steps:['打开全景','检查页面树','验证模式支持的状态','返回首页'],pages,
          interaction:s.mode.id==='source'?'个人中心 → 我的设置 → 编辑资料，双侧语义含 dialog':'静态快照'};
      });
      if(maxStage>=3)console.log('阶段 3：ZIP 六页、源码路由与弹窗、HTML/URL 快照边界已验收。');

      if(maxStage>=4)for(const s of scenarios)await record(4,s,async()=>{
        const {page}=s;
        await precise(page);
        await issue(page,'#campus-hero');
        await page.getByRole('button',{name:'AI 分析与修复',exact:true}).click();
        const value=page.getByLabel('建议的文本内容');
        await page.getByText(/横幅展示校园环境/).first().waitFor();
        assert.match(await value.inputValue(),/教学楼旁有绿树/);
        await page.getByRole('radio',{name:'内容性图片'}).check();
        await value.fill('蓝色教学楼旁有两棵绿树，天空中有太阳');
        await page.getByRole('button',{name:'生成补丁预览',exact:true}).click();
        await page.getByRole('region',{name:'修复内容摘要'}).waitFor();
        await seeDiff(page);
        const diff=page.locator('.patch-file').first();
        assert.match(await diff.innerText(),s.mode.id==='source'?/src\/campus\.tsx/:/index\.html/);
        assert.match(await diff.locator('ins').allTextContents().then(values=>values.join(' ')),/alt|蓝色教学楼/);
        return {steps:['选中图片','触发 Mock 多模态调用','选择内容性图片','编辑建议','检查真实 Diff'],
          model:visionCalls.at(-1),candidate:await value.inputValue(),diff:await diff.innerText(),human:'说明应符合实际页面用途'};
      });
      if(maxStage>=4)console.log('阶段 4：五次 Mock 视觉调用均检查真实像素与校园上下文，补丁含真实文件差异。');

      if(maxStage>=5)for(const s of scenarios)await record(5,s,async()=>{
        const {page}=s;
        await apply(page);
        const v1=await readProject(s.id);
        s.previous=v1.project.currentSnapshot;
        assert.notEqual(s.previous,s.original);
        assert.equal(v1.verifications[0].status,'passed');
        assert.ok(!v1.current.issues.some(item=>item.ruleId==='image-alt'&&item.selector==='#campus-hero'));
        await issue(page,s.mode.id==='source'?'#registration-note':'#quick-search');
        const field=page.locator('#repair-value');
        let labelDecision:string|undefined;
        await page.getByRole('button',{name:'AI 分析与修复',exact:true}).click();
        if(s.mode.id!=='source'){
          const decision=page.getByText(/建议人工确认|需要补充信息/).first();
          await decision.waitFor();
          labelDecision=await decision.innerText();
          await field.fill('搜索校园课程');
          await page.getByRole('button',{name:'生成补丁预览',exact:true}).click();
        }
        await page.getByRole('region',{name:'修复内容摘要'}).waitFor();
        await seeDiff(page);
        if(s.mode.id==='source')assert.match(await page.locator('.patch-file').first().innerText(),/src\/campus\.css/);
        await apply(page);
        const v2=await readProject(s.id);
        assert.equal(v2.snapshots.length,3);
        assert.ok(v2.verifications.every(item=>item.status==='passed'&&item.added.length===0));
        const current=v2.project.currentSnapshot;
        await page.getByRole('button',{name:'重命名',exact:true}).click();
        await page.getByLabel('版本名称').fill('校园验收 V2');
        await page.getByRole('button',{name:'保存',exact:true}).click();
        await page.getByText('版本名称已保存。').waitFor();

        await page.getByRole('button',{name:'全景交互浏览',exact:true}).click();
        await panoramaReady(page);
        const panel=panorama(page);
        assert.equal(await panel.getByLabel('全景左侧版本').inputValue(),s.original);
        assert.equal(await panel.getByLabel('全景右侧版本').inputValue(),current);
        await panel.getByLabel('全景左侧版本').selectOption(s.previous!);
        await panoramaReady(page);
        assert.equal((await readProject(s.id)).project.currentSnapshot,current);
        await page.getByLabel('切换项目版本').selectOption(s.original);
        await page.getByText(/已恢复到所选有效版本/).waitFor();
        assert.ok((await readProject(s.id)).current.issues.some(item=>item.selector==='#campus-hero'));
        await page.getByLabel('切换项目版本').selectOption(current);
        await page.getByText(/已恢复到所选有效版本/).waitFor();
        assert.equal((await readProject(s.id)).project.currentSnapshot,current);

        let rejectedPatch:string|undefined;
        if(s.mode.id==='html'){
          await precise(page);
          await issue(page,'#registration-note');
          await field.fill('#ffffff');
          await page.getByRole('button',{name:'生成补丁预览',exact:true}).click();
          await page.getByRole('region',{name:'修复内容摘要'}).waitFor();
          await page.getByRole('button',{name:'确认应用修复',exact:true}).click();
          await page.getByRole('button',{name:'确认应用并复测',exact:true}).click();
          const error=page.getByRole('alert').filter({hasText:/已保留原版本/});
          await error.waitFor();
          rejectedPatch=await error.innerText();
          const retained=await readProject(s.id);
          assert.equal(retained.project.currentSnapshot,current);
          assert.equal(retained.verifications[0].status,'failed');
          await page.screenshot({path:path.join(out,'stage-5-html-rejected-patch.png'),fullPage:true});
        }

        const pending=page.waitForEvent('download');
        await page.getByRole('link',{name:'导出项目 ZIP'}).click();
        const zipfile=path.join(out,'export-'+s.mode.id+'.zip');
        await (await pending).saveAs(zipfile);
        const archived=unzipSync(await fs.readFile(zipfile));
        const report=JSON.parse(strFromU8(archived['report/report.json']));
        assert.equal(report.project.currentSnapshot,current);
        assert.equal(report.verifications.length,rejectedPatch?3:2);
        assert.equal(report.verifications.filter(item=>item.status==='passed'&&item.diff).length,2);
        assert.equal(report.verifications.filter(item=>item.status==='failed').length,rejectedPatch?1:0);
        const exports=path.join(scratch,'export-'+s.mode.id);
        const prefix=s.mode.id==='source'?'source/':'website/';
        for(const [name,bytes] of Object.entries(archived))if(name.startsWith(prefix)){
          const file=path.join(exports,name.slice(prefix.length));
          await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
        }
        let serve:http.Server;
        if(s.mode.id==='source'){
          await fs.symlink(path.join(process.cwd(),'node_modules'),path.join(exports,'node_modules'),'dir');
          await build({root:exports,configFile:false,logLevel:'silent'});
          serve=(await preview({root:exports,configFile:false,logLevel:'silent',preview:{host:'127.0.0.1',port:0}})).httpServer;
        }else{
          serve=campusUpstream(exports);await listen(serve);
        }
        try{
          const offline=await browser.newPage();
          await offline.goto('http://127.0.0.1:'+(serve.address() as AddressInfo).port);
          const image=offline.getByRole('img',{name:'蓝色教学楼旁有两棵绿树，天空中有太阳'});
          await image.waitFor();
          assert.ok(await image.evaluate(node=>(node as HTMLImageElement).naturalWidth>0));
          if(s.mode.id==='source'){
            await offline.getByRole('link',{name:'课程中心',exact:true}).click();
            await offline.getByRole('heading',{name:'课程中心',exact:true}).waitFor();
            await offline.getByLabel('搜索课程').fill('无障碍');
            assert.equal(await offline.locator('.cards article').count(),1);
            await offline.getByRole('link',{name:'课程报名',exact:true}).click();
            await offline.getByLabel('姓名',{exact:true}).fill('演示学生');
            await offline.getByLabel('邮箱',{exact:true}).fill('sample@example.test');
            await offline.getByLabel('课程',{exact:true}).selectOption({label:'开放科学工作坊'});
            await offline.getByRole('checkbox',{name:'我确认使用演示资料'}).check();
            await offline.getByRole('button',{name:'检查报名'}).click();
            await offline.getByText('请使用校园邮箱。').waitFor();
            await offline.getByLabel('邮箱',{exact:true}).fill('sample@campus.example');
            await offline.getByRole('button',{name:'检查报名'}).click();
            await offline.getByText('演示报名已保存。').waitFor();
          }else{
            await offline.getByRole('searchbox',{name:'搜索校园课程'}).waitFor();
            if(s.mode.id==='zip'){
              await offline.getByRole('link',{name:'学习资源',exact:true}).click();
              const video=offline.locator('video');
              await video.evaluate(element=>(element as HTMLVideoElement).load());
              await offline.waitForFunction(()=>(document.querySelector('video')?.readyState??0)>=1);
              assert.equal(await video.locator('track[kind=captions]').count(),1);
              await offline.locator('audio').evaluate(element=>(element as HTMLAudioElement).load());
              await offline.waitForFunction(()=>(document.querySelector('audio')?.duration??0)>0);
            }
          }
          await offline.close();
        }finally{await close(serve);}
        return {steps:['应用图片补丁','复测','生成第二次补丁','建立 V2','重命名','任意对照','回退和恢复','浏览器下载','离线复验'],
          original:s.original,previous:s.previous,current,versions:report.snapshots,verifications:report.verifications.map(item=>({
            status:item.status,patch:item.patch,added:item.added,reason:item.reason,sourceChecks:item.sourceChecks,agentTrace:item.agentTrace})),
          labelDecision,rejectedPatch,export:zipfile};
      });
      if(maxStage>=5){
        assert.equal(agentCalls,2);
        console.log('阶段 5：两次应用、失败补丁保留原版本、版本命名/对照/回退、ZIP 下载和离线打开全部通过。');
      }
    }finally{await browser.close();}
  }finally{
    await saveJson('model-and-url.json',{visionMode:'mock',liveDeepSeekCalls:0,externalCost:0,visionCalls,agentCalls,upstreamHits});
    await fs.writeFile(path.join(out,'server-errors.log'),serverOutput.join(''));
    await stop(service); await close(upstream);await close(model);await fs.rm(scratch,{recursive:true,force:true});
  }
});
