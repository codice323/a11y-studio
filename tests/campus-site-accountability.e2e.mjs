import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const out = process.env.A11Y_SITE_EVIDENCE ?? 'data/site-accountability';
const live = process.argv.includes('--live');
const independent = process.argv.includes('--independent');
const runName = live ? 'original' : independent ? 'independent' : 'injected';
const origin = process.env.A11Y_SITE_ORIGIN ?? (live ? 'http://localhost:5173' : 'http://127.0.0.1:4189');
const archive = process.env.A11Y_CAMPUS_ZIP ?? 'data/campus-fixtures/campus-multipage.zip';
const injected = [
  ['courses','image-alt','#qa-missing-alt','<img id="qa-missing-alt" src="../assets/campus.png" width="200" height="120">'],
  ['enroll','label','#qa-missing-label','<input id="qa-missing-label" type="text">'],
  ['resources','button-name','#qa-resource-button','<section><h2>打印学习资料</h2><p>下面的图标按钮用于打印当前学习资料。</p><button type="button" id="qa-resource-button" style="min-height:36px;min-width:40px"><span aria-hidden="true">⎙</span></button></section>'],
  ['profile','aria-broken-idref','#qa-broken-reference','<button id="qa-broken-reference" type="button" aria-describedby="qa-not-present">查看账户资料</button>'],
  ['help','color-contrast','#qa-low-contrast','<p id="qa-low-contrast" style="background:#fff;color:#aaa;font-size:16px">服务台周一开放</p>'],
];
const paths = ['/index.html',...injected.map(([page])=>'/pages/'+page+'.html')].sort();
await fs.mkdir(out,{recursive:true});
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(25000);
const requests=[];
page.on('response',response=>{
  const url=new URL(response.url());
  if (/\/api\/(projects|jobs|proposals)/.test(url.pathname) && (response.request().method() !== 'GET' || !url.pathname.includes('/jobs/'))) {
    requests.push({path:url.pathname,status:response.status(),method:response.request().method()});
  }
});
const save = (name,value) => fs.writeFile(out+'/'+name+'.json',JSON.stringify(value,null,2));
const get = async route => {
  const response = await page.request.get(origin+route);
  assert.ok(response.ok(), await response.text());
  return response.json();
};
const panel = page.getByRole('region',{name:'修复效果对比'});
const issues = page.getByRole('region',{name:'待处理问题'});
const shot = name => page.screenshot({path:out+'/'+name+'.png',fullPage:true});
const report = pid => get('/api/projects/'+pid+'/reports');
const getProject = async name => {
  const project = (await get('/api/projects')).find(item=>item.name===name);
  assert.ok(project, name);
  return project;
};
async function collect() {
  await panel.getByRole('button',{name:'检测已发现页面'}).click();
  await page.getByText(/已检测 6\/6 个已发现页面/).waitFor({timeout:115000});
  await panel.getByRole('button',{name:'检测已发现页面'}).isEnabled();
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(el=>el.textContent==='检测已发现页面'&&!el.disabled));
}
function assertReport(data) {
  assert.deepEqual(data.site.pages.map(item=>item.path).sort(),paths);
  assert.equal(data.site.states.length,6);
  assert.equal(new Set(data.site.states.map(item=>item.id)).size,6);
  assert.equal(new Set(data.site.states.map(item=>item.stateId)).size,6);
  assert.equal(data.site.confirmed,data.site.pages.reduce((sum,item)=>sum+item.issues,0));
  for (const state of data.site.states) {
    assert.equal(data.site.pages.find(row=>row.pageId===state.pageId)?.path,state.path);
    assert.ok(state.dom && state.ax && state.screenshot, state.path);
    assert.ok(state.scan.engine.version && state.scan.browser && state.scan.rules.length, state.path);
    assert.equal(state.scan.behavior.status,'completed',state.path);
    assert.equal(state.scan.resources.images,state.scan.resources.loadedImages,state.path);
    assert.equal(state.scan.resources.stylesheets,state.scan.resources.loadedStylesheets,state.path);
    assert.equal(state.resourceFailures.length,0,state.path);
  }
}
try {
  await page.goto(origin);
  let project;
  if (live) {
    project=await getProject('campus-multipage.zip');
    const before=await report(project.id);
    await page.locator('.recent-list').getByRole('button',{name:/^campus-multipage\.zip/}).first().click();
    const batch=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/panorama')&&response.request().postDataJSON()?.site===true);
    await collect();
    assert.equal((await batch).status(),202);
    const data=await report(project.id);
    assertReport(data);
    assert.notEqual(data.site.states[0].id,before.site.states[0]?.id,'fresh scan must replace old captures');
    await save('campus-original-report',data.site);
    await page.getByRole('button',{name:'结果报告',exact:true}).click();
    await page.getByText(/全站 4 项确定性违规/).waitFor();
    await shot('campus-original-report');
  } else if (independent) {
    const name='reading-room-accountability.zip';
    const document = (title, content) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${content}</main></body></html>`;
    const unnamed='<button id="same-control" style="min-width:48px;min-height:36px"><span aria-hidden="true">?</span></button>';
    const files = {
      'index.html':document('Reading room','<a href="/nested/reading%20guide.html?q=1#intro">Guide</a><a href="nested/reading%20guide.html">Guide again</a><a href="not-in-archive.html">Unpackaged link</a>'),
      'nested/reading guide.html':document('Guide','<p id="intro">Reading directions.</p><a href="../index.html#top">Home</a>'),
      'nested/catalog.html':document('Catalog',unnamed),
      'nested/calendar.htm':document('Calendar',unnamed),
      'nested/oversize.html':document('Oversized','<p style="min-height:7000px">Exceeds the preview height limit.</p>'),
    };
    const bytes=Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([file,html])=>[file,strToU8(html)]))));
    await page.getByRole('button',{name:'ZIP',exact:true}).click();
    await page.locator('input[type=file]').setInputFiles({name,mimeType:'application/zip',buffer:bytes});
    await panel.getByRole('button',{name:'检测已发现页面'}).click();
    await page.getByText(/已检测 4\/5 个已发现页面/).waitFor();
    project=await getProject(name);
    const {site}=await report(project.id);
    const results=Object.fromEntries(site.pages.map(item=>[item.path,item]));
    assert.equal(site.pages.length,5);
    assert.equal(results['/nested/reading%20guide.html'].issues,0);
    assert.equal(results['/index.html'].issues,0);
    assert.equal(results['/nested/catalog.html'].issues,1);
    assert.equal(results['/nested/calendar.htm'].issues,1);
    assert.equal(site.confirmed,2,'identical issue IDs from different pages count separately');
    assert.equal(results['/nested/oversize.html'].issues,null);
    assert.equal(results['/nested/oversize.html'].status,'failed');
    assert.match(results['/nested/oversize.html'].error,/页面尺寸超过/);
    assert.ok(!site.states.some(state=>state.path==='/nested/oversize.html'));
    await panel.getByLabel('页面',{exact:true}).selectOption('/nested/oversize.html');
    await issues.getByText('所选页面检测未完成',{exact:true}).waitFor();
    await shot('independent-failed-page');
    await page.getByRole('button',{name:'结果报告',exact:true}).click();
    await page.getByText(/全站 2 项确定性违规/).waitFor();
    await shot('independent-coverage');
    await save('independent-report',site);
  } else {
    const files=unzipSync(new Uint8Array(await fs.readFile(archive)));
    for (const [part,,,html] of injected) {
      const file='pages/'+part+'.html';
      assert.ok(files[file],file);
      const original=strFromU8(files[file]);
      const changed=original.replace(/<\/main>/i,html+'</main>');
      assert.notEqual(changed,original,file);
      files[file]=strToU8(changed);
    }
    const name='campus-accountability-injected.zip';
    const bytes=Buffer.from(zipSync(files));
    await fs.writeFile(out+'/'+name,bytes);
    await save('manual-oracle',injected.map(([path,rule,selector,html])=>({path:'/pages/'+path+'.html',rule,selector,html,
      expected:rule==='aria-broken-idref'?'V2 needs-review':'axe violation',
      ...(rule==='color-contrast'&&{contrast:1.05/((170/255+0.055)**2.4/1.055**2.4+0.05),threshold:4.5})})));
    await page.getByRole('button',{name:'ZIP',exact:true}).click();
    await page.locator('input[type=file]').setInputFiles({name,mimeType:'application/zip',buffer:bytes});
    await collect();
    project=await getProject(name);
    const before=await report(project.id);
    assertReport(before);
    for (const [part,rule,selector] of injected) {
      const target='/pages/'+part+'.html';
      const state=before.site.states.find(item=>item.path===target);
      if (rule==='aria-broken-idref') assert.ok(state.scan.behavior.findings.some(f=>f.ruleId===rule&&f.selector===selector&&f.status==='needs-review'), JSON.stringify(state.scan.behavior.findings));
      else assert.ok(state.issues.some(issue=>issue.ruleId===rule&&issue.selector===selector), JSON.stringify(state.issues));
      assert.equal(before.site.states.filter(item=>item.path!==target).flatMap(item=>item.issues).some(issue=>issue.selector===selector),false);
    }
    await save('injected-v0-report',before.site);
    const selectPage = async pathname => {
      await panel.getByLabel('页面',{exact:true}).selectOption(pathname);
      await panel.getByText(/左右已匹配同一页面和状态/).waitFor();
      await page.getByRole('tab',{name:'问题与历史'}).click();
    };
    await selectPage('/pages/courses.html');
    await issues.getByRole('button').filter({hasText:'#qa-missing-alt'}).waitFor();
    await selectPage('/pages/resources.html');
    assert.equal(await issues.getByRole('button').filter({hasText:'#qa-missing-alt'}).count(),0);
    await issues.getByRole('button').filter({hasText:'#qa-resource-button'}).click();
    await shot('injected-resources-issue');
    const ai = page.getByRole('button',{name:'AI 分析与修复',exact:true});
    if (await ai.isEnabled() && process.env.A11Y_SITE_REAL_AI==='1') {
      const started=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/panorama/proposals'));
      await ai.click();
      const ticket=await (await started).json();
      assert.ok(ticket.id);
      let response;
      for (let attempt=0;attempt<90;attempt++) {
        response=await get('/api/jobs/'+ticket.id);
        if (!['queued','running'].includes(response.status)) break;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      await save('real-ai-job',response);
      console.log('REAL_AI',response.status,response.result?.suggestedValue??null,response.error??null);
    }
    await page.getByLabel('建议的文本内容').fill('打印学习资料');
    await page.getByRole('button',{name:'生成补丁预览',exact:true}).click();
    const confirm=page.getByRole('button',{name:'确认应用修复',exact:true});
    await confirm.waitFor({timeout:95000});
    await shot('injected-resources-patch');
    await confirm.click();
    await page.getByRole('checkbox',{name:/我已核对修复内容/}).check();
    await page.getByRole('button',{name:'确认应用并复测',exact:true}).click();
    await page.getByText(/当前版本已更新/).waitFor({timeout:100000});
    const after=await report(project.id);
    assertReport(after);
    assert.notEqual(before.site.snapshotId,after.site.snapshotId);
    const remaining = after.site.states.flatMap(item=>item.issues);
    assert.ok(!remaining.some(issue=>issue.selector==='#qa-resource-button'));
    for (const [,rule,selector] of injected.filter(([,rule])=>!['button-name','aria-broken-idref'].includes(rule))) assert.ok(remaining.some(issue=>issue.ruleId===rule&&issue.selector===selector));
    assert.equal(after.site.confirmed,before.site.confirmed-1);
    await save('injected-v1-report',after.site);
    await save('injected-v1-verification',after.verifications[0]);
    await page.getByRole('tab',{name:'问题与历史'}).click();
    await page.getByRole('button',{name:'重新检测',exact:true}).click();
    await page.getByText('已发现的页面和已记录的状态检测完成。',{exact:true}).waitFor({timeout:115000});
    const rerun=await report(project.id);
    assertReport(rerun);
    assert.equal(rerun.site.snapshotId,after.site.snapshotId);
    assert.notEqual(rerun.site.states[0].id,after.site.states[0].id);
    assert.equal(rerun.site.confirmed,after.site.confirmed);
    await save('injected-v1-rerun',rerun.site);
  }
  console.log(runName.toUpperCase()+'_OK',project.id);
} catch(error) {
  await shot(runName+'-failure').catch(()=>{});
  throw error;
} finally {
  await save(runName+'-requests',requests);
  await browser.close();
}
